/**
 * outreach-core.test.mjs — characterization suite for the outreach cadence
 * state machine (classifyContact / classifyAll / normalizeOutcome /
 * channelFamily) plus the log parser/collapser in outreach-cadence.mjs.
 *
 * The cadence is a fixed precedence: outcome terminals (replied/declined) win,
 * then the touch ceiling, then the due/scheduled window. These tests pin both
 * the chosen action AND which signal won, so the contract can't drift silently.
 *
 * Run: node --test scripts/outreach-core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContact,
  classifyAll,
  normalizeOutcome,
  channelFamily,
  contactLeverage,
  touchCeiling,
  nudgePriority,
  CADENCE,
  LEVERAGE_PRIORITY,
  LEVERAGE_EXTRA_TOUCHES,
} from './outreach-core.mjs';
import { parseLog, collapse } from './outreach-cadence.mjs';

const TODAY = '2026-06-25';

// ── normalizeOutcome ───────────────────────────────────────────────────────
test('empty / blank outcome → pending', () => {
  assert.equal(normalizeOutcome(''), 'pending');
  assert.equal(normalizeOutcome('   '), 'pending');
  assert.equal(normalizeOutcome(undefined), 'pending');
});

test('reply phrases → replied (terminal)', () => {
  for (const s of ['Replied', 'they responded', 'wrote back', 'call booked', 'intro made']) {
    assert.equal(normalizeOutcome(s), 'replied', `"${s}" should be replied`);
  }
});

test('reply wins over accepted when both present', () => {
  assert.equal(normalizeOutcome('accepted and replied'), 'replied');
});

test('decline phrases → declined (terminal)', () => {
  for (const s of ['Declined', 'ignored', 'withdrawn', 'not interested', 'ghosted']) {
    assert.equal(normalizeOutcome(s), 'declined', `"${s}" should be declined`);
  }
});

test('accepted (no reply) → accepted', () => {
  assert.equal(normalizeOutcome('Accepted'), 'accepted');
  assert.equal(normalizeOutcome('connection accepted'), 'accepted');
});

// ── channelFamily ──────────────────────────────────────────────────────────
test('connection-request variants → connection family', () => {
  for (const c of ['Connection', 'connect', 'LinkedIn connection', 'connection request', 'request']) {
    assert.equal(channelFamily(c), 'connection', `"${c}"`);
  }
});

test('message / inmail / email → message family', () => {
  for (const c of ['Message', 'InMail', 'Email', 'DM', '']) {
    assert.equal(channelFamily(c), 'message', `"${c}"`);
  }
});

// ── classifyContact precedence ─────────────────────────────────────────────
test('replied short-circuits everything → done', () => {
  const r = classifyContact(
    { channel: 'Message', lastTouch: '2026-01-01', touches: 99, outcome: 'replied' },
    TODAY,
  );
  assert.equal(r.action, 'done');
  assert.equal(r.state, 'replied');
});

test('declined → cold even if recent', () => {
  const r = classifyContact(
    { channel: 'Connection', lastTouch: TODAY, touches: 1, outcome: 'declined' },
    TODAY,
  );
  assert.equal(r.action, 'cold');
});

test('touch ceiling → cold before any window check', () => {
  const r = classifyContact(
    { channel: 'Message', lastTouch: '2026-01-01', touches: CADENCE.message_max, outcome: '' },
    TODAY,
  );
  assert.equal(r.action, 'cold');
  assert.match(r.reason, /switch angle or contact/);
});

test('message past first window → nudge', () => {
  const last = '2026-06-19'; // 6 days before TODAY, > message_first (5)
  const r = classifyContact({ channel: 'Message', lastTouch: last, touches: 1, outcome: '' }, TODAY);
  assert.equal(r.action, 'nudge');
  assert.equal(r.daysSince, 6);
});

test('message inside first window → waiting with a next-nudge date', () => {
  const last = '2026-06-22'; // 3 days before TODAY, < message_first (5)
  const r = classifyContact({ channel: 'Message', lastTouch: last, touches: 1, outcome: '' }, TODAY);
  assert.equal(r.action, 'waiting');
  assert.equal(r.nextNudge, '2026-06-27'); // 2026-06-22 + 5
});

test('connection has a longer leash than message', () => {
  const last = '2026-06-19'; // 6 days
  const conn = classifyContact({ channel: 'Connection', lastTouch: last, touches: 1, outcome: '' }, TODAY);
  const msg = classifyContact({ channel: 'Message', lastTouch: last, touches: 1, outcome: '' }, TODAY);
  // 6 days: still inside the 7-day connection window, but past the 5-day message window.
  assert.equal(conn.action, 'waiting');
  assert.equal(msg.action, 'nudge');
});

test('accepted connection switches to the tighter message cadence', () => {
  const last = '2026-06-19'; // 6 days
  const r = classifyContact({ channel: 'Connection', lastTouch: last, touches: 1, outcome: 'accepted' }, TODAY);
  // accepted → effFamily message → window 5 → 6 days is overdue
  assert.equal(r.action, 'nudge');
  assert.match(r.reason, /value-add message/);
});

test('missing last-touch date → nudge (never silently lost)', () => {
  const r = classifyContact({ channel: 'Message', lastTouch: '', touches: 1, outcome: '' }, TODAY);
  assert.equal(r.action, 'nudge');
  assert.equal(r.daysSince, null);
  assert.equal(r.nextNudge, null);
});

test('subsequent-touch window applies on touch 2', () => {
  // touch 2, message_subsequent = 6. 5 days → waiting, 6 days → nudge.
  const waiting = classifyContact({ channel: 'Email', lastTouch: '2026-06-20', touches: 2, outcome: '' }, TODAY);
  const due = classifyContact({ channel: 'Email', lastTouch: '2026-06-19', touches: 2, outcome: '' }, TODAY);
  // message_max is 2, so touches===2 already hits the ceiling → cold.
  // This documents that the ceiling check precedes the window: both are cold.
  assert.equal(waiting.action, 'cold');
  assert.equal(due.action, 'cold');
});

// ── classifyAll rollup + sort ──────────────────────────────────────────────
test('classifyAll counts and floats actionable to the top', () => {
  const contacts = [
    { company: 'A', contact: 'p1', channel: 'Message', lastTouch: '2026-06-23', touches: 1, outcome: '' }, // waiting
    { company: 'B', contact: 'p2', channel: 'Message', lastTouch: '2026-06-10', touches: 1, outcome: '' }, // nudge
    { company: 'C', contact: 'p3', channel: 'Message', lastTouch: '2026-06-01', touches: 1, outcome: 'replied' }, // done
  ];
  const { entries, counts, actionable } = classifyAll(contacts, TODAY);
  assert.equal(counts.nudge, 1);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.done, 1);
  assert.equal(actionable, 1);
  assert.equal(entries[0].action, 'nudge'); // most actionable first
  assert.equal(entries[entries.length - 1].action, 'done');
});

// ── log parsing + collapse ─────────────────────────────────────────────────
const SAMPLE_LOG = `# Outreach Log

| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Acme | Data Analyst | Jane Roe | Hiring Manager | Connection | 1 | Pending | hook on their blog |
| 2 | 2026-06-18 | Acme | Data Analyst | Jane Roe | Hiring Manager | Message | 2 | Accepted | sent value-add |
| 3 | 2026-06-20 | Globex | ML Engineer | John Doe | Recruiter | Email | 1 | Replied | wants CV |
`;

test('parseLog reads only data rows, not header/separator', () => {
  const rows = parseLog(SAMPLE_LOG);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].channel, 'Connection');
  assert.equal(rows[1].touch, 2);
  assert.equal(rows[2].outcome, 'Replied');
});

test('collapse folds touches per contact, latest wins', () => {
  const collapsed = collapse(parseLog(SAMPLE_LOG));
  // Jane Roe has 2 touches folded to 1 record; John Doe is separate.
  assert.equal(collapsed.length, 2);
  const jane = collapsed.find((c) => c.contact === 'Jane Roe');
  assert.equal(jane.touches, 2);
  assert.equal(jane.lastTouch, '2026-06-18');
  assert.equal(jane.outcome, 'Accepted'); // latest row's outcome
  assert.equal(jane.channel, 'Message');
});

test('end-to-end: collapsed sample classifies sensibly', () => {
  const { entries, counts } = classifyAll(collapse(parseLog(SAMPLE_LOG)), TODAY);
  const john = entries.find((e) => e.contact === 'John Doe');
  const jane = entries.find((e) => e.contact === 'Jane Roe');
  assert.equal(john.action, 'done'); // replied
  // Jane: accepted Hiring Manager, 2 touches. The manager ceiling is 3 (base 2
  // + 1 extra), so 2 touches is NOT yet the ceiling — she's a live nudge, not
  // cold. This is the leverage lift in action: the hiring manager gets chased
  // one more time before we give up.
  assert.equal(jane.leverage, 'manager');
  assert.equal(jane.action, 'nudge');
  assert.equal(counts.done, 1);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Leverage-aware cadence — the contact's referral leverage (read from the
 * outreach log's Title column) lifts the touch ceiling for a hiring manager and
 * prioritizes which due nudge is most valuable. Fictional titles only.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── contactLeverage ─────────────────────────────────────────────────────────
test('contactLeverage: explicit "Hiring Manager" → manager', () => {
  assert.equal(contactLeverage('Hiring Manager'), 'manager');
  assert.equal(contactLeverage('hiring lead'), 'manager');
});

test('contactLeverage: leadership job titles → manager', () => {
  assert.equal(contactLeverage('Head of Data'), 'manager');
  assert.equal(contactLeverage('VP Engineering'), 'manager');
  assert.equal(contactLeverage('Director, Product'), 'manager');
  assert.equal(contactLeverage('CTO'), 'manager');
});

test('contactLeverage: peer / interviewer / IC role words → peer', () => {
  assert.equal(contactLeverage('Peer'), 'peer');
  assert.equal(contactLeverage('Teammate'), 'peer');
  assert.equal(contactLeverage('Interviewer'), 'peer');
  assert.equal(contactLeverage('Data Engineer'), 'peer');
  assert.equal(contactLeverage('Product Designer'), 'peer');
});

test('contactLeverage: recruiter / talent / HR cues → recruiter', () => {
  assert.equal(contactLeverage('Recruiter'), 'recruiter');
  assert.equal(contactLeverage('Technical Recruiter'), 'recruiter');
  assert.equal(contactLeverage('Talent Partner'), 'recruiter');
  assert.equal(contactLeverage('Head of People'), 'recruiter');
});

test('contactLeverage: recruiter cue wins over a manager cue (Talent Acquisition Manager)', () => {
  // "...Manager" must not promote a talent role to hiring manager.
  assert.equal(contactLeverage('Talent Acquisition Manager'), 'recruiter');
  assert.equal(contactLeverage('Recruiting Lead'), 'recruiter');
});

test('contactLeverage: empty / unreadable / unrelated title → neutral', () => {
  assert.equal(contactLeverage(''), 'neutral');
  assert.equal(contactLeverage(null), 'neutral');
  assert.equal(contactLeverage('Office Coordinator'), 'neutral');
});

// ── touchCeiling ────────────────────────────────────────────────────────────
test('touchCeiling: only a manager lifts the ceiling; others keep the base', () => {
  // message base = 2; connection base = 2.
  assert.equal(touchCeiling('message', 'manager'), CADENCE.message_max + 1);
  assert.equal(touchCeiling('message', 'peer'), CADENCE.message_max);
  assert.equal(touchCeiling('message', 'recruiter'), CADENCE.message_max);
  assert.equal(touchCeiling('message', 'neutral'), CADENCE.message_max);
  assert.equal(touchCeiling('connection', 'manager'), CADENCE.connection_max + 1);
  assert.equal(touchCeiling('connection', 'recruiter'), CADENCE.connection_max);
});

test('LEVERAGE_EXTRA_TOUCHES gives only the manager an extra touch', () => {
  assert.deepEqual(LEVERAGE_EXTRA_TOUCHES, { manager: 1, peer: 0, recruiter: 0, neutral: 0 });
});

// ── classifyContact: leverage lifts the ceiling ─────────────────────────────
test('hiring manager gets one extra touch before going cold', () => {
  // 2 touches, message channel: a recruiter is at the ceiling (cold), but a
  // hiring manager still has one nudge left.
  const recruiter = classifyContact(
    { channel: 'Message', title: 'Recruiter', lastTouch: '2026-06-10', touches: 2, outcome: '' },
    TODAY,
  );
  const manager = classifyContact(
    { channel: 'Message', title: 'Hiring Manager', lastTouch: '2026-06-10', touches: 2, outcome: '' },
    TODAY,
  );
  assert.equal(recruiter.action, 'cold');   // base ceiling 2 hit
  assert.equal(manager.action, 'nudge');    // ceiling lifted to 3 → still live
  assert.equal(manager.leverage, 'manager');
});

test('the manager lift is exhausted at the lifted ceiling (3 touches → cold)', () => {
  const r = classifyContact(
    { channel: 'Message', title: 'Hiring Manager', lastTouch: '2026-06-10', touches: 3, outcome: '' },
    TODAY,
  );
  assert.equal(r.action, 'cold');
  assert.match(r.reason, /extra touch/); // notes that the manager already got the lift
});

test('leverage rides on every classified entry (terminal states included)', () => {
  const replied = classifyContact(
    { channel: 'Message', title: 'Head of Data', lastTouch: TODAY, touches: 1, outcome: 'replied' },
    TODAY,
  );
  assert.equal(replied.action, 'done');
  assert.equal(replied.leverage, 'manager');
  const waiting = classifyContact(
    { channel: 'Message', title: 'Recruiter', lastTouch: '2026-06-23', touches: 1, outcome: '' },
    TODAY,
  );
  assert.equal(waiting.action, 'waiting');
  assert.equal(waiting.leverage, 'recruiter');
});

test('a contact with no title keeps the old behavior (neutral, base ceiling)', () => {
  // Back-compat: the round-2 tests pass title-less contacts; nothing regresses.
  const r = classifyContact({ channel: 'Message', lastTouch: '2026-06-10', touches: 2, outcome: '' }, TODAY);
  assert.equal(r.leverage, 'neutral');
  assert.equal(r.action, 'cold'); // base ceiling 2, no lift
});

// ── nudgePriority + classifyAll ranking ─────────────────────────────────────
test('nudgePriority ranks by leverage first, then days-overdue', () => {
  const mgr = nudgePriority({ leverage: 'manager', daysSince: 6 });
  const peer = nudgePriority({ leverage: 'peer', daysSince: 20 });
  const rec = nudgePriority({ leverage: 'recruiter', daysSince: 50 });
  // Manager outranks a far-more-overdue peer or recruiter (leverage dominates).
  assert.ok(mgr > peer);
  assert.ok(peer > rec);
  // At equal leverage, more overdue wins.
  assert.ok(
    nudgePriority({ leverage: 'peer', daysSince: 30 }) >
    nudgePriority({ leverage: 'peer', daysSince: 10 }),
  );
});

test('LEVERAGE_PRIORITY orders manager > peer > neutral > recruiter', () => {
  assert.ok(LEVERAGE_PRIORITY.manager > LEVERAGE_PRIORITY.peer);
  assert.ok(LEVERAGE_PRIORITY.peer > LEVERAGE_PRIORITY.neutral);
  assert.ok(LEVERAGE_PRIORITY.neutral > LEVERAGE_PRIORITY.recruiter);
});

test('classifyAll floats the most valuable due nudge to the top of the nudge bucket', () => {
  // Three due nudges: a recruiter (very overdue), a peer, and a hiring manager
  // (least overdue). Leverage should put the hiring manager first despite being
  // the least overdue — the most valuable thread to act on.
  const contacts = [
    { company: 'A', contact: 'Recruiter Rae', channel: 'Message', title: 'Recruiter', lastTouch: '2026-06-01', touches: 1, outcome: '' },
    { company: 'B', contact: 'Peer Pat', channel: 'Message', title: 'Data Engineer', lastTouch: '2026-06-05', touches: 1, outcome: '' },
    { company: 'C', contact: 'Manager Max', channel: 'Message', title: 'Hiring Manager', lastTouch: '2026-06-18', touches: 1, outcome: '' },
  ];
  const { entries } = classifyAll(contacts, TODAY);
  // All three are due nudges (past the 5-day message window).
  assert.equal(entries.filter((e) => e.action === 'nudge').length, 3);
  assert.equal(entries[0].contact, 'Manager Max');  // manager first
  assert.equal(entries[0].leverage, 'manager');
  assert.equal(entries[1].contact, 'Peer Pat');     // peer next
  assert.equal(entries[2].contact, 'Recruiter Rae'); // recruiter last
});

test('classifyAll still puts actionable buckets before non-actionable ones', () => {
  // A high-leverage WAITING thread must not jump ahead of a low-leverage NUDGE:
  // the action bucket is the primary sort key, leverage only orders within it.
  const contacts = [
    { company: 'A', contact: 'Manager Waiting', channel: 'Message', title: 'Hiring Manager', lastTouch: '2026-06-23', touches: 1, outcome: '' }, // 2d → waiting
    { company: 'B', contact: 'Recruiter Due', channel: 'Message', title: 'Recruiter', lastTouch: '2026-06-10', touches: 1, outcome: '' },        // 15d → nudge
  ];
  const { entries } = classifyAll(contacts, TODAY);
  assert.equal(entries[0].contact, 'Recruiter Due'); // nudge bucket beats waiting
  assert.equal(entries[0].action, 'nudge');
  assert.equal(entries[1].action, 'waiting');
});

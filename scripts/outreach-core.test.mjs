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
  CADENCE,
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
  // Jane: accepted, 2 touches, message_max=2 → ceiling → cold.
  assert.equal(jane.action, 'cold');
  assert.equal(counts.done, 1);
});

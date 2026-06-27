/**
 * outreach-core.mjs — pure cadence logic for the `contacto` (outreach) mode.
 *
 * The `contacto` mode finds the right person at a target company and drafts a
 * LinkedIn / email message. Once sent, the touch is recorded in
 * `data/outreach.md`. This module turns that log into an actionable state:
 * for each contact it decides whether a nudge is due now, scheduled, or whether
 * the thread should be closed.
 *
 * Everything here is a pure function of its inputs — no filesystem, no clock
 * (the caller passes `today`) — so it is exhaustively unit-testable. The I/O
 * wrapper lives in `outreach-cadence.mjs`.
 *
 * --- The outreach state machine ---
 *
 * A contact row carries a `channel`, a `lastTouch` date, a `touches` count and
 * an `outcome` (free text the user writes when something happens). The outcome
 * is normalized into one of:
 *
 *   replied   — they answered. TERMINAL for cadence: stop nudging, hand off to
 *               the human (a reply is a conversation, not a cadence step).
 *   accepted  — a LinkedIn connection request was accepted but no message back
 *               yet → it's now "awaiting reply", same as a sent message.
 *   declined  — request ignored/withdrawn, or an explicit no. TERMINAL: cold.
 *   pending   — sent, nothing back yet (the default).
 *
 * From state + channel + days-since-last-touch we derive an `action`:
 *
 *   replied            → "done"     (no nudge; the user takes it from here)
 *   declined           → "cold"     (stop; suggest a different contact)
 *   touches >= max     → "cold"     (don't pester; suggest a different angle)
 *   due now            → "nudge"    (a follow-up is overdue → draft one)
 *   scheduled          → "waiting"  (on track, next-nudge date in the future)
 *
 * Cadence windows differ by channel because the social contract differs:
 *   - a LinkedIn *connection request* is silent until accepted, so it gets a
 *     longer leash before a withdraw-and-retry nudge;
 *   - a sent *message / InMail / email* warrants a tighter, value-add nudge.
 *
 * --- Leverage-aware cadence (who is worth chasing, and how hard) ---
 *
 * The channel sets the *rhythm*; the contact's referral leverage sets the
 * *persistence*. `contacto.md` § Step 2/3 ranks who you reach by what they can
 * do for THIS role — Hiring Manager > Peer > Recruiter > anyone-else — and the
 * outreach log records that as the `Title` column. Two outreach layers used to
 * disagree: `network.mjs` ranked WHO to pursue by leverage, but this cadence
 * chased everyone with the same 2-touch ceiling — so a hiring manager who owns
 * the req went cold at the same point as a recruiter who owns only logistics.
 * That's backwards: the person who can actually move you forward is worth one
 * more patient, value-add touch before you give up. Leverage now:
 *   - lifts the touch ceiling for a high-leverage contact (the hiring manager
 *     earns an extra nudge; the recruiter keeps the standard, tighter ceiling);
 *   - rides on every classified entry as `leverage`, and feeds a `priority`
 *     score so the most valuable *due* nudge floats to the top of the dashboard
 *     instead of being buried under low-leverage ones.
 * It never makes a thread MORE aggressive than the channel's base cadence — it
 * only buys a genuinely high-value contact a little more patience.
 */

// First-nudge window (days since last touch) and max touches before going cold.
export const CADENCE = {
  // LinkedIn connection request: longer leash, accept can lag.
  connection_first: 7,
  connection_subsequent: 7,
  connection_max: 2,
  // Direct message / InMail / email: tighter, lead with value.
  message_first: 5,
  message_subsequent: 6,
  message_max: 2,
};

/* ───── Contact-type leverage (from the outreach log's Title column) ──────────
 * The `Title` column in data/outreach.md is the explicit contact-type label the
 * `contacto` mode records (its Step 3): Hiring Manager · Peer · Recruiter ·
 * Interviewer. We read leverage straight from that label rather than re-deriving
 * it from a free-text job title — that role-relative inference lives in
 * network-core's `leverageTier` (which needs the target role); here the type is
 * already named, so a simple cue match is enough and stays a zero-dep leaf.
 * Four tiers, mirroring contacto.md § Step 2's priority order:
 *
 *   manager     — Hiring Manager: owns the req, feels the pain the role solves.
 *                 Highest leverage → worth the most persistence.
 *   peer        — Peer on the team / Interviewer: the best *referral* path (a
 *                 peer who likes you drops your name internally; a scheduled
 *                 interviewer is a warm, high-value thread).
 *   recruiter   — Recruiter / Talent: owns the funnel; useful for logistics,
 *                 weaker as a referral → standard cadence, no extra leash.
 *   neutral     — label unreadable / generic; a tie is still a tie, no lift.
 *
 * Pure; returns one of LEVERAGE_PRIORITY's keys. Recruiter/talent cues win over
 * manager cues (a "Talent Acquisition Manager" is a recruiter, not the hiring
 * manager) — the same precedence network-core uses, kept consistent on purpose.
 */
export const LEVERAGE_PRIORITY = { manager: 3, peer: 2, neutral: 1, recruiter: 0 };

// Extra touches a contact earns (on top of the channel's base ceiling) before
// the thread goes cold. Only the hiring manager — the person who can actually
// move you forward — gets the extra patience; everyone else keeps the base.
export const LEVERAGE_EXTRA_TOUCHES = { manager: 1, peer: 0, recruiter: 0, neutral: 0 };

const RECRUITER_TYPE_CUES = /\b(?:recruit(?:er|ing|ment)?|talent|sourcer|sourcing|hr|human resources|talent acquisition|people)\b/i;
const MANAGER_TYPE_CUES = /\b(?:hiring manager|hiring lead|hiring|head|chief|vp|vice[- ]president|director|manager|principal|founder|co-?founder|owner|lead|leads?|cto|cpo|ceo|coo|cfo|cmo|gm)\b/i;
const PEER_TYPE_CUES = /\b(?:peer|teammate|team member|colleague|individual contributor|engineer|designer|analyst|scientist|developer|interviewer|interview)\b/i;

/** Classify a logged contact's referral leverage from its Title-column label. */
export function contactLeverage(title) {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return 'neutral';
  // Recruiter/talent wins over manager (a "Talent Acquisition Manager" is talent).
  if (RECRUITER_TYPE_CUES.test(t)) return 'recruiter';
  // "Hiring Manager" / leadership label → the hiring manager.
  if (MANAGER_TYPE_CUES.test(t)) return 'manager';
  // Peer / teammate / interviewer / IC-role word → peer-level referral path.
  if (PEER_TYPE_CUES.test(t)) return 'peer';
  return 'neutral';
}

/** Channel-base touch ceiling, lifted by the contact's leverage (manager only). */
export function touchCeiling(family, leverage) {
  const base = family === 'connection' ? CADENCE.connection_max : CADENCE.message_max;
  return base + (LEVERAGE_EXTRA_TOUCHES[leverage] ?? 0);
}

// Map the channel free-text onto the two cadence families.
// LinkedIn *connection requests* are the "connection" family; everything else
// (DM after connect, InMail, email) is the "message" family.
export function channelFamily(channel) {
  const c = (channel || '').trim().toLowerCase();
  if (
    c === 'connection' ||
    c === 'connect' ||
    c === 'linkedin connection' ||
    c === 'connection request' ||
    c === 'request'
  ) {
    return 'connection';
  }
  return 'message';
}

// Normalize the user's free-text outcome into a cadence state.
// Order matters: "replied" wins over "accepted" (a reply implies acceptance),
// and explicit declines win over pending.
export function normalizeOutcome(outcome) {
  const o = (outcome || '').trim().toLowerCase();
  if (!o) return 'pending';

  // Terminal: they answered us.
  if (/\b(replied|reply|responded|answered|wrote back|got a reply|in touch|call booked|meeting|intro(?:duced)?)\b/.test(o)) {
    return 'replied';
  }
  // Terminal-negative: explicit no / ignored / withdrawn.
  if (/\b(declined|rejected|ignored|no response after|withdrawn|withdrew|not interested|ghosted|dead)\b/.test(o)) {
    return 'declined';
  }
  // Connection accepted but no message yet → treat as awaiting-reply.
  if (/\b(accepted|connected|connection accepted)\b/.test(o)) {
    return 'accepted';
  }
  return 'pending';
}

function parseDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim())) return null;
  const d = new Date(`${String(s).trim()}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

function addDays(s, n) {
  const d = parseDate(s);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Classify a single contact's outreach cadence state.
 *
 * @param {object} contact
 *   - channel    {string}  raw channel text
 *   - title      {string}  contact-type label (Hiring Manager / Peer / …) — sets
 *                          referral leverage, which adjusts the touch ceiling
 *   - lastTouch  {string}  YYYY-MM-DD of the most recent touch
 *   - touches    {number}  how many times we've reached out (>=1)
 *   - outcome    {string}  free-text outcome the user logged
 * @param {string} todayStr  YYYY-MM-DD "today" (injected for testability)
 * @returns {object} { action, state, family, leverage, daysSince, nextNudge, reason }
 *   action ∈ {done, cold, nudge, waiting}; leverage ∈ keys of LEVERAGE_PRIORITY
 */
export function classifyContact(contact, todayStr) {
  const family = channelFamily(contact.channel);
  const state = normalizeOutcome(contact.outcome);
  const leverage = contactLeverage(contact.title);
  const touches = Number.isFinite(contact.touches) ? contact.touches : 1;

  const today = parseDate(todayStr);
  const last = parseDate(contact.lastTouch);
  const daysSince = today && last ? daysBetween(last, today) : null;

  // 1. Terminal states first — outcome short-circuits cadence.
  if (state === 'replied') {
    return { action: 'done', state, family, leverage, daysSince, nextNudge: null,
      reason: 'They replied — hand off to a real conversation' };
  }
  if (state === 'declined') {
    return { action: 'cold', state, family, leverage, daysSince, nextNudge: null,
      reason: 'No path here — try a different contact' };
  }

  // The touch ceiling is the channel's base, lifted for a high-leverage contact:
  // a hiring manager who owns the req earns one more patient touch before cold.
  const max = touchCeiling(family, leverage);

  // 2. Hit the (leverage-adjusted) touch ceiling → go cold (don't pester).
  if (touches >= max) {
    const lev = leverage === 'manager'
      ? ' (already gave the hiring manager an extra touch)'
      : '';
    return { action: 'cold', state, family, leverage, daysSince, nextNudge: null,
      reason: `${touches} touches, no reply — switch angle or contact${lev}` };
  }

  // 3. Compute the next-nudge window. An accepted-but-silent connection
  //    switches to the message cadence (the request already landed; now it's
  //    about getting a reply). First touch uses the *_first window, later
  //    touches use *_subsequent.
  const effFamily = state === 'accepted' ? 'message' : family;
  const window = touches <= 1
    ? (effFamily === 'connection' ? CADENCE.connection_first : CADENCE.message_first)
    : (effFamily === 'connection' ? CADENCE.connection_subsequent : CADENCE.message_subsequent);

  const nextNudge = addDays(contact.lastTouch, window);

  // 4. Missing/garbage date → we can't schedule; flag for a nudge so it isn't
  //    silently lost.
  if (daysSince === null) {
    return { action: 'nudge', state, family, leverage, daysSince: null, nextNudge: null,
      reason: 'No valid last-touch date — review and re-send if needed' };
  }

  // 5. Due now vs scheduled.
  if (daysSince >= window) {
    const what = state === 'accepted'
      ? 'Connection accepted, no reply yet — send a value-add message'
      : (family === 'connection'
          ? 'Connection request still pending — nudge or try another contact'
          : 'No reply yet — follow up with a fresh angle');
    return { action: 'nudge', state, family, leverage, daysSince, nextNudge, reason: what };
  }
  return { action: 'waiting', state, family, leverage, daysSince, nextNudge,
    reason: `On track — next nudge ${nextNudge}` };
}

/**
 * Classify a whole list and return entries plus a rollup.
 *
 * Each entry carries a `leverage` tier (from the contact's Title) and a derived
 * `priority` number. The sort is two-level: first by action bucket (nudge >
 * waiting > cold > done — most actionable on top), then *within a bucket* by
 * priority — so among the due nudges, the hiring-manager thread (who can move
 * you forward) ranks above a low-leverage one, and the most-overdue breaks ties.
 * This makes the dashboard's top row the single most valuable next touch, which
 * is exactly what `daily-brief` wants when it folds outreach into its one-action
 * surface.
 *
 * @param {Array} contacts
 * @param {string} todayStr
 */
export function classifyAll(contacts, todayStr) {
  const entries = contacts.map((c) => {
    const r = classifyContact(c, todayStr);
    return { ...c, ...r, priority: nudgePriority(r) };
  });
  const counts = { nudge: 0, waiting: 0, cold: 0, done: 0 };
  for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;
  // Sort: most actionable bucket first, then by within-bucket priority.
  const order = { nudge: 0, waiting: 1, cold: 2, done: 3 };
  entries.sort((a, b) =>
    (order[a.action] - order[b.action]) ||
    (b.priority - a.priority) ||
    ((b.daysSince ?? -1) - (a.daysSince ?? -1)));
  return { entries, counts, actionable: counts.nudge };
}

/**
 * Priority score for ranking entries *within* an action bucket: leverage is the
 * dominant axis (the hiring manager's thread is the most valuable to act on),
 * and days-overdue breaks ties so a long-stale nudge edges out a just-due one at
 * equal leverage. Pure; only meaningful as a relative ordering key.
 */
export function nudgePriority(classified) {
  const lev = LEVERAGE_PRIORITY[classified.leverage] ?? LEVERAGE_PRIORITY.neutral;
  const overdue = Math.max(0, classified.daysSince ?? 0);
  // Leverage dominates (×100); overdue days are a bounded tie-breaker.
  return lev * 100 + Math.min(overdue, 99);
}

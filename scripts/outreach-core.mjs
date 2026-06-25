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
 *   - lastTouch  {string}  YYYY-MM-DD of the most recent touch
 *   - touches    {number}  how many times we've reached out (>=1)
 *   - outcome    {string}  free-text outcome the user logged
 * @param {string} todayStr  YYYY-MM-DD "today" (injected for testability)
 * @returns {object} { action, state, family, daysSince, nextNudge, reason }
 *   action ∈ {done, cold, nudge, waiting}
 */
export function classifyContact(contact, todayStr) {
  const family = channelFamily(contact.channel);
  const state = normalizeOutcome(contact.outcome);
  const touches = Number.isFinite(contact.touches) ? contact.touches : 1;

  const today = parseDate(todayStr);
  const last = parseDate(contact.lastTouch);
  const daysSince = today && last ? daysBetween(last, today) : null;

  // 1. Terminal states first — outcome short-circuits cadence.
  if (state === 'replied') {
    return { action: 'done', state, family, daysSince, nextNudge: null,
      reason: 'They replied — hand off to a real conversation' };
  }
  if (state === 'declined') {
    return { action: 'cold', state, family, daysSince, nextNudge: null,
      reason: 'No path here — try a different contact' };
  }

  const max = family === 'connection' ? CADENCE.connection_max : CADENCE.message_max;

  // 2. Hit the touch ceiling → go cold (don't pester).
  if (touches >= max) {
    return { action: 'cold', state, family, daysSince, nextNudge: null,
      reason: `${touches} touches, no reply — switch angle or contact` };
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
    return { action: 'nudge', state, family, daysSince: null, nextNudge: null,
      reason: 'No valid last-touch date — review and re-send if needed' };
  }

  // 5. Due now vs scheduled.
  if (daysSince >= window) {
    const what = state === 'accepted'
      ? 'Connection accepted, no reply yet — send a value-add message'
      : (family === 'connection'
          ? 'Connection request still pending — nudge or try another contact'
          : 'No reply yet — follow up with a fresh angle');
    return { action: 'nudge', state, family, daysSince, nextNudge, reason: what };
  }
  return { action: 'waiting', state, family, daysSince, nextNudge,
    reason: `On track — next nudge ${nextNudge}` };
}

/**
 * Classify a whole list and return entries plus a rollup.
 * @param {Array} contacts
 * @param {string} todayStr
 */
export function classifyAll(contacts, todayStr) {
  const entries = contacts.map((c) => ({ ...c, ...classifyContact(c, todayStr) }));
  const counts = { nudge: 0, waiting: 0, cold: 0, done: 0 };
  for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;
  // Sort so the most actionable float to the top.
  const order = { nudge: 0, waiting: 1, cold: 2, done: 3 };
  entries.sort((a, b) => (order[a.action] - order[b.action]) || ((b.daysSince ?? -1) - (a.daysSince ?? -1)));
  return { entries, counts, actionable: counts.nudge };
}

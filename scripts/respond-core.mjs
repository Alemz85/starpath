/**
 * respond-core.mjs — pure logic for the `respond` mode (recruiter-reply drafting).
 *
 * When a recruiter replies to an application, the message usually bundles a few
 * concrete asks: screening questions ("why us?", "years in X"), the awkward ones
 * (comp expectations, notice period / availability), scheduling, a take-home, or
 * a soft rejection. The `respond` mode drafts a strong, specific reply grounded
 * in the candidate's own files — but to do that well it first has to *classify*
 * what's actually being asked, so it can route each ask to the right framing and
 * the right source file.
 *
 * This module owns that classification plus the comp/availability framing math.
 * Everything here is pure: no filesystem, no network, no clock (the caller passes
 * any "today" it needs), no input mutation. The agent (modes/respond.md) owns
 * reading user/* and the story bank; this module owns *what a recruiter message
 * means* and *how to frame the numbers*. Mirrors the extract-then-test pattern of
 * outreach-core.mjs and lib/story-bank.mjs.
 *
 * SYSTEM-LAYER HYGIENE: no candidate specifics live here. Comp framing takes the
 * candidate's target/floor as arguments (the caller reads them from
 * user/profile.yml at runtime); this file only knows how to *phrase* a range it
 * is handed, never a particular number.
 */

/* ───── ask taxonomy ─────────────────────────────────────────────────────────
 *
 * The canonical set of asks a recruiter reply can contain. A single message
 * routinely carries several (e.g. "loved your profile — what are your comp
 * expectations, and when could you start? happy to set up a call next week").
 * Each id has a `handling` note the mode uses to pick the framing, and an
 * ordered list of regex cues. Cues are intentionally broad-but-shallow: this is
 * a router, not an NLU engine — the agent reads the full message too.
 */
export const ASK_TYPES = [
  {
    id: 'comp',
    label: 'Compensation expectations',
    // The single most-fumbled ask. Frame from profile targets, anchor a range,
    // never blurt a single number, never go below the floor.
    handling: 'comp',
  },
  {
    id: 'availability',
    label: 'Availability / notice period / start date',
    handling: 'availability',
  },
  {
    id: 'scheduling',
    label: 'Scheduling a call / interview',
    handling: 'scheduling',
  },
  {
    id: 'takehome',
    label: 'Take-home assignment / assessment',
    handling: 'takehome',
  },
  {
    id: 'screening',
    label: 'Screening question (why us / fit / experience)',
    handling: 'screening',
  },
  {
    id: 'logistics',
    label: 'Logistics (CV, references, links, work authorization)',
    handling: 'logistics',
  },
  {
    id: 'rejection',
    label: 'Rejection / not moving forward',
    handling: 'decline_gracefully',
  },
];

const ASK_IDS = new Set(ASK_TYPES.map((a) => a.id));

// Cue patterns per ask id. Order within an id doesn't matter (any hit counts);
// `detectAsks` returns asks in ASK_TYPES order regardless of cue order.
const CUES = {
  comp: [
    /\bcomp(?:ensation)?\b/i,
    /\bsalary\b/i,
    /\bsalaries\b/i,
    /\bpay\b/i,
    /\bremuneration\b/i,
    /\bbase\b/i,
    /\bpackage\b/i,
    /\bday\s?rate\b/i,
    /\b(?:rate|rates) (?:for|you)\b/i,
    /\bexpectations? (?:around|on|for|regarding)?\s*(?:comp|salary|pay)?/i,
    /\bwhat (?:are|were) you (?:looking|hoping) (?:to|for)\b/i,
    /\bcurrent (?:salary|comp|package)\b/i,
    /\bband\b/i,
    /€|\$|£|\bk\s*[-–]\s*\d/i,
  ],
  availability: [
    /\bavailab/i,
    /\bnotice period\b/i,
    /\bnotice\b/i,
    /\bstart date\b/i,
    /\bwhen (?:could|can|would) you (?:start|begin|join)\b/i,
    /\bhow soon\b/i,
    /\bwhen are you (?:free|available)\b/i,
    /\bearliest start\b/i,
    /\bdate you (?:could|can) start\b/i,
  ],
  scheduling: [
    /\b(?:set up|schedule|book|arrange|jump on|hop on|grab)\b.*\b(?:call|chat|meeting|interview|time|slot)\b/i,
    /\bare you free\b/i,
    /\bwhat (?:times?|slots?) work\b/i,
    /\bcalendar\b/i,
    /\bcalendly\b/i,
    /\bavailability (?:this|next) week\b/i,
    /\b(?:15|20|30|45|60)[ -]?min(?:ute)?s?\b/i,
    /\bgive (?:me )?a call\b/i,
    /\bphone screen\b/i,
  ],
  takehome: [
    /\btake[ -]?home\b/i,
    /\bassignment\b/i,
    /\bassessment\b/i,
    /\bcase study\b/i,
    /\bexercise\b/i,
    /\bcoding (?:test|challenge)\b/i,
    /\btest task\b/i,
    /\bcomplete (?:the|a|this) (?:task|challenge|test)\b/i,
  ],
  screening: [
    /\bwhy (?:do you want to|are you interested|us|this (?:role|company|position))\b/i,
    /\btell me (?:about|more)\b/i,
    /\bwhat (?:interests|excites|draws) you\b/i,
    /\bwhy (?:are you )?(?:looking|leaving)\b/i,
    /\bhow many years\b/i,
    /\byears of experience\b/i,
    /\bexperience (?:with|in)\b/i,
    /\bwalk me through\b/i,
    /\bwhat (?:do you know|makes you)\b/i,
    /\bare you familiar with\b/i,
  ],
  logistics: [
    /\b(?:updated |latest )?(?:cv|resume|résumé)\b/i,
    /\breferences?\b/i,
    /\bportfolio\b/i,
    /\bgithub\b/i,
    /\blinkedin\b/i,
    /\b(?:work (?:authorization|permit|visa)|right to work|sponsorship|visa status)\b/i,
    /\bnationality\b/i,
    /\b(?:relocat|willing to move)/i,
    /\bremote (?:or )?(?:on[ -]?site|hybrid|office)\b/i,
    /\blocated\b/i,
    /\bwhere are you based\b/i,
  ],
  rejection: [
    /\bunfortunately\b/i,
    /\bnot (?:moving|move|proceeding|proceed|going) (?:forward|ahead)\b/i,
    /\bdecided (?:not|to) (?:proceed|move forward|go (?:in )?a different)\b/i,
    /\bdifferent (?:candidate|direction)\b/i,
    /\bnot (?:a|the right) (?:fit|match)\b/i,
    /\bwon'?t be (?:moving|proceeding)\b/i,
    /\bregret to (?:inform|tell)\b/i,
    /\bwill not be progressing\b/i,
    /\bother candidates?\b/i,
  ],
};

/* ───── detection ────────────────────────────────────────────────────────────*/

// Does a single ask id's cues fire on the text? Pure, case-insensitive.
function askMatches(id, text) {
  const cues = CUES[id] || [];
  return cues.some((re) => re.test(text));
}

// Classify a recruiter message into the asks it contains. Returns the matching
// ASK_TYPES entries in canonical order (so the drafted reply addresses comp →
// availability → scheduling → … predictably). A message with no recognized cue
// returns [] — the caller treats that as a free-form note to answer directly.
export function detectAsks(message) {
  const text = String(message || '');
  if (!text.trim()) return [];
  return ASK_TYPES.filter((a) => askMatches(a.id, text));
}

// Convenience: just the ids, canonical order.
export function detectAskIds(message) {
  return detectAsks(message).map((a) => a.id);
}

// Is this primarily a rejection? A rejection cue dominates the reply (you pivot
// to a graceful, door-open close) even if the same email also says "we'll keep
// your CV on file" (a logistics-ish cue). Used by the mode to switch templates.
export function isRejection(message) {
  return askMatches('rejection', String(message || ''));
}

/* ───── comp framing ─────────────────────────────────────────────────────────
 *
 * The comp ask is where candidates lose money. The rules baked in here:
 *   - Always answer with a *range*, never a single point (a point caps you).
 *   - Anchor the bottom of the range at-or-above the candidate's target, not at
 *     their floor — you negotiate down from an anchor, never up from a floor.
 *   - Never state a number below the walk-away floor.
 *   - If the candidate has no target on file, DON'T invent one — defer the ask
 *     politely and ask for the band instead.
 *
 * `target` and `floor` are whatever the caller parsed from user/profile.yml
 * (numbers, or a "55k"/"55000" string). This function only decides the *shape*
 * of the answer, not the currency or magnitude.
 */

// Parse a comp value that may be a number, a "55k"/"55K" string, or a plain
// "55000" string into a number. Returns null if it can't.
export function parseCompNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  // Grab the first number, honoring a trailing k/K thousands suffix and
  // thousands separators (commas/dots/spaces) inside the digits.
  const m = s.match(/(\d[\d.,\s]*)\s*([kK])?/);
  if (!m) return null;
  const digits = m[1].replace(/[,\s]/g, '').replace(/\.(?=\d{3}\b)/g, '');
  let n = parseFloat(digits);
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1000;
  return n;
}

// Build the recommended anchor range from a target and (optional) floor.
// Returns { ok, low, high, reason }:
//   - low  = the bottom of the range you state (anchored at target, clamped up
//            to the floor if target < floor — never below walk-away).
//   - high = top of the range (target * spreadHigh, a confident anchor).
// `ok:false` with a `reason` when there's no usable target — the mode then
// defers the ask instead of guessing.
export function compRange(target, floor, { spreadHigh = 1.15, minSpread = 1.08 } = {}) {
  const t = parseCompNumber(target);
  const f = parseCompNumber(floor);
  if (t == null) {
    return { ok: false, reason: 'no target comp on file', low: null, high: null };
  }
  // Anchor low at the target; if a floor is higher than the target (mis-set or
  // a recently-raised floor), respect the floor as the hard minimum.
  let low = t;
  if (f != null && f > low) low = f;
  let high = Math.round(t * spreadHigh);
  // Guarantee a non-degenerate spread so the "range" is actually a range.
  if (high <= low) high = Math.round(low * minSpread);
  return { ok: true, low: Math.round(low), high, reason: null };
}

/* ───── comp DISCLOSURE vs. comp QUESTION ─────────────────────────────────────
 *
 * The comp ask has two opposite shapes that need opposite replies, and the bare
 * cue list above can't tell them apart:
 *
 *   QUESTION   — "what are your salary expectations?" → the candidate states a
 *                range (compRange): anchor at target, never below floor.
 *   DISCLOSURE — "the band for this role is €55–65k" / "we're budgeting 60k" →
 *                the RECRUITER put a number on the table. The candidate doesn't
 *                answer with their own range; they EVALUATE the number against
 *                their floor/target and react: accept warmly (at/above target),
 *                engage but anchor up (between floor and target), or push back /
 *                surface the floor (below floor). Replying to a disclosure as if
 *                it were a question — blurting your own range over a number
 *                already on the table — wastes the anchor they just handed you.
 *
 * detectCompDisclosure pulls the number(s) the recruiter stated. It only fires
 * when a comp CONTEXT word is near a figure (so "we have 200 engineers" or "by
 * the 15th" doesn't read as comp) AND a disclosure phrasing is present (so a
 * bare question like "can you do 60k?" doesn't read as a firm offer).
 */

// Currency/figure token: €55k, $60,000, 55k, 55.000, 55-65k, 55 000.
const FIGURE_RE = /(?:[€$£]\s?)?(\d[\d.,\s]*\d|\d)\s*([kK])?/g;
// Words near a figure that mark it as compensation (vs. headcount, dates, etc.).
const COMP_CONTEXT_RE =
  /\b(?:comp(?:ensation)?|salary|salaries|pay|package|budget(?:ed|ing)?|band|range|base|offer(?:ing)?|remuneration|total|ote|on[- ]target|day\s?rate|gross|annual|per\s?(?:year|annum|month)|€|\$|£)\b/i;
// Phrasings that mark the recruiter as DISCLOSING a number, not asking for one.
const DISCLOSURE_CUE_RE =
  /\b(?:budget(?:ed|ing)?|the\s+(?:band|range|salary|comp(?:ensation)?|package|base)|(?:we|this role|the role|it)\s*(?:can\s+)?(?:pay|pays|offers?|is\s+offering|starts?\s+at|sits?\s+at)|paying|offering|range\s*(?:is|of|from|sits)|band\s*(?:is|of|sits)|comp(?:ensation)?\s*(?:is|of|for\s+this)|salary\s*(?:is|of|for\s+this|range)|up\s+to|between)\b/i;

// A "N–M k" / "N to M k" band shares one magnitude suffix across both ends:
// "55-65k" means 55k–65k, not 55 and 65000. The figure scanner alone can't see
// that (the trailing k is glued only to the second number), so we first expand
// any such range to give BOTH numbers the suffix, e.g. "55-65k" → "55k-65k".
const COMP_RANGE_RE =
  /(?<![\d.,])(\d[\d.,\s]*\d|\d)\s*(?:[-–—]|to)\s*(\d[\d.,\s]*\d|\d)\s*([kK])\b/g;
function expandSharedKSuffix(text) {
  return String(text || '').replace(COMP_RANGE_RE, (full, a, b, k) => `${a}${k}-${b}${k}`);
}

// Extract every comp figure from text, in document order, as numbers.
// Used by detectCompDisclosure to capture a single number or a "55–65k" band.
export function extractCompFigures(text) {
  const s = expandSharedKSuffix(text);
  const out = [];
  let m;
  FIGURE_RE.lastIndex = 0;
  while ((m = FIGURE_RE.exec(s)) !== null) {
    const raw = m[0];
    const idx = m.index;
    const hasCurrencyGlued = /[€$£]/.test(raw) || !!m[2]; // €/$/£ on it, or a k-suffix
    // Window around the figure to test for a comp context word nearby.
    const window = s.slice(Math.max(0, idx - 24), idx + raw.length + 14);
    if (!hasCurrencyGlued && !COMP_CONTEXT_RE.test(window)) continue;
    const n = parseCompNumber(raw);
    if (n == null) continue;
    // A bare integer below 1000 with no k/currency cue is almost never a salary
    // ("200 engineers", "by 2026" already filtered, but guard low magnitudes).
    if (!hasCurrencyGlued && n < 1000) continue;
    out.push(n);
  }
  return out;
}

/**
 * Detect whether the recruiter DISCLOSED a comp number (vs. asked for one).
 * Returns { disclosed:boolean, figures:number[], low:number|null, high:number|null }.
 * `disclosed` is true only when a disclosure phrasing co-occurs with at least one
 * comp figure. A pure question ("what are your expectations?") returns
 * disclosed:false even though it's a comp ask — the two are handled differently.
 */
export function detectCompDisclosure(message) {
  const text = String(message || '');
  if (!text.trim()) return { disclosed: false, figures: [], low: null, high: null };
  const figures = extractCompFigures(text);
  if (!figures.length) return { disclosed: false, figures: [], low: null, high: null };
  if (!DISCLOSURE_CUE_RE.test(text)) {
    return { disclosed: false, figures, low: null, high: null };
  }
  const low = Math.min(...figures);
  const high = Math.max(...figures);
  return { disclosed: true, figures, low, high };
}

/**
 * Evaluate a comp number (or band) the recruiter disclosed against the
 * candidate's target + floor, and return the reply posture. Pure.
 *
 * Accepts either a disclosure object ({ low, high } from detectCompDisclosure)
 * or a single number/string. `target` and `floor` are whatever the caller parsed
 * from user/profile.yml.
 *
 *   verdict ∈ {
 *     below_floor          — top of the disclosed band is under the walk-away
 *                            floor: it doesn't clear the minimum.
 *     spans_floor          — band straddles the floor (low < floor ≤ high):
 *                            workable only at the top; anchor to the upper half.
 *     below_target         — clears the floor but tops out under target: engage,
 *                            but anchor up toward target on the full package.
 *     at_or_above_target   — meets/exceeds target: accept warmly, light note that
 *                            the final number depends on scope.
 *   }
 *
 * `ok:false` when there's no number to evaluate, or no floor/target on file to
 * judge against (the caller then just acknowledges the number without a posture).
 */
export function evaluateCompOffer(disclosed, target, floor) {
  let low = null;
  let high = null;
  if (disclosed && typeof disclosed === 'object') {
    low = parseCompNumber(disclosed.low);
    high = parseCompNumber(disclosed.high);
  } else {
    low = parseCompNumber(disclosed);
    high = low;
  }
  if (low == null && high == null) {
    return { ok: false, verdict: null, reason: 'no disclosed number to evaluate' };
  }
  if (low == null) low = high;
  if (high == null) high = low;
  if (low > high) { const tmp = low; low = high; high = tmp; }

  const t = parseCompNumber(target);
  const f = parseCompNumber(floor);
  if (t == null && f == null) {
    return { ok: false, verdict: null, reason: 'no target/floor on file to judge against', low, high };
  }

  let verdict;
  if (f != null && high < f) {
    verdict = 'below_floor';
  } else if (f != null && low < f && high >= f) {
    verdict = 'spans_floor';
  } else if (t != null && high < t) {
    verdict = 'below_target';
  } else {
    // Meets/beats target, or floor is cleared with no target on file.
    verdict = 'at_or_above_target';
  }
  return { ok: true, verdict, low, high, target: t, floor: f, reason: null };
}

// Plain-words handling for each disclosure verdict — the mode expands this into
// prose. Keeps the *posture* deterministic while the words stay grounded in the
// candidate's files.
export const COMP_OFFER_HANDLING = {
  below_floor:
    "The disclosed number is under the candidate's walk-away floor. Don't reject " +
    'outright in the first reply: warmly note the band is below what they can ' +
    'consider, state the floor as total comp, and ask whether there is any ' +
    'flexibility on the package. If there is none, this is a graceful decline.',
  spans_floor:
    'The disclosed band straddles the floor — only the top is workable. Express ' +
    'genuine interest, then anchor explicitly to the upper end and frame the ' +
    "candidate's floor as the realistic starting point, citing fit.",
  below_target:
    'The number clears the floor but lands under target. Stay engaged and ' +
    'positive; anchor up toward the target on the basis of scope/fit, and note ' +
    'that total comp (not just base) is what matters. Do not accept the figure as final.',
  at_or_above_target:
    'The number meets or beats target. Respond warmly and confirm strong fit; ' +
    'keep a light note that the final figure depends on the full scope/level so ' +
    'you preserve room without haggling over an already-good offer.',
};

/* ───── reply URGENCY (a deadline raises a reply to the top of the pipeline) ───
 *
 * Thrust #4 of the funnel is response *rate* and *speed*: a fast, well-framed
 * reply beats a slow one. A recruiter message often carries a soft or hard
 * deadline ("can you get back to me by Friday?", "the role closes Monday",
 * "we're moving quickly"). detectUrgency flags those so the mode can tell the
 * user "this one is time-critical — reply today", and so a frontend could float
 * it above the rest. Pure; no clock needed — it reads the language, not a date.
 */
const URGENCY_CUE_RE =
  /\b(?:by\s+(?:end\s+of\s+(?:day|week)|eod|eow|cob|today|tomorrow|tonight|this\s+(?:week|afternoon|morning)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|asap|as\s+soon\s+as\s+possible|urgent(?:ly)?|time[- ]sensitive|moving\s+(?:quickly|fast)|closes?\s+(?:soon|on|this|tomorrow|today)|closing\s+(?:soon|date)|deadline|short\s+notice|right\s+away|get\s+back\s+to\s+(?:me|us)\s+(?:by|asap|today|soon)|quick\s+turnaround|within\s+\d+\s+(?:hours?|days?)|last\s+round\s+of)\b/i;

/**
 * Does the recruiter message imply a reply deadline / time pressure? Pure.
 * Returns { urgent:boolean, cue:string|null } — `cue` is the matched phrase so
 * the mode can echo *why* it's urgent ("they said 'by Friday'").
 */
export function detectUrgency(message) {
  const text = String(message || '');
  const m = text.match(URGENCY_CUE_RE);
  return { urgent: !!m, cue: m ? m[0] : null };
}

/* ───── per-ask drafting guidance ────────────────────────────────────────────
 *
 * Each ask id maps to a compact "how to answer" spec the agent expands into
 * real prose using user/* + the story bank. Keeping the *strategy* here (not the
 * prose) means every recruiter reply handles the awkward asks the same correct
 * way, while the actual words stay grounded in the candidate's own files.
 */
export const HANDLING = {
  comp:
    'Answer with a RANGE, never a single number. Anchor the bottom at-or-above ' +
    'the candidate target (compRange), state it as total comp, and add one ' +
    'flexibility clause ("for the right role / depending on the full package"). ' +
    'Never go below the floor. If no target on file, defer and ask for their band first.',
  availability:
    'State the real notice period / earliest start from user/profile.yml. If a ' +
    'known constraint exists (a program start window, an exchange/relocation), ' +
    'name it plainly and frame it as a fixed date, not an apology.',
  scheduling:
    'Say yes enthusiastically, then propose 2–3 concrete windows (or point to a ' +
    'scheduling link if the candidate has one). Confirm timezone. Do not commit ' +
    'to an exact slot the user has not approved.',
  takehome:
    'Accept positively, confirm scope + deadline + expected effort in writing, ' +
    'and ask the one clarifying question that de-risks the work. Flag to the ' +
    'user if the effort looks disproportionate (unpaid multi-day) so they decide.',
  screening:
    'Answer with ONE specific, quantified proof point from the story bank / ' +
    'user/cv.md — not a generic value statement. Tie it to this role/company ' +
    'using the report context if a report exists. Lead with the number.',
  logistics:
    'Answer factually from user/profile.yml + user/cv.md (location, work ' +
    'authorization, links). Attach/offer the latest CV. Keep it to the fact ' +
    'asked — do not volunteer more than the recruiter needs.',
  decline_gracefully:
    'Thank them genuinely, keep the door open (express interest in future ' +
    'roles), ask for one piece of feedback if appropriate, and stay warm. No ' +
    'arguing the decision. This contact may surface a better-fit role later.',
};

// Resolve the handling guidance for an ask id (or the rejection handling).
export function handlingFor(askId) {
  if (askId === 'rejection') return HANDLING.decline_gracefully;
  if (ASK_IDS.has(askId)) {
    const ask = ASK_TYPES.find((a) => a.id === askId);
    return HANDLING[ask.handling] || null;
  }
  return null;
}

/* ───── reply plan ───────────────────────────────────────────────────────────*/

// Build the comp step for the plan. If the recruiter DISCLOSED a number, the
// step routes to disclosure-evaluation guidance (evaluate against floor/target,
// don't blurt your own range) and carries the parsed figures so the wrapper can
// echo them; otherwise it's the normal "state your range" question handling.
function buildCompStep(message) {
  const disc = detectCompDisclosure(message);
  if (disc.disclosed) {
    return {
      id: 'comp',
      label: 'Compensation — recruiter disclosed a number (evaluate, don’t over-ask)',
      handling:
        'The recruiter put a figure on the table — do NOT answer with your own ' +
        'range as if asked. Run evaluateCompOffer(disclosure, target, floor) and ' +
        'follow the verdict’s posture (COMP_OFFER_HANDLING): accept warmly ' +
        'at/above target, anchor up if it clears the floor but lands under target, ' +
        'surface the floor if it’s below. Read target/floor from user/profile.yml.',
      compDisclosure: { low: disc.low, high: disc.high, figures: disc.figures },
    };
  }
  return { id: 'comp', label: 'Compensation expectations', handling: HANDLING.comp };
}

// Build an ordered, deduped plan for replying to a message: one step per
// detected ask, each carrying its label + handling guidance. A rejection
// short-circuits to a single graceful-decline step (you don't "also answer the
// comp question" in a rejection reply). An empty message / no cues yields a
// single 'freeform' step telling the agent to answer the message directly.
//
// Every plan also carries `urgency: { urgent, cue }` so a time-sensitive reply
// ("by Friday", "ASAP") floats to the top — speed is part of response rate.
export function buildReplyPlan(message) {
  const text = String(message || '');
  const urgency = detectUrgency(text);
  if (isRejection(text)) {
    return {
      kind: 'rejection',
      urgency,
      steps: [
        { id: 'rejection', label: 'Graceful decline + door open', handling: HANDLING.decline_gracefully },
      ],
    };
  }
  const asks = detectAsks(text);
  if (asks.length === 0) {
    return {
      kind: 'freeform',
      urgency,
      steps: [
        {
          id: 'freeform',
          label: 'Answer the message directly',
          handling:
            'No standard ask detected. Read the message and answer its actual ' +
            'question(s) grounded in user/cv.md + the story bank. Stay specific.',
        },
      ],
    };
  }
  return {
    kind: 'reply',
    urgency,
    steps: asks.map((a) =>
      a.id === 'comp'
        ? buildCompStep(text)
        : { id: a.id, label: a.label, handling: HANDLING[a.handling] },
    ),
  };
}

/* ───── status suggestion ─────────────────────────────────────────────────────
 *
 * `respond` shares the pipeline with the rest of the system. A recruiter reply
 * is a status signal: the application should move to `Responded` (and an
 * `Interview` once a screen / take-home is scheduled). This returns the
 * canonical status the mode SUGGESTS — it never writes; the mode stops for
 * review before any writeback, per the Ethical Use contract. Statuses match
 * templates/states.yml.
 */
export function suggestedStatus(message) {
  const text = String(message || '');
  if (isRejection(text)) return 'Rejected';
  const ids = new Set(detectAskIds(text));
  // A scheduled call / take-home means the process is actively moving.
  if (ids.has('scheduling') || ids.has('takehome')) return 'Interview';
  // Any other recruiter reply means they responded.
  return 'Responded';
}

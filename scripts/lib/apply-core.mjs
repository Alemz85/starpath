// apply-core.mjs — pure answer-drafting logic for modes/apply.md.
//
// `apply.md` is the conversion-critical mode: a candidate is on a live
// application form and the agent drafts an answer for every question. The mode
// prose (Step 4 + Step 5) describes three things that are *mechanical* and
// shouldn't be re-eyeballed per question across a 10-field form:
//
//   1. CLASSIFY each question to its drafting recipe (the Step 4 table) — is this
//      a logistics field, a behavioral "tell me about a time", a motivation /
//      fit prompt, or a long-form cover letter? The recipe decides the source and
//      shape; mis-classifying is how you get a mini-cover-letter in a salary box.
//   2. SELF-CHECK each drafted answer against the Step 5G gate — does it cite a
//      verifiable concrete, does it trip a hard-banned phrase, is it within the
//      target length, did the salary walk-away leak?
//   3. Across the WHOLE form, don't reuse the same proof point twice (Step 5D) —
//      a form that repeats the same capstone in every answer reads as a one-note
//      profile. That's a *session* property; it can only be tracked across answers.
//
// This module owns exactly that deterministic layer and is pure: no I/O, no
// globals, no clock, no input mutation. The agent still does the *writing* (turn
// a story into prose, pick the proof point, phrase the framing); this module
// turns the agent's structured findings into a consistent verdict so the quality
// bar is the same on question 1 and question 10. Mirrors the extract-then-test
// pattern of lib/apply-kit-core.mjs and lib/mock-interview-core.mjs.
//
// ── COMPOSES WITH WHAT ROUNDS 1–2 BUILT ─────────────────────────────────────
// It does NOT duplicate the competency taxonomy or the question→story ranker —
// those live in lib/story-bank.mjs (the single source apply.md, interview-prep.md
// and mock-interview-core.mjs already share). For behavioral questions it reuses
// the SAME competency inference mock-interview-core exposes, so a question
// classified here maps to a story exactly as it would in mock-interview.
//
// ── NO HARDCODED USER DATA (CLAUDE.md § System Layer Hygiene) ────────────────
// The banned-phrase list and the question-type signals are universal application-
// craft material — recruiter-fatigue clichés and generic form-field wording. They
// name no company, school, person, city, metric or archetype. Everything
// candidate-specific (the actual proof points, the comp numbers, the visa status)
// is PASSED IN by the caller, read from user/* at runtime. A different candidate
// gets different concretes and different reuse warnings from the same code.

import { inferCompetency } from './mock-interview-core.mjs';

/* ───── question type → drafting recipe (modes/apply.md Step 4 table) ──────── */
//
// Every form question is classified to exactly ONE recipe by the first signal it
// matches, walked top to bottom. The order encodes the mode's "logística primero"
// rule: a field asking for a fact (comp, date, visa) is logistics even when it's
// wrapped in prose — it must NOT become a mini-cover-letter. Each recipe records
// the source the agent should draw from and the Step 5 sub-recipe id, so the
// classification *is* the routing.

export const RECIPES = {
  logistics: {
    id: 'logistics',
    recipe: '5F',
    label: 'Logistics (comp / availability / authorization)',
    source: 'user/profile.yml (compensation, visa_status, location) + user/_profile.md',
    shape: 'factual, one sentence, no fluff',
  },
  behavioral: {
    id: 'behavioral',
    recipe: '5A',
    label: 'Behavioral ("tell me about a time…")',
    source: 'story bank — STAR+R story whose competency matches',
    shape: '4–7 sentences, Action+Result carry the weight',
  },
  coverletter: {
    id: 'coverletter',
    recipe: '5C',
    label: 'Cover letter / long free text',
    source: 'exit narrative + strongest STAR+R story + report fingerprint',
    shape: '4-move structure, ~250–350 words',
  },
  motivation: {
    id: 'motivation',
    recipe: '5B',
    label: 'Motivation ("why us / why this role")',
    source: 'exit narrative (user/_profile.md) + one concrete fact about this company/JD',
    shape: '3–5 sentences, one company-specific concrete',
  },
  fit: {
    id: 'fit',
    recipe: '5B',
    label: 'Fit ("why are you a good fit")',
    source: 'report dimensional table (strongest dim) + one quantified proof point',
    shape: '3–5 sentences, lead with strongest dimension + one proof point',
  },
};

// Signal tables, walked in order. Each entry: a recipe id + the regexes that fire
// it. Kept as word-ish patterns so "salary" matches but "salaried role" context
// still lands logistics (it's asking a fact). Tuned to the mode's worked signals.
const LOGISTICS_SIGNALS = [
  /\bwork\s+authoriz/i, /\bauthoriz(ed|ation)\s+to\s+work/i, /\blegally\s+(?:authorized|allowed|entitled)\s+to\s+work/i,
  /\bvisa\b/i, /\bsponsor(ship|ed)?\b/i, /\brelocat/i, /\bnotice\s+period\b/i,
  /\bstart\s+date\b/i, /\bavailab(le|ility)\b/i, /\bsalary\b/i, /\bcompensation\b/i,
  /\bexpected\s+(?:pay|comp|salary)/i, /\bdesired\s+(?:salary|comp)/i, /\bpay\s+expectation/i,
  /\bwilling\s+to\s+relocate\b/i, /\bon[- ]?site\b/i, /\bhybrid\b/i, /\bremote\b/i,
  /\bhow\s+did\s+you\s+hear\b/i, /\bare\s+you\s+(?:able|willing)\s+to\b/i,
];
const BEHAVIORAL_SIGNALS = [
  /\btell\s+me\s+about\s+a\s+time\b/i, /\bdescribe\s+a\s+(?:time|situation|project|challenge)\b/i,
  /\bgive\s+(?:me\s+)?an\s+example\b/i, /\bhow\s+did\s+you\s+handle\b/i, /\bhow\s+do\s+you\s+(?:handle|deal\s+with)\b/i,
  /\ba\s+(?:time|situation)\s+(?:when|where)\b/i, /\bwalk\s+me\s+through\s+a\s+time\b/i,
  /\btell\s+us\s+about\s+(?:a\s+time|an?\s+example)\b/i,
  // Common behavioral openers that name the *competency* instead of "a time".
  /\btell\s+(?:me|us)\s+about\s+(?:a|an|your)\s+(?:failure|mistake|conflict|disagreement|challenge|weakness|achievement|accomplishment|success)\b/i,
  /\b(?:your|a)\s+(?:biggest|greatest|proudest)\s+(?:failure|mistake|achievement|accomplishment|weakness|strength|challenge)\b/i,
  /\bwhat\s+(?:is|was)\s+(?:your|a)\s+(?:biggest|greatest)\s+(?:failure|weakness|strength|achievement)\b/i,
];
const MOTIVATION_SIGNALS = [
  /\bwhy\s+(?:do\s+you\s+(?:want|wish)|are\s+you\s+interested)\b/i, /\bwhy\s+(?:this|our)\s+(?:role|company|team|position)\b/i,
  /\bwhy\s+do\s+you\s+want\s+to\s+(?:work|join)\b/i, /\bwhat\s+(?:attracts|draws|excites)\s+you\b/i,
  /\bwhy\s+us\b/i, /\bwhy\s+(?:would\s+you\s+(?:like|want)|join)\b/i, /\binterest(?:ed)?\s+in\s+(?:this|the)\s+(?:role|position|company)\b/i,
];
const FIT_SIGNALS = [
  /\bwhy\s+are\s+you\s+a\s+(?:good|great|strong)\s+fit\b/i, /\bwhat\s+makes\s+you\s+(?:qualified|a\s+good\s+fit)\b/i,
  /\bwhy\s+should\s+we\s+(?:hire|consider)\s+you\b/i, /\bwhat\s+(?:would\s+you\s+bring|do\s+you\s+bring)\b/i,
  /\byour\s+strengths\s+for\s+this\b/i, /\bwhat\s+qualif/i,
];
// A long free-text / cover-letter field is recognised by an explicit label.
const COVERLETTER_SIGNALS = [
  /\bcover\s+letter\b/i, /\banything\s+else\s+you'?d?\s+like\s+(?:us\s+)?to\s+know\b/i,
  /\bin\s+your\s+own\s+words\b/i, /\btell\s+us\s+about\s+yourself\b/i,
];

function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify a single form question to its drafting recipe.
 *
 * Walks the Step 4 table in order: logistics first (a fact wrapped in prose is
 * still a fact), then behavioral, motivation, fit, then a cover-letter label.
 * A field with a long character limit and no other signal defaults to
 * cover-letter; everything else defaults to `motivation`-style short prose with
 * `defaulted: true` flagged so the agent knows the classification was a fallback.
 *
 * For behavioral questions it attaches the inferred competency (via the shared
 * story-bank taxonomy) so the caller can match a story without re-inferring.
 *
 *   classifyQuestion("Tell me about a time you led without authority", { charLimit })
 *     → { type, recipe, label, source, shape, competency, defaulted, secondary }
 *
 * `secondary` is set when a SECOND distinct recipe also fires (a compound field
 * like "why this role and what's your biggest strength") — the mode's rule is to
 * answer both moves, not pick one. It's the second-matching recipe id, or null.
 *
 * @param {string} text       the question / field label
 * @param {object} [opts]     { charLimit?:number }  visible character limit, if any
 */
export function classifyQuestion(text, opts = {}) {
  const q = String(text || '').trim();
  const charLimit = Number.isFinite(opts.charLimit) ? opts.charLimit : null;

  // Which recipes fire, in table order. The FIRST is the primary; a later
  // distinct one (different recipe id) becomes the secondary (compound field).
  const fired = [];
  const push = (id) => { if (!fired.includes(id)) fired.push(id); };
  if (anyMatch(LOGISTICS_SIGNALS, q)) push('logistics');
  if (anyMatch(BEHAVIORAL_SIGNALS, q)) push('behavioral');
  if (anyMatch(COVERLETTER_SIGNALS, q)) push('coverletter');
  if (anyMatch(MOTIVATION_SIGNALS, q)) push('motivation');
  if (anyMatch(FIT_SIGNALS, q)) push('fit');

  let type;
  let defaulted = false;
  if (fired.length > 0) {
    type = fired[0];
  } else if (charLimit != null && charLimit >= 600) {
    // A big text box with no recognizable prompt → treat as a cover-letter field.
    type = 'coverletter';
    defaulted = true;
  } else {
    // Unknown short field → default to the motivation recipe (concise, specific).
    type = 'motivation';
    defaulted = true;
  }

  // A secondary recipe makes it a compound field: distinct from the primary, and
  // not the cover-letter container (cover-letter already folds the others in).
  const secondary = fired.find((id) => id !== type && id !== 'coverletter') || null;

  const meta = RECIPES[type];
  const out = { ...meta, type, defaulted, secondary };
  // Behavioral → infer the competency from the shared taxonomy so the caller can
  // pull the right story without re-classifying.
  out.competency = type === 'behavioral' ? inferCompetency(q) : null;
  return out;
}

/* ───── hard-banned phrases (modes/apply.md Step 5D) ───────────────────────── */
//
// The recruiter-fatigue clichés the mode bans outright. Universal application-
// craft, not user data. Matched case-insensitively as whole-ish phrases so
// "passionate" inside a real sentence ("I'm passionate about distributed systems")
// still trips — the ban is on the empty-signal phrase, and the mode's intent is
// that EVERY claim be backed by a concrete, so we flag and let the agent rewrite.

export const BANNED_PHRASES = [
  'passionate about',
  'fast-paced environment',
  'team player',
  'hit the ground running',
  'wear many hats',
  'wears many hats',
  'results-driven',
  'results driven',
  'think outside the box',
  'thinking outside the box',
  'synergy',
  'synergies',
  'i would be a great fit',
  "i'd be a great fit",
  'i believe i would be a great fit',
  'i believe i am a great fit',
  'i am a great fit',
  'great opportunity to grow',
  'detail-oriented',
  'detail oriented',
  'go-getter',
  'self-starter',
  'self starter',
  'dynamic environment',
  'i look forward to hearing from you',
];

/**
 * Scan an answer for hard-banned phrases. Returns the list of banned phrases
 * found (lowercased, de-duplicated, in first-appearance order). Empty = clean.
 *
 * Matching is substring + case-insensitive. We sort the phrase list longest-first
 * so a more specific phrase ("i believe i would be a great fit") is preferred and
 * its shorter sub-phrases ("i would be a great fit") aren't double-reported.
 */
export function scanForBannedPhrases(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return [];
  const found = [];
  const phrases = [...BANNED_PHRASES].sort((a, b) => b.length - a.length);
  let scratch = hay;
  for (const p of phrases) {
    if (scratch.includes(p)) {
      found.push(p);
      // Blank out the matched span so a contained shorter phrase doesn't re-fire.
      scratch = scratch.split(p).join(' '.repeat(p.length));
    }
  }
  // Report in the order they appear in the original text, not phrase-length order.
  return found.sort((a, b) => hay.indexOf(a) - hay.indexOf(b));
}

/* ───── verifiable-concrete detection (modes/apply.md Step 5D / 5G gate 1) ──── */
//
// Every answer must cite ≥1 verifiable concrete: a number, OR a proper noun the
// candidate actually owns (a project / company / tool from their CV), OR a line
// from the JD. The agent supplies the candidate's proof-vocabulary (tokens from
// user/cv.md / article-digest) and the JD vocabulary; this checks the answer
// against them. A number is always a concrete. We deliberately do NOT hardcode any
// candidate term — the vocabulary is passed in.

// A token that looks like a metric/number/quantity. Catches "20%", "$1.2M",
// "3x", "from 12 to 75", plain integers, and ranges.
const NUMERIC = /(\$?\d[\d,.]*\s*(?:%|k|m|bn|x|×|\+)?\b)|(\b\d+\s*(?:to|–|-|→)\s*\d+\b)/i;

function hasNumber(text) {
  return NUMERIC.test(String(text || ''));
}

// Tokenize to lowercase word-ish units for vocabulary matching.
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\-\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Does the answer cite at least one verifiable concrete?
 *
 *   hasConcrete(answer, { proofVocab, jdVocab })
 *     → { ok, via, matched }
 *
 *   via      — 'number' | 'proof' | 'jd' | null  (what satisfied it)
 *   matched  — the concrete that satisfied it (the matched vocab token), or null
 *
 * Order of evidence: a number always counts; else a proof-vocab token (a CV
 * proper noun / metric word the candidate owns); else a JD-vocab token (shows the
 * answer is anchored to this role). `proofVocab` / `jdVocab` are arrays of tokens
 * the caller extracted from user/* and the JD — never hardcoded here.
 */
export function hasConcrete(text, { proofVocab = [], jdVocab = [] } = {}) {
  const ans = String(text || '');
  if (!ans.trim()) return { ok: false, via: null, matched: null };
  if (hasNumber(ans)) {
    const m = ans.match(NUMERIC);
    return { ok: true, via: 'number', matched: m ? m[0].trim() : null };
  }

  const ansWords = new Set(words(ans));
  const lower = ans.toLowerCase();
  const norm = (arr) => (arr || []).map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);

  for (const t of norm(proofVocab)) {
    if (ansWords.has(t) || (t.includes(' ') && lower.includes(t))) {
      return { ok: true, via: 'proof', matched: t };
    }
  }
  for (const t of norm(jdVocab)) {
    if (ansWords.has(t) || (t.includes(' ') && lower.includes(t))) {
      return { ok: true, via: 'jd', matched: t };
    }
  }
  return { ok: false, via: null, matched: null };
}

/* ───── target lengths (modes/apply.md Step 5E) ────────────────────────────── */
//
// Each recipe has a target length band. We score an answer's word count against
// the band for its recipe and against the visible character limit if one exists.

export const LENGTH_TARGETS = {
  logistics: { minWords: 1, maxWords: 40, note: '1–2 sentences' },
  motivation: { minWords: 25, maxWords: 110, note: '3–5 sentences' },
  fit: { minWords: 25, maxWords: 110, note: '3–5 sentences' },
  behavioral: { minWords: 50, maxWords: 180, note: '4–7 sentences' },
  coverletter: { minWords: 200, maxWords: 380, note: '~250–350 words' },
};

function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Check an answer's length against its recipe's target band and any visible
 * character limit.
 *
 *   lengthCheck(answer, 'behavioral', { charLimit })
 *     → { words, chars, target, ok, verdict, overCharLimit }
 *
 *   verdict — 'ok' | 'short' | 'long'
 *   overCharLimit — true if a charLimit was given and the answer exceeds it
 *
 * The char limit is a HARD gate (the form will reject a too-long answer); the
 * word band is a soft target (off-band → 'short'/'long' so the agent tightens or
 * expands). Both feed the self-check.
 */
export function lengthCheck(text, type, opts = {}) {
  const charLimit = Number.isFinite(opts.charLimit) ? opts.charLimit : null;
  const target = LENGTH_TARGETS[type] || LENGTH_TARGETS.motivation;
  const w = countWords(text);
  const chars = String(text || '').length;
  let verdict = 'ok';
  if (w < target.minWords) verdict = 'short';
  else if (w > target.maxWords) verdict = 'long';
  const overCharLimit = charLimit != null && chars > charLimit;
  return {
    words: w,
    chars,
    target,
    overCharLimit,
    verdict,
    ok: verdict === 'ok' && !overCharLimit,
  };
}

/* ───── cross-form proof-point ledger (modes/apply.md Step 5D) ─────────────── */
//
// "Don't reuse the same proof point twice in the same form unless inevitable." A
// form that repeats the same capstone in every answer reads as a one-note profile.
// This is a SESSION property — only visible across answers — so it's a tiny pure
// ledger the caller threads through the form. The agent tags each answer with the
// proof-point id(s) it leaned on (a story title, a project handle, a metric); the
// ledger reports when one is being reused.

/**
 * Create an empty proof-point ledger.
 *   { used: {}, order: [] }
 * Kept as plain structures so the agent (or a frontend) can serialize it between
 * turns. Pure — every mutator returns a NEW ledger.
 */
export function createProofLedger() {
  return { used: {}, order: [] };
}

// Normalize a proof-point id for de-dup (case / punctuation / spacing-insensitive),
// the same shape story titles are keyed by elsewhere.
export function proofKey(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Record that an answer used one or more proof points, returning a NEW ledger and
 * the reuse report for THIS answer.
 *
 *   recordProofUse(ledger, ['Migration rescue', 'capstone'])
 *     → { ledger, reused }
 *
 *   reused — [{ id, key, priorCount }] for each proof point already used earlier
 *            in this form (priorCount = how many prior answers used it). Empty
 *            when every proof point in this answer is fresh.
 */
export function recordProofUse(ledger, proofIds = []) {
  const base = ledger && typeof ledger === 'object' ? ledger : createProofLedger();
  const used = { ...(base.used || {}) };
  const order = [...(base.order || [])];
  const reused = [];
  // De-dup within this single answer first (using the same proof twice in ONE
  // answer is one use, not a cross-answer reuse).
  const seenThisAnswer = new Set();
  for (const raw of proofIds || []) {
    const id = String(raw || '').trim();
    const key = proofKey(id);
    if (!key || seenThisAnswer.has(key)) continue;
    seenThisAnswer.add(key);
    const prior = used[key] || 0;
    if (prior > 0) reused.push({ id, key, priorCount: prior });
    else order.push(key);
    used[key] = prior + 1;
  }
  return { ledger: { used, order }, reused };
}

/**
 * Which proof points have been leaned on more than `max` times across the form so
 * far. The mode's heuristic is "don't reuse the same proof point twice" → flag any
 * used more than once (max defaults to 1).
 *
 *   overusedProofs(ledger) → [{ key, count }] worst (most-used) first
 */
export function overusedProofs(ledger, max = 1) {
  const used = (ledger && ledger.used) || {};
  return Object.entries(used)
    .filter(([, count]) => count > max)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/* ───── the self-check gate (modes/apply.md Step 5G) ───────────────────────── */
//
// Before an answer is handed back for copy-paste, it passes the 5G gate. This
// runs the deterministic gates and returns a structured verdict so the agent
// rewrites a failing answer instead of shipping it with an apology. The agent
// supplies what only it can judge (which proof points the answer used; whether
// the comp walk-away leaked) and the vocab; this composes the rest.

/**
 * Run the Step 5G self-check over one drafted answer.
 *
 *   selfCheck({
 *     answer,            // the drafted text (string)
 *     type,              // the recipe id from classifyQuestion (string)
 *     charLimit,         // visible char limit, if any (number|null)
 *     proofVocab,        // candidate proof tokens from user/* (string[])
 *     jdVocab,           // JD tokens (string[])
 *     proofIds,          // proof points this answer leaned on (string[])
 *     ledger,            // the running cross-form proof ledger (from createProofLedger)
 *     leakedWalkaway,    // true if the agent detected the comp `minimum` leaked (bool)
 *   })
 *     → { ok, gates, reasons, ledger, reused, detail }
 *
 *   gates   — per-gate booleans { concrete, noBanned, length, noReuse, noWalkaway }
 *   reasons — human-readable failure strings (empty when ok)
 *   ledger  — the UPDATED ledger (proofIds recorded), to thread into the next answer
 *   reused  — this answer's reuse report (from recordProofUse)
 *
 * Pure: the input ledger is never mutated; a new one comes back. Logistics fields
 * are exempt from the concrete/length/banned-as-prose gates that target prose — a
 * salary box has no "concrete" to cite and shouldn't be padded — but the banned
 * phrase, walk-away, and char-limit gates still apply.
 */
export function selfCheck({
  answer = '',
  type = 'motivation',
  charLimit = null,
  proofVocab = [],
  jdVocab = [],
  proofIds = [],
  ledger = null,
  leakedWalkaway = false,
} = {}) {
  const isLogistics = type === 'logistics';
  const reasons = [];

  // Gate 1 — verifiable concrete (skipped for logistics: a fact field IS the
  // concrete; no proof point to cite).
  const concrete = isLogistics
    ? { ok: true, via: 'logistics', matched: null }
    : hasConcrete(answer, { proofVocab, jdVocab });
  if (!concrete.ok) reasons.push('No verifiable concrete (number, CV proper noun, or JD term) — rewrite to cite one.');

  // Gate 2 — no hard-banned phrase (applies everywhere, including logistics).
  const banned = scanForBannedPhrases(answer);
  if (banned.length) reasons.push(`Hard-banned phrase(s): ${banned.join(', ')} — rewrite.`);

  // Gate 3 — length within target band + under the visible char limit.
  const len = lengthCheck(answer, type, { charLimit });
  if (len.overCharLimit) {
    reasons.push(`Over the visible character limit (${len.chars} > ${charLimit}) — trim, prioritising Result/Action.`);
  } else if (!isLogistics && len.verdict !== 'ok') {
    reasons.push(`Length ${len.verdict} for a ${type} answer (${len.words} words, target ${len.target.note}).`);
  }

  // Gate 4 — no proof-point reuse across the form.
  const { ledger: nextLedger, reused } = recordProofUse(ledger, proofIds);
  if (reused.length) {
    reasons.push(`Proof point(s) already used earlier in this form: ${reused.map((r) => r.id).join(', ')} — swap for a different one unless inevitable.`);
  }

  // Gate 5 — the comp walk-away (`minimum`) must never leak.
  if (leakedWalkaway) reasons.push('Comp walk-away (minimum) leaked — never surface the minimum; use the target-range ceiling.');

  const gates = {
    concrete: concrete.ok,
    noBanned: banned.length === 0,
    length: len.overCharLimit ? false : (isLogistics ? true : len.verdict === 'ok'),
    noReuse: reused.length === 0,
    noWalkaway: !leakedWalkaway,
  };

  return {
    ok: reasons.length === 0,
    gates,
    reasons,
    ledger: nextLedger,
    reused,
    detail: { concrete, banned, length: len },
  };
}

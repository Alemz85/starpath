/**
 * network-core.mjs — pure logic for the referral / networking tracker.
 *
 * THE PROBLEM THIS SOLVES
 * A warm referral is the single highest-ROI move in a job search: it lifts
 * response rates far above a cold application. But the system only tracked 1:1
 * outreach *touches* (`data/outreach.md` → `outreach-core.mjs`), not the network
 * *around* a target company — who the candidate already knows (or is one hop
 * from) at companies sitting in their pipeline. This module maps that network
 * onto the pipeline and surfaces the best referral path for any application.
 *
 * HOW IT COMPLEMENTS OUTREACH (does not duplicate it)
 *   - `outreach.md`  : a LOG of messages already SENT, with cadence/nudge state.
 *                      Answers "who do I need to follow up with, and when?".
 *   - `network.md`   : a static ROSTER of people the candidate KNOWS, with how
 *                      warm and how many hops away they are. Answers "for THIS
 *                      application, who is my best path in?" — the asset that
 *                      *precedes* an outreach touch. Once the candidate actually
 *                      reaches out, that touch is logged in `outreach.md`; the
 *                      two layers chain (network → pick path → outreach → cadence).
 *
 * Everything here is a pure function of its inputs — no filesystem, no clock,
 * no network — so it is exhaustively unit-testable. The I/O wrapper that reads
 * `data/network.md` + the pipeline files lives in `scripts/network.mjs`.
 *
 * --- data/network.md table schema ---
 * | # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
 *   #             sequential row id
 *   Name          the person's name
 *   Company       where they currently work (matched against the pipeline)
 *   Title         their role (free text; used to gauge referral leverage)
 *   Relationship  how well the candidate knows them: strong | medium | weak
 *   Degree        1 = you know them directly · 2 = a mutual could introduce you
 *   Via           for a 2nd-degree contact, the 1st-degree person who bridges
 *                 (blank for 1st-degree)
 *   Last Contact  YYYY-MM-DD you last spoke (optional — informs "is this warm
 *                 still?"); blank/n/d if never or unknown
 *   Notes         anything (how you know them, what they own, what to ask)
 *
 * NO HARDCODED USER DATA: this module ships zero names, companies, schools, or
 * scores. Everything is derived from the caller's `network.md` + pipeline text.
 */

/* ───── Company / role keys (shared shape with scouting-core / dedup-index) ──
 * Reusing the exact same normalization the rest of the pipeline uses means the
 * network matcher and the dedup index agree on what "the same company" is. We
 * re-declare (rather than import) so this module stays a standalone leaf with no
 * coupling to the tracker internals — the contract is the algorithm, and it is
 * locked by a cross-check test against scouting-core's companyKey.
 */

/** Strict company dedup key: lowercase, strip every non-alphanumeric. */
export function companyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ───── Relationship strength & degree → a referral "warmth" score ──────────
 * The score ranks referral paths so the strongest, closest contact floats to
 * the top for a given company. It is intentionally simple and explainable:
 *
 *   warmth = strengthWeight × degreeFactor × recencyFactor
 *
 * - strength: a direct, strong tie is worth far more than a weak acquaintance.
 * - degree:   a 1st-degree contact you can message directly beats a 2nd-degree
 *             one that needs a warm intro (which itself beats a cold app).
 * - recency:  a tie you've touched recently is "warmer" than a dormant one; an
 *             unknown/never date is treated as neutral, never penalized to zero
 *             (an old colleague is still a real tie).
 */

export const STRENGTH_WEIGHT = { strong: 3, medium: 2, weak: 1 };
export const DEGREE_FACTOR = { 1: 1.0, 2: 0.6 };

/** Normalize a free-text relationship into strong | medium | weak (default medium). */
export function normalizeStrength(rel) {
  const r = String(rel ?? '').trim().toLowerCase();
  if (!r) return 'medium';
  if (/\b(strong|close|good friend|tight|well)\b/.test(r)) return 'strong';
  if (/\b(weak|loose|acquaintance|barely|distant|cold)\b/.test(r)) return 'weak';
  if (/\b(medium|ok|some|moderate)\b/.test(r)) return 'medium';
  // A bare label like "friend" / "ex-colleague" reads as a real, medium tie.
  return 'medium';
}

/** Normalize the degree cell into 1 or 2 (default 1 — assume a direct tie). */
export function normalizeDegree(deg) {
  const d = String(deg ?? '').trim().toLowerCase();
  if (d === '2' || d === '2nd' || d === 'second' || /\bsecond\b/.test(d)) return 2;
  return 1;
}

function parseDate(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Recency multiplier from the last-contact date. Recent ties are warmer.
 * Unknown / missing dates are neutral (1.0) — never zeroed.
 *   ≤180d → 1.0 · ≤365d → 0.85 · ≤730d → 0.7 · older → 0.55
 */
export function recencyFactor(lastContact, todayStr) {
  const last = parseDate(lastContact);
  const today = parseDate(todayStr);
  if (!last || !today) return 1.0;
  const days = Math.floor((today - last) / 86400000);
  if (days < 0) return 1.0; // future/garbage date → neutral
  if (days <= 180) return 1.0;
  if (days <= 365) return 0.85;
  if (days <= 730) return 0.7;
  return 0.55;
}

/**
 * Compute a referral-warmth score for one contact (higher = better path in).
 * Pure: returns a number rounded to 2dp. `todayStr` is injected for testability
 * and may be omitted (recency then neutral).
 */
export function warmthScore(contact, todayStr) {
  const strength = normalizeStrength(contact.relationship);
  const degree = normalizeDegree(contact.degree);
  const sw = STRENGTH_WEIGHT[strength] ?? STRENGTH_WEIGHT.medium;
  const df = DEGREE_FACTOR[degree] ?? DEGREE_FACTOR[1];
  const rf = recencyFactor(contact.lastContact, todayStr);
  return Math.round(sw * df * rf * 100) / 100;
}

/* ───── Parse data/network.md ──────────────────────────────────────────────── */

// Column order in the network.md table (after the leading empty pipe-edge cell).
const COL = { num: 1, name: 2, company: 3, title: 4, relationship: 5, degree: 6, via: 7, lastContact: 8, notes: 9 };

/** True for a real data row (pipe-delimited, not header / separator). */
export function isDataRow(line) {
  const t = String(line ?? '').trim();
  if (!t.startsWith('|')) return false;
  if (t.includes('---')) return false;
  // Header row starts with "| # |".
  if (/^\|\s*#\s*\|/.test(t)) return false;
  return true;
}

/** Treat sentinel placeholders ("", "n/d", "—", "-") as an absent value. */
function clean(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s === 'n/d' || s === '—' || s === '-' || s.toLowerCase() === 'n/a') return '';
  return s;
}

/**
 * Parse one network.md row into a contact object, or null if it isn't a real
 * entry (header, separator, non-numeric id, or missing name+company).
 */
export function parseContactRow(line) {
  if (!isDataRow(line)) return null;
  const parts = String(line).split('|').map((s) => s.trim());
  // Need 9 data cells + 2 pipe edges = 11 parts minimum.
  if (parts.length < COL.notes + 1) return null;
  const num = parseInt(parts[COL.num], 10);
  if (Number.isNaN(num)) return null;
  const name = clean(parts[COL.name]);
  const company = clean(parts[COL.company]);
  if (!name || !company) return null; // a contact with no name or no employer is unusable
  return {
    num,
    name,
    company,
    companyKey: companyKey(company),
    title: clean(parts[COL.title]),
    relationship: normalizeStrength(parts[COL.relationship]),
    degree: normalizeDegree(parts[COL.degree]),
    via: clean(parts[COL.via]),
    lastContact: clean(parts[COL.lastContact]),
    notes: clean(parts[COL.notes] ?? ''),
  };
}

/** Parse a whole network.md document into an array of contacts. */
export function parseNetwork(content) {
  const out = [];
  for (const line of String(content ?? '').split('\n')) {
    const c = parseContactRow(line);
    if (c) out.push(c);
  }
  return out;
}

/* ───── Parse the pipeline (applications.md + scouting.md) ───────────────────
 * Both files share the leading shape `| num | date | company | role | score |`.
 * We only need company + role + score + a source tag here, so one lenient parser
 * handles both. Score lets us rank coverage gaps (a referral matters most for a
 * high-scoring role).
 */

/** Pull the leading numeric from a score cell ("7.2/10", "**8**") → number, 0 if none. */
export function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Parse one pipeline row into { company, role, score } or null.
 * `source` tags where it came from ('application' | 'scouting').
 */
export function parsePipelineRow(line, source) {
  const t = String(line ?? '').trim();
  if (!t.startsWith('|') || t.includes('---')) return null;
  if (/^\|\s*#\s*\|/.test(t)) return null;
  const parts = t.split('|').map((s) => s.trim());
  if (parts.length < 6) return null;
  const num = parseInt(parts[1], 10);
  if (Number.isNaN(num)) return null;
  const date = parts[2];
  const company = clean(parts[3]);
  const role = clean(parts[4]);
  if (!company || !role) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null; // guard header noise
  return { company, companyKey: companyKey(company), role, score: parseScore(parts[5]), source };
}

/**
 * Build the deduped set of pipeline targets from applications + scouting text.
 * Keyed by (companyKey + normalized role); the higher score wins on collision,
 * and an 'application' source is preferred over 'scouting' for the same key
 * (you've decided to apply → it's a more committed target).
 */
export function parsePipeline(applicationsContent, scoutingContent) {
  const byKey = new Map();
  const add = (line, source) => {
    const r = parsePipelineRow(line, source);
    if (!r) return;
    const key = `${r.companyKey}|${r.role.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); return; }
    // Prefer application source; otherwise keep the higher score.
    const prevRank = prev.source === 'application' ? 1 : 0;
    const curRank = source === 'application' ? 1 : 0;
    if (curRank > prevRank || (curRank === prevRank && r.score > prev.score)) {
      byKey.set(key, r);
    }
  };
  for (const line of String(applicationsContent ?? '').split('\n')) add(line, 'application');
  for (const line of String(scoutingContent ?? '').split('\n')) add(line, 'scouting');
  return [...byKey.values()];
}

/* ───── The match: network × pipeline ───────────────────────────────────────── */

/**
 * Match the candidate's contacts against pipeline targets by company key, and
 * rank the referral paths per company. Pure.
 *
 * @param {Array} contacts   from parseNetwork()
 * @param {Array} pipeline   from parsePipeline()
 * @param {string} todayStr  YYYY-MM-DD (for recency); optional
 * @returns {object}
 *   - matches: per company with ≥1 contact AND ≥1 pipeline target:
 *       { company, companyKey, bestWarmth, contacts:[…ranked], roles:[…] }
 *   - gaps: pipeline targets (companyKey) with NO contact, ranked by best score
 *   - orphanContacts: contacts whose company isn't in the pipeline (latent leads
 *       — a person you know somewhere you haven't targeted yet)
 *   - counts: { matchedCompanies, contactsMatched, gaps, orphanContacts }
 */
export function matchNetworkToPipeline(contacts, pipeline, todayStr) {
  // Index pipeline targets by company key.
  const pipeByCompany = new Map();
  for (const p of pipeline) {
    const arr = pipeByCompany.get(p.companyKey) || [];
    arr.push(p);
    pipeByCompany.set(p.companyKey, arr);
  }

  // Index contacts by company key, each carrying its computed warmth.
  const contactsByCompany = new Map();
  for (const c of contacts) {
    const scored = { ...c, warmth: warmthScore(c, todayStr) };
    const arr = contactsByCompany.get(c.companyKey) || [];
    arr.push(scored);
    contactsByCompany.set(c.companyKey, arr);
  }

  const matches = [];
  const orphanContacts = [];

  for (const [ck, cs] of contactsByCompany) {
    const targets = pipeByCompany.get(ck);
    const ranked = cs.slice().sort(rankContacts);
    if (!targets) {
      // Person you know at a company not in the pipeline — a latent lead.
      for (const c of ranked) orphanContacts.push(c);
      continue;
    }
    const roles = targets
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((t) => ({ role: t.role, score: t.score, source: t.source }));
    matches.push({
      company: cs[0].company, // display name from the first contact's spelling
      companyKey: ck,
      bestWarmth: ranked[0].warmth,
      topScore: roles[0]?.score ?? 0,
      contacts: ranked,
      roles,
    });
  }

  // Gaps: pipeline companies with no contact at all.
  const gaps = [];
  for (const [ck, targets] of pipeByCompany) {
    if (contactsByCompany.has(ck)) continue;
    const sorted = targets.slice().sort((a, b) => b.score - a.score);
    gaps.push({
      company: sorted[0].company,
      companyKey: ck,
      topScore: sorted[0].score,
      roles: sorted.map((t) => ({ role: t.role, score: t.score, source: t.source })),
    });
  }

  // Rank matches: warmest path first, then highest-scoring role.
  matches.sort((a, b) => (b.bestWarmth - a.bestWarmth) || (b.topScore - a.topScore));
  // Rank gaps by the best role score (most worth finding a contact for).
  gaps.sort((a, b) => b.topScore - a.topScore);
  // Orphan leads: warmest first (most reusable if you ever target them).
  orphanContacts.sort((a, b) => b.warmth - a.warmth);

  return {
    matches,
    gaps,
    orphanContacts,
    counts: {
      matchedCompanies: matches.length,
      contactsMatched: matches.reduce((n, m) => n + m.contacts.length, 0),
      gaps: gaps.length,
      orphanContacts: orphanContacts.length,
    },
  };
}

/** Sort comparator: warmer first, then 1st-degree before 2nd, then by name. */
function rankContacts(a, b) {
  if (b.warmth !== a.warmth) return b.warmth - a.warmth;
  if (a.degree !== b.degree) return a.degree - b.degree;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * Resolve the best referral path(s) for a single named company — the query
 * behind "who do I know at {company}?". Returns the ranked contacts plus the
 * matching pipeline roles, or a not-found shape. Pure.
 */
export function pathsForCompany(companyName, contacts, pipeline, todayStr) {
  const ck = companyKey(companyName);
  const ranked = contacts
    .filter((c) => c.companyKey === ck)
    .map((c) => ({ ...c, warmth: warmthScore(c, todayStr) }))
    .sort(rankContacts);
  const roles = pipeline
    .filter((p) => p.companyKey === ck)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ role: p.role, score: p.score, source: p.source }));
  return {
    company: companyName,
    companyKey: ck,
    found: ranked.length > 0,
    inPipeline: roles.length > 0,
    contacts: ranked,
    roles,
  };
}

/* ───── A one-line, human-readable label for a referral path ─────────────────
 * Used by the CLI summary and re-usable by the mode/frontend. Explains WHY a
 * path ranks where it does, in plain words.
 */
export function pathLabel(contact) {
  const deg = contact.degree === 2
    ? (contact.via ? `2nd-degree via ${contact.via}` : '2nd-degree (needs an intro)')
    : '1st-degree (direct)';
  const rel = `${contact.relationship} tie`;
  const title = contact.title ? ` · ${contact.title}` : '';
  return `${contact.name}${title} — ${rel}, ${deg}`;
}

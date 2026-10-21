// scouting-core.mjs — pure parsing/normalization for the data/scouting.md
// pipeline (merge-scouting, promote-to-applications).
//
// Sibling of lib/tracker-core.mjs (applications.md) for the scouting side.
// All functions are pure (no I/O, no globals, no input mutation); the CLI
// scripts own file reading/writing. Scouting rows are landscape inventory and
// use a different 12-column shape than applications.md (docs/scoring-v2.md §8.2):
//
//   # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes
//
//   Want / Ease  "8.25" / "5.6" (no "/10"), "—" when the listing is Blocked
//   Eligibility  "green" | "amber: <reasons ;-joined>" | "red: <reason>"
//
// The v1 shapes (11-column Score/Tier/CF-AF, 10-column legacy) are retired:
// v1 data was archived on the switch to scoring v2, so there is no back-compat
// reader. Rows that don't have the 12 v2 columns parse as null.

import { normalizeCompany } from './dedup-index.mjs';

/* ───── Verdict grid (mirror of scripts/lib/score-bands.mjs) ─────── */

// score-bands.mjs is the engine's source of truth for these constants and for
// assignVerdict(); this is a deliberately tiny pure copy so the tracker
// pipeline can derive tier / promotion hints from the stored cells without
// importing the engine. Keep in sync with docs/scoring-v2.md §4.
export const WANT_HIGH = 8.0;
export const WANT_MID = 6.5;
export const EASE_HIGH = 7.0;
export const EASE_MID = 5.0;

/** Tier per verdict key (spec §4). */
export const VERDICT_TIERS = {
  go: 'T1', stretch: 'T2', growth: 'T3', solid: 'T2', thin: 'T2', skip: 'T4', blocked: 'T4',
};

/**
 * Verdict + tier from the stored cells.
 *   verdictFromCells({ want, ease, eligibility }) → { verdict, tier }
 * `eligibility` may be a bare status ("red") or a full cell ("red: …").
 * Red (or a non-numeric want/ease) → blocked / T4.
 */
export function verdictFromCells({ want, ease, eligibility } = {}) {
  const w = toNumber(want);
  const e = toNumber(ease);
  if (eligibilityStatus(eligibility) === 'red' || w === null || e === null) {
    return { verdict: 'blocked', tier: VERDICT_TIERS.blocked };
  }
  let verdict;
  if (w >= WANT_HIGH) verdict = e >= EASE_HIGH ? 'go' : e >= EASE_MID ? 'stretch' : 'growth';
  else if (w >= WANT_MID) verdict = e >= EASE_HIGH ? 'solid' : e >= EASE_MID ? 'thin' : 'skip';
  else verdict = 'skip';
  return { verdict, tier: VERDICT_TIERS[verdict] };
}

/* ───── Tiers + promotion hints ──────────────────────────────────── */

export const VALID_TIERS = ['T1', 'T2', 'T3', 'T4'];

/** Coerce a tier cell to canonical T1-T4. Accepts "Tier 1"/"tier-1"/"1". */
export function normalizeTier(tier, warn = console.warn) {
  const clean = String(tier || '').replace(/\*\*/g, '').trim().toUpperCase();
  if (VALID_TIERS.includes(clean)) return clean;
  const m = clean.match(/T(?:IER[- ]?)?(\d)/);
  if (m && VALID_TIERS.includes(`T${m[1]}`)) return `T${m[1]}`;
  if (/^\d$/.test(clean) && VALID_TIERS.includes(`T${clean}`)) return `T${clean}`;
  warn(`⚠️  Non-canonical tier "${tier}" → defaulting to "T4"`);
  return 'T4';
}

/** Promotion hint a verdict implies (spec §4): READY for go; MONITOR for stretch/solid; else blank. */
export function promotionHintForVerdict(verdict) {
  if (verdict === 'go') return 'READY';
  if (verdict === 'stretch' || verdict === 'solid') return 'MONITOR';
  return '';
}

/**
 * Normalize a promotion hint. A blank hint defaults from the verdict key
 * (READY / MONITOR / blank). "ready*" → READY and "monitor*" → MONITOR; any
 * other writer-supplied text (e.g. PROMOTED-12) passes through.
 */
export function normalizePromotionHint(hint, verdict) {
  const clean = String(hint || '').trim();
  if (!clean) return promotionHintForVerdict(verdict);
  if (/^ready/i.test(clean)) return 'READY';
  if (/^monitor/i.test(clean)) return 'MONITOR';
  return clean;
}

/* ───── Cell parsers (Want / Ease / Eligibility) ─────────────────── */

const BLOCKED_CELLS = new Set(['—', '-', '–']);

/** Cell text for a missing (Blocked) Want/Ease. */
export const BLOCKED_CELL = '—';

/** Number from a Want/Ease cell ("8.25", "**8**", "8.25/10"); null for "—"/blank/garbage. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/\*\*/g, '').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*10)?$/);
  return m ? parseFloat(m[1]) : null;
}

/** True for a well-formed Want/Ease cell: a number in [1,10] or the "—" blocked marker. */
export function isValidScoreCell(v) {
  const s = String(v ?? '').trim();
  if (BLOCKED_CELLS.has(s)) return true;
  const n = toNumber(s);
  return n !== null && n >= 1 && n <= 10;
}

/** Bare eligibility status ("green" | "amber" | "red") from a cell or status; null if unrecognized. */
export function eligibilityStatus(cell) {
  const m = String(cell ?? '').replace(/\*\*/g, '').trim().toLowerCase().match(/^(green|amber|red)\b/);
  return m ? m[1] : null;
}

/**
 * Parse an Eligibility cell → { status, reasons }.
 *   "green" → { status: 'green', reasons: [] }
 *   "amber: start date not stated; duration not stated" → { status: 'amber', reasons: [..2] }
 * Returns null when the status isn't green/amber/red.
 */
export function parseEligibilityCell(cell) {
  const status = eligibilityStatus(cell);
  if (!status) return null;
  const rest = String(cell).replace(/\*\*/g, '').trim().slice(status.length).replace(/^\s*[:—-]\s*/, '');
  const reasons = rest ? rest.split(';').map(r => r.trim()).filter(Boolean) : [];
  return { status, reasons };
}

/** Build an Eligibility cell: formatEligibilityCell('amber', ['a','b']) → "amber: a; b". */
export function formatEligibilityCell(status, reasons = []) {
  const rs = (Array.isArray(reasons) ? reasons : [reasons]).map(r => String(r).trim()).filter(Boolean);
  return status === 'green' || rs.length === 0 ? String(status) : `${status}: ${rs.join('; ')}`;
}

/* ───── Company / role keys (shared shape with tracker-core) ─────── */

/** Strict dedup key: `normalizeCompany` (dedup-index.mjs), the one company key every writer shares. */
export function companyKey(name) {
  return normalizeCompany(name);
}

/** Lowercase + collapse whitespace, for the dedup-index.tsv role key. */
export function normalizeRoleForIndex(role) {
  return String(role).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Loose role match: ≥2 shared words longer than 3 chars, substring-tolerant. */
export function roleFuzzyMatch(a, b) {
  const wordsA = String(a).toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = String(b).toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return overlap.length >= 2;
}

/**
 * Same-listing role match for scouting.md, where one company often has many
 * sibling rows (one per city, track or intake). After gender tags and req ids
 * are stripped, the shorter title's words must all appear in the longer one
 * and number at least two: "Data Analyst" ~ "Data Analyst (m/f/d) - Lyon". A
 * differing city, track or level word keeps two titles apart, which
 * `roleFuzzyMatch` (≥2 shared words) does not: it calls "Ops Intern, Summer
 * 2027 – Lyon" and "Sales Intern, Summer 2027 – Lyon" the same listing.
 * Trailing locations are deliberately NOT stripped (unlike the scanner's
 * canonicalizeRole): in scouting the city is what separates two rows.
 */
const VARIANT_GENDER_TAG_RE = /\(\s*[mwfdhx](?:\s*[\/|]\s*[mwfdhx])+\s*\)/gi;
const VARIANT_REQ_ID_RE = /(?:[#(]\s*(?:jr|req|ref|id|r)?[-\s]?\d{4,}[a-z0-9-]*\s*\)?|\b(?:req|ref|job\s*id|requisition)\b[:#]?\s*[a-z]?\d{3,}[a-z0-9-]*)/gi;

export function roleVariantMatch(a, b) {
  const words = (t) => new Set(String(t ?? '').toLowerCase().replace(VARIANT_GENDER_TAG_RE, ' ').replace(VARIANT_REQ_ID_RE, ' ')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  const wa = words(a);
  const wb = words(b);
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (small.size < 2) return false;
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

/* ───── Scalar parsers ───────────────────────────────────────────── */

/** Extract the report number from a "[#12](…)" / "[12](…)" link, else null. */
export function extractReportNum(reportStr) {
  const m = String(reportStr).match(/\[#?(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

const NO_DEADLINE = new Set(['', 'n/d', '-', '—']);

/**
 * Pick the first "real" deadline among the candidates, treating the
 * no-deadline sentinels (''/n/d/-/—) as absent. Falls back to 'n/d'. Lets a
 * re-eval that omits the deadline keep the posting's previously-known close
 * date instead of blanking it.
 */
export function coalesceDeadline(...vals) {
  for (const v of vals) {
    const c = String(v ?? '').trim();
    if (c && !NO_DEADLINE.has(c.toLowerCase())) return c;
  }
  return 'n/d';
}

/* ───── Report tier paths ────────────────────────────────────────── */

/**
 * Reports live in tier subfolders (reports/tier-1…tier-4). Rewrite a flat
 * `reports/foo.md` into the entry's tier. Already-tiered paths and the
 * "no report" sentinels pass through.
 */
export function rewriteReportPathForTier(reportStr, tier) {
  if (!reportStr || reportStr === '—' || reportStr === '-') return reportStr;
  if (/reports\/tier-\d\//.test(reportStr)) return reportStr;
  const m = String(tier).match(/^T(\d)$/);
  if (!m) return reportStr;
  return reportStr.replace(/reports\//, `reports/tier-${m[1]}/`);
}

/* ───── Row parsing ──────────────────────────────────────────────── */

/**
 * Column indices for a scouting.md row. Indices are into the raw `|`-split
 * array (cells[0] is the empty string before the leading pipe). The v2 shape
 * is fixed at 12 columns — no optional columns.
 */
export function scoutingColumns() {
  return {
    num: 1, date: 2, company: 3, role: 4, want: 5, ease: 6, tier: 7, eligibility: 8,
    report: 9, deadline: 10, hint: 11, notes: 12,
  };
}

/** True when a table header line is the v2 12-column scouting header. */
export function isV2ScoutingHeader(line) {
  const cells = String(line).split('|').map(s => s.trim().toLowerCase());
  return cells.length >= 14 && cells[5] === 'want' && cells[6] === 'ease' && cells[8] === 'eligibility';
}

/**
 * Parse one scouting.md table row (12-column v2 layout). Returns null for
 * headers, separators, rows without a numeric id, and any row that doesn't
 * have all 12 columns (v1 rows are not readable by design). `cells`/`cols` are
 * exposed so a caller mutating one field can rewrite the row precisely.
 *
 * `want` / `ease` are the raw cell strings; `wantNum` / `easeNum` the numbers
 * (null when blocked). `eligibility` is the raw cell, `eligibilityStatus` its
 * bare status.
 */
export function parseScoutingRow(line) {
  if (typeof line !== 'string' || !line.startsWith('|')) return null;
  const cells = line.split('|').map(s => s.trim());
  // 12 fields + leading/trailing empties = 14 cells.
  if (cells.length < 14) return null;
  const num = parseInt(cells[1], 10);
  if (isNaN(num) || num === 0) return null;

  const cols = scoutingColumns();
  return {
    num,
    date: cells[cols.date],
    company: cells[cols.company],
    role: cells[cols.role],
    want: cells[cols.want],
    ease: cells[cols.ease],
    wantNum: toNumber(cells[cols.want]),
    easeNum: toNumber(cells[cols.ease]),
    tier: cells[cols.tier],
    eligibility: cells[cols.eligibility],
    eligibilityStatus: eligibilityStatus(cells[cols.eligibility]),
    report: cells[cols.report],
    deadline: cells[cols.deadline],
    hint: cells[cols.hint],
    notes: cells[cols.notes] ?? '',
    cols,
    cells,
    raw: line,
  };
}

// A literal "|" inside a free-text cell would shift every later column.
const cellSafe = (v) => String(v ?? '').replace(/\|/g, '/');

/** Serialize a scouting entry to the canonical 12-column row. */
export function formatScoutingRow(e) {
  return `| ${e.num} | ${e.date} | ${e.company} | ${e.role} | ${e.want} | ${e.ease} | ${e.tier} | ${cellSafe(e.eligibility)} | ${e.report} | ${e.deadline || 'n/d'} | ${e.hint} | ${cellSafe(e.notes)} |`;
}

/* ───── TSV additions (merge-scouting input) ─────────────────────── */

/**
 * Parse one scouting-additions TSV into a normalized addition. Canonical form
 * is 12 tab-separated columns (docs/scoring-v2.md §8.2):
 *   num date company role want ease tier eligibility report deadline hint notes
 * Trailing empty hint/notes may be absent (≥10 fields accepted). Want/Ease are
 * a number in [1,10] or "—" (blocked); a red eligibility forces the blocked
 * shape (T4, no hint) and keeps Want / Ease only when both are given (the
 * profile's score_through_red). A v1-shaped TSV (e.g. "6.7/10" in the Want
 * slot) fails validation and is skipped with a warning. Returns null on
 * malformed input.
 */
export function parseScoutingTsv(content, filename = 'addition', warn = console.warn) {
  content = String(content).replace(/^[\r\n]+|[\r\n]+$/g, '');
  if (!content.trim()) return null;

  const parts = content.split('\t');
  if (parts.length < 10) {
    warn(`⚠️  Skipping malformed scouting TSV ${filename}: ${parts.length} fields (expected 12)`);
    return null;
  }

  const num = parseInt(parts[0], 10);
  if (isNaN(num) || num === 0) {
    warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  const elig = parseEligibilityCell(parts[7]);
  if (!elig) {
    warn(`⚠️  Skipping ${filename}: eligibility "${parts[7]}" must be green | amber: … | red: …`);
    return null;
  }
  if (!isValidScoreCell(parts[4]) || !isValidScoreCell(parts[5])) {
    warn(`⚠️  Skipping ${filename}: want/ease must be numbers 1-10 or "—" (got "${parts[4]}" / "${parts[5]}") — v1 Score/CF-AF rows are not supported`);
    return null;
  }

  const blockedShape = elig.status === 'red';
  const wantNum = toNumber(parts[4]);
  const easeNum = toNumber(parts[5]);
  if (!blockedShape && (wantNum === null || easeNum === null)) {
    warn(`⚠️  Skipping ${filename}: want/ease "—" is only valid for a red (blocked) listing`);
    return null;
  }
  // A blocked row keeps its Want / Ease when the profile's score_through_red
  // scored it (both or neither, as verify-pipeline checks): blanking them here
  // used to drop the scores the user asked for on the way into the Database.
  if (blockedShape && (wantNum === null) !== (easeNum === null)) {
    warn(`⚠️  Skipping ${filename}: a red (blocked) listing needs both Want and Ease, or "—" for both`);
    return null;
  }

  // Tier: trust a valid writer-supplied tier, else derive from the grid.
  const derived = verdictFromCells({ want: wantNum, ease: easeNum, eligibility: elig.status });
  const rawTier = String(parts[6] ?? '').trim();
  const tier = blockedShape ? 'T4' : (rawTier ? normalizeTier(rawTier, warn) : derived.tier);

  return {
    num,
    date: parts[1],
    company: parts[2],
    role: parts[3],
    want: wantNum === null ? BLOCKED_CELL : String(wantNum),
    ease: easeNum === null ? BLOCKED_CELL : String(easeNum),
    tier,
    eligibility: formatEligibilityCell(elig.status, elig.reasons),
    report: rewriteReportPathForTier(parts[8] ?? '', tier),
    deadline: parts[9] || 'n/d',
    hint: blockedShape ? '' : normalizePromotionHint(parts[10], derived.verdict),
    notes: parts[11] || '',
  };
}

/* ───── Re-evaluation merge ──────────────────────────────────────── */

/**
 * Re-eval annotation for the Notes cell: "Re-eval (W 7.1→8.25, E 5→5.6)".
 * Blocked sides render as "—".
 */
export function reEvalNote(oldRow, newRow) {
  const c = (v) => (toNumber(v) === null ? BLOCKED_CELL : String(toNumber(v)));
  return `Re-eval (W ${c(oldRow.want)}→${c(newRow.want)}, E ${c(oldRow.ease)}→${c(newRow.ease)})`;
}

/**
 * Should `addition` replace the existing scouting row for the same listing?
 * A newer evaluation always wins (the model is point-in-time; a re-eval
 * reflects the candidate's current profile). An addition dated before the
 * existing row is stale and is skipped. Equal dates replace.
 */
export function shouldReplaceScoutingRow(existing, addition) {
  return String(addition.date) >= String(existing.date);
}

/**
 * Build the merged row for a re-evaluation: the addition's cells win, the
 * entry number is kept, the posting's known deadline survives a re-eval that
 * omits it, a PROMOTED-n hint is preserved (the entry is a frozen record of
 * an application already opened), and the Notes get the Re-eval annotation.
 */
export function buildReEvalRow(existing, addition) {
  const promoted = /^PROMOTED-/i.test(String(existing.hint || ''));
  return {
    num: existing.num,
    date: addition.date,
    company: addition.company,
    role: addition.role,
    want: addition.want,
    ease: addition.ease,
    tier: addition.tier,
    eligibility: addition.eligibility,
    // The link text stays the row's own number, whatever number the worker picked.
    report: /^\[\d+\]/.test(String(addition.report)) ? addition.report.replace(/^\[\d+\]/, `[${existing.num}]`) : addition.report,
    deadline: coalesceDeadline(addition.deadline, existing.deadline),
    hint: promoted ? existing.hint : addition.hint,
    notes: `${reEvalNote(existing, addition)}. ${addition.notes}`.trim(),
  };
}

/* ───── Row validation (verify-pipeline) ─────────────────────────── */

/**
 * Validate a parsed scouting row against the v2 cell rules. Returns
 * { errors: string[], warnings: string[] } (both empty = clean).
 *   errors   — structurally invalid: bad tier, Want/Ease not a number 1-10 or
 *              "—", eligibility not green|amber|red[: reasons], a red row with
 *              only one of Want/Ease or not T4, a non-red row missing them.
 *   warnings — tier disagrees with the verdict grid for the stored cells (the
 *              writer may have used a stale grid), or a blocked row carries a
 *              READY/MONITOR hint.
 */
export function validateScoutingRow(row) {
  const errors = [];
  const warnings = [];
  if (!VALID_TIERS.includes(row.tier)) errors.push(`invalid tier "${row.tier}" (expected T1-T4)`);
  const wantOk = isValidScoreCell(row.want);
  const easeOk = isValidScoreCell(row.ease);
  if (!wantOk) errors.push(`invalid Want "${row.want}" (expected a number 1-10 or "—")`);
  if (!easeOk) errors.push(`invalid Ease "${row.ease}" (expected a number 1-10 or "—")`);
  const elig = parseEligibilityCell(row.eligibility);
  if (!elig) {
    errors.push(`invalid Eligibility "${row.eligibility}" (expected green | amber: … | red: …)`);
  } else if (wantOk && easeOk) {
    const w = toNumber(row.want);
    const e = toNumber(row.ease);
    if (elig.status === 'red') {
      // A red row is Blocked; it carries scores only when the profile's
      // score_through_red allowed them, and then both or neither.
      if ((w === null) !== (e === null)) errors.push('red (blocked) row must have both Want and Ease, or "—" for both');
      if (row.tier !== 'T4') errors.push(`red (blocked) row must be T4, got ${row.tier}`);
      if (/^(READY|MONITOR)$/i.test(row.hint || '')) warnings.push(`blocked row carries hint "${row.hint}"`);
    } else if (w === null || e === null) {
      errors.push('Want/Ease "—" is only valid for a red (blocked) row');
    } else {
      const { tier } = verdictFromCells({ want: w, ease: e, eligibility: elig.status });
      if (VALID_TIERS.includes(row.tier) && tier !== row.tier) {
        warnings.push(`tier ${row.tier} disagrees with the verdict grid for W${w} E${e} (grid says ${tier})`);
      }
    }
  }
  return { errors, warnings };
}

// scouting-core.mjs — pure parsing/normalization for the data/scouting.md
// pipeline (merge-scouting, promote-to-applications).
//
// Sibling of lib/tracker-core.mjs (applications.md) for the scouting side.
// All functions are pure (no I/O, no globals, no input mutation); the CLI
// scripts own file reading/writing. Scouting rows are landscape inventory and
// use a different 11-column shape than applications.md:
//
//   # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes
//
// THE FORMAT GOTCHA (why parseScoutingRow exists): the `Deadline` cell sits
// between Report and Promotion Hint. The legacy rows had no Deadline column.
// Hand-indexing `hint = cells[9]` is therefore wrong for the current format —
// it reads the *deadline* as the hint and shifts notes onto the hint cell,
// dropping the real notes. parseScoutingRow detects the column by row width and
// exposes resolved indices so every consumer agrees.

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

/** Default a blank hint to READY for T1, blank otherwise; normalize "ready*". */
export function normalizePromotionHint(hint, tier) {
  const clean = String(hint || '').trim();
  if (!clean) return tier === 'T1' ? 'READY' : '';
  if (/^ready/i.test(clean)) return 'READY';
  return clean;
}

/* ───── Company / role keys (shared shape with tracker-core) ─────── */

/** Strict dedup key: lowercase, strip every non-alphanumeric. */
export function companyKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
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

/* ───── Scalar parsers ───────────────────────────────────────────── */

/** Pull the leading numeric out of a score cell ("6.7/10", "**8**") → number. */
export function parseScore(s) {
  const m = String(s).replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

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

/* ───── Row parsing (the deadline-aware core) ────────────────────── */

/**
 * Column indices for a scouting.md row given whether the Deadline cell is
 * present. Indices are into the raw `|`-split array (cells[0] is the empty
 * string before the leading pipe). Everything up to Report is positionally
 * fixed; only deadline/hint/notes shift.
 */
export function scoutingColumns(hasDeadline) {
  return {
    num: 1, date: 2, company: 3, role: 4, score: 5, tier: 6, cfAf: 7, report: 8,
    deadline: hasDeadline ? 9 : null,
    hint: hasDeadline ? 10 : 9,
    notes: hasDeadline ? 11 : 10,
  };
}

/**
 * Parse one scouting.md table row, transparently handling BOTH the 11-column
 * (with Deadline) and legacy 10-column layouts. Returns null for headers,
 * separators, and rows without a numeric id. `cells`/`cols` are exposed so a
 * caller mutating one field can rewrite the row precisely.
 */
export function parseScoutingRow(line) {
  if (typeof line !== 'string' || !line.startsWith('|')) return null;
  const cells = line.split('|').map(s => s.trim());
  // 10-column shape: '' + 10 fields + '' = 12 cells; 11-column → 13.
  if (cells.length < 12) return null;
  const num = parseInt(cells[1], 10);
  if (isNaN(num) || num === 0) return null;

  const hasDeadline = cells.length >= 13;
  const cols = scoutingColumns(hasDeadline);
  return {
    num,
    date: cells[cols.date],
    company: cells[cols.company],
    role: cells[cols.role],
    score: cells[cols.score],
    tier: cells[cols.tier],
    cfAf: cells[cols.cfAf],
    report: cells[cols.report],
    deadline: cols.deadline === null ? 'n/d' : cells[cols.deadline],
    hint: cells[cols.hint],
    notes: cells[cols.notes] ?? '',
    hasDeadline,
    cols,
    cells,
    raw: line,
  };
}

/** Serialize a scouting entry to the canonical 11-column row (always w/ Deadline). */
export function formatScoutingRow(e) {
  return `| ${e.num} | ${e.date} | ${e.company} | ${e.role} | ${e.score} | ${e.tier} | ${e.cfAf} | ${e.report} | ${e.deadline || 'n/d'} | ${e.hint} | ${e.notes} |`;
}

/* ───── TSV additions (merge-scouting input) ─────────────────────── */

/**
 * Parse one scouting-additions TSV into a normalized addition. Canonical form
 * is 11 columns:
 *   num date company role score tier cf_af report deadline hint notes
 * Backward-compatible with the legacy 10-column form (no deadline). Returns
 * null (and warns) on malformed input.
 */
export function parseScoutingTsv(content, filename = 'addition', warn = console.warn) {
  content = String(content).trim();
  if (!content) return null;

  const parts = content.split('\t');
  if (parts.length < 9) {
    warn(`⚠️  Skipping malformed scouting TSV ${filename}: ${parts.length} fields (expected 11)`);
    return null;
  }

  const tier = normalizeTier(parts[5], warn);
  // 11-col: num date company role score tier cf_af report deadline hint notes
  // 10-col: num date company role score tier cf_af report hint notes
  const hasDeadline = parts.length >= 11;
  const addition = {
    num: parseInt(parts[0], 10),
    date: parts[1],
    company: parts[2],
    role: parts[3],
    score: parts[4],
    tier,
    cfAf: parts[6],
    report: rewriteReportPathForTier(parts[7], tier),
    deadline: hasDeadline ? (parts[8] || 'n/d') : 'n/d',
    hint: normalizePromotionHint(hasDeadline ? parts[9] : parts[8], tier),
    notes: hasDeadline ? (parts[10] || '') : (parts[9] || ''),
  };

  if (isNaN(addition.num) || addition.num === 0) {
    warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

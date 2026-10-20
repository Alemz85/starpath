// tracker-core.mjs — pure parsing/normalization logic for the applications.md
// data pipeline (merge-tracker, dedup-tracker, normalize-statuses).
//
// All functions here are pure (no I/O, no globals, no mutation of inputs). The
// CLI scripts own file reading/writing; this module owns the transformations
// that decide what a row *means* — so the highest-blast-radius code in the
// system (it rewrites the user's on-disk applications.md) is testable in
// isolation. Mirrors the extract-then-test pattern already used for
// liveness-core.mjs and lib/score-bands.mjs.
//
// THE FORMAT GOTCHA (why parseAppRow exists): applications.md data rows carry
// an optional `Deadline` cell between PDF and Report. merge-tracker writes the
// 10-column form (`# date company role score status pdf deadline report
// notes`), but the legacy 9-column form (no deadline) is still valid on disk.
// Hand-indexing `report = cells[8]` is therefore wrong for the current format —
// it reads the *deadline* as the report and shifts notes onto the report cell.
// `parseAppRow` detects the deadline column by width and exposes the correct
// report/notes indices so every consumer agrees.

import { verdictFromCells } from './scouting-core.mjs';

/* ───── Canonical states ─────────────────────────────────────────── */

// Canonical applications.md states (templates/states.yml). Scouting
// observations are NOT here — they live in data/scouting.md with a Tier
// column instead (see merge-scouting.mjs).
export const CANONICAL_STATES = [
  'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP',
];

// Status advancement order (higher = further along the pipeline). Used by
// dedup-tracker to preserve the most-advanced status when collapsing dupes.
// 'applied' outranks 'rejected' because an active application beats a terminal
// state. Spanish aliases kept for backward-compat with older tracker data.
export const STATUS_RANK = {
  skip: 0, discarded: 0, rejected: 1, evaluated: 3, applied: 4,
  responded: 5, interview: 6, offer: 7,
  // Spanish aliases
  no_aplicar: 0, 'no aplicar': 0, descartado: 0, descartada: 0,
  rechazado: 1, rechazada: 1, evaluada: 3, aplicado: 4, respondido: 5,
  entrevista: 6, oferta: 7,
};

// Non-canonical → canonical aliases for validateStatus().
const STATUS_ALIASES = {
  // Spanish → English
  evaluada: 'Evaluated', condicional: 'Evaluated', hold: 'Evaluated', evaluar: 'Evaluated', verificar: 'Evaluated',
  aplicado: 'Applied', enviada: 'Applied', aplicada: 'Applied', applied: 'Applied', sent: 'Applied',
  respondido: 'Responded',
  entrevista: 'Interview',
  oferta: 'Offer',
  rechazado: 'Rejected', rechazada: 'Rejected',
  descartado: 'Discarded', descartada: 'Discarded', cerrada: 'Discarded', cancelada: 'Discarded',
  'no aplicar': 'SKIP', no_aplicar: 'SKIP', skip: 'SKIP', monitor: 'SKIP',
  'geo blocker': 'SKIP',
};

/* ───── Company / role normalization ─────────────────────────────── */

/**
 * Strict dedup key: lowercase, strip every non-alphanumeric (incl. spaces).
 * "Acme Inc." and "ACME-INC" both collapse to "acmeinc". This is the key
 * merge-tracker uses for its every-batch dedup gate.
 */
export function companyKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Looser company key that preserves internal spaces (used historically by
 * dedup-tracker). "Acme Inc" → "acme inc". Kept distinct from companyKey()
 * because the two scripts genuinely differ on space handling; unifying them
 * changes dedup matching and wants the user's full dataset to validate.
 */
export function companyKeyLoose(name) {
  return String(name).toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/** Lowercase + collapse whitespace, for the dedup-index.tsv role key. */
export function normalizeRoleForIndex(role) {
  return String(role).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalize a role for token comparison: drop parens/punctuation, keep "/". */
export function normalizeRole(role) {
  return String(role).toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite', 'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

/**
 * Loose role match (merge-tracker): ≥2 shared words longer than 3 chars,
 * substring-tolerant. Quick "is this listing already tracked?" check.
 */
export function roleFuzzyMatch(a, b) {
  const wordsA = String(a).toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = String(b).toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return overlap.length >= 2;
}

/**
 * Strict role match (dedup-tracker): strips seniority/location stopwords, then
 * requires ≥2 exact shared tokens AND ≥60% overlap of the smaller set. Used
 * for the careful cleanup pass where a false merge loses a real application.
 */
export function roleMatchStrict(a, b) {
  const filter = (words) => words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));
  const wordsA = filter(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filter(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  return overlap.length >= 2 && overlap.length / smaller >= 0.6;
}

/* ───── Scalar field parsers ─────────────────────────────────────── */

// Score cell forms in applications.md (docs/scoring-v2.md §8.3):
//   v2      "W8.3 E5.6"   (Want + Ease; blocked listings are never promoted)
//   legacy  "7.4/10"      (v1 Overall; existing rows stay valid and display as-is)
const V2_CELL_RE = /^W\s*(\d+(?:\.\d+)?)\s*[ ·\/,]?\s*E\s*(\d+(?:\.\d+)?)$/i;
const LEGACY_CELL_RE = /^(\d+(?:\.\d+)?)(?:\s*\/\s*10)?$/;

/**
 * Parse an applications.md Score cell (or tracker-additions score column).
 *   "W8.3 E5.6" → { want: 8.3, ease: 5.6 }
 *   "7.4/10"    → { legacy: 7.4 }
 *   anything else ("N/A", "—", "", garbage) → null
 * Tolerates bold markers and a few separators ("W8.3 · E5.6", "W8.3/E5.6").
 * Mirrored by the frontend's applications parser.
 */
export function parseScoreCell(cell) {
  const s = String(cell ?? '').replace(/\*\*/g, '').trim();
  if (!s) return null;
  const v2 = s.match(V2_CELL_RE);
  if (v2) return { want: parseFloat(v2[1]), ease: parseFloat(v2[2]) };
  const legacy = s.match(LEGACY_CELL_RE);
  if (legacy) return { legacy: parseFloat(legacy[1]) };
  return null;
}

/** Canonical v2 cell text: formatScoreCell(8.3, 5.6) → "W8.3 E5.6". */
export function formatScoreCell(want, ease) {
  return `W${Number(want)} E${Number(ease)}`;
}

/** Human display of a score cell: "W8.3 · E5.6" for v2, "7.4/10" for legacy, raw text otherwise. */
export function displayScoreCell(cell) {
  const p = parseScoreCell(cell);
  if (!p) return String(cell ?? '').trim();
  if ('legacy' in p) return `${p.legacy}/10`;
  return `W${p.want} · E${p.ease}`;
}

/**
 * Sort key for "higher wins" comparisons: Priority = round(sqrt(want × ease), 2)
 * for v2 cells (spec §5), the legacy number for legacy cells, null when the
 * cell is unparseable.
 */
export function scoreCellPriority(cell) {
  const p = parseScoreCell(cell);
  if (!p) return null;
  if ('legacy' in p) return p.legacy;
  return Math.round(Math.sqrt(p.want * p.ease) * 100) / 100;
}

/**
 * Compare two score cells for "higher wins": > 0 when `a` is better than `b`,
 * < 0 when worse, 0 when equal. Unparseable cells rank below everything. On an
 * exact priority tie a v2 cell beats a legacy one (the newer model wins).
 */
export function compareScoreCells(a, b) {
  const pa = scoreCellPriority(a);
  const pb = scoreCellPriority(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  if (pa !== pb) return pa - pb;
  const v2a = 'want' in parseScoreCell(a);
  const v2b = 'want' in parseScoreCell(b);
  if (v2a === v2b) return 0;
  return v2a ? 1 : -1;
}

/**
 * Re-eval annotation for the Notes cell: "(W 7.1→8.3, E 5→5.6)" when both
 * cells are v2, otherwise "(7.4/10→W8.3 · E5.6)"-style old→new display.
 */
export function describeReEval(oldCell, newCell) {
  const o = parseScoreCell(oldCell);
  const n = parseScoreCell(newCell);
  if (o && n && 'want' in o && 'want' in n) {
    return `(W ${o.want}→${n.want}, E ${o.ease}→${n.ease})`;
  }
  return `(${displayScoreCell(oldCell)}→${displayScoreCell(newCell)})`;
}

/** Extract the report number from a "[#12](…)" / "[12](…)" link, else null. */
export function extractReportNum(reportStr) {
  const m = String(reportStr).match(/\[#?(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

/* ───── Status normalization ─────────────────────────────────────── */

/**
 * Coerce a raw status into a canonical state, applying aliases. Strips bold and
 * any trailing date. Unknown values default to 'Evaluated' (and warn). Used by
 * merge-tracker on incoming TSV additions.
 */
export function validateStatus(status, warn = console.warn) {
  const clean = String(status).replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }
  if (STATUS_ALIASES[lower]) return STATUS_ALIASES[lower];
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

/**
 * Map a raw status cell to a cleanup result for normalize-statuses:
 *   { status }                       → rewrite the cell
 *   { status, moveToNotes }          → rewrite + carry the original to notes
 *   { status: null, unknown: true }  → leave it, flag for the user
 * Distinct from validateStatus(): this one preserves DUPLICADO/repost context
 * by moving it to notes rather than discarding it, and reports unknowns instead
 * of silently defaulting.
 */
export function normalizeStatus(raw) {
  const s = String(raw).replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) return { status: 'Discarded', moveToNotes: String(raw).trim() };
  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };
  if (/^descartado$/i.test(s)) return { status: 'Discarded' };
  if (/^rechazada?$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };
  if (/^monitor$/i.test(s)) return { status: 'SKIP' };
  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };
  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: String(raw).trim() };
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  const canonical = ['Scouted', 'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  if (lower === 'scouting') return { status: 'Scouted' };
  if (lower === 'evaluada') return { status: 'Evaluated' };
  if (['aplicado', 'enviada', 'aplicada', 'applied', 'sent'].includes(lower)) return { status: 'Applied' };
  if (lower === 'respondido') return { status: 'Responded' };
  if (lower === 'entrevista') return { status: 'Interview' };
  if (lower === 'oferta') return { status: 'Offer' };
  if (['cerrada', 'descartada'].includes(lower)) return { status: 'Discarded' };
  if (['no aplicar', 'no_aplicar', 'skip'].includes(lower)) return { status: 'SKIP' };

  return { status: null, unknown: true };
}

/* ───── Report tier paths ────────────────────────────────────────── */

/**
 * Derive the report tier (1-4) from a score cell + status, for rewriting a
 * flat `reports/foo.md` path into its tier subfolder. SKIP → 4. A v2 cell goes
 * through the verdict grid (docs/scoring-v2.md §4; eligibility is not carried
 * in the cell, and amber is already priced into Ease, so green is assumed).
 * Legacy `X.X/10` cells and unparseable cells return null (v1 tier cut-offs are
 * retired) — the caller leaves the path untouched.
 */
export function tierForScoreCell(cell, status) {
  if (String(status || '').toLowerCase() === 'skip') return 4;
  const p = parseScoreCell(cell);
  if (!p || !('want' in p)) return null;
  const { tier } = verdictFromCells({ want: p.want, ease: p.ease, eligibility: 'green' });
  return Number(tier.slice(1));
}

/**
 * Reports live in tier subfolders (reports/tier-1…tier-4). If the writer left
 * a flat `reports/foo.md` path, rewrite it into the tier derived from the
 * score cell + status. Already-tiered paths, the "no report" sentinels and
 * cells without a derivable tier pass through.
 */
export function rewriteReportPathForOfertaTier(reportStr, scoreCell, status) {
  if (!reportStr || reportStr === '—' || reportStr === '-') return reportStr;
  if (/reports\/tier-\d\//.test(reportStr)) return reportStr;
  const tier = tierForScoreCell(scoreCell, status);
  if (tier === null) return reportStr;
  return reportStr.replace(/reports\//, `reports/tier-${tier}/`);
}

/* ───── Row parsing (the deadline-aware core) ────────────────────── */

/**
 * Column indices for an applications.md row, given whether the deadline cell is
 * present. Indices are into the raw `|`-split array (cells[0] is the empty
 * string before the leading pipe). Score/status/pdf are positionally fixed;
 * only report/notes shift when the deadline column is present.
 */
export function appColumns(hasDeadline) {
  return {
    num: 1, date: 2, company: 3, role: 4, score: 5, status: 6, pdf: 7,
    deadline: hasDeadline ? 8 : null,
    report: hasDeadline ? 9 : 8,
    notes: hasDeadline ? 10 : 9,
  };
}

/**
 * Parse one applications.md table row into a structured object, transparently
 * handling BOTH the 10-column (with Deadline) and legacy 9-column layouts.
 * Returns null for headers, separators, and rows without a numeric id.
 *
 * `cells` is the trimmed `|`-split array and `cols` the resolved index map, so
 * callers that mutate one field can rewrite the row precisely without
 * re-deriving where the columns live:
 *
 *   const row = parseAppRow(line);
 *   row.cells[row.cols.status] = 'Applied';
 *   line = serializeAppRow(row.cells);
 */
export function parseAppRow(line) {
  if (typeof line !== 'string' || !line.startsWith('|')) return null;
  const cells = line.split('|').map(s => s.trim());
  // A valid row needs at least the 9-column shape: '' + 9 fields + '' = 11.
  if (cells.length < 11) return null;
  const num = parseInt(cells[1], 10);
  if (isNaN(num) || num === 0) return null;

  // 10-column rows (deadline present) split into ≥12 cells; 9-column into 11.
  const hasDeadline = cells.length >= 12;
  const cols = appColumns(hasDeadline);
  return {
    num,
    date: cells[cols.date],
    company: cells[cols.company],
    role: cells[cols.role],
    score: cells[cols.score],
    status: cells[cols.status],
    pdf: cells[cols.pdf],
    deadline: cols.deadline === null ? null : cells[cols.deadline],
    report: cells[cols.report],
    notes: cells[cols.notes] ?? '',
    hasDeadline,
    cols,
    cells,
    raw: line,
  };
}

/** Rebuild a table row from a trimmed cells array (drops the leading/trailing empties). */
export function serializeAppRow(cells) {
  return '| ' + cells.slice(1, -1).join(' | ') + ' |';
}

/* ───── TSV additions (merge-tracker input) ──────────────────────── */

/**
 * Parse one tracker-additions TSV (or pipe-delimited markdown row) into a
 * normalized addition. The score column is a v2 `W8.3 E5.6` cell (legacy
 * `X.X/10` still accepted). Handles the canonical 10-col TSV, the legacy 9-col and
 * 8-col forms, and a pipe-delimited fallback. Tolerates the historical
 * status/score column swap via a value-shape heuristic. Returns null (and
 * warns) on malformed input.
 */
export function parseTsvAddition(content, filename = 'addition', warn = console.warn) {
  content = String(content).trim();
  if (!content) return null;

  let addition;

  if (content.startsWith('|')) {
    const parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // num | date | company | role | score | status | pdf | report | notes
    addition = {
      num: parseInt(parts[0], 10),
      date: parts[1], company: parts[2], role: parts[3],
      score: parts[4], status: validateStatus(parts[5], warn),
      pdf: parts[6], report: parts[7], notes: parts[8] || '',
      deadline: 'n/d',
    };
  } else {
    const parts = content.split('\t');
    if (parts.length < 8) {
      warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Columns 4/5 are (status, score) canonically, but some historical writers
    // emitted (score, status). Disambiguate by value shape.
    const col4 = parts[4].trim();
    const col5 = parts[5].trim();
    const looksScore = (v) => /^W\s*\d/i.test(v) || /^\d+\.?\d*\/\d+$/.test(v) || v === 'N/A' || v === 'DUP';
    const looksStatus = (v) => /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(v);

    let statusCol, scoreCol;
    if (looksStatus(col4) && !looksScore(col4)) { statusCol = col4; scoreCol = col5; }
    else if (looksScore(col4) && looksStatus(col5)) { statusCol = col5; scoreCol = col4; }
    else if (looksScore(col5) && !looksScore(col4)) { statusCol = col4; scoreCol = col5; }
    else { statusCol = col4; scoreCol = col5; }

    // 10-col: num date company role status score pdf deadline report notes
    //  9-col: num date company role status score pdf report notes
    const hasDeadline = parts.length >= 10;
    addition = {
      num: parseInt(parts[0], 10),
      date: parts[1], company: parts[2], role: parts[3],
      status: validateStatus(statusCol, warn), score: scoreCol, pdf: parts[6],
      deadline: hasDeadline ? (parts[7] || 'n/d') : 'n/d',
      report: hasDeadline ? parts[8] : parts[7],
      notes: hasDeadline ? (parts[9] || '') : (parts[8] || ''),
    };
  }

  if (isNaN(addition.num) || addition.num === 0) {
    warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  // Score validation: a v2 "W.. E.." cell, a legacy "X.X/10" cell, or the
  // N/A / DUP sentinels. Anything else (a "—" blocked marker, a v1-era
  // shape error) would poison the higher-wins comparison, so skip it loudly.
  const parsedScore = parseScoreCell(addition.score);
  if (parsedScore && 'want' in parsedScore) {
    addition.score = formatScoreCell(parsedScore.want, parsedScore.ease); // canonical spelling
  } else if (!parsedScore && !['N/A', 'DUP'].includes(String(addition.score).trim())) {
    warn(`⚠️  Skipping ${filename}: unparseable score "${addition.score}" (expected "W8.3 E5.6" or legacy "7.4/10")`);
    return null;
  }

  addition.report = rewriteReportPathForOfertaTier(addition.report, addition.score, addition.status);
  return addition;
}

/* ───── Score cell validation (verify-pipeline) ──────────────────── */

/**
 * Validate an applications.md Score cell. Returns an error string, or null when
 * the cell is acceptable: a v2 "W8.3 E5.6" (both in [1,10]), a legacy
 * "X.X/10", or the N/A / DUP sentinels. A "—" is invalid here — blocked
 * listings are never promoted into applications.md.
 */
export function validateScoreCell(cell) {
  const s = String(cell ?? '').replace(/\*\*/g, '').trim();
  if (s === 'N/A' || s === 'DUP') return null;
  const p = parseScoreCell(s);
  if (!p) return `invalid score format "${cell}" (expected "W8.3 E5.6" or legacy "7.4/10")`;
  if ('want' in p && (p.want < 1 || p.want > 10 || p.ease < 1 || p.ease > 10)) {
    return `score "${cell}" out of range (Want/Ease must be 1-10)`;
  }
  return null;
}

/* ───── Re-evaluation refresh (merge-scouting → applications.md) ───── */

/**
 * When a listing that is already in applications.md gets re-scored, its row
 * should show the new Want/Ease and link the new report instead of keeping a
 * stale score. Matching is deliberately strict — same company key AND
 * (identical normalized role OR roleMatchStrict) — because a loose match would
 * rewrite a different application at the same company (e.g. a student event
 * next to a graduate role).
 *
 *   lines    applications.md split on '\n'
 *   updates  [{ company, role, want, ease, report }]; want/ease numbers, or
 *            null for a Blocked re-eval (the row is then left untouched —
 *            blocked listings are never promoted, and its score stays as a
 *            record of the earlier evaluation). report '—' keeps the old link.
 *
 * Returns { lines, changed: [{ num, company, role, from, to }], matched } —
 * `matched` lists every application row an update matched (even when its
 * cells were already current) as { num, update }, so the caller can mark the
 * scouting row as promoted. Pure.
 */
export function refreshApplicationRows(lines, updates) {
  const out = [...lines];
  const changed = [];
  const matched = [];
  for (const u of updates) {
    if (!Number.isFinite(u.want) || !Number.isFinite(u.ease)) continue;
    const key = companyKey(u.company);
    const roleKey = normalizeRoleForIndex(u.role);
    for (let i = 0; i < out.length; i++) {
      const row = parseAppRow(out[i]);
      if (!row || companyKey(row.company) !== key) continue;
      if (normalizeRoleForIndex(row.role) !== roleKey && !roleMatchStrict(row.role, u.role)) continue;
      matched.push({ num: row.num, update: u });
      const to = formatScoreCell(u.want, u.ease);
      const from = row.score;
      row.cells[row.cols.score] = to;
      if (u.report && u.report !== '—') row.cells[row.cols.report] = u.report;
      const line = serializeAppRow(row.cells);
      if (line !== out[i]) {
        out[i] = line;
        changed.push({ num: row.num, company: row.company, role: row.role, from, to });
      }
    }
  }
  return { lines: out, changed, matched };
}

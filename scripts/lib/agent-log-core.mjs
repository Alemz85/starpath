// agent-log-core.mjs — pure logic for the agent issue log (data/agent-log.tsv).
//
// Agents (batch eval workers, mode sessions) self-report operational problems
// here instead of silently working around recurring breakage — a schema
// mismatch, an unparseable data file, a URL pattern that consistently fails
// verification, a rubric ambiguity. Maintenance sessions check unresolved
// entries first. Ported from Alke's chatctx/agent_log.py — that version wrote
// to a Supabase table over PostgREST; this repo has no DB, so the log is a
// plain TSV file instead. Shared across search profiles (not one of the
// `scripts/profile.mjs`-managed symlinks): operational issues are about the
// tooling, not any one search.
//
// All functions here are pure — no filesystem, no `Date.now()`, no globals.
// The CLI wrapper (scripts/agent-log.mjs) owns reading/writing
// data/agent-log.tsv and supplies `id` / `timestamp` so this file stays
// exhaustively unit-testable.

export const CATEGORIES = ['schema', 'data', 'url', 'rubric', 'other'];
export const SEVERITIES = ['low', 'med', 'high'];
export const DEFAULT_SEVERITY = 'med';
export const STATUSES = ['open', 'resolved'];

export const COLUMNS = [
  'id', 'timestamp', 'category', 'subject', 'severity',
  'message', 'status', 'resolved_at', 'resolution_note',
];
export const HEADER = COLUMNS.join('\t');

/* ───── TSV field escaping ─────────────────────────────────────────────────
 *
 * Free-text fields (subject, message, resolution_note) can contain tabs or
 * newlines — pasted URLs, JD snippets, multi-line "what happened" notes.
 * Escape backslash first, then tab/newline, so every row stays one line and
 * the round trip through unescapeField is lossless (mod \r\n → \n, which
 * counts as "collapsed" per the data contract, not corrupted).
 */

export function escapeField(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function unescapeField(value) {
  return String(value ?? '').replace(/\\(\\|t|n)/g, (_, ch) => (
    ch === '\\' ? '\\' : ch === 't' ? '\t' : '\n'
  ));
}

/* ───── Parse / serialize ─────────────────────────────────────────────────*/

/**
 * Parse data/agent-log.tsv content into row objects. Blank lines, the header
 * row, and malformed rows (too few columns, non-numeric id) are skipped —
 * a missing or empty file parses to [].
 */
export function parseRows(content) {
  const lines = String(content ?? '').split('\n').filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('id\t')) continue; // header row
    const cells = line.split('\t');
    if (cells.length < COLUMNS.length) continue;
    const id = Number.parseInt(cells[0], 10);
    if (!Number.isFinite(id)) continue;
    rows.push({
      id,
      timestamp: cells[1] ?? '',
      category: cells[2] ?? '',
      subject: unescapeField(cells[3]),
      severity: cells[4] ?? '',
      message: unescapeField(cells[5]),
      status: cells[6] ?? '',
      resolvedAt: cells[7] ?? '',
      resolutionNote: unescapeField(cells[8] ?? ''),
    });
  }
  return rows;
}

/** Serialize one row to a single TSV line (no trailing newline). */
export function serializeRow(row) {
  return [
    row.id,
    row.timestamp,
    row.category,
    escapeField(row.subject),
    row.severity,
    escapeField(row.message),
    row.status,
    row.resolvedAt ?? '',
    escapeField(row.resolutionNote ?? ''),
  ].join('\t');
}

/** Full file content: header + every row, each newline-terminated. */
export function serializeAll(rows) {
  return [HEADER, ...rows.map(serializeRow)].join('\n') + '\n';
}

/* ───── Entry construction ─────────────────────────────────────────────────*/

export function nextId(rows) {
  return rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

/** Build a new open entry (pure — id/timestamp supplied by the caller). */
export function buildEntry({ id, timestamp, category, subject, severity, message }) {
  return {
    id,
    timestamp,
    category,
    subject,
    severity: severity || DEFAULT_SEVERITY,
    message,
    status: 'open',
    resolvedAt: '',
    resolutionNote: '',
  };
}

/* ───── Filters / sort / limit ────────────────────────────────────────────*/

export function filterRows(rows, { unresolved = false, category = null } = {}) {
  return rows.filter((r) => {
    if (unresolved && r.status !== 'open') return false;
    if (category && r.category !== category) return false;
    return true;
  });
}

/** Newest first — id is monotonically increasing, so id-desc is newest-first. */
export function sortNewestFirst(rows) {
  return [...rows].sort((a, b) => b.id - a.id);
}

/** Cap at `limit` rows; a missing/non-positive/non-numeric limit returns all. */
export function limitRows(rows, limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return rows;
  return rows.slice(0, n);
}

/* ───── Counts (repeat-flag view) ─────────────────────────────────────────*/

/**
 * Entries grouped by (category, subject), most-repeated first. Ties broken
 * alphabetically by category then subject for deterministic output.
 */
export function computeCounts(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.category} ${r.subject}`;
    const entry = map.get(key) || { category: r.category, subject: r.subject, total: 0, open: 0 };
    entry.total += 1;
    if (r.status === 'open') entry.open += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return 0;
  });
}

/* ───── Resolve transition ────────────────────────────────────────────────*/

/**
 * Transition one entry to resolved. Returns a NEW rows array (originals
 * untouched) plus `found`. An unknown id leaves rows unchanged (new array,
 * same row objects) and `found: false` — the CLI turns that into an error.
 */
export function resolveRow(rows, id, { note = '', timestamp } = {}) {
  const targetId = Number.parseInt(id, 10);
  let found = false;
  const next = rows.map((r) => {
    if (r.id !== targetId) return r;
    found = true;
    return {
      ...r,
      status: 'resolved',
      resolvedAt: timestamp,
      resolutionNote: note ? note : r.resolutionNote,
    };
  });
  return { rows: next, found };
}

/* ───── Rendering (markdown, for non-JSON CLI output) ─────────────────────*/

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderList(rows) {
  if (rows.length === 0) return '_no agent-log entries_';
  const lines = [
    '| id | timestamp | category | subject | severity | message | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.timestamp} | ${r.category} | ${cell(r.subject)} | ${r.severity} | ` +
      `${cell(truncate(r.message, 80))} | ${r.status} |`
    );
  }
  return lines.join('\n');
}

export function renderCounts(counts) {
  if (counts.length === 0) return '_no agent-log entries_';
  const lines = [
    '| category | subject | total | open |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of counts) {
    lines.push(`| ${c.category} | ${cell(c.subject)} | ${c.total} | ${c.open} |`);
  }
  return lines.join('\n');
}

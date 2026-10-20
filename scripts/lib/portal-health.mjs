/**
 * portal-health.mjs — what the scanner remembers about boards that are not
 * healthy (data/portal-health.tsv).
 *
 * Only unhealthy boards have a row, so an empty (or missing) file means every
 * board is healthy. One row per board, keyed by `<provider>:<api url>`:
 *
 *   board  company  provider  consecutive_404  consecutive_errors  consecutive_empty
 *   last_error  last_checked  skip_until
 *
 * Outcomes recorded after each board fetch:
 *   ok      the board listed postings → the row is deleted (healthy again)
 *   empty   200 with zero postings   → consecutive_empty++ (a streak is worth a
 *           look: the board may have moved), the 404/error streaks reset
 *   404     a REAL not-found from the board endpoint → consecutive_404++; at the
 *           threshold (default 3) the board is skipped until `skip_until`
 *           (default 30 days). Network errors, timeouts, 429 and 5xx are
 *           `error`, never 404: they do not count toward dead-board memory.
 *   error   anything else → consecutive_errors++, no skip, 404 streak untouched
 *
 * After the skip window the next scan probes the board once; a success clears
 * the row, another 404 skips it again.
 *
 * Pure. scan.mjs owns the file IO.
 */

export const HEALTH_COLUMNS = Object.freeze([
  'board', 'company', 'provider', 'consecutive_404', 'consecutive_errors', 'consecutive_empty',
  'last_error', 'last_checked', 'skip_until',
]);
export const HEALTH_HEADER = HEALTH_COLUMNS.join('\t');

export const DEAD_BOARD_404S = 3;
export const DEAD_BOARD_SKIP_DAYS = 30;

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** Parse the file into Map<board, record>. Tolerates a missing header and junk lines. */
export function parseHealth(text) {
  const map = new Map();
  const lines = String(text ?? '').split('\n');
  const header = lines[0]?.split('\t');
  const cols = header && header[0] === 'board' ? header : HEALTH_COLUMNS;
  for (const line of header && header[0] === 'board' ? lines.slice(1) : lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const rec = {};
    cols.forEach((c, i) => { rec[c] = cells[i] ?? ''; });
    if (!rec.board) continue;
    for (const k of ['consecutive_404', 'consecutive_errors', 'consecutive_empty']) rec[k] = Number(rec[k]) || 0;
    map.set(rec.board, rec);
  }
  return map;
}

/** Serialize (header always written; no rows → just the header, i.e. all healthy). */
export function serializeHealth(map) {
  const rows = [...map.values()]
    .sort((a, b) => a.board.localeCompare(b.board))
    .map((r) => HEALTH_COLUMNS.map((c) => clean(r[c])).join('\t'));
  return [HEALTH_HEADER, ...rows].join('\n') + '\n';
}

export const boardKey = (providerId, apiUrl) => `${providerId}:${apiUrl}`;

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Is this board in its skip window? Dates are ISO (YYYY-MM-DD): skipped while
 * `today < skip_until`.
 * @returns {{skip: boolean, until: string, reason: string}}
 */
export function shouldSkip(map, board, today) {
  const r = map.get(board);
  if (r && r.skip_until && today < r.skip_until) {
    return { skip: true, until: r.skip_until, reason: `${r.consecutive_404} consecutive 404s` };
  }
  return { skip: false, until: '', reason: '' };
}

/**
 * Record one fetch outcome. Mutates and returns `map`.
 * @param {Map<string, object>} map
 * @param {{board:string, company:string, provider:string, outcome:'ok'|'empty'|'404'|'error',
 *          error?:string, today:string}} o
 * @param {{dead404s?:number, skipDays?:number}} [policy]
 */
export function recordOutcome(map, o, { dead404s = DEAD_BOARD_404S, skipDays = DEAD_BOARD_SKIP_DAYS } = {}) {
  if (o.outcome === 'ok') {
    map.delete(o.board);
    return map;
  }
  const rec = map.get(o.board) || {
    board: o.board, company: '', provider: '', consecutive_404: 0, consecutive_errors: 0,
    consecutive_empty: 0, last_error: '', last_checked: '', skip_until: '',
  };
  rec.company = clean(o.company);
  rec.provider = clean(o.provider);
  rec.last_checked = o.today;
  if (o.outcome === 'empty') {
    rec.consecutive_empty += 1;
    rec.consecutive_404 = 0;
    rec.consecutive_errors = 0;
    rec.skip_until = '';
    rec.last_error = '';
  } else if (o.outcome === '404') {
    rec.consecutive_404 += 1;
    rec.consecutive_empty = 0;
    rec.last_error = clean(o.error).slice(0, 200);
    if (rec.consecutive_404 >= dead404s) rec.skip_until = addDays(o.today, skipDays);
  } else {
    rec.consecutive_errors += 1;
    rec.last_error = clean(o.error).slice(0, 200);
  }
  map.set(o.board, rec);
  return map;
}

/** Boards whose empty streak is at least `n` scans: worth a look, never skipped. */
export function longEmptyBoards(map, n = 3) {
  return [...map.values()].filter((r) => r.consecutive_empty >= n);
}

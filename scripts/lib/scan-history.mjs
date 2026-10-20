/**
 * scan-history.mjs — schema + row helpers for data/scan-history.tsv.
 *
 * The file is header-named: readers find columns by NAME (the frontend's
 * deriveLiveness does), so new columns only ever get appended and old files
 * keep working. The first eight columns are the original schema and never move;
 * everything after them is optional, and a row shorter than the header simply
 * has empty trailing cells.
 *
 *   url            canonical posting URL (as the ATS gave it)
 *   first_seen     date our scanner first saw it
 *   portal         source, e.g. `greenhouse-api`, `jobspy-indeed`
 *   title, company
 *   location       the location string AS THE SOURCE GAVE IT (display; may be a
 *                  comma-joined multi-city string)
 *   status         `added`
 *   scan_dates     `|`-joined dates the posting was seen in a scan
 *   posted_date    ISO date the ATS says it was posted ('' when unknown)
 *   deadline       ISO application deadline ('' unless the source states one)
 *   posting_id     ATS-native posting id (identity together with `portal`)
 *   req_id         requisition id — a label, never an identity on its own
 *   locations      `|`-joined SEPARATE locations (the split of `location`)
 *
 * Display date for a listing: deadline, else posted_date, else first_seen
 * (`pickDisplayDate`).
 */

import { splitLocations } from './listing-fields.mjs';

export const HISTORY_COLUMNS = Object.freeze([
  'url', 'first_seen', 'portal', 'title', 'company', 'location', 'status', 'scan_dates',
  'posted_date', 'deadline', 'posting_id', 'req_id', 'locations',
]);
export const HISTORY_HEADER_FULL = HISTORY_COLUMNS.join('\t');

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** Header line → column names, or null when the line is not a scan-history header. */
export function parseHistoryHeader(line) {
  const cols = String(line ?? '').replace(/\r$/, '').split('\t');
  return cols[0] === 'url' && cols.includes('first_seen') ? cols : null;
}

/**
 * Columns to write: the file's own columns (their order kept), plus any known
 * column it lacks appended at the end. Unknown extra columns survive.
 */
export function upgradeColumns(existing) {
  if (!existing || existing.length === 0) return [...HISTORY_COLUMNS];
  return [...existing, ...HISTORY_COLUMNS.filter((c) => !existing.includes(c))];
}

/** Parse a whole file: `{columns, rows}` where rows are raw data lines. */
export function parseHistoryFile(text) {
  const lines = String(text ?? '').split('\n');
  const header = parseHistoryHeader(lines[0]);
  const columns = header || [...HISTORY_COLUMNS.slice(0, 8)];
  const rows = (header ? lines.slice(1) : lines).filter((l) => l.trim());
  return { columns, rows };
}

/** Read one named cell of a raw row ('' when absent). */
export function getCell(row, columns, name) {
  const i = columns.indexOf(name);
  if (i < 0) return '';
  return String(row).split('\t')[i] ?? '';
}

/** Return `row` with the named cells set (padding short rows). */
export function setCells(row, columns, patch) {
  const cells = String(row).split('\t');
  for (const [name, value] of Object.entries(patch)) {
    const i = columns.indexOf(name);
    if (i < 0) continue;
    while (cells.length <= i) cells.push('');
    cells[i] = clean(value);
  }
  return cells.join('\t');
}

/**
 * Re-lay a staging row (laid out by `fromCols`) into the canonical column order
 * `toCols`; cells with no source stay empty. Lets JobSpy staging written by an
 * older (8-column) scan.py merge into a wider canonical file and vice versa.
 */
export function alignRow(row, fromCols, toCols) {
  if (fromCols.length === toCols.length && fromCols.every((c, i) => c === toCols[i])) return String(row);
  const cells = String(row).split('\t');
  return toCols.map((c) => {
    const i = fromCols.indexOf(c);
    return i < 0 ? '' : (cells[i] ?? '');
  }).join('\t');
}

/**
 * Build one scan-history line from a scanned offer.
 * @param {{url:string, source:string, title:string, company:string, location?:string,
 *          postedDate?:string|null, deadline?:string|null, postingId?:string, reqId?:string,
 *          locations?:string[]}} o
 * @param {string} date scan date (YYYY-MM-DD)
 * @param {string[]} [columns] target layout (default: canonical)
 */
export function buildHistoryRow(o, date, columns = HISTORY_COLUMNS) {
  const values = {
    url: o.url,
    first_seen: date,
    portal: o.source,
    title: o.title,
    company: o.company,
    location: o.location || '',
    status: 'added',
    scan_dates: date,
    posted_date: o.postedDate || '',
    deadline: o.deadline || '',
    posting_id: o.postingId || '',
    req_id: o.reqId || '',
    locations: (o.locations || []).map(clean).filter(Boolean).join('|'),
  };
  return columns.map((c) => clean(values[c] ?? '')).join('\t');
}

/**
 * Display date for a listing: deadline → posted date → first scan date.
 * @returns {{kind:'deadline'|'posted'|'scanned', date:string}|null}
 */
export function pickDisplayDate({ deadline, postedDate, firstSeen } = {}) {
  if (deadline) return { kind: 'deadline', date: deadline };
  if (postedDate) return { kind: 'posted', date: postedDate };
  if (firstSeen) return { kind: 'scanned', date: firstSeen };
  return null;
}

/**
 * Fill the `locations` cell of rows that lack one by splitting their `location`
 * string (JobSpy hands us only the one string). Rows that already carry a
 * `locations` value, or whose location splits to nothing, are returned as is.
 */
export function fillLocations(rows, columns, knownPlaces = []) {
  return rows.map((row) => {
    if (getCell(row, columns, 'locations')) return row;
    const list = splitLocations(getCell(row, columns, 'location'), { knownPlaces });
    return list.length ? setCells(row, columns, { locations: list.join('|') }) : row;
  });
}

/**
 * status-ledger.mjs — the one write path for an application's status, and
 * its history.
 *
 * Every status change (CLI, app dropdown/drag, chat confirm card) goes through
 * `setStatus*`: it validates the target against templates/states.yml, rewrites
 * the row's Status cell in data/applications.md under the tracker lock
 * (dir-lock.mjs) with an atomic write (write-file-atomic.mjs), and appends one
 * row to the status log in the same critical section.
 *
 * The log is `status-log.tsv` beside the real applications.md (so it follows
 * the active profile; `data/status-log.tsv` without profiles). Columns are
 * named by its header line, so readers never index by position:
 *
 *   num  date  company  role  from  to  stage  source  note  logged_at
 *
 * `date` is when the change happened (defaults to today, may be in the past:
 * rejections are often logged late); `logged_at` is when it was written.
 * `from` is empty on an origin row (the status a row started with: written by
 * merge-tracker for new rows, or by `backfill` for rows that predate the log).
 * `stage` is optional free text (where a rejection happened, say).
 *
 * Pure helpers + small sync/async I/O wrappers; unit-tested in
 * status-ledger.test.mjs. Electron main loads this module through
 * importRepoModule, so keep it free of process-wide side effects.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { CANONICAL_STATES, parseAppRow, serializeAppRow } from './tracker-core.mjs'
import { acquireLock, lockPathFor, withLockSync } from './dir-lock.mjs'
import { resolveWriteTarget, writeFileAtomic } from './write-file-atomic.mjs'

export const LEDGER_NAME = 'status-log.tsv'
export const LEDGER_COLUMNS = ['num', 'date', 'company', 'role', 'from', 'to', 'stage', 'source', 'note', 'logged_at']
export const SOURCES = ['cli', 'app', 'chat', 'merge-tracker', 'backfill', 'normalize', 'dedup', 'promote']

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/** The status log that belongs to an applications.md (resolved through links). */
export function ledgerPathFor(appsFile) {
  return join(dirname(resolveWriteTarget(appsFile)), LEDGER_NAME)
}

/* ───── States ───────────────────────────────────────────────────── */

/** [{ id, label, aliases }] from templates/states.yml; the built-in list if unreadable. */
export function loadStates(statesFile) {
  try {
    const doc = yaml.load(readFileSync(statesFile, 'utf-8'))
    const states = (doc?.states ?? [])
      .filter((s) => s && typeof s.label === 'string')
      .map((s) => ({ id: String(s.id ?? s.label).toLowerCase(), label: s.label, aliases: (s.aliases ?? []).map(String) }))
    if (states.length) return states
  } catch { /* fall through */ }
  return CANONICAL_STATES.map((label) => ({ id: label.toLowerCase(), label, aliases: [] }))
}

/** The canonical label for a status (label, id or alias, any case), or null. */
export function canonicalStatus(input, states) {
  const s = String(input ?? '').replace(/\*\*/g, '').trim().toLowerCase()
  if (!s) return null
  for (const st of states) {
    if (st.label.toLowerCase() === s || st.id === s || st.aliases.some((a) => a.toLowerCase() === s)) return st.label
  }
  return null
}

/* ───── Dates and cells ──────────────────────────────────────────── */

/** Today as YYYY-MM-DD in local time. */
export function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** An error message for a bad event date, or null. Past dates are fine; future ones are not. */
export function dateError(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return `date must be YYYY-MM-DD, got "${date}"`
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return `"${date}" is not a real date`
  if (date > today) return `date ${date} is in the future`
  return null
}

/** A value safe for one TSV cell (and one markdown table cell). */
export function cleanCell(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\|/g, '/').trim()
}

/* ───── Ledger parse / format ────────────────────────────────────── */

/** { header, rows } — rows are objects keyed by header names, plus `_i` (file order). */
export function parseLedger(raw) {
  const lines = String(raw ?? '').split('\n').filter((l) => l.trim() !== '')
  if (!lines.length) return { header: [...LEDGER_COLUMNS], rows: [] }
  const header = lines[0].split('\t').map((h) => h.trim())
  const rows = lines.slice(1).map((line, i) => {
    const cells = line.split('\t')
    const row = { _i: i }
    header.forEach((h, j) => { row[h] = (cells[j] ?? '').trim() })
    row.num = Number(row.num)
    return row
  })
  return { header, rows }
}

export function formatLedgerRow(entry, header = LEDGER_COLUMNS) {
  return header.map((h) => cleanCell(entry[h])).join('\t')
}

const key = (s) => String(s ?? '').trim().toLowerCase()

/** Does a ledger row belong to this application? Number first; company/role guard reuse of a number. */
export function entryMatches(entry, app) {
  if (entry.num !== app.num) return false
  if (!entry.company && !entry.role) return true
  return key(entry.company) === key(app.company) && key(entry.role) === key(app.role)
}

/** Chronological: by event date, then by order written. */
export function sortHistory(entries) {
  return [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._i - b._i))
}

/* ───── applications.md rows ─────────────────────────────────────── */

/** The application rows (parsed) matching { num } or { company, role }. */
export function matchingRows(lines, { num, company, role }) {
  const hits = []
  lines.forEach((line, index) => {
    const row = parseAppRow(line)
    if (!row) return
    if (num != null) {
      if (row.num !== Number(num)) return
      if ((company && key(company) !== key(row.company)) || (role && key(role) !== key(row.role))) {
        throw fail('EMISMATCH', `#${num} is ${row.company} — ${row.role}, not ${company} — ${role}`)
      }
    } else if (key(row.company) !== key(company) || key(row.role) !== key(role)) {
      return
    }
    hits.push({ index, row })
  })
  return hits
}

/**
 * Plan a status change on the applications.md text. Pure. Returns
 * { raw, changes: [{ num, company, role, from, to }] } — `raw` is the new
 * text (unchanged when every match already has the status).
 */
export function planStatusChange(appsRaw, target, to) {
  const lines = String(appsRaw).split('\n')
  const hits = matchingRows(lines, target)
  if (!hits.length) {
    const what = target.num != null ? `#${target.num}` : `${target.company} — ${target.role}`
    throw fail('ENOAPP', `${what} is not in applications.md`)
  }
  const changes = []
  for (const { index, row } of hits) {
    const from = row.status
    if (from === to) continue
    row.cells[row.cols.status] = to
    lines[index] = serializeAppRow(row.cells)
    changes.push({ num: row.num, company: row.company, role: row.role, from, to })
  }
  return { raw: lines.join('\n'), changes }
}

/**
 * Ledger entries for status changes a script made itself, in one pass over the
 * file ({ num, company, role, from, to } each). For writers that rewrite more
 * than the Status cell (normalize-statuses, dedup-tracker); a plain status
 * change goes through setStatus. Pure.
 */
export function statusChangeEntries(changes, { source, note = '', now = new Date() } = {}) {
  if (!SOURCES.includes(source)) throw fail('EBADSOURCE', `source must be one of ${SOURCES.join(', ')}`)
  const date = todayLocal(now)
  const loggedAt = now.toISOString()
  return changes.map((c) => ({
    num: c.num, company: c.company, role: c.role, from: c.from, to: c.to,
    date, stage: '', source, note: c.note ?? note, logged_at: loggedAt,
  }))
}

/* ───── I/O (callers hold the applications.md lock) ──────────────── */

/** Append entries to the log, writing the header first when the file is new. */
export function appendLedger(ledgerFile, entries) {
  if (!entries.length) return
  const target = resolveWriteTarget(ledgerFile)
  const existing = existsSync(target) ? readFileSync(target, 'utf-8') : ''
  const header = existing.trim() ? parseLedger(existing).header : LEDGER_COLUMNS
  let out = ''
  if (!existing.trim()) out += LEDGER_COLUMNS.join('\t') + '\n'
  else if (!existing.endsWith('\n')) out += '\n'
  out += entries.map((e) => formatLedgerRow(e, header)).join('\n') + '\n'
  appendFileSync(target, out)
}

export function readLedger(ledgerFile) {
  try { return parseLedger(readFileSync(ledgerFile, 'utf-8')) } catch { return parseLedger('') }
}

function normalizeRequest(req, states, now) {
  const to = canonicalStatus(req.to, states)
  if (!to) throw fail('EBADSTATUS', `"${req.to}" is not a status (use ${states.map((s) => s.label).join(', ')})`)
  const today = todayLocal(now)
  const date = req.date ? String(req.date).trim() : today
  const bad = dateError(date, today)
  if (bad) throw fail('EBADDATE', bad)
  const source = req.source ? String(req.source) : 'cli'
  if (!SOURCES.includes(source)) throw fail('EBADSOURCE', `source must be one of ${SOURCES.join(', ')}`)
  const num = req.num == null || req.num === '' ? null : Number(req.num)
  if (num !== null && (!Number.isInteger(num) || num <= 0)) throw fail('EBADNUM', `"${req.num}" is not an application number`)
  if (num === null && (!req.company || !req.role)) throw fail('EBADTARGET', 'give an application number, or company and role')
  return { to, date, source, num, company: req.company, role: req.role, stage: req.stage ?? '', note: req.note ?? '' }
}

/** The whole change, assuming the caller holds the lock. */
export function setStatusUnlocked(req) {
  const { appsFile, statesFile, now = new Date() } = req
  const states = loadStates(statesFile)
  const r = normalizeRequest(req, states, now)
  if (!existsSync(appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  const raw = readFileSync(appsFile, 'utf-8')
  const plan = planStatusChange(raw, { num: r.num, company: r.company, role: r.role }, r.to)
  if (!plan.changes.length) {
    return { changed: false, to: r.to, date: r.date, entries: [] }
  }
  writeFileAtomic(appsFile, plan.raw)
  const loggedAt = now.toISOString()
  const entries = plan.changes.map((c) => ({
    ...c, date: r.date, stage: r.stage, source: r.source, note: r.note, logged_at: loggedAt,
  }))
  appendLedger(ledgerPathFor(appsFile), entries)
  return { changed: true, to: r.to, date: r.date, entries }
}

/** Synchronous status change (CLI). Blocks until the lock is free. */
export function setStatus(req) {
  if (!existsSync(req.appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  return withLockSync(lockPathFor(req.appsFile), () => setStatusUnlocked(req), { label: `set-status ${req.source ?? 'cli'}`, ...req.lockOpts })
}

/** Async status change (Electron main: never blocks the event loop while waiting). */
export async function setStatusAsync(req) {
  if (!existsSync(req.appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  const handle = await acquireLock(lockPathFor(req.appsFile), { label: `set-status ${req.source ?? 'app'}`, ...req.lockOpts })
  try { return setStatusUnlocked(req) } finally { handle.release() }
}

/* ───── Corrections ──────────────────────────────────────────────── */

/**
 * Correct the date and/or stage of an application's latest logged move to
 * `to` (a rejection backfilled with an approximate date, say). Pure: takes the
 * parsed ledger rows and the application row, returns
 * { rows, entry, changed, appended }. The row is edited in place, keeps its
 * `logged_at`, and gets a "corrected <today>" note so the log shows it moved.
 * When the log has no such move but the application has that status now (a
 * row older than the log), one entry is added with `from` empty, like an
 * origin row. `date` / `stage` left undefined are kept; `stage: ''` clears it.
 */
export function planAmend(ledgerRows, app, to, { date, stage, source = 'cli' } = {}, { now = new Date() } = {}) {
  const today = todayLocal(now)
  if (date !== undefined) {
    const bad = dateError(date, today)
    if (bad) throw fail('EBADDATE', bad)
  }
  const mine = sortHistory(ledgerRows.filter((e) => entryMatches(e, app) && e.to === to))
  const last = mine[mine.length - 1]
  const mark = `corrected ${today}`
  if (last) {
    const next = { ...last }
    if (date !== undefined) next.date = date
    if (stage !== undefined) next.stage = cleanCell(stage)
    const changed = next.date !== last.date || next.stage !== last.stage
    if (!changed) return { rows: ledgerRows, entry: last, changed: false, appended: false }
    if (!String(next.note ?? '').includes(mark)) next.note = [last.note, mark].filter(Boolean).join('; ')
    return { rows: ledgerRows.map((e) => (e === last ? next : e)), entry: next, changed: true, appended: false }
  }
  if (app.status !== to) throw fail('ENOENTRY', `${app.company} — ${app.role} has no move to ${to} on record`)
  const entry = {
    num: app.num, date: date ?? today, company: app.company, role: app.role,
    from: '', to, stage: cleanCell(stage ?? ''), source, note: `recorded after the fact; ${mark}`,
    logged_at: now.toISOString(),
  }
  return { rows: [...ledgerRows, { ...entry, _i: ledgerRows.length }], entry, changed: true, appended: true }
}

/** The whole correction, assuming the caller holds the applications.md lock. */
export function amendStatusUnlocked(req) {
  const { appsFile, statesFile, now = new Date() } = req
  const states = loadStates(statesFile)
  const to = canonicalStatus(req.to, states)
  if (!to) throw fail('EBADSTATUS', `"${req.to}" is not a status (use ${states.map((s) => s.label).join(', ')})`)
  const source = req.source ? String(req.source) : 'cli'
  if (!SOURCES.includes(source)) throw fail('EBADSOURCE', `source must be one of ${SOURCES.join(', ')}`)
  if (!existsSync(appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  const num = req.num == null || req.num === '' ? null : Number(req.num)
  if (num === null && (!req.company || !req.role)) throw fail('EBADTARGET', 'give an application number, or company and role')
  const hit = matchingRows(readFileSync(appsFile, 'utf-8').split('\n'), { num, company: req.company, role: req.role })[0]
  if (!hit) throw fail('ENOAPP', `${num != null ? `#${num}` : `${req.company} — ${req.role}`} is not in applications.md`)
  const date = req.date === undefined || req.date === null || req.date === '' ? undefined : String(req.date).trim()
  const ledgerFile = ledgerPathFor(appsFile)
  const { header, rows } = readLedger(ledgerFile)
  const plan = planAmend(rows, hit.row, to, { date, stage: req.stage, source }, { now })
  if (!plan.changed) return { changed: false, entry: stripIndex(plan.entry) }
  if (plan.appended) appendLedger(ledgerFile, [plan.entry])
  else writeFileAtomic(ledgerFile, [header.join('\t'), ...plan.rows.map((e) => formatLedgerRow(e, header))].join('\n') + '\n')
  return { changed: true, entry: stripIndex(plan.entry) }
}

const stripIndex = ({ _i, ...rest }) => rest

/** Synchronous correction (CLI). */
export function amendStatus(req) {
  if (!existsSync(req.appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  return withLockSync(lockPathFor(req.appsFile), () => amendStatusUnlocked(req), { label: `amend-status ${req.source ?? 'cli'}`, ...req.lockOpts })
}

/** Async correction (Electron main). */
export async function amendStatusAsync(req) {
  if (!existsSync(req.appsFile)) throw fail('ENOAPP', 'applications.md does not exist')
  const handle = await acquireLock(lockPathFor(req.appsFile), { label: `amend-status ${req.source ?? 'app'}`, ...req.lockOpts })
  try { return amendStatusUnlocked(req) } finally { handle.release() }
}

/**
 * Status history. With { num } or { company, role }: that application's
 * entries, oldest first. With neither: every entry, oldest first (the
 * Applying board reads it once and groups by application).
 */
export function readHistory({ appsFile, num = null, company = null, role = null }) {
  const { rows } = readLedger(ledgerPathFor(appsFile))
  const strip = ({ _i, ...rest }) => rest
  if (num == null && !company) return sortHistory(rows).map(strip)
  let app = null
  if (existsSync(appsFile)) {
    const lines = readFileSync(appsFile, 'utf-8').split('\n')
    try { app = matchingRows(lines, { num, company, role })[0]?.row ?? null } catch { app = null }
  }
  const want = app ?? { num: Number(num), company, role }
  const hits = rows.filter((e) => (want.num ? entryMatches(e, want) : key(e.company) === key(want.company) && key(e.role) === key(want.role)))
  return sortHistory(hits).map(strip)
}

/**
 * Origin rows for applications the log has never seen. One per application,
 * source `backfill`, dated with the row's own date. When later changes are
 * already logged, the origin status is the earliest `from` (the status the
 * row had before them); otherwise the current status. Idempotent: an
 * application that already has an origin row is skipped. Pure.
 */
export function planBackfill(appsRaw, ledgerRows, { now = new Date() } = {}) {
  const today = todayLocal(now)
  const loggedAt = now.toISOString()
  const out = []
  for (const line of String(appsRaw).split('\n')) {
    const app = parseAppRow(line)
    if (!app) continue
    const mine = sortHistory(ledgerRows.filter((e) => entryMatches(e, app)))
    if (mine.some((e) => e.from === '')) continue
    if (out.some((e) => e.num === app.num)) continue
    const start = mine.length ? mine[0].from : app.status
    out.push({
      num: app.num,
      date: dateError(app.date, today) ? today : app.date,
      company: app.company, role: app.role,
      from: '', to: start, stage: '', source: 'backfill',
      note: 'seeded from applications.md', logged_at: loggedAt,
    })
  }
  return out
}

/** Seed the log from applications.md (under the lock). Returns the rows added. */
export function backfill({ appsFile, dryRun = false, now = new Date(), lockOpts = {} }) {
  if (!existsSync(appsFile)) throw fail('ENOAPP', `no applications.md at ${appsFile}`)
  return withLockSync(lockPathFor(appsFile), () => {
    if (!existsSync(appsFile)) return []
    const ledgerFile = ledgerPathFor(appsFile)
    const entries = planBackfill(readFileSync(appsFile, 'utf-8'), readLedger(ledgerFile).rows, { now })
    if (!dryRun) appendLedger(ledgerFile, entries)
    return entries
  }, { label: 'status backfill', ...lockOpts })
}

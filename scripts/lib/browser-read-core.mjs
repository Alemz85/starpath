/**
 * browser-read-core.mjs — pure logic for listings that only a real browser
 * can read (scripts/browser-read.mjs does the locked I/O).
 *
 * Some sites answer every script with HTTP 403 or an empty shell (headless
 * browsers included). Starpath never tries to get around that: no stealth
 * browser, no faked user agent. Instead the listing is *parked*: its line
 * leaves the Pending inbox for a `## Needs a browser read` section and one
 * Messages alert asks a person to open it. Once someone saved the posting
 * text under `jds/` (by pasting it into the app's chat, or a Claude Code
 * session reading it in a browser), *requeue* puts the line back in Pending
 * with a `JD saved: <path>` note, and the next evaluation reads that file
 * instead of fetching the page.
 *
 * Parked line (the `[!]` box keeps it out of every Pending parser, the way
 * `- [!] FILTERED` lines are):
 *
 *   - [!] BROWSER READ | <url> | <Company> | <Role> | YYYY-MM-DD: <why>
 *
 * Requeued line (an ordinary pending line; parsers read Company and Role
 * from the first two fields and ignore the rest):
 *
 *   - [ ] <url> | <Company> | <Role> | JD saved: jds/<file>.md (browser read YYYY-MM-DD)
 *
 * No fs and no clock here; dates come from the caller. Tested in
 * browser-read-core.test.mjs.
 */

import { createHash } from 'node:crypto'
import { canonicalizeUrl } from './merge-staging-core.mjs'
import { archiveFileName } from './jd-archive-core.mjs'

export const PARKED_HEADING = '## Needs a browser read'
export const PARKED_TAG = 'BROWSER READ'
export const KEY_PREFIX = 'browser-read:'
export const JD_SAVED = 'JD saved:'
export const PIPELINE_SCAFFOLD = '# Pipeline — Pending Evaluations\n\n## Pending\n'

const PENDING_RE = /^- \[ \] (https?:\/\/\S+)(.*)$/
const PARKED_RE = /^- \[!\] BROWSER READ \| (https?:\/\/\S+) \|([^|]*)\|([^|]*)\|\s*(\d{4}-\d{2}-\d{2}):\s*(.*)$/
const JD_SAVED_RE = /JD saved:\s*(\S+)/

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/** One-line cell text: no pipes (they split fields), no newlines. */
export function cell(s) {
  return String(s ?? '').replace(/[|\r\n]+/g, ' / ').replace(/\s+/g, ' ').replace(/^[\s/]+|[\s/]+$/g, '').trim()
}

/** Stable id of a listing URL (tracking params, `www.`, fragments don't change it). */
export function urlId(url) {
  return createHash('sha1').update(String(canonicalizeUrl(String(url ?? '').trim()))).digest('hex').slice(0, 12)
}

/** The Messages dedupe key for a listing: one alert per URL, never repeated while open. */
export function messageKey(url) {
  return `${KEY_PREFIX}${urlId(url)}`
}

const sameUrl = (a, b) => canonicalizeUrl(a) === canonicalizeUrl(b)

/* ───── Lines ────────────────────────────────────────────────────── */

export function parkedLine({ url, company, role, date, why }) {
  return `- [!] ${PARKED_TAG} | ${url} | ${cell(company)} | ${cell(role)} | ${date}: ${cell(why) || 'unreadable without a browser'}`
}

/** `{ url, company, role, date, why }` for a parked line, else null. */
export function parseParkedLine(line) {
  const m = PARKED_RE.exec(String(line ?? '').trim())
  if (!m) return null
  return { url: m[1], company: m[2].trim(), role: m[3].trim(), date: m[4], why: m[5].trim() }
}

/** Is this line meant to be a parked line (so a malformed one can be reported)? */
export function looksParked(line) {
  return String(line ?? '').trim().startsWith(`- [!] ${PARKED_TAG}`)
}

/** `{ url, fields }` for a pending `- [ ]` line, else null. */
export function parsePendingLine(line) {
  const m = PENDING_RE.exec(String(line ?? '').trim())
  if (!m) return null
  return { url: m[1], fields: m[2].split('|').map((s) => s.trim()).filter(Boolean) }
}

export function jdSavedNote(path, date) {
  return `${JD_SAVED} ${path} (browser read ${date})`
}

/** The saved-JD path a line's note names, or null. */
export function jdSavedPath(line) {
  const m = JD_SAVED_RE.exec(String(line ?? ''))
  return m ? m[1] : null
}

export function pendingLine({ url, company, role, note }) {
  const base = `- [ ] ${url} | ${cell(company)} | ${cell(role)}`
  return note ? `${base} | ${cell(note)}` : base
}

/** Company / Role from a pending line's fields (the scanner writes them first). */
function namesFromPending(fields) {
  const isNote = (f) => /^relevance [0-9.]/.test(f) || /^NOT EVALUATED/i.test(f) || f.startsWith(JD_SAVED)
  const named = fields.filter((f) => !isNote(f))
  return { company: named[0] ?? '', role: named[1] ?? '' }
}

/* ───── Sections ─────────────────────────────────────────────────── */

const isHeading = (line) => /^## /.test(line)

/** [start, end) line range of the section under `heading` (start = heading line), or null. */
function sectionRange(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (isHeading(lines[i])) { end = i; break }
  return [start, end]
}

/** Index just past the last non-blank line of a section. */
function sectionTail(lines, [start, end]) {
  let at = end
  while (at > start + 1 && !lines[at - 1].trim()) at--
  return at
}

/**
 * Insert `line` at the end of the section under `heading`, creating the
 * section when it is missing: right after `afterHeading`'s section when that
 * exists, else before the first `## ` heading, else at the end.
 */
function insertInSection(lines, heading, line, afterHeading = null) {
  const range = sectionRange(lines, heading)
  if (range) {
    lines.splice(sectionTail(lines, range), 0, line)
    return lines
  }
  const after = afterHeading ? sectionRange(lines, afterHeading) : null
  let at
  if (after) at = after[1]
  else {
    at = lines.findIndex(isHeading)
    if (at === -1) at = lines.length
  }
  // A blank line on each side keeps the markdown readable.
  const block = [heading, line, '']
  if (at > 0 && lines[at - 1].trim()) block.unshift('')
  lines.splice(at, 0, ...block)
  return lines
}

/** Drop a section whose heading is all that is left (blank lines aside). */
function dropIfEmpty(lines, heading) {
  const range = sectionRange(lines, heading)
  if (!range) return lines
  const [start, end] = range
  if (lines.slice(start + 1, end).some((l) => l.trim())) return lines
  lines.splice(start, end - start)
  // Collapse the double blank the removal can leave behind.
  if (start > 0 && start < lines.length && !lines[start - 1].trim() && !lines[start].trim()) lines.splice(start, 1)
  return lines
}

function splitLines(text) {
  const t = String(text ?? '')
  return (t.trim() ? t : PIPELINE_SCAFFOLD).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
}

const joinLines = (lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'

/** Remove every pending and parked line for `url`; returns what was removed. */
function takeLines(lines, url) {
  const pending = []
  const parked = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = parsePendingLine(lines[i])
    if (p && sameUrl(p.url, url)) { pending.unshift(p); lines.splice(i, 1); continue }
    const k = parseParkedLine(lines[i])
    if (k && sameUrl(k.url, url)) { parked.unshift(k); lines.splice(i, 1) }
  }
  return { pending, parked }
}

function pickNames({ company, role }, { pending, parked }) {
  const fromPending = pending.map((p) => namesFromPending(p.fields))
  const c = cell(company) || parked.map((k) => k.company).find(Boolean) || fromPending.map((n) => n.company).find(Boolean) || ''
  const r = cell(role) || parked.map((k) => k.role).find(Boolean) || fromPending.map((n) => n.role).find(Boolean) || ''
  return { company: c, role: r }
}

/* ───── Park / requeue ───────────────────────────────────────────── */

function checkUrl(url) {
  const u = String(url ?? '').trim()
  if (!/^https?:\/\/\S+$/i.test(u)) throw fail('EBADARGS', `--url must be an http(s) URL (got "${url ?? ''}")`)
  return u
}

/**
 * Move a listing out of Pending into the parked section. Pending lines for
 * the URL (and an older parked line) are replaced by one parked line, so a
 * second park only refreshes the date and reason. Company and Role default to
 * what the pending line carried. Returns `{ text, line, company, role, wasPending, wasParked }`.
 */
export function parkInPipeline(text, { url, company, role, why, date }) {
  const u = checkUrl(url)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw fail('EBADARGS', 'date must be YYYY-MM-DD')
  if (!cell(why)) throw fail('EBADARGS', '--why is required: say in a few words why no script could read it')
  const lines = splitLines(text)
  const taken = takeLines(lines, u)
  const names = pickNames({ company, role }, taken)
  if (!names.company || !names.role) throw fail('EBADARGS', 'name the listing: --company and --role (the pipeline line does not carry them)')
  const line = parkedLine({ url: u, ...names, date, why })
  insertInSection(lines, PARKED_HEADING, line, '## Pending')
  return { text: joinLines(lines), line, ...names, wasPending: taken.pending.length > 0, wasParked: taken.parked.length > 0 }
}

/** A `jds/…` path, repo-relative, with no way out of the folder. */
export function checkJdPath(path) {
  const p = String(path ?? '').trim().replace(/^\.\//, '')
  if (!p) throw fail('EBADARGS', '--jd-file is required')
  if (p.startsWith('/') || p.split('/').includes('..')) throw fail('EBADARGS', `--jd-file must be a repo-relative path under jds/ (got "${path}")`)
  if (!p.startsWith('jds/') || !/\.(md|txt)$/i.test(p)) throw fail('EBADARGS', `--jd-file must be a .md or .txt file under jds/ (got "${path}")`)
  return p
}

/**
 * Put a parked (or still pending) listing back at the end of Pending with a
 * `JD saved:` note. Returns `{ text, line, company, role, wasParked, wasPending }`.
 */
export function requeueInPipeline(text, { url, jdFile, date, company, role }) {
  const u = checkUrl(url)
  const jd = checkJdPath(jdFile)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw fail('EBADARGS', 'date must be YYYY-MM-DD')
  const lines = splitLines(text)
  const taken = takeLines(lines, u)
  const names = pickNames({ company, role }, taken)
  if (!names.company || !names.role) throw fail('EBADARGS', 'name the listing: --company and --role (it is not in data/pipeline.md)')
  const line = pendingLine({ url: u, ...names, note: jdSavedNote(jd, date) })
  insertInSection(lines, '## Pending', line)
  dropIfEmpty(lines, PARKED_HEADING)
  return { text: joinLines(lines), line, ...names, wasParked: taken.parked.length > 0, wasPending: taken.pending.length > 0 }
}

/** Every parked listing, in file order. */
export function parkedEntries(text) {
  return String(text ?? '').split('\n').map(parseParkedLine).filter(Boolean)
}

/** Lines that start like a parked line but don't parse (for verify-pipeline). */
export function malformedParkedLines(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => looksParked(l) && !parseParkedLine(l))
}

/** The saved JD a pending line for `url` points at, or null. */
export function savedJdFor(text, url) {
  for (const line of String(text ?? '').split('\n')) {
    const p = parsePendingLine(line)
    if (p && sameUrl(p.url, url)) {
      const path = jdSavedPath(line)
      if (path) return path
    }
  }
  return null
}

/** Every pending line that names a saved JD: `{ url, path }`. */
export function savedJdEntries(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const p = parsePendingLine(line)
    const path = p && jdSavedPath(line)
    if (path) out.push({ url: p.url, path })
  }
  return out
}

/* ───── Messages ─────────────────────────────────────────────────── */

/** Where the chat should save the posting text for a listing. */
export function suggestedJdPath({ company, role }) {
  return `jds/${archiveFileName({ company, role })}`
}

/** The Messages post input for a parked listing (one per URL, keyed). */
export function parkMessage({ url, company, role, why, source = 'eval' }) {
  const jd = suggestedJdPath({ company, role })
  const title = `Needs a browser read: ${cell(company)} — ${cell(role)}`.slice(0, 200)
  const body = [
    `Starpath couldn't read this posting without a real browser (${cell(why)}), so it left the Pending inbox instead of being retried on every run.`,
    '',
    '**To get it evaluated**',
    '1. Open the link in your browser.',
    '2. Paste the job description into the app\'s chat and say which listing it is, or ask a Claude Code session to read the page in its browser.',
    '',
    `The chat or session saves the text as \`${jd}\` and runs \`node scripts/browser-read.mjs requeue --url '${url}' --jd-file ${jd}\`. That puts the listing back in the Pending inbox, the next evaluation reads the saved text instead of fetching the page, and this message resolves itself.`,
  ].join('\n')
  return { source, kind: 'alert', key: messageKey(url), title, body, links: [url] }
}

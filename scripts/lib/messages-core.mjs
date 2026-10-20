/**
 * messages-core.mjs — pure logic for agent → user Messages
 * (data/agent-messages.jsonl).
 *
 * Agents the app runs (the weekly scheduler, calibrate, eval workers, chat)
 * and any Claude Code session can leave the user a message they read and
 * resolve in the app's Messages view. Posting is optional and meant to be
 * rare: an agent that is stuck, found an important issue, or wants approval
 * for a change (to the profile, say) posts one; everything else it keeps
 * handling on its own.
 *
 * The file is append-only JSON Lines. Two record types:
 *
 *   { type: 'post',   id, created_at, source, kind, title, body, links, key? }
 *   { type: 'update', id, at, status, note? }
 *
 * A message's current state is the fold of its post and every later update
 * (status open | resolved | dismissed, plus resolved_at / resolution_note).
 * History is never rewritten. `key` is an optional stable dedupe key: a post
 * whose key matches a message that is still open, or that the user
 * dismissed, is a no-op (calibrate re-running, a scheduler retry).
 *
 * Everything here is pure (no fs, no clock); scripts/lib/messages-store.mjs
 * does the locked I/O. Unit-tested in messages-core.test.mjs.
 */

export const SOURCES = ['calibrate', 'scheduler', 'eval', 'chat', 'session']
export const KINDS = ['approval', 'alert', 'suggestion', 'fyi']
export const STATUSES = ['open', 'resolved', 'dismissed']
export const LINK_KINDS = ['report', 'application', 'url', 'file']

export const MAX_TITLE = 200
export const MAX_BODY = 20_000
export const MAX_NOTE = 2_000
export const MAX_LINKS = 20
const MAX_KEY = 200

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

const str = (v) => (v === undefined || v === null ? '' : String(v))

/* ───── Ids ──────────────────────────────────────────────────────── */

/** `m-YYYYMMDD-<hex>` from a Date and a random hex suffix (both supplied by the caller). */
export function makeId(now, hex) {
  const p = (n) => String(n).padStart(2, '0')
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
  return `m-${d}-${String(hex).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8)}`
}

/* ───── Links ────────────────────────────────────────────────────── */

/** What a bare link string points at: a URL, a report, an application (`app:`), or a file. */
export function inferLinkKind(target) {
  const t = str(target).trim()
  if (/^https?:\/\//i.test(t)) return 'url'
  if (/^app:/i.test(t)) return 'application'
  if (/^reports\/.+\.md$/i.test(t)) return 'report'
  return 'file'
}

/**
 * Normalise one link: a string (`reports/…md`, `https://…`, `app:<key>`, a
 * repo path) or `{ kind?, target, label? }`. Null for an empty or unusable one.
 */
export function normalizeLink(link) {
  if (link === null || link === undefined) return null
  const obj = typeof link === 'string' ? { target: link } : link
  if (typeof obj !== 'object') return null
  let target = str(obj.target ?? obj.href ?? obj.path ?? obj.url).trim()
  if (!target) return null
  const kind = LINK_KINDS.includes(obj.kind) ? obj.kind : inferLinkKind(target)
  if (kind === 'application') target = target.replace(/^app:/i, '')
  if (kind === 'url' && !/^https?:\/\//i.test(target)) return null
  // Repo-relative paths only: no absolute paths, no climbing out.
  if ((kind === 'report' || kind === 'file') && (target.startsWith('/') || target.split('/').includes('..'))) return null
  const label = str(obj.label).trim().slice(0, MAX_TITLE)
  return label ? { kind, target, label } : { kind, target }
}

/* ───── Building records ─────────────────────────────────────────── */

/**
 * Validate a post request and build its record. `id` and `now` (a Date)
 * come from the caller. Throws EBADMSG with a readable reason.
 */
export function buildPost(input, { id, now }) {
  const i = input ?? {}
  const source = str(i.source).trim().toLowerCase() || 'session'
  if (!SOURCES.includes(source)) throw fail('EBADMSG', `source must be one of ${SOURCES.join(', ')} (got "${i.source}")`)
  const kind = str(i.kind).trim().toLowerCase() || 'fyi'
  if (!KINDS.includes(kind)) throw fail('EBADMSG', `kind must be one of ${KINDS.join(', ')} (got "${i.kind}")`)
  const title = str(i.title).replace(/\s+/g, ' ').trim()
  if (!title) throw fail('EBADMSG', 'a message needs a title')
  if (title.length > MAX_TITLE) throw fail('EBADMSG', `title is longer than ${MAX_TITLE} characters`)
  const body = str(i.body).replace(/\r\n?/g, '\n').trim()
  if (body.length > MAX_BODY) throw fail('EBADMSG', `body is longer than ${MAX_BODY} characters`)
  const rawLinks = Array.isArray(i.links) ? i.links : (i.links ? [i.links] : [])
  const links = rawLinks.map(normalizeLink).filter(Boolean).slice(0, MAX_LINKS)
  const key = str(i.key).trim().slice(0, MAX_KEY)
  if (!id) throw fail('EBADMSG', 'id is required')
  return {
    type: 'post', id, created_at: now.toISOString(), source, kind, title, body, links,
    ...(key ? { key } : {}),
  }
}

/** An update record moving a message to `status`. */
export function buildUpdate(id, status, { note = '', now }) {
  if (!STATUSES.includes(status)) throw fail('EBADMSG', `status must be one of ${STATUSES.join(', ')}`)
  const n = str(note).replace(/\r\n?/g, '\n').trim()
  if (n.length > MAX_NOTE) throw fail('EBADMSG', `note is longer than ${MAX_NOTE} characters`)
  return { type: 'update', id, at: now.toISOString(), status, ...(n ? { note: n } : {}) }
}

/* ───── Parse / serialize ────────────────────────────────────────── */

/** One record per line, newline-terminated. */
export function serializeRecord(record) {
  return JSON.stringify(record) + '\n'
}

/**
 * Parse the file into records. Blank lines, unparseable lines (a write cut
 * short by a crash) and records of an unknown shape are skipped and counted.
 */
export function parseRecords(raw) {
  const records = []
  let skipped = 0
  for (const line of str(raw).split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { skipped++; continue }
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) { skipped++; continue }
    if (r.type === 'post' && typeof r.title === 'string' && typeof r.created_at === 'string') records.push(r)
    else if (r.type === 'update' && STATUSES.includes(r.status) && typeof r.at === 'string') records.push(r)
    else skipped++
  }
  return { records, skipped }
}

/* ───── Fold ─────────────────────────────────────────────────────── */

/**
 * Current state of every message, in post order. A later post with an id
 * already seen is ignored (ids are unique; the first post wins); updates for
 * an unknown id are ignored. Each message carries its `history` of updates.
 */
export function foldMessages(records) {
  const byId = new Map()
  for (const r of records ?? []) {
    if (r.type === 'post') {
      if (byId.has(r.id)) continue
      byId.set(r.id, {
        id: r.id,
        created_at: r.created_at,
        source: SOURCES.includes(r.source) ? r.source : 'session',
        kind: KINDS.includes(r.kind) ? r.kind : 'fyi',
        title: r.title,
        body: str(r.body),
        links: (Array.isArray(r.links) ? r.links : []).map(normalizeLink).filter(Boolean),
        ...(r.key ? { key: String(r.key) } : {}),
        status: 'open',
        updated_at: r.created_at,
        resolved_at: null,
        resolution_note: null,
        history: [],
      })
    } else if (r.type === 'update') {
      const m = byId.get(r.id)
      if (!m) continue
      m.history.push({ at: r.at, status: r.status, ...(r.note ? { note: r.note } : {}) })
      m.status = r.status
      m.updated_at = r.at
      if (r.status === 'open') {
        m.resolved_at = null
        m.resolution_note = null
      } else {
        m.resolved_at = r.at
        m.resolution_note = r.note ? String(r.note) : null
      }
    }
  }
  return [...byId.values()]
}

/* ───── Queries ──────────────────────────────────────────────────── */

/** Newest first (by created_at, then id for a stable order). */
export function sortNewestFirst(messages) {
  return [...messages].sort((a, b) => (b.created_at.localeCompare(a.created_at)) || b.id.localeCompare(a.id))
}

/** Resolved/dismissed history: most recently closed first. */
export function sortRecentlyClosed(messages) {
  return [...messages].sort((a, b) => str(b.resolved_at).localeCompare(str(a.resolved_at)) || b.id.localeCompare(a.id))
}

export function openMessages(messages) {
  return sortNewestFirst(messages.filter((m) => m.status === 'open'))
}

export function closedMessages(messages) {
  return sortRecentlyClosed(messages.filter((m) => m.status !== 'open'))
}

export function openCount(messages) {
  return messages.reduce((n, m) => n + (m.status === 'open' ? 1 : 0), 0)
}

/**
 * Find one message by full id or unique id prefix (≥ 4 characters past the
 * `m-`), for the CLI. Throws ENOMSG / EAMBIG.
 */
export function findMessage(messages, ref) {
  const r = str(ref).trim()
  if (!r) throw fail('ENOMSG', 'no message id given')
  const exact = messages.find((m) => m.id === r)
  if (exact) return exact
  const hits = r.length >= 4 ? messages.filter((m) => m.id.startsWith(r) || m.id.endsWith(r)) : []
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw fail('EAMBIG', `"${r}" matches ${hits.length} messages: ${hits.map((m) => m.id).join(', ')}`)
  throw fail('ENOMSG', `no message with id "${r}"`)
}

/**
 * Does posting `post` duplicate an existing message? Returns that message or
 * null. Only keyed posts dedupe: an open or dismissed message with the same
 * key blocks it (a resolved one does not — the issue can come back).
 */
export function duplicateOf(messages, post) {
  if (!post?.key) return null
  return messages.find((m) => m.key === post.key && (m.status === 'open' || m.status === 'dismissed')) ?? null
}

/**
 * Plan a status change: the update record to append, or null when the
 * message is already in that state (a no-op). Throws when the id is unknown.
 */
export function planUpdate(messages, ref, status, { note = '', now }) {
  const m = findMessage(messages, ref)
  if (m.status === status && !str(note).trim()) return { message: m, record: null }
  return { message: m, record: buildUpdate(m.id, status, { note, now }) }
}

/* ───── CLI rendering ────────────────────────────────────────────── */

export function renderList(messages, { showBody = false } = {}) {
  if (!messages.length) return 'no messages'
  const lines = []
  for (const m of messages) {
    const state = m.status === 'open' ? '' : ` [${m.status}${m.resolved_at ? ' ' + m.resolved_at.slice(0, 10) : ''}]`
    lines.push(`${m.id}  ${m.created_at.slice(0, 16).replace('T', ' ')}  ${m.kind.padEnd(10)} ${m.source.padEnd(9)} ${m.title}${state}`)
    if (showBody && m.body) for (const l of m.body.split('\n')) lines.push(`    ${l}`)
    if (showBody) for (const l of m.links) lines.push(`    → ${l.label ? l.label + ': ' : ''}${l.kind === 'application' ? 'app:' : ''}${l.target}`)
    if (m.resolution_note) lines.push(`    note: ${m.resolution_note}`)
  }
  return lines.join('\n')
}

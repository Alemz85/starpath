#!/usr/bin/env node
/**
 * browser-read.mjs — hand a listing no script can read to a person with a
 * browser, then take it back once they saved the posting.
 *
 * Some sites refuse every non-browser client (HTTP 403 to fetch-posting, the
 * posting check and WebFetch alike). Starpath never tries to get around that
 * (no stealth browsers, no faked user agents). An evaluation worker that hits
 * such a wall parks the listing instead of leaving it pending:
 *
 *   node scripts/browser-read.mjs park --url '<url>' --company '<Company>' --role '<Role>' --why '<reason>'
 *        [--source eval|scan|chat|session|worker] [--json]
 *     Moves the line out of Pending in data/pipeline.md into
 *     `## Needs a browser read` (`- [!] BROWSER READ | url | Company | Role | date: why`,
 *     which no Pending parser counts) and posts ONE Messages alert, keyed
 *     `browser-read:<url id>`, so it is never posted twice while open.
 *     --company / --role default to what the pipeline line carries.
 *
 *   node scripts/browser-read.mjs requeue --url '<url>' --jd-file jds/<file>.md [--company …] [--role …] [--json]
 *     After someone saved the posting text under jds/ (the app's chat, or a
 *     Claude Code session that read the page in a browser): moves the line
 *     back to Pending with a `JD saved: <path>` note, which tells the next
 *     evaluation to read the file instead of fetching, and resolves the alert.
 *
 *   node scripts/browser-read.mjs list [--json]           parked listings
 *   node scripts/browser-read.mjs saved-jd --url '<url>'  the saved JD path for a pending URL (empty when none)
 *
 * Always single-quote the URL (zsh globs `?` and `&`). Writes take the
 * pipeline file's lock and are atomic (dir-lock.mjs, write-file-atomic.mjs);
 * the message goes through messages-store.mjs. Paths resolve through the
 * data root (CAREER_OPS_ROOT, then STARPATH_DATA / private/ / this checkout).
 * Pure logic: scripts/lib/browser-read-core.mjs.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { lockPathFor, withLockSync } from './lib/dir-lock.mjs'
import { writeFileAtomic } from './lib/write-file-atomic.mjs'
import { SOURCES } from './lib/messages-core.mjs'
import { messagesPathFor, postMessage, readMessages, setMessageStatus } from './lib/messages-store.mjs'
import {
  checkJdPath, messageKey, parkInPipeline, parkMessage, parkedEntries, requeueInPipeline, savedJdFor,
} from './lib/browser-read-core.mjs'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--url', '--company', '--role', '--why', '--source', '--jd-file'])
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))
const command = positional[0]
const JSON_OUT = argv.includes('--json')

const REPO = repoRootFrom(import.meta.url)
const ROOT = process.env.CAREER_OPS_ROOT || dataRootFor(REPO)
const PIPELINE = join(ROOT, 'data/pipeline.md')
const MESSAGES = messagesPathFor(ROOT)

const today = () => new Date().toISOString().slice(0, 10)
const readPipeline = () => (existsSync(PIPELINE) ? readFileSync(PIPELINE, 'utf-8') : '')

function usage(msg) {
  if (msg) console.error(`error: ${msg}`)
  console.error("usage: node scripts/browser-read.mjs park --url '<url>' --company … --role … --why … | requeue --url '<url>' --jd-file jds/<file>.md | list | saved-jd --url '<url>'")
  process.exit(2)
}

/** Read-modify-write data/pipeline.md under its lock. */
function editPipeline(label, change) {
  mkdirSync(dirname(PIPELINE), { recursive: true })
  return withLockSync(lockPathFor(PIPELINE), () => {
    const result = change(readPipeline())
    writeFileAtomic(PIPELINE, result.text)
    return result
  }, { label })
}

/** The saved file must exist and hold text (data root first: jds/ is a link into it). */
function assertJdFile(rel) {
  for (const base of [ROOT, REPO]) {
    const abs = join(base, rel)
    if (existsSync(abs) && statSync(abs).isFile() && statSync(abs).size > 0) return
  }
  usage(`${rel} does not exist or is empty: save the posting text there first`)
}

function park() {
  const source = (flag('--source') ?? 'eval').toLowerCase()
  if (!SOURCES.includes(source)) usage(`--source must be one of ${SOURCES.join(', ')}`)
  const input = { url: flag('--url'), company: flag('--company'), role: flag('--role'), why: flag('--why'), date: today() }
  const result = editPipeline('browser-read park', (text) => parkInPipeline(text, input))
  const post = parkMessage({ url: input.url.trim(), company: result.company, role: result.role, why: input.why, source })
  const { posted, message } = postMessage(MESSAGES, post)
  if (JSON_OUT) return console.log(JSON.stringify({ parked: result.line, wasPending: result.wasPending, posted, message: message.id }))
  console.log(`parked: ${result.company} — ${result.role} (${result.wasPending ? 'moved out of Pending' : result.wasParked ? 'already parked, date refreshed' : 'added'})`)
  console.log(posted ? `message ${message.id} posted: ${message.title}` : `message ${message.id} already ${message.status}; not posted again`)
}

function requeue() {
  const jdFile = checkJdPath(flag('--jd-file'))
  assertJdFile(jdFile)
  const input = { url: flag('--url'), jdFile, company: flag('--company'), role: flag('--role'), date: today() }
  const result = editPipeline('browser-read requeue', (text) => requeueInPipeline(text, input))
  const key = messageKey(input.url.trim())
  const open = readMessages(MESSAGES).filter((m) => m.key === key && m.status === 'open')
  for (const m of open) setMessageStatus(MESSAGES, m.id, 'resolved', { note: `Posting saved as ${jdFile}; back in the Pending inbox.` })
  if (JSON_OUT) return console.log(JSON.stringify({ queued: result.line, wasParked: result.wasParked, resolved: open.map((m) => m.id) }))
  console.log(`back in Pending: ${result.company} — ${result.role} (reads ${jdFile})`)
  if (open.length) console.log(`resolved ${open.map((m) => m.id).join(', ')}`)
}

function main() {
  switch (command) {
    case 'park': return park()
    case 'requeue': return requeue()
    case 'list': {
      const parked = parkedEntries(readPipeline())
      if (JSON_OUT) return console.log(JSON.stringify(parked))
      if (!parked.length) return console.log('no listings need a browser read')
      for (const p of parked) console.log(`${p.date}  ${p.company} — ${p.role}  ${p.url}  (${p.why})`)
      return
    }
    case 'saved-jd': {
      if (!flag('--url')) usage('saved-jd needs --url')
      const path = savedJdFor(readPipeline(), flag('--url'))
      if (path) console.log(path)
      return
    }
    default:
      usage(command ? `unknown command "${command}"` : 'no command given')
  }
}

try {
  main()
} catch (e) {
  if (e.code === 'EBADARGS') usage(e.message)
  console.error(`error: ${e.message}`)
  process.exit(1)
}

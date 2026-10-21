#!/usr/bin/env node
/**
 * messages.mjs — leave the user a message they read in the app (Messages view).
 *
 * Optional and meant to be rare. Post when you are stuck on something only
 * the user can unblock, found an important issue they should fix, or match
 * their approval before a change (to their profile, say). Otherwise keep
 * working on your own; never wait for an answer here.
 *
 * Usage:
 *   node scripts/messages.mjs post --title "…" [--body "…markdown…" | --body -] [--body-file <path>]
 *        [--kind approval|alert|suggestion|fyi] [--source session|calibrate|scheduler|eval|chat]
 *        [--link reports/tier-1/…md] [--link https://…] [--link app:<application key>] [--key <dedupe key>]
 *   node scripts/messages.mjs post --from-json '{"title":"…","body":"…","kind":"alert","links":[…]}'   (or --from-json - for stdin)
 *   node scripts/messages.mjs list [--open | --closed] [--full] [--json]
 *   node scripts/messages.mjs show <id> [--json]
 *   node scripts/messages.mjs resolve <id> [--note "…"]
 *   node scripts/messages.mjs dismiss <id> [--note "…"]
 *   node scripts/messages.mjs reopen <id>
 *   node scripts/messages.mjs count [--json]
 *
 * Every command takes --json for machine-readable output.
 * <id> may be a unique prefix or the hex suffix. A post with --key is skipped
 * while a message with that key is open or was dismissed. Defaults: kind fyi,
 * source session. The file is data/agent-messages.jsonl under the data root
 * (CAREER_OPS_ROOT, then STARPATH_DATA / private/ / this checkout); logic in
 * scripts/lib/messages-core.mjs, locked I/O in scripts/lib/messages-store.mjs.
 */

import { readFileSync } from 'node:fs'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { closedMessages, findMessage, openCount, openMessages, renderList, sortNewestFirst } from './lib/messages-core.mjs'
import { messagesPathFor, postMessage, readMessages, setMessageStatus } from './lib/messages-store.mjs'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--title', '--body', '--body-file', '--kind', '--source', '--link', '--key', '--note', '--from-json'])
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const flagAll = (name) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []))
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))
const command = positional[0]
const JSON_OUT = argv.includes('--json')

const REPO = repoRootFrom(import.meta.url)
const ROOT = process.env.CAREER_OPS_ROOT || dataRootFor(REPO)
const FILE = messagesPathFor(ROOT)

function usage(msg) {
  if (msg) console.error(`error: ${msg}`)
  console.error('usage: node scripts/messages.mjs post --title "…" [--body …] [--kind …] [--link …] | list [--open|--closed] | show <id> | resolve <id> [--note …] | dismiss <id> | reopen <id> | count')
  process.exit(1)
}

const readStdin = () => readFileSync(0, 'utf-8')

function postInput() {
  const json = flag('--from-json')
  if (json !== undefined) {
    let obj
    try { obj = JSON.parse(json === '-' ? readStdin() : json) } catch (e) { usage(`--from-json is not valid JSON: ${e.message}`) }
    return obj
  }
  let body = flag('--body')
  if (body === '-') body = readStdin()
  const bodyFile = flag('--body-file')
  if (bodyFile) body = readFileSync(bodyFile, 'utf-8')
  return {
    title: flag('--title'),
    body,
    kind: flag('--kind'),
    source: flag('--source'),
    links: flagAll('--link'),
    key: flag('--key'),
  }
}

function main() {
  switch (command) {
    case 'post': {
      const { posted, message } = postMessage(FILE, postInput())
      if (JSON_OUT) return console.log(JSON.stringify({ posted, message }))
      console.log(posted ? `posted ${message.id}: ${message.title}` : `skipped: ${message.id} with key "${message.key}" is already ${message.status}`)
      return
    }
    case 'list': {
      const all = readMessages(FILE)
      const list = argv.includes('--open') ? openMessages(all)
        : argv.includes('--closed') ? closedMessages(all)
        : sortNewestFirst(all)
      if (JSON_OUT) return console.log(JSON.stringify(list))
      console.log(renderList(list, { showBody: argv.includes('--full') }))
      return
    }
    case 'show': {
      const m = findMessage(readMessages(FILE), positional[1])
      if (JSON_OUT) return console.log(JSON.stringify(m))
      console.log(renderList([m], { showBody: true }))
      return
    }
    case 'resolve':
    case 'dismiss':
    case 'reopen': {
      if (!positional[1]) usage(`${command} needs a message id`)
      const status = command === 'resolve' ? 'resolved' : command === 'dismiss' ? 'dismissed' : 'open'
      const { changed, message } = setMessageStatus(FILE, positional[1], status, { note: flag('--note') ?? '' })
      if (JSON_OUT) return console.log(JSON.stringify({ changed, message }))
      console.log(changed ? `${message.id} is now ${message.status}` : `${message.id} was already ${message.status}`)
      return
    }
    case 'count': {
      const n = openCount(readMessages(FILE))
      if (JSON_OUT) return console.log(JSON.stringify({ open: n }))
      console.log(`${n} open`)
      return
    }
    default:
      usage(command ? `unknown command "${command}"` : 'no command given')
  }
}

try {
  main()
} catch (e) {
  console.error(`error: ${e.message}`)
  process.exit(e.code === 'ELOCKED' ? 3 : 2)
}

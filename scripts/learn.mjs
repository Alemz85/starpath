#!/usr/bin/env node
/**
 * learn.mjs — the retro gate's CLI: check proposed rules, list them, and let
 * the user apply the ones they accept by id.
 *
 * The `retro` mode (modes/retro.md) proposes up to five rule candidates at the
 * end of a session. This script runs them through the deterministic gate in
 * lib/learn-core.mjs, numbers the survivors into data/learn-pending.json, and
 * writes accepted ids into user/_profile.md › Learned preferences. Nothing is
 * applied unless a person at a terminal names the ids and types `apply`.
 *
 * Usage:
 *   node scripts/learn.mjs check [<candidates.json> | -] [--json] [--dry-run]
 *   node scripts/learn.mjs list [--json]
 *   node scripts/learn.mjs apply --accept 1,3        (a person at a terminal only)
 *   node scripts/learn.mjs reject 2[,4]
 *
 * `check` reads a JSON array (or {"candidates": [...]}) from the file, or
 * from stdin when the argument is `-` or missing. It prints every candidate as
 * accepted (with its new id) or rejected (with each reason) and exits 0; a
 * batch refused as a whole (more than five, not a list) exits 1.
 *
 * `apply` refuses when headless: no TTY on stdin or stdout, CI set, or run by
 * an agent (CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / AI_AGENT; every Claude Code
 * tool call and every `claude -p` worker carries them). It refuses on the demo
 * dataset, re-checks every accepted rule through the gate, shows the exact
 * lines and asks for `apply` to be typed. Then, under the profile file's lock,
 * it saves user/_profile.md.bak beside the real file, writes the file
 * atomically through its link (it can be a link into the active profile),
 * appends one ledger line per rule to data/learn-ledger.tsv and drops the
 * applied ids from the pending file. No flag skips any of this.
 *
 * Paths resolve through the data root (CAREER_OPS_ROOT, then STARPATH_DATA /
 * private/ / this checkout).
 */

import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { dataRootFor, repoRootFrom, DEMO_DIR } from './lib/data-root.mjs'
import { lockPathFor, withLockSync } from './lib/dir-lock.mjs'
import { resolveWriteTarget, writeFileAtomic } from './lib/write-file-atomic.mjs'
import { parseActive, ACTIVE_POINTER } from './lib/profile-core.mjs'
import {
  KINDS, LEDGER_FILE, PENDING_FILE, TARGET_FILE,
  addToPending, checkCandidates, existingRules, formatLedgerRow, headlessReason, ledgerHeader,
  maxLedgerId, parseIds, parsePending, planApply, removeFromPending, renderList, renderPending, renderRuleLine,
} from './lib/learn-core.mjs'

const REPO = repoRootFrom(import.meta.url)

function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

const readOr = (file, fallback = null) => {
  try { return readFileSync(file, 'utf-8') } catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}

/** Absolute paths for one data root. */
export function pathsFor(root) {
  return {
    root,
    pending: join(root, PENDING_FILE),
    ledger: join(root, LEDGER_FILE),
    profile: join(root, TARGET_FILE),
    active: join(root, ACTIVE_POINTER),
  }
}

function activeProfile(paths) {
  return parseActive(readOr(paths.active, null))
}

function appendLedger(file, rows) {
  if (!rows.length) return
  const needsHeader = !existsSync(file) || !readFileSync(file, 'utf-8').trim()
  appendFileSync(resolveWriteTarget(file), (needsHeader ? ledgerHeader() : '') + rows.join(''))
}

const LOCK_LABEL = (verb) => ({ label: `learn ${verb}` })

/**
 * `check`: gate the candidates, number the survivors into the pending file.
 * Duplicates are judged against what is pending and what user/_profile.md
 * already holds.
 */
export function runCheck(paths, input, { dryRun = false, now = new Date() } = {}) {
  const date = todayLocal(now)
  const work = () => {
    const pending = parsePending(readOr(paths.pending, null))
    const existing = [...pending.items.map((it) => it.change), ...existingRules(readOr(paths.profile, ''))]
    const result = checkCandidates(input, { existing })
    if (result.batchError) return { ...result, added: [] }
    const { pending: next, added } = addToPending(pending, result.accepted, {
      date, profile: activeProfile(paths), minNextId: maxLedgerId(readOr(paths.ledger, '')) + 1,
    })
    if (!dryRun && added.length) writeFileAtomic(paths.pending, renderPending(next))
    return { ...result, added }
  }
  return dryRun ? work() : withLockSync(lockPathFor(paths.pending), work, LOCK_LABEL('check'))
}

/** `reject`: drop pending ids (logged). Needs no terminal: it only removes. */
export function runReject(paths, ids, { now = new Date() } = {}) {
  const date = todayLocal(now)
  return withLockSync(lockPathFor(paths.pending), () => {
    const pending = parsePending(readOr(paths.pending, null))
    const byId = new Map(pending.items.map((it) => [it.id, it]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) throw new Error(`not pending: ${missing.map((id) => `#${id}`).join(', ')} (see: learn.mjs list)`)
    writeFileAtomic(paths.pending, renderPending(removeFromPending(pending, ids)))
    appendLedger(paths.ledger, ids.map((id) => formatLedgerRow({ date, item: byId.get(id), action: 'rejected' })))
    return ids.map((id) => byId.get(id))
  }, LOCK_LABEL('reject'))
}

/** Is this data root the fictional demo dataset? */
function isDemoRoot(root) {
  try { return realpathSync(root) === realpathSync(join(REPO, DEMO_DIR)) } catch { return false }
}

/**
 * `apply`: the only path that writes user/_profile.md. `tty`, `env` and
 * `confirm` are injectable for tests; the CLI passes the real process values,
 * and there is no option that turns the refusal off.
 */
export async function runApply(paths, ids, {
  tty = { stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) },
  env = process.env,
  confirm,
  print = (s) => process.stdout.write(s + '\n'),
  now = new Date(),
} = {}) {
  const why = headlessReason({ ...tty, env })
  if (why) {
    const e = new Error(`apply refused: ${why}. Applying learned rules needs you at a terminal: run \`npm run learn -- apply --accept <ids>\` in your own shell.`)
    e.code = 'EHEADLESS'
    throw e
  }
  if (typeof confirm !== 'function') throw new Error('apply: no confirmation prompt')
  if (isDemoRoot(paths.root)) throw new Error('apply refused: the data root is the demo dataset, which is read-only')
  if (!existsSync(paths.profile)) throw new Error(`apply refused: ${TARGET_FILE} does not exist yet (finish onboarding first)`)

  const date = todayLocal(now)
  const plan = () => planApply(parsePending(readOr(paths.pending, null)), ids, readFileSync(paths.profile, 'utf-8'), { date, activeProfile: activeProfile(paths) })

  // Plan and ask outside the lock (a person may take a while), then re-plan
  // under it and write only if it is exactly what they confirmed.
  const first = plan()
  if (!first.ok) throw new Error(`apply refused:\n  ${first.errors.join('\n  ')}`)
  print(`About to add ${first.items.length} rule(s) to ${TARGET_FILE} › Learned preferences:`)
  for (const it of first.items) print(`  [${KINDS[it.kind].section}] ${renderRuleLine(it, date)}`)
  const answer = String(await confirm('Type "apply" to write them, anything else to stop: ')).trim()
  if (answer !== 'apply') return { applied: [], cancelled: true }

  const fingerprint = (items) => JSON.stringify(items.map((it) => [it.id, it.kind, it.change]))
  return withLockSync(lockPathFor(paths.profile), () => withLockSync(lockPathFor(paths.pending), () => {
    const original = readFileSync(paths.profile, 'utf-8')
    const again = plan()
    if (!again.ok || fingerprint(again.items) !== fingerprint(first.items)) {
      throw new Error('apply stopped: the pending rules or the profile changed while you were confirming; run it again')
    }
    const real = resolveWriteTarget(paths.profile)
    writeFileAtomic(`${real}.bak`, original)
    writeFileAtomic(real, again.text)
    appendLedger(paths.ledger, again.items.map((item) => formatLedgerRow({ date, item, action: 'applied' })))
    const pending = parsePending(readOr(paths.pending, null))
    writeFileAtomic(paths.pending, renderPending(removeFromPending(pending, ids)))
    return { applied: again.items, cancelled: false, backup: `${real}.bak` }
  }, LOCK_LABEL('apply')), LOCK_LABEL('apply'))
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

function printCheck(result) {
  if (result.batchError) {
    console.log(`Refused the whole batch: ${result.batchError.message}`)
    return
  }
  const idFor = new Map(result.accepted.map((a, i) => [a.index, result.added[i]?.id]))
  const rows = [
    ...result.accepted.map((a) => ({ index: a.index, ok: true, candidate: a.candidate })),
    ...result.rejected.map((r) => ({ index: r.index, ok: false, candidate: r.candidate, reasons: r.reasons })),
  ].sort((a, b) => a.index - b.index)
  for (const r of rows) {
    const change = typeof r.candidate?.change === 'string' ? r.candidate.change : '(no change text)'
    if (r.ok) console.log(`✓ #${idFor.get(r.index)}  [${r.candidate.kind}]  ${change}`)
    else {
      console.log(`✗ candidate ${r.index + 1}  ${change.slice(0, 120)}`)
      for (const reason of r.reasons) console.log(`    ${reason.code}: ${reason.message}`)
    }
  }
  console.log(result.added.length
    ? `\n${result.added.length} rule(s) pending. Nothing is applied until you run, in your own terminal: npm run learn -- apply --accept ${result.added.map((a) => a.id).join(',')}`
    : '\nNo rule passed the gate; nothing is pending.')
}

async function main(argv) {
  const [cmd, ...rest] = argv
  const JSON_OUT = rest.includes('--json')
  const root = process.env.CAREER_OPS_ROOT || dataRootFor(REPO)
  const paths = pathsFor(root)

  if (cmd === 'check') {
    const file = rest.find((a) => !a.startsWith('--'))
    const raw = !file || file === '-' ? await readStdin() : readFileSync(file, 'utf-8')
    let input
    try { input = JSON.parse(raw) } catch (e) { throw new Error(`check: candidates are not valid JSON (${e.message})`) }
    const result = runCheck(paths, input, { dryRun: rest.includes('--dry-run') })
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
    else printCheck(result)
    return result.batchError ? 1 : 0
  }

  if (cmd === 'list') {
    const pending = parsePending(readOr(paths.pending, null))
    console.log(JSON_OUT ? JSON.stringify(pending.items, null, 2) : renderList(pending))
    return 0
  }

  if (cmd === 'apply') {
    const i = rest.indexOf('--accept')
    if (i === -1 || !rest[i + 1]) throw new Error('usage: learn.mjs apply --accept 1,3')
    const ids = parseIds(rest[i + 1])
    const result = await runApply(paths, ids, { confirm: ask })
    if (result.cancelled) { console.log('Stopped; nothing written.'); return 0 }
    console.log(`Added ${result.applied.length} rule(s) to ${TARGET_FILE}. Backup: ${result.backup}`)
    return 0
  }

  if (cmd === 'reject') {
    const spec = rest.find((a) => !a.startsWith('--'))
    const removed = runReject(paths, parseIds(spec))
    console.log(`Rejected ${removed.map((it) => `#${it.id}`).join(', ')}; removed from pending.`)
    return 0
  }

  console.error('usage: learn.mjs check [<file>|-] [--json] [--dry-run] | list [--json] | apply --accept 1,3 | reject <ids>')
  return 2
}

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`❌ ${e.message}`)
    process.exit(e.code === 'EHEADLESS' ? 3 : 1)
  })
}

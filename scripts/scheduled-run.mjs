#!/usr/bin/env node

/**
 * scheduled-run.mjs — the weekly scan + evaluation run, and its launchd job.
 *
 *   npm run schedule -- <command> [options]
 *
 * Commands
 *   run        scan → merge → triage → [evaluate] → merge trackers.
 *              Exits early when a full run finished, or a scan of any kind ran
 *              (app Full/API scan, manual scan.mjs, scheduled run), in the last 7 days.
 *              Evaluations are OFF unless saved with `config --evaluate on` (or --eval for one run):
 *              the workers (`claude -p`, least privilege: worker-capabilities.mjs) run unattended.
 *              --force            ignore the 7-day check
 *              --dry-run          print the plan, run only read-only stages, spawn no worker
 *              --eval             evaluate in this run even if the saved setting is off
 *              --no-eval          scan + triage only (zero tokens); recorded as "partial"
 *              --trigger <t>      "scheduled" (what launchd passes) or "manual" (default)
 *              --no-message       don't post the failure alert / run summary to the app's Messages
 *              --top N --parallel N --model M --jobspy   override the saved options
 *   suggest    print the 3 quietest weekly slots from Claude usage and Mac wake times
 *              [--weeks N] [--json]
 *   install    write ~/Library/LaunchAgents/com.starpath.scheduled-run.plist and load it
 *              [--slot "tue 09:00"]  (default: the saved slot, else the top suggestion)
 *              [--print] show the plist without installing
 *   uninstall  unload and remove the job (the saved slot and run history stay)
 *   status     [--json] the slot, last/next run, last result, whether the job is loaded
 *   config     [--evaluate on|off] [--top N] [--parallel N] [--model M|default] [--jobspy on|off]
 *              saved options; the model defaults to batch-runner.sh's own (latest Opus)
 *
 * It never applies, sends or submits anything: the workers only write
 * evaluation reports and tracker rows. Scanning and triage cost no tokens; the
 * evaluation workers (batch/batch-runner.sh, `claude -p`) are the only spend.
 *
 * State: data/scheduled-runs.json   Log: data/scheduled-runs.log
 * Details: docs/REPO-GUIDE.md § Scheduled runs.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { repoRootFrom } from './lib/data-root.mjs'
import { resolveWriteTarget } from './lib/write-file-atomic.mjs'
import {
  RETRY_EVERY_HOURS, LABEL, LAUNCHD_LOG_REL, LOG_REL, buildPlist, isRunLocked, lastFullRun, lastRun, nextRunAt, parseSlot, readState,
  summarizeRun, updateState, validSlot, decideRun, countingScanAt,
} from './lib/schedule-core.mjs'
import { runScheduled, resolveOptions, DEFAULT_OPTIONS } from './lib/scheduled-run-core.mjs'
import { readLastScan } from './lib/last-scan.mjs'
import {
  DEFAULT_PLIST_DIR, installJob, jobPath, jobStatus, plistPathFor, resolveBinary, uninstallJob,
} from './lib/schedule-launchd.mjs'
import { messageForRun, runStartDate, topPicksSince } from './lib/scheduled-run-messages.mjs'
import { MESSAGES_REL, postMessage } from './lib/messages-store.mjs'
import { runReview } from './portal-review.mjs'
import { DEFAULT_WEEKS, FALLBACK_SLOT, awakeHistogram, formatSlot, rankSlots, usageHistogram } from './lib/idle-slot-core.mjs'
import { collectAwakeIntervals, collectClaudeTimestamps } from './lib/idle-slot-io.mjs'

const MAX_LOG_BYTES = 2 * 1024 * 1024

// Test hooks (used to check the Settings panel without touching the real
// LaunchAgents): --plist-dir / $STARPATH_LAUNCH_AGENTS_DIR picks the folder
// the plist goes in, --no-load / $STARPATH_SCHEDULE_NO_LOAD=1 skips launchctl.
const plistDirOf = (flags) => (typeof flags['plist-dir'] === 'string' ? flags['plist-dir'] : process.env.STARPATH_LAUNCH_AGENTS_DIR || DEFAULT_PLIST_DIR)
const noLoadOf = (flags) => flags['no-load'] === true || process.env.STARPATH_SCHEDULE_NO_LOAD === '1'

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [command = 'status', ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
  }
  return { command, flags }
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v))

// ── logging ─────────────────────────────────────────────────────────────────

function makeLogger(root) {
  const file = join(root, LOG_REL)
  try {
    mkdirSync(dirname(resolveWriteTarget(file)), { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(resolveWriteTarget(file), resolveWriteTarget(file) + '.1')
  } catch { /* logging is best-effort */ }
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`
    process.stdout.write(line)
    try { appendFileSync(file, line) } catch { /* best-effort */ }
  }
}

// ── real process execution ──────────────────────────────────────────────────

function makeExec({ root, env }) {
  return (stage, { onLine }) => new Promise((resolve) => {
    // detached: its own process group, so a timeout or Ctrl-C can take the
    // whole tree (batch-runner.sh → claude workers) down together.
    const child = spawn(stage.cmd, stage.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    activeChild = child
    let timedOut = false
    const timer = stage.timeoutMs ? setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      setTimeout(() => killGroup(child, 'SIGKILL'), 10_000).unref()
    }, stage.timeoutMs) : null
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (l) => { if (l.trim()) onLine(l) })
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); activeChild = null; resolve({ code: -1, error: e.message }) })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      activeChild = null
      resolve({ code: code ?? (signal ? 128 : 0), signal, timedOut })
    })
  })
}

let activeChild = null
function killGroup(child, signal) {
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* gone */ } }
}

// ── environment ─────────────────────────────────────────────────────────────

function toolchain() {
  const nodePath = resolveBinary('node') ?? process.execPath
  const claudePath = resolveBinary('claude')
  return { nodePath, claudePath }
}

/** What launchd gives children: a PATH that reaches node, claude, bash and bc. */
function childEnv({ nodePath, claudePath }) {
  return { ...process.env, PATH: jobPath({ nodePath, claudePath }), HOME: process.env.HOME ?? homedir() }
}

// ── suggest ─────────────────────────────────────────────────────────────────

export async function suggest({ root, weeks = DEFAULT_WEEKS, now = Date.now() } = {}) {
  const state = readState(root)
  // Our own earlier runs (and their `claude -p` workers) are not the user's usage.
  const excludeWindows = state.runs
    .filter((r) => r.startedAt)
    .map((r) => ({ start: Date.parse(r.startedAt), end: Date.parse(r.finishedAt ?? r.startedAt) + 5 * 60_000 }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
  const stamps = await collectClaudeTimestamps({ sinceMs: now - weeks * 7 * 86_400_000 })
  const usage = usageHistogram(stamps, { now, weeks, excludeWindows })
  const power = collectAwakeIntervals({ now })
  const awake = power.intervals.length && power.from
    ? awakeHistogram(power.intervals, { from: power.from, now })
    : null
  const ranked = rankSlots({ usage, awake })
  return {
    ...ranked,
    evidence: {
      claudeTimestamps: usage.total,
      claudeFrom: new Date(usage.from).toISOString(),
      powerLogFrom: power.from ? new Date(power.from).toISOString() : null,
      awakeDaysObserved: awake?.observedDays ?? 0,
      weeks,
    },
  }
}

function printSuggestion(s) {
  const e = s.evidence
  console.log(`Quietest weekly slots (confidence: ${s.confidence}${s.fallback ? ', built-in default' : ''})`)
  console.log(`Based on ${e.claudeTimestamps} Claude activity timestamps since ${e.claudeFrom.slice(0, 10)} (timestamps only, no content)`)
  console.log(e.powerLogFrom
    ? `and the Mac's wake log since ${e.powerLogFrom.slice(0, 10)} (${e.awakeDaysObserved} days).`
    : 'and no readable Mac wake log (so hours before 07:00 are excluded).')
  console.log('')
  s.picks.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.label}`)
    console.log(`     ${p.evidence}`)
  })
  if (s.confidence === 'low') console.log('\nLow confidence: not much history yet. Re-run `suggest` after a few weeks of use, or pick the slot yourself with `install --slot "tue 09:00"`.')
}

// ── status ──────────────────────────────────────────────────────────────────

function expectedPlistFor({ root, slot, nodePath, claudePath }) {
  return buildPlist({
    nodePath, scriptPath: join(root, 'scripts', 'scheduled-run.mjs'), root, slot,
    pathEnv: jobPath({ nodePath, claudePath }), home: homedir(), logPath: join(root, LAUNCHD_LOG_REL),
  })
}

export function statusReport({ root, now = Date.now(), plistDir = DEFAULT_PLIST_DIR, load = true, run } = {}) {
  const state = readState(root)
  const { nodePath, claudePath } = toolchain()
  const job = jobStatus({ plistDir, expect: { slot: state.slot, root }, load, ...(run ? { run } : {}) })
  const full = lastFullRun(state)
  const last = lastRun(state)
  const lastScan = readLastScan(root)
  const next = state.slot && job.installed ? nextRunAt({ slot: state.slot, state, now, lastScan }) : null
  return {
    installed: job.installed,
    loaded: job.loaded,
    upToDate: job.upToDate,
    problems: job.problems,
    plistPath: job.plistPath,
    slot: state.slot,
    slotLabel: state.slot ? formatSlot(state.slot) : null,
    running: isRunLocked(root),
    lastRun: last ? { ...last.run, summaryText: summarizeRun(last.run) } : null,
    lastFullRunAt: full ? full.run.finishedAt : null,
    // The last scan of any kind (app, manual or scheduled) and whether it holds the weekly run off.
    lastScanAt: lastScan ? new Date(lastScan.at).toISOString() : null,
    lastScanCounts: countingScanAt(state, lastScan) !== null,
    nextRunAt: next ? new Date(next).toISOString() : null,
    dueNow: decideRun({ state, now, lastScan }).run,
    options: resolveOptions(state.options),
    logPath: join(root, LOG_REL),
    root,
    claudeFound: Boolean(claudePath),
    nodePath,
    claudePath,
  }
}

function printStatus(r) {
  console.log(`Job:        ${r.installed ? (r.loaded ? 'installed and loaded' : 'installed but NOT loaded') : 'not installed'}${r.installed && r.upToDate === false ? ` (needs attention: ${r.problems.join('; ')}; re-run install)` : ''}`)
  console.log(`Slot:       ${r.slotLabel ?? 'none chosen yet'}`)
  console.log(`Last run:   ${r.lastRun ? `${r.lastRun.finishedAt ?? r.lastRun.startedAt} (${r.lastRun.trigger}), ${r.lastRun.status}: ${r.lastRun.summaryText}` : 'never'}`)
  console.log(`Last scan:  ${r.lastScanAt ? `${r.lastScanAt}${r.lastScanCounts ? '' : ' (not counted: no board answered, or it was part of a run that failed)'}` : 'never recorded'} (any scan counts toward the 7-day wait)`)
  console.log(`Next run:   ${r.nextRunAt ?? (r.installed ? 'unknown' : 'n/a (job not installed)')}`)
  console.log(`Running:    ${r.running ? 'yes' : 'no'}`)
  console.log(`Evaluations: ${r.options.evaluate ? `on (up to ${r.options.top} listings per run, ${r.options.parallel} at a time, model ${r.options.model || 'runner default'})` : 'off (scan + triage only; enable with `config --evaluate on`)'}`)
  console.log(`Options:    jobspy ${r.options.jobspy ? 'on' : 'off'}`)
  console.log(`claude CLI: ${r.claudePath ?? 'NOT FOUND on PATH: evaluations will fail'}`)
  console.log(`Log:        ${r.logPath}`)
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdRun({ root, flags }) {
  const tools = toolchain()
  const log = makeLogger(root)
  const trigger = flags.trigger === 'scheduled' ? 'scheduled' : 'manual'
  const dryRun = flags['dry-run'] === true
  if (!dryRun && !flags['no-eval'] && !tools.claudePath) {
    log('warning: the `claude` CLI is not on PATH; the evaluation stage will fail')
  }

  // Keep the Mac awake while we work (best effort; idle sleep only).
  if (!dryRun) {
    try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref() } catch { /* optional */ }
  }

  let interrupted = false
  const onSignal = (sig) => {
    if (interrupted) return
    interrupted = true
    log(`received ${sig}: stopping`)
    if (activeChild) killGroup(activeChild, 'SIGTERM')
    // The in-flight stage resolves, runScheduled records what happened, and
    // the finally-block releases the lock; mark the run so it shows as stopped.
    setTimeout(() => process.exit(130), 15_000).unref()
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))

  const result = await runScheduled({
    root,
    exec: makeExec({ root, env: childEnv(tools) }),
    log,
    trigger,
    force: flags.force === true,
    dryRun,
    stopRequested: () => interrupted,
    noEval: flags['no-eval'] === true,
    nodePath: tools.nodePath,
    options: {
      top: num(flags.top), parallel: num(flags.parallel),
      model: typeof flags.model === 'string' ? (flags.model === 'default' ? '' : flags.model) : undefined,
      evaluate: flags.eval === true ? true : undefined,
      jobspy: flags.jobspy === true ? true : undefined,
    },
  })
  if (!dryRun && flags['no-message'] !== true) postRunMessage({ root, result, trigger, log })
  if (!dryRun && flags['no-message'] !== true) await postPortalSuggestions({ root, result, log })
  if (flags.json) console.log(JSON.stringify(result))
  return result.outcome === 'failed' || result.outcome === 'blocked' ? 1 : 0
}

/**
 * Tell the user in the app's Messages view when a run failed, or what it
 * found (scheduled-run-messages.mjs decides; quiet runs post nothing).
 * Best effort: a message that cannot be written never fails the run.
 */
function postRunMessage({ root, result, trigger, log }) {
  try {
    const since = runStartDate(result.run)
    let picks = []
    if (since) {
      try { picks = topPicksSince(readFileSync(join(root, 'data/score-history.tsv'), 'utf-8'), since) } catch { /* no history yet */ }
    }
    const msg = messageForRun(result, { picks, trigger })
    if (!msg) return
    const { posted, message } = postMessage(join(root, MESSAGES_REL), msg)
    log(posted ? `message for the app: ${message.title}` : `message already open: ${message.title}`)
  } catch (e) {
    log(`could not leave a message for the app: ${e.message}`)
  }
}

/**
 * After a scan that finished, suggest (as Messages) which tracked companies to
 * keep, pause or add (scripts/portal-review.mjs; it never edits portals.yml).
 * Best effort: a failure here never fails the run.
 */
async function postPortalSuggestions({ root, result, log }) {
  if (!result.run?.stages?.some((st) => st.name === 'scan' && st.status === 'ok')) return
  try {
    const r = await runReview({ root })
    if (r.posted.length) log(`portal review: ${r.posted.length} suggestion${r.posted.length === 1 ? '' : 's'} for the app (${r.posted.map((p) => `${p.action} ${p.company}`).join(', ')})`)
  } catch (e) {
    log(`portal review failed: ${e.message}`)
  }
}

async function cmdSuggest({ root, flags }) {
  const s = await suggest({ root, weeks: num(flags.weeks) || DEFAULT_WEEKS })
  if (flags.json) console.log(JSON.stringify(s, null, 2))
  else printSuggestion(s)
  return 0
}

async function cmdInstall({ root, flags }) {
  if (!existsSync(join(root, 'private')) && !existsSync(join(root, 'data'))) {
    console.error(`install: ${root} has no private/ folder or data/ links. Run this from the main checkout, where your data lives.`)
    return 1
  }
  const tools = toolchain()
  const state = readState(root)
  let slot
  let source
  if (flags.slot) {
    slot = parseSlot(flags.slot)
    if (!slot) { console.error(`install: could not read slot "${flags.slot}". Use e.g. --slot "tue 09:00".`); return 1 }
    source = 'from --slot'
  } else if (validSlot(state.slot)) {
    slot = state.slot
    source = 'saved earlier'
  } else {
    const s = await suggest({ root })
    slot = s.picks[0] ? { weekday: s.picks[0].weekday, hour: s.picks[0].hour, minute: s.picks[0].minute } : { ...FALLBACK_SLOT }
    source = `top suggestion (${s.confidence} confidence)`
  }
  if (!tools.claudePath) console.error('install: warning: `claude` is not on PATH, so evaluations would fail. Install the CLI first.')

  const plistDir = plistDirOf(flags)
  if (flags.print) {
    process.stdout.write(expectedPlistFor({ root, slot, ...tools }))
    console.error(`\n(slot ${formatSlot(slot)}, ${source}; would be written to ${plistPathFor(plistDir)}; nothing installed)`)
    return 0
  }
  const res = installJob({ root, slot, ...tools, plistDir, load: !noLoadOf(flags) })
  updateState(root, (s) => ({ ...s, enabled: true, slot }))
  console.log(`Installed ${LABEL}`)
  console.log(`  plist: ${res.plistPath}`)
  console.log(`  slot:  ${formatSlot(slot)} (${source}); retries every ${RETRY_EVERY_HOURS}h the same day if a run fails (never the next day), and runs when the Mac wakes if it was asleep`)
  console.log(`  runs:  only if no scan of any kind (app, manual or scheduled) happened in the last 7 days`)
  const o = resolveOptions(readState(root).options)
  console.log(`  evaluations: ${o.evaluate ? `ON (up to ${o.top} listings per run on ${o.model || 'the runner default model'}, unattended claude workers)` : 'OFF (scan + triage only; turn on with `npm run schedule -- config --evaluate on`)'}`)
  return 0
}

async function cmdUninstall({ root, flags }) {
  const r = uninstallJob({ plistDir: plistDirOf(flags), load: !noLoadOf(flags) })
  updateState(root, (s) => ({ ...s, enabled: false }))
  console.log(r.existed ? `Removed ${r.plistPath}` : 'The job was not installed.')
  return 0
}

async function cmdConfig({ root, flags }) {
  const patch = {}
  if (num(flags.top) !== undefined) patch.top = num(flags.top)
  if (num(flags.parallel) !== undefined) patch.parallel = num(flags.parallel)
  if (typeof flags.model === 'string') patch.model = flags.model === 'default' ? '' : flags.model
  if (flags.evaluate === 'on' || flags.evaluate === 'off') patch.evaluate = flags.evaluate === 'on'
  if (flags.jobspy === 'on' || flags.jobspy === 'off') patch.jobspy = flags.jobspy === 'on'
  if (Object.keys(patch).length) {
    updateState(root, (s) => ({ ...s, options: resolveOptions(s.options, patch) }))
  }
  const o = resolveOptions(readState(root).options)
  if (flags.json) console.log(JSON.stringify(o))
  else console.log(`evaluate ${o.evaluate ? 'on' : 'off'}, top ${o.top}, parallel ${o.parallel}, model ${o.model || 'runner default'}, jobspy ${o.jobspy ? 'on' : 'off'} (defaults: ${JSON.stringify(DEFAULT_OPTIONS)})`)
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv)
  const root = typeof flags.root === 'string' ? flags.root : repoRootFrom(import.meta.url)
  process.chdir(root)
  switch (command) {
    case 'run': return cmdRun({ root, flags })
    case 'suggest': return cmdSuggest({ root, flags })
    case 'install': return cmdInstall({ root, flags })
    case 'uninstall': return cmdUninstall({ root, flags })
    case 'config': return cmdConfig({ root, flags })
    case 'status': {
      const r = statusReport({ root, load: !noLoadOf(flags), plistDir: plistDirOf(flags) })
      if (flags.json) console.log(JSON.stringify(r))
      else printStatus(r)
      return 0
    }
    default:
      console.error(`unknown command "${command}". Commands: run, suggest, install, uninstall, status, config`)
      return 1
  }
}

// Compare real paths: when the checkout sits behind a link, argv[1] is the link
// path and import.meta.url the resolved one, and a plain comparison would make
// the script exit silently without doing anything.
const isEntry = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
})()
if (isEntry) {
  main().then((code) => process.exit(code), (e) => { console.error(e.stack ?? e.message); process.exit(1) })
}

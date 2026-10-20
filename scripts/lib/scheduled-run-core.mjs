/**
 * scheduled-run-core.mjs — the weekly run: scan → triage → evaluate → merge.
 *
 * `runScheduled` owns the sequencing, the cadence check, the lock and the
 * state record. It never spawns anything itself: every stage goes through the
 * injected `exec(stage, { onLine })`, which scheduled-run.mjs backs with real
 * child processes and the tests back with a fake. That keeps the guarantees
 * (7-day cadence, one run at a time, honest records, nothing sent or applied)
 * unit-testable.
 *
 * What it runs, all inside the user's checkout (cwd = `root`):
 *   scan          node scripts/scan.mjs                       (zero tokens)
 *   jobspy        python scripts/jobspy/scan.py + merge       (optional, zero tokens)
 *   triage        node scripts/triage-pipeline.mjs --emit-batch (zero tokens)
 *   evaluate      batch/batch-runner.sh [--model M]           (the only token spend; OPT-IN)
 *   merge         merge-scouting, merge-tracker, verify-pipeline
 * Nothing here applies, sends or submits anything: the workers only write
 * evaluation reports and tracker rows.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideRun, finalStatus, newRun, reconcileRuns, upsertRun, updateState, readState, acquireRunLock,
  lastFullRun, summarizeRun,
} from './schedule-core.mjs'

/**
 * `evaluate` is off by default: the workers run `claude -p` unattended (least
 * privilege, scripts/lib/worker-capabilities.mjs kind `eval`), and they
 * spend tokens, so the user opts in. `model` is
 * an optional override; empty means batch-runner.sh's own default (the latest
 * Opus), which stays the single source of truth, so scheduled and manual
 * evaluations are scored by the same model.
 */
export const DEFAULT_OPTIONS = Object.freeze({ top: 15, parallel: 2, model: '', evaluate: false, jobspy: false })

const MIN = 60_000
const HOUR = 60 * MIN

/** Files a run cannot do without; a missing one means onboarding is not finished. */
export const REQUIRED_FILES = ['user/portals.yml', 'user/profile.yml', 'user/cv.md', 'data/pipeline.md']

export function missingPrereqs(root, exists = existsSync) {
  return REQUIRED_FILES.filter((f) => !exists(join(root, f)))
}

/** Effective options: defaults, then the saved ones, then explicit overrides. */
export function resolveOptions(...layers) {
  const out = { ...DEFAULT_OPTIONS }
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (v !== undefined && v !== null && k in DEFAULT_OPTIONS) out[k] = v
    }
  }
  out.top = Math.max(1, Math.floor(Number(out.top)) || DEFAULT_OPTIONS.top)
  out.parallel = Math.max(1, Math.floor(Number(out.parallel)) || DEFAULT_OPTIONS.parallel)
  out.model = out.model ? String(out.model) : ''
  out.evaluate = out.evaluate === true
  out.jobspy = out.jobspy === true
  return out
}

/**
 * The ordered stages. `required: false` stages can fail without failing the
 * run; `abortOnFail` stops everything after them except the merges (which
 * are idempotent and also pick up leftovers of an interrupted earlier run).
 */
export function buildStages({ options, noEval = false, dryRun = false, nodePath = 'node', pythonPath = 'scripts/jobspy/.venv/bin/python' }) {
  const o = resolveOptions(options)
  const stages = [
    { name: 'scan', cmd: nodePath, args: ['scripts/scan.mjs'], required: true, abortOnFail: true, timeoutMs: 20 * MIN },
  ]
  if (o.jobspy) {
    stages.push(
      { name: 'jobspy', cmd: pythonPath, args: ['scripts/jobspy/scan.py'], required: false, timeoutMs: 20 * MIN },
      { name: 'jobspy-merge', cmd: nodePath, args: ['scripts/merge-scan-staging.mjs'], required: false, timeoutMs: 5 * MIN },
    )
  }
  stages.push({
    name: 'triage', cmd: nodePath,
    args: ['scripts/triage-pipeline.mjs', '--top', String(o.top), ...(dryRun || !(o.evaluate && !noEval) ? [] : ['--emit-batch'])],
    required: true, abortOnFail: true, timeoutMs: 5 * MIN,
  })
  if (o.evaluate && !noEval) {
    stages.push({
      name: 'evaluate', cmd: 'bash',
      args: ['batch/batch-runner.sh', ...(o.model ? ['--model', o.model] : []), '--parallel', String(o.parallel), ...(dryRun ? ['--dry-run'] : [])],
      required: true, timeoutMs: 6 * HOUR,
    })
  }
  if (!dryRun) {
    stages.push(
      { name: 'merge-scouting', cmd: nodePath, args: ['scripts/merge-scouting.mjs'], required: true, timeoutMs: 5 * MIN, alwaysRun: true },
      { name: 'merge-tracker', cmd: nodePath, args: ['scripts/merge-tracker.mjs'], required: true, timeoutMs: 5 * MIN, alwaysRun: true },
      { name: 'verify', cmd: nodePath, args: ['scripts/verify-pipeline.mjs'], required: false, informational: true, timeoutMs: 5 * MIN, alwaysRun: true },
    )
  }
  return stages
}

/** Pending `- [ ]` lines in pipeline.md under "## Pending" (0 when the file is unreadable). */
export function countPending(root, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const text = read(join(root, 'data/pipeline.md'))
    const m = /^## Pending\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)
    return ((m ? m[1] : text).match(/^- \[ \] /gm) ?? []).length
  } catch {
    return 0
  }
}

/**
 * Evaluation outcomes from batch-runner.sh output lines. The runner prints
 * "✅ Completed" whenever the worker exited cleanly, even if it wrote nothing
 * (its priority is then "-"), so a clean exit without a priority or a
 * "blocked" verdict is counted apart as `evalNoResult`.
 */
export function tallyBatchLine(line, tally) {
  if (line.includes('❌ Failed')) { tally.evalFailed++; return }
  if (!line.includes('✅ Completed')) return
  if (/blocked by eligibility/.test(line) || /priority:\s*\d/.test(line)) tally.evalCompleted++
  else tally.evalNoResult++
}

/** Sum of cost_usd in batch/logs/usage.tsv rows stamped at or after `sinceMs` (header-named columns). */
export function sumUsageCost(text, sinceMs) {
  const lines = String(text ?? '').split('\n').filter(Boolean)
  if (lines.length < 2) return 0
  const head = lines[0].split('\t')
  const ti = head.indexOf('timestamp')
  const ci = head.indexOf('cost_usd')
  if (ti < 0 || ci < 0) return 0
  let sum = 0
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    const at = Date.parse(cells[ti])
    const cost = Number(cells[ci])
    if (Number.isFinite(at) && at >= sinceMs && Number.isFinite(cost)) sum += cost
  }
  return Math.round(sum * 10_000) / 10_000
}

/** "triage: ... — 7 added, 2 already present" -> 7 */
export function parseTriageAdded(line) {
  const m = /—\s*(\d+) added/.exec(line)
  return m ? Number(m[1]) : null
}

const iso = (ms) => new Date(ms).toISOString()

/**
 * Run the weekly pipeline once.
 *
 * Returns { outcome, ... } where outcome is one of
 *   'skipped'   a full run finished within the last 7 days (nothing recorded)
 *   'locked'    another run holds the lock (nothing recorded)
 *   'blocked'   onboarding is incomplete (`missing` lists the files)
 *   'dry-run'   plan printed, read-only stages ran, nothing recorded
 *   'completed' | 'completed-with-errors' | 'partial' | 'failed'  (recorded in the state file)
 */
export async function runScheduled({
  root, exec, log = () => {}, now = () => Date.now(),
  trigger = 'manual', force = false, dryRun = false, noEval = false,
  options = {}, nodePath = 'node', pythonPath, exists = existsSync, runId, stopRequested = () => false,
  readUsage = (r) => { try { return readFileSync(join(r, 'batch/logs/usage.tsv'), 'utf8') } catch { return '' } },
}) {
  const t0 = now()
  const state0 = readState(root)
  const opts = resolveOptions(state0.options, options)

  const missing = missingPrereqs(root, exists)
  if (missing.length) {
    log(`blocked: onboarding is not finished (missing ${missing.join(', ')})`)
    return { outcome: 'blocked', missing }
  }

  if (dryRun) {
    const stages = buildStages({ options: opts, noEval, dryRun: true, nodePath, pythonPath })
    log(`dry run (${trigger}): nothing is written and no worker is spawned`)
    const decision = decideRun({ state: state0, now: t0, force: true })
    const natural = decideRun({ state: state0, now: t0 })
    log(`cadence: ${natural.run ? 'a real run would start now' : 'a real run would be skipped: ' + natural.reason}`)
    log(`options: evaluations ${opts.evaluate ? 'on' : 'off (enable with `config --evaluate on`, or `run --eval` for one run)'}, top ${opts.top}, parallel ${opts.parallel}, model ${opts.model || 'runner default'}, jobspy ${opts.jobspy ? 'on' : 'off'}`)
    const results = []
    for (const s of stages) {
      if (s.name === 'scan' || s.name === 'jobspy' || s.name === 'jobspy-merge') {
        log(`would run [${s.name}]: ${s.cmd} ${s.args.join(' ')}`)
        results.push({ name: s.name, status: 'planned' })
        continue
      }
      if (s.name === 'evaluate' && !exists(join(root, 'batch/batch-input.tsv'))) {
        log('would run [evaluate]: batch/batch-input.tsv does not exist yet; the real triage stage creates it')
        results.push({ name: s.name, status: 'planned' })
        continue
      }
      log(`running read-only [${s.name}]: ${s.cmd} ${s.args.join(' ')}`)
      const r = await exec(s, { onLine: (l) => log(`  ${s.name} | ${l}`) })
      results.push({ name: s.name, status: r.code === 0 ? 'ok' : 'failed', code: r.code })
    }
    return { outcome: 'dry-run', stages: results, decision, wouldRun: natural.run }
  }

  const decision = decideRun({ state: state0, now: t0, force })
  if (!decision.run) {
    log(`skipped: ${decision.reason}`)
    return { outcome: 'skipped', reason: decision.reason }
  }

  const lock = acquireRunLock(root, { label: `scheduled-run (${trigger})` })
  if (!lock) {
    log('skipped: another scheduled run is in progress')
    return { outcome: 'locked' }
  }

  const id = runId ?? `${iso(t0)}-${Math.random().toString(16).slice(2, 8)}`
  let run = newRun({ id, trigger, now: t0 })
  // A record still `running` while we hold the lock belongs to a dead process.
  updateState(root, (s) => upsertRun(reconcileRuns(s, { now: t0 }), run))

  const persist = () => updateState(root, (s) => upsertRun(s, run))
  const tally = { evalCompleted: 0, evalFailed: 0, evalNoResult: 0 }
  const summary = {}
  run.summary = summary
  let aborted = false
  let stopped = false

  try {
    log(`run ${id} starting (${trigger}${force ? ', forced' : ''}): ${decision.reason}`)
    summary.pendingBefore = countPending(root)

    for (const stage of buildStages({ options: opts, noEval, nodePath, pythonPath })) {
      // A stop request (SIGTERM from launchd, Ctrl-C) ends the run: no further stage starts.
      if (stopRequested()) { stopped = true; aborted = true }
      if (stopped || (aborted && !stage.alwaysRun)) {
        run.stages.push({ name: stage.name, status: 'skipped', required: stage.required })
        continue
      }
      const started = now()
      log(`[${stage.name}] ${stage.cmd} ${stage.args.join(' ')}`)
      let result
      try {
        result = await exec(stage, {
          onLine: (line) => {
            log(`  ${stage.name} | ${line}`)
            if (stage.name === 'evaluate') tallyBatchLine(line, tally)
            if (stage.name === 'triage') { const n = parseTriageAdded(line); if (n !== null) summary.queued = n }
          },
        })
      } catch (e) {
        result = { code: -1, error: e.message }
      }
      const ok = result.code === 0
      run.stages.push({
        name: stage.name, status: ok ? 'ok' : (stage.informational ? 'warn' : 'failed'), required: stage.required,
        code: result.code, ms: now() - started,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
      if (stage.name === 'scan') summary.scanNew = Math.max(0, countPending(root) - summary.pendingBefore)
      if (!ok) {
        log(`[${stage.name}] ${stage.informational ? 'reported issues' : 'failed'} (${result.timedOut ? 'timed out' : result.error ?? `exit ${result.code}`})`)
        if (stage.abortOnFail) aborted = true
        if (!run.error && stage.required) run.error = result.timedOut ? `${stage.name} timed out` : (result.error ?? `${stage.name} exited ${result.code}`)
      }
      persist()
    }

    summary.evaluations = opts.evaluate && !noEval
    if (run.stages.some((x) => x.name === 'evaluate' && x.status !== 'skipped')) {
      summary.evalCompleted = tally.evalCompleted
      summary.evalFailed = tally.evalFailed
      summary.evalNoResult = tally.evalNoResult
      summary.costUsd = sumUsageCost(readUsage(root), t0)
    }
    summary.pendingAfter = countPending(root)
    let status = finalStatus(run.stages, summary)
    if (status !== 'failed' && noEval) status = 'partial'
    if (stopped) { status = 'interrupted'; run.error = run.error ?? 'stopped before it finished' }
    run = { ...run, status, finishedAt: iso(now()), summary }
  } catch (e) {
    run = { ...run, status: 'failed', finishedAt: iso(now()), error: e.message, summary }
    log(`run crashed: ${e.stack ?? e.message}`)
  } finally {
    try { persist() } finally { lock.release() }
  }

  log(`run ${id} ${run.status}: ${summarizeRun(run)}`)
  return { outcome: run.status, run }
}

export { lastFullRun }

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runScheduled, buildStages, resolveOptions, missingPrereqs, countPending, parseTriageAdded, tallyBatchLine,
} from './scheduled-run-core.mjs'
import { readState, updateState, acquireRunLock, upsertRun, summarizeRun } from './schedule-core.mjs'

const DAY = 86_400_000

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sched-run-'))
  for (const d of ['data', 'user']) mkdirSync(join(root, d))
  writeFileSync(join(root, 'user/portals.yml'), 'x: 1\n')
  writeFileSync(join(root, 'user/profile.yml'), 'x: 1\n')
  writeFileSync(join(root, 'user/cv.md'), '# cv\n')
  writeFileSync(join(root, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n- [ ] https://example.com/a\n\n## Processed\n- [x] https://example.com/old\n')
  return root
}

/** A fake exec: records each stage, lets a test script its behaviour per stage name. */
function fakeExec(root, script = {}) {
  const calls = []
  const exec = async (stage, { onLine }) => {
    calls.push(stage.name)
    const behaviour = script[stage.name]
    if (behaviour?.before) behaviour.before(root)
    for (const l of behaviour?.lines ?? []) onLine(l)
    return { code: behaviour?.code ?? 0, timedOut: behaviour?.timedOut }
  }
  return { exec, calls }
}

const happy = {
  scan: { before: (root) => writeFileSync(join(root, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n- [ ] https://example.com/a\n- [ ] https://example.com/b\n- [ ] https://example.com/c\n\n## Processed\n'), lines: ['scan done'] },
  triage: { lines: ['triage: batch/batch-input.tsv updated — 2 added, 0 already present. Next: ./batch/batch-runner.sh --dry-run'] },
  evaluate: { lines: ['    ✅ Completed (priority: 7.1, report: 12)', '    ✅ Completed (priority: 5.2, report: 13)', '    ❌ Failed (attempt 1, exit code 1)'] },
}

test('buildStages orders scan, triage, evaluate, merges and puts the model and slice on the command lines', () => {
  const names = buildStages({ options: { top: 10, parallel: 3, model: 'sonnet' } })
  assert.deepEqual(names.map((s) => s.name), ['scan', 'triage', 'evaluate', 'merge-scouting', 'merge-tracker', 'verify'])
  const triage = names.find((s) => s.name === 'triage')
  assert.deepEqual(triage.args, ['scripts/triage-pipeline.mjs', '--top', '10', '--emit-batch'])
  const evaluate = names.find((s) => s.name === 'evaluate')
  assert.deepEqual(evaluate.args, ['batch/batch-runner.sh', '--model', 'sonnet', '--parallel', '3'])
})

test('buildStages: --no-eval drops the evaluation, jobspy adds its two stages, dry run never emits or merges', () => {
  assert.ok(!buildStages({ options: {}, noEval: true }).some((s) => s.name === 'evaluate'))
  assert.ok(buildStages({ options: { jobspy: true } }).some((s) => s.name === 'jobspy-merge'))
  const dry = buildStages({ options: {}, dryRun: true })
  assert.ok(!dry.find((s) => s.name === 'triage').args.includes('--emit-batch'))
  assert.ok(dry.find((s) => s.name === 'evaluate').args.includes('--dry-run'))
  assert.ok(!dry.some((s) => s.name.startsWith('merge')))
})

test('resolveOptions layers defaults, saved options and overrides, and clamps junk', () => {
  assert.deepEqual(resolveOptions({ top: 5 }, { parallel: 4, model: undefined }), { top: 5, parallel: 4, model: 'sonnet', jobspy: false })
  assert.equal(resolveOptions({ top: 'abc', parallel: -3 }).top, 15)
  assert.equal(resolveOptions({ parallel: -3 }).parallel, 1)
  assert.equal(resolveOptions({ unknown: 1 }).unknown, undefined)
})

test('countPending counts only the Pending section; parsers read the child output', () => {
  const root = fixtureRoot()
  try {
    assert.equal(countPending(root), 1)
    assert.equal(countPending(join(root, 'nowhere')), 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
  assert.equal(parseTriageAdded('triage: x updated — 7 added, 2 already present.'), 7)
  assert.equal(parseTriageAdded('nothing'), null)
  const t = { evalCompleted: 0, evalFailed: 0, evalNoResult: 0 }
  tallyBatchLine('    ✅ Completed (priority: 7.1, report: 12)', t)
  tallyBatchLine('    ✅ Completed (blocked by eligibility, report: 13)', t)
  tallyBatchLine('    ✅ Completed (priority: -, report: 14)', t)
  tallyBatchLine('    ❌ Failed (attempt 1, exit code 1)', t)
  tallyBatchLine('--- Processing offer #1: https://example.com/x (report 003, attempt 1)', t)
  assert.deepEqual(t, { evalCompleted: 2, evalFailed: 1, evalNoResult: 1 })
})

test('missingPrereqs lists the onboarding files that are absent', () => {
  const root = fixtureRoot()
  try {
    assert.deepEqual(missingPrereqs(root), [])
    rmSync(join(root, 'user/cv.md'))
    assert.deepEqual(missingPrereqs(root), ['user/cv.md'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full run: stages in order, summary recorded, lock released, status completed-with-errors when a worker failed', async () => {
  const root = fixtureRoot()
  try {
    const { exec, calls } = fakeExec(root, happy)
    const logs = []
    const r = await runScheduled({ root, exec, log: (l) => logs.push(l), trigger: 'scheduled' })
    assert.equal(r.outcome, 'completed-with-errors')
    assert.deepEqual(calls, ['scan', 'triage', 'evaluate', 'merge-scouting', 'merge-tracker', 'verify'])
    const state = readState(root)
    assert.equal(state.runs.length, 1)
    const run = state.runs[0]
    assert.equal(run.trigger, 'scheduled')
    assert.equal(run.status, 'completed-with-errors')
    assert.equal(run.summary.scanNew, 2)
    assert.equal(run.summary.queued, 2)
    assert.equal(run.summary.evalCompleted, 2)
    assert.equal(run.summary.evalFailed, 1)
    assert.ok(run.finishedAt)
    assert.equal(acquireRunLock(root)?.release() !== undefined, true, 'lock is free after the run')
    assert.ok(logs.some((l) => /completed-with-errors/.test(l)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the 7-day cadence: a second invocation right after skips and spawns nothing', async () => {
  const root = fixtureRoot()
  try {
    const first = fakeExec(root, { ...happy, evaluate: { lines: ['    ✅ Completed (priority: 7.1, report: 12)'] } })
    assert.equal((await runScheduled({ root, exec: first.exec })).outcome, 'completed')
    const second = fakeExec(root)
    const r = await runScheduled({ root, exec: second.exec, trigger: 'scheduled' })
    assert.equal(r.outcome, 'skipped')
    assert.match(r.reason, /days ago/)
    assert.deepEqual(second.calls, [])
    assert.equal(readState(root).runs.length, 1, 'a skip leaves no record')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cadence passes after 7 days and with --force', async () => {
  const root = fixtureRoot()
  try {
    const t0 = Date.parse('2026-10-20T09:00:00Z')
    const a = fakeExec(root, happy)
    await runScheduled({ root, exec: a.exec, now: () => t0 })
    const b = fakeExec(root, happy)
    assert.equal((await runScheduled({ root, exec: b.exec, now: () => t0 + 3 * DAY })).outcome, 'skipped')
    assert.equal((await runScheduled({ root, exec: b.exec, now: () => t0 + 3 * DAY, force: true })).outcome, 'completed-with-errors')
    const c = fakeExec(root, happy)
    assert.notEqual((await runScheduled({ root, exec: c.exec, now: () => t0 + 11 * DAY })).outcome, 'skipped')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the lock: a run in progress makes a second one stand down without spawning or recording', async () => {
  const root = fixtureRoot()
  try {
    const held = acquireRunLock(root)
    const { exec, calls } = fakeExec(root)
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'locked')
    assert.deepEqual(calls, [])
    assert.equal(readState(root).runs.length, 0)
    held.release()
    assert.equal((await runScheduled({ root, exec: fakeExec(root, happy).exec })).outcome !== 'locked', true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('two overlapping runs: exactly one executes', async () => {
  const root = fixtureRoot()
  try {
    let release
    const gate = new Promise((res) => { release = res })
    const calls = []
    const slow = async (stage) => { calls.push(stage.name); if (stage.name === 'scan') await gate; return { code: 0 } }
    const a = runScheduled({ root, exec: slow, force: true })
    await new Promise((r) => setTimeout(r, 30))
    const b = await runScheduled({ root, exec: fakeExec(root).exec, force: true })
    assert.equal(b.outcome, 'locked')
    release()
    assert.equal((await a).outcome, 'completed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed scan aborts triage and evaluation but still runs the idempotent merges; failure is retried (not a full run)', async () => {
  const root = fixtureRoot()
  try {
    const { exec, calls } = fakeExec(root, { scan: { code: 1 } })
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'failed')
    assert.deepEqual(calls, ['scan', 'merge-scouting', 'merge-tracker', 'verify'])
    const run = readState(root).runs[0]
    assert.equal(run.status, 'failed')
    assert.deepEqual(run.stages.filter((s) => s.status === 'skipped').map((s) => s.name), ['triage', 'evaluate'])
    assert.match(run.error, /scan exited 1/)
    // Not a full run, so the next fire goes ahead.
    const again = await runScheduled({ root, exec: fakeExec(root, happy).exec })
    assert.notEqual(again.outcome, 'skipped')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an evaluation stage that cannot start fails the run but the merges still happen', async () => {
  const root = fixtureRoot()
  try {
    const { exec, calls } = fakeExec(root, { ...happy, evaluate: { code: 1 } })
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'failed')
    assert.ok(calls.includes('merge-scouting'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a throwing exec is recorded as a failed stage, never crashes the run or leaks the lock', async () => {
  const root = fixtureRoot()
  try {
    const exec = async (stage) => { if (stage.name === 'scan') throw new Error('spawn ENOENT'); return { code: 0 } }
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'failed')
    assert.equal(readState(root).runs[0].stages[0].error, 'spawn ENOENT')
    assert.ok(acquireRunLock(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--no-eval records a partial run that does not start the 7 days', async () => {
  const root = fixtureRoot()
  try {
    const { exec, calls } = fakeExec(root, happy)
    const r = await runScheduled({ root, exec, noEval: true })
    assert.equal(r.outcome, 'partial')
    assert.ok(!calls.includes('evaluate'))
    const next = await runScheduled({ root, exec: fakeExec(root, happy).exec })
    assert.notEqual(next.outcome, 'skipped')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('workers that exit cleanly without a result degrade the run and are reported as such', async () => {
  const root = fixtureRoot()
  try {
    const { exec } = fakeExec(root, { ...happy, evaluate: { lines: ['    ✅ Completed (priority: -, report: 12)'] } })
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'completed-with-errors')
    assert.equal(r.run.summary.evalNoResult, 1)
    assert.match(summarizeRun(r.run), /1 without a result/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a verify warning does not degrade the run', async () => {
  const root = fixtureRoot()
  try {
    const { exec } = fakeExec(root, { ...happy, evaluate: { lines: ['    ✅ Completed (priority: 7.1, report: 12)'] }, verify: { code: 1 } })
    assert.equal((await runScheduled({ root, exec })).outcome, 'completed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a record left running by a dead process is marked interrupted on the next run', async () => {
  const root = fixtureRoot()
  try {
    updateState(root, (s) => upsertRun(s, { id: 'ghost', trigger: 'scheduled', startedAt: '2026-10-01T09:00:00.000Z', finishedAt: null, status: 'running', stages: [], summary: {}, error: null }))
    await runScheduled({ root, exec: fakeExec(root, happy).exec })
    const ghost = readState(root).runs.find((r) => r.id === 'ghost')
    assert.equal(ghost.status, 'interrupted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run: runs only read-only stages, writes no state, spawns no evaluation workers', async () => {
  const root = fixtureRoot()
  try {
    const { exec, calls } = fakeExec(root)
    const logs = []
    const r = await runScheduled({ root, exec, dryRun: true, log: (l) => logs.push(l) })
    assert.equal(r.outcome, 'dry-run')
    assert.deepEqual(calls, ['triage'], 'scan is only planned; evaluate is only planned while there is no batch input')
    mkdirSync(join(root, 'batch'))
    writeFileSync(join(root, 'batch/batch-input.tsv'), 'id\turl\tsource\tnotes\n')
    const again = fakeExec(root)
    const logs2 = []
    await runScheduled({ root, exec: again.exec, dryRun: true, log: (l) => logs2.push(l) })
    assert.deepEqual(again.calls, ['triage', 'evaluate'], 'with a batch input, batch-runner --dry-run runs')
    assert.equal(readState(root).runs.length, 0)
    assert.ok(logs.some((l) => /would run \[scan\]/.test(l)))
    assert.ok(logs2.some((l) => /batch-runner\.sh .*--dry-run/.test(l)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('onboarding incomplete: blocked, nothing runs or is recorded', async () => {
  const root = fixtureRoot()
  try {
    rmSync(join(root, 'user/profile.yml'))
    const { exec, calls } = fakeExec(root)
    const r = await runScheduled({ root, exec })
    assert.equal(r.outcome, 'blocked')
    assert.deepEqual(r.missing, ['user/profile.yml'])
    assert.deepEqual(calls, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saved options reach the commands; explicit overrides win', async () => {
  const root = fixtureRoot()
  try {
    updateState(root, (s) => ({ ...s, options: { top: 4, parallel: 1 } }))
    const seen = []
    const exec = async (stage) => { seen.push(stage); return { code: 0 } }
    await runScheduled({ root, exec, options: { top: 6 }, force: true })
    assert.deepEqual(seen.find((s) => s.name === 'triage').args.slice(0, 3), ['scripts/triage-pipeline.mjs', '--top', '6'])
    assert.ok(seen.find((s) => s.name === 'evaluate').args.includes('1'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a stop request (SIGTERM) ends the run: later stages never start, status is interrupted, it does not count as a full run', async () => {
  const root = fixtureRoot()
  try {
    let stop = false
    const calls = []
    const exec = async (stage) => { calls.push(stage.name); if (stage.name === 'triage') { stop = true; return { code: 143 } } return { code: 0 } }
    const r = await runScheduled({ root, exec, stopRequested: () => stop })
    assert.equal(r.outcome, 'interrupted')
    assert.deepEqual(calls, ['scan', 'triage'])
    const next = await runScheduled({ root, exec: fakeExec(root, happy).exec })
    assert.notEqual(next.outcome, 'skipped')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

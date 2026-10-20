import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScheduleStatus, parseSlotSuggestion, slotArg, slotLabel, sameSlot, schedulerArgs,
  runResultChip, jobStateLine, formatWhen, WEEKDAY_ORDER, modelLabel, evaluationCapLine, formatCost, type ScheduleStatus,
} from './schedule'

const STATUS_JSON = JSON.stringify({
  installed: true, loaded: true, upToDate: true, problems: [], plistPath: '/x/a.plist',
  slot: { weekday: 3, hour: 12, minute: 0 }, slotLabel: 'Wednesday 12:00', running: false,
  lastRun: {
    id: 'r1', trigger: 'scheduled', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    status: 'completed-with-errors', stages: [], summary: { costUsd: 3.42, evalCompleted: 8 }, error: null, summaryText: '12 new listings, 8 evaluated, 1 failed',
  },
  lastFullRunAt: '2026-10-21T10:40:00.000Z', nextRunAt: '2026-10-28T11:00:00.000Z', dueNow: false,
  options: { top: 15, parallel: 2, model: '', evaluate: true, jobspy: false },
  logPath: '/x/data/scheduled-runs.log', root: '/x', claudeFound: true,
})

test('parseScheduleStatus reads the CLI json, even behind log lines', () => {
  const s = parseScheduleStatus('some noise\n' + STATUS_JSON + '\n')
  assert.ok(s)
  assert.equal(s.installed, true)
  assert.deepEqual(s.slot, { weekday: 3, hour: 12, minute: 0 })
  assert.equal(s.slotLabel, 'Wednesday 12:00')
  assert.equal(s.lastRun?.status, 'completed-with-errors')
  assert.equal(s.lastRun?.summaryText, '12 new listings, 8 evaluated, 1 failed')
  assert.equal(s.options.model, '')
  assert.equal(s.options.evaluate, true)
  assert.equal(s.lastRun?.costUsd, 3.42)
  assert.equal(s.lastRun?.evaluated, 8)
  assert.equal(s.root, '/x')
})

test('parseScheduleStatus tolerates a fresh install and rejects junk', () => {
  const s = parseScheduleStatus(JSON.stringify({ installed: false, slot: null, lastRun: null }))
  assert.ok(s)
  assert.equal(s.slot, null)
  assert.equal(s.lastRun, null)
  assert.equal(s.options.top, 15)
  assert.equal(s.options.evaluate, false, 'evaluations are off unless the CLI says so')
  assert.equal(s.lastRun, null)
  assert.equal(s.claudeFound, true)
  assert.equal(parseScheduleStatus(''), null)
  assert.equal(parseScheduleStatus('not json'), null)
  assert.equal(parseScheduleStatus('{"hello":1}'), null)
  assert.equal(parseScheduleStatus(JSON.stringify({ installed: true, slot: { weekday: 9, hour: 1 } }))?.slot, null)
})

test('parseSlotSuggestion keeps valid picks and the confidence', () => {
  const s = parseSlotSuggestion(JSON.stringify({
    picks: [{ weekday: 3, hour: 12, minute: 0, evidence: 'quiet' }, { weekday: 99, hour: 1 }],
    confidence: 'medium', fallback: false,
  }))
  assert.ok(s)
  assert.equal(s.picks.length, 1)
  assert.equal(s.picks[0].label, 'Wednesday 12:00')
  assert.equal(s.confidence, 'medium')
  assert.equal(parseSlotSuggestion('{"picks":[]}'), null)
  assert.equal(parseSlotSuggestion('nope'), null)
})

test('slotArg is what the CLI parses; labels and comparison are consistent', () => {
  assert.equal(slotArg({ weekday: 2, hour: 9, minute: 30 }), 'tue 09:30')
  assert.equal(slotArg({ weekday: 0, hour: 18, minute: 0 }), 'sun 18:00')
  assert.equal(slotLabel({ weekday: 6, hour: 7, minute: 5 }), 'Saturday 07:05')
  assert.equal(sameSlot({ weekday: 1, hour: 1, minute: 0 }, { weekday: 1, hour: 1, minute: 0 }), true)
  assert.equal(sameSlot({ weekday: 1, hour: 1, minute: 0 }, { weekday: 1, hour: 2, minute: 0 }), false)
  assert.equal(sameSlot(null, null), true)
  assert.equal(sameSlot(null, { weekday: 1, hour: 1, minute: 0 }), false)
})

test('schedulerArgs build the exact commands', () => {
  assert.deepEqual(schedulerArgs.status(), ['scripts/scheduled-run.mjs', 'status', '--json'])
  assert.deepEqual(schedulerArgs.install({ weekday: 4, hour: 8, minute: 15 }), ['scripts/scheduled-run.mjs', 'install', '--slot', 'thu 08:15'])
  assert.deepEqual(schedulerArgs.install(), ['scripts/scheduled-run.mjs', 'install'])
  assert.deepEqual(schedulerArgs.uninstall(), ['scripts/scheduled-run.mjs', 'uninstall'])
  assert.deepEqual(schedulerArgs.setEvaluate(true), ['scripts/scheduled-run.mjs', 'config', '--evaluate', 'on'])
  assert.deepEqual(schedulerArgs.setModel(''), ['scripts/scheduled-run.mjs', 'config', '--model', 'default'])
  assert.deepEqual(schedulerArgs.setModel('sonnet'), ['scripts/scheduled-run.mjs', 'config', '--model', 'sonnet'])
  assert.deepEqual(schedulerArgs.setTop(10), ['scripts/scheduled-run.mjs', 'config', '--top', '10'])
})

test('runResultChip covers every status', () => {
  assert.equal(runResultChip('completed').tone, 'success')
  assert.equal(runResultChip('completed-with-errors').tone, 'warning')
  assert.equal(runResultChip('failed').tone, 'danger')
  assert.equal(runResultChip('partial').label, 'Scan only')
  assert.equal(runResultChip(undefined).label, 'No runs yet')
})

test('jobStateLine distinguishes off, unloaded, attention and on', () => {
  const base = parseScheduleStatus(STATUS_JSON) as ScheduleStatus
  assert.equal(jobStateLine({ ...base, installed: false }), 'Off. Nothing runs on its own.')
  assert.match(jobStateLine({ ...base, loaded: false }), /not loaded/)
  assert.match(jobStateLine({ ...base, upToDate: false }), /needs attention/)
  assert.equal(jobStateLine(base), 'On.')
})

test('formatWhen formats an ISO time and falls back for blanks and junk', () => {
  assert.equal(formatWhen(null), '—')
  assert.equal(formatWhen('garbage'), 'garbage')
  assert.match(formatWhen('2026-10-28T11:00:00.000Z'), /\d{2}:\d{2}/)
})

test('the weekday display order is Monday first and covers all seven days once', () => {
  assert.equal(WEEKDAY_ORDER[0], 1)
  assert.equal(WEEKDAY_ORDER[6], 0)
  assert.deepEqual([...WEEKDAY_ORDER].sort(), [0, 1, 2, 3, 4, 5, 6])
})

test('the model label and cap line say the runner default is the latest Opus; cost formats', () => {
  assert.equal(modelLabel(''), 'the default (latest Opus)')
  assert.equal(modelLabel('sonnet'), 'Sonnet')
  assert.equal(evaluationCapLine({ top: 15, parallel: 2, model: '', evaluate: true, jobspy: false }), 'Up to 15 listings per run, 2 at a time, on the default (latest Opus).')
  assert.equal(formatCost(3.4189), '$3.42')
  assert.equal(formatCost(null), '—')
  assert.equal(formatCost(0), '—')
})

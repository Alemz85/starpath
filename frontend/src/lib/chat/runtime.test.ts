// Tests for the chat runtime reducer — the piece both processes run.
//
// What matters here: the phase machine never lets two generations overlap,
// every mutation emits exactly one monotonically-sequenced envelope, the
// renderer's fold of those envelopes lands on the same snapshot the main
// process holds, a snapshot restored from disk mid-generation becomes
// `interrupted` rather than a phantom "still working", and every byte cap
// actually bites.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ASSISTANT_TEXT_BYTES,
  MAX_ERROR_BYTES,
  MAX_WORK_DETAIL_BYTES,
  MAX_WORK_ENTRIES,
  MAX_WORK_LABEL_BYTES,
  applyEnvelope,
  mergeRuntime,
  parseRuntimeSnapshot,
  reduceRuntime,
  restoreRuntime,
  truncateUtf8,
  utf8Length,
} from '@/lib/chat/runtime'
import type { ChatRuntimeEnvelope, ChatRuntimeSnapshot } from '@/lib/chat/types'

const T0 = '2026-08-18T09:00:00.000Z'
const T1 = '2026-08-18T09:00:01.000Z'

function begin(): ChatRuntimeSnapshot {
  return reduceRuntime(null, {
    type: 'begin', generationId: 'g1', sessionId: 's1', message: 'what is urgent?',
  }, T0).snapshot
}

// ─── Phase machine ───────────────────────────────────────────────────────────

test('begin opens a starting generation and emits sequence 1', () => {
  const step = reduceRuntime(null, {
    type: 'begin', generationId: 'g1', sessionId: 's1', message: 'hello',
  }, T0)
  assert.equal(step.snapshot.phase, 'starting')
  assert.equal(step.snapshot.lastSequence, 1)
  assert.equal(step.snapshot.assistantText, '')
  assert.equal(step.snapshot.resumeAvailable, false)
  assert.equal(step.envelope?.sequence, 1)
  assert.equal(step.envelope?.event.kind, 'status')
  assert.equal((step.envelope?.event as { label: string }).label, 'Starting')
})

test('start → streaming → completed walks the whole happy path', () => {
  let snapshot = begin()
  snapshot = reduceRuntime(snapshot, { type: 'running' }, T0).snapshot
  assert.equal(snapshot.phase, 'running')
  snapshot = reduceRuntime(snapshot, { type: 'text', text: 'Two ' }, T0).snapshot
  snapshot = reduceRuntime(snapshot, { type: 'text', text: 'deadlines.' }, T0).snapshot
  assert.equal(snapshot.assistantText, 'Two deadlines.')
  const done = reduceRuntime(snapshot, { type: 'completed' }, T1)
  assert.equal(done.snapshot.phase, 'completed')
  assert.equal(done.snapshot.error, null)
  assert.deepEqual(done.envelope?.event, { kind: 'done' })
  // 1 begin + 1 running + 2 text + 1 done
  assert.equal(done.snapshot.lastSequence, 5)
})

test('text on a still-starting generation promotes it to running', () => {
  const snapshot = reduceRuntime(begin(), { type: 'text', text: 'hi' }, T0).snapshot
  assert.equal(snapshot.phase, 'running')
})

test('failed records the message on the snapshot and in the envelope', () => {
  const step = reduceRuntime(begin(), { type: 'failed', message: 'claude exited with code 1' }, T1)
  assert.equal(step.snapshot.phase, 'failed')
  assert.equal(step.snapshot.error, 'claude exited with code 1')
  assert.deepEqual(step.envelope?.event, { kind: 'error', message: 'claude exited with code 1' })
})

test('stopping then completed is how an interrupt-by-user reads', () => {
  let snapshot = reduceRuntime(begin(), { type: 'running' }, T0).snapshot
  snapshot = reduceRuntime(snapshot, { type: 'stopping' }, T0).snapshot
  assert.equal(snapshot.phase, 'stopping')
  // main treats a SIGTERM'd run as complete — the partial answer is the answer.
  snapshot = reduceRuntime(snapshot, { type: 'completed' }, T1).snapshot
  assert.equal(snapshot.phase, 'completed')
})

test('a second begin while a generation is live is refused', () => {
  const live = reduceRuntime(begin(), { type: 'running' }, T0).snapshot
  assert.throws(
    () => reduceRuntime(live, { type: 'begin', generationId: 'g2', sessionId: 's1', message: 'again' }, T1),
    /already running/i,
  )
})

test('begin is allowed once the previous generation reached a terminal phase', () => {
  const finished = reduceRuntime(begin(), { type: 'completed' }, T0).snapshot
  const next = reduceRuntime(finished, {
    type: 'begin', generationId: 'g2', sessionId: 's1', message: 'follow-up',
  }, T1)
  assert.equal(next.snapshot.generationId, 'g2')
  assert.equal(next.snapshot.lastSequence, 1)  // sequence restarts per generation
})

test('resume-available is bookkeeping — no envelope, no sequence burn', () => {
  const snapshot = begin()
  const step = reduceRuntime(snapshot, { type: 'resume-available', available: true }, T1)
  assert.equal(step.envelope, null)
  assert.equal(step.snapshot.resumeAvailable, true)
  assert.equal(step.snapshot.lastSequence, snapshot.lastSequence)
})

// ─── Work log ────────────────────────────────────────────────────────────────

test('phase transitions are themselves work-log lines', () => {
  // Both processes must hold the same log — the renderer folds every status
  // envelope in, so main records them too (see `transition`).
  const snapshot = reduceRuntime(begin(), { type: 'running' }, T0).snapshot
  assert.deepEqual(snapshot.workLog.map(e => e.label), ['Starting', 'Working'])
  assert.ok(snapshot.workLog.every(e => e.kind === 'status'))
})

test('work entries land in the log and emit a matching envelope', () => {
  const step = reduceRuntime(begin(), {
    type: 'work', kind: 'tool', label: 'Read data/scouting.md', detail: '{"file_path":"x"}',
  }, T1)
  assert.equal(step.snapshot.workLog.at(-1)!.label, 'Read data/scouting.md')
  assert.deepEqual(step.envelope?.event, {
    kind: 'tool', name: 'Read data/scouting.md', detail: '{"file_path":"x"}',
  })
})

test('the work log is capped by entry count, keeping the newest', () => {
  let snapshot = begin()
  for (let i = 0; i < MAX_WORK_ENTRIES + 25; i++) {
    snapshot = reduceRuntime(snapshot, { type: 'work', kind: 'status', label: `step ${i}` }, T1).snapshot
  }
  assert.equal(snapshot.workLog.length, MAX_WORK_ENTRIES)
  assert.equal(snapshot.workLog.at(-1)!.label, `step ${MAX_WORK_ENTRIES + 24}`)
})

test('work labels and details are byte-capped', () => {
  const step = reduceRuntime(begin(), {
    type: 'work', kind: 'tool', label: 'L'.repeat(MAX_WORK_LABEL_BYTES + 500),
    detail: 'D'.repeat(MAX_WORK_DETAIL_BYTES + 500),
  }, T1)
  assert.equal(utf8Length(step.snapshot.workLog.at(-1)!.label), MAX_WORK_LABEL_BYTES)
  assert.equal(utf8Length(step.snapshot.workLog.at(-1)!.detail), MAX_WORK_DETAIL_BYTES)
})

// ─── Byte caps ───────────────────────────────────────────────────────────────

test('the streamed answer stops growing at the cap', () => {
  let snapshot = begin()
  for (let i = 0; i < 12; i++) {
    snapshot = reduceRuntime(snapshot, { type: 'text', text: 'x'.repeat(100_000) }, T1).snapshot
  }
  assert.equal(utf8Length(snapshot.assistantText), MAX_ASSISTANT_TEXT_BYTES)
})

test('the error message is byte-capped', () => {
  const step = reduceRuntime(begin(), { type: 'failed', message: 'e'.repeat(MAX_ERROR_BYTES + 999) }, T1)
  assert.equal(utf8Length(step.snapshot.error!), MAX_ERROR_BYTES)
})

test('truncateUtf8 never leaves half a multi-byte character behind', () => {
  // 'é' is 2 bytes — cutting at 3 must drop the second one entirely.
  assert.equal(truncateUtf8('éé', 3), 'é')
  assert.equal(truncateUtf8('abc', 10), 'abc')
})

// ─── Renderer folding + reattach ─────────────────────────────────────────────

function envelope(sequence: number, event: ChatRuntimeEnvelope['event']): ChatRuntimeEnvelope {
  return { generationId: 'g1', sessionId: 's1', sequence, event }
}

test('folding envelopes reproduces the snapshot the reducer produced', () => {
  // Main's side.
  let main = begin()
  const envelopes: ChatRuntimeEnvelope[] = []
  const push = (action: Parameters<typeof reduceRuntime>[1]) => {
    const step = reduceRuntime(main, action, T1)
    main = step.snapshot
    if (step.envelope) envelopes.push(step.envelope)
  }
  push({ type: 'running' })
  push({ type: 'work', kind: 'tool', label: 'Read data/pipeline.md', detail: '{}' })
  push({ type: 'text', text: 'Three ' })
  push({ type: 'text', text: 'are urgent.' })
  push({ type: 'completed' })

  // Renderer's side: reattach at the begin snapshot, fold the rest.
  let renderer: ChatRuntimeSnapshot | null = begin()
  for (const env of envelopes) renderer = applyEnvelope(renderer, env, T1)

  assert.equal(renderer!.phase, main.phase)
  assert.equal(renderer!.assistantText, main.assistantText)
  assert.equal(renderer!.lastSequence, main.lastSequence)
  assert.deepEqual(renderer!.workLog.map(e => e.label), main.workLog.map(e => e.label))
})

test('an envelope already contained in the snapshot is ignored', () => {
  const snapshot = reduceRuntime(begin(), { type: 'text', text: 'a' }, T1).snapshot
  // sequence 2 is already folded in — replaying it must not duplicate the text.
  const same = applyEnvelope(snapshot, envelope(2, { kind: 'text', text: 'a' }), T1)
  assert.equal(same!.assistantText, 'a')
  assert.equal(same, snapshot)
})

test('an envelope from another generation is ignored', () => {
  const snapshot = begin()
  const other = applyEnvelope(
    snapshot,
    { generationId: 'g-other', sessionId: 's1', sequence: 99, event: { kind: 'text', text: 'x' } },
    T1,
  )
  assert.equal(other, snapshot)
})

test('mergeRuntime keeps a local snapshot that is ahead of the fetched one', () => {
  const fetched = begin()
  const local = reduceRuntime(fetched, { type: 'text', text: 'ahead' }, T1).snapshot
  assert.equal(mergeRuntime(local, fetched), local)
  // A different generation always wins — it is newer by definition.
  const newer = { ...fetched, generationId: 'g2', lastSequence: 1 }
  assert.equal(mergeRuntime(local, newer), newer)
})

test('restore turns a snapshot still marked live into an interrupted one', () => {
  const live = reduceRuntime(begin(), { type: 'text', text: 'partial answer' }, T1).snapshot
  const step = restoreRuntime(JSON.parse(JSON.stringify(live)), T1)!
  assert.equal(step.snapshot.phase, 'interrupted')
  assert.equal(step.snapshot.assistantText, 'partial answer')
  assert.equal(step.snapshot.lastSequence, live.lastSequence + 1)
  assert.equal(step.envelope?.event.kind, 'status')
})

test('restore leaves an already-terminal snapshot alone', () => {
  const done = reduceRuntime(begin(), { type: 'completed' }, T1).snapshot
  const step = restoreRuntime(JSON.parse(JSON.stringify(done)), T1)!
  assert.equal(step.snapshot.phase, 'completed')
  assert.equal(step.envelope, null)
})

test('a corrupt or foreign snapshot restores as nothing rather than throwing', () => {
  assert.equal(restoreRuntime(null, T1), null)
  assert.equal(restoreRuntime({ version: 2 }, T1), null)
  assert.equal(restoreRuntime({ ...begin(), phase: 'wat' }, T1), null)
  assert.equal(parseRuntimeSnapshot({ ...begin(), lastSequence: -1 }), null)
  assert.equal(parseRuntimeSnapshot({ ...begin(), workLog: [{ nope: true }] }), null)
})

test('restore re-caps oversized fields read off disk', () => {
  const bloated = { ...begin(), assistantText: 'x'.repeat(MAX_ASSISTANT_TEXT_BYTES + 5_000) }
  const step = restoreRuntime(bloated, T1)!
  assert.equal(utf8Length(step.snapshot.assistantText), MAX_ASSISTANT_TEXT_BYTES)
})

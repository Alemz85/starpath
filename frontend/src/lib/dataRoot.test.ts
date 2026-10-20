import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canWrite, dataKindLabel, demoToggleState, describePrivateInitFailure,
  initialOnboardingPhase, isDemo, isDemoReadOnlyError, needsOnboarding,
  needsPrivateInit, needsTailoring, ownDataAction, phaseAfterChoosingOwn,
  writeGate, DEMO_READ_ONLY_TOOLTIP, type DataRootInfo,
} from './dataRoot'

const info = (over: Partial<DataRootInfo> = {}): DataRootInfo => ({
  root: '/tmp/fixture-repo/private',
  kind: 'private',
  source: 'default',
  repoPath: '/tmp/fixture-repo',
  demoAvailable: true,
  privateExists: true,
  ownDataAvailable: true,
  ...over,
})

// ─── Write gate ──────────────────────────────────────────────────────────────

test('only the demo is read-only; unknown state counts as writable', () => {
  assert.equal(canWrite(info()), true)
  assert.equal(canWrite(info({ kind: 'external' })), true)
  assert.equal(canWrite(info({ kind: 'none' })), true)
  assert.equal(canWrite(null), true)
  assert.equal(canWrite(info({ kind: 'demo' })), false)
  assert.equal(isDemo(info({ kind: 'demo' })), true)
})

test('writeGate carries the tooltip only when read-only', () => {
  assert.deepEqual(writeGate(info()), { canWrite: true, readOnlyTitle: undefined })
  assert.deepEqual(writeGate(info({ kind: 'demo' })), { canWrite: false, readOnlyTitle: DEMO_READ_ONLY_TOOLTIP })
  assert.equal(DEMO_READ_ONLY_TOOLTIP, 'Demo data is read-only')
})

test('isDemoReadOnlyError recognises main\'s refusal through the IPC wrapper', () => {
  assert.equal(isDemoReadOnlyError(new Error("Error invoking remote method 'fs:write': Error: demo-read-only: Demo data is read-only")), true)
  assert.equal(isDemoReadOnlyError('demo-read-only'), true)
  assert.equal(isDemoReadOnlyError(new Error('ENOENT')), false)
  assert.equal(isDemoReadOnlyError(undefined), false)
})

test('every kind has a label', () => {
  for (const kind of ['private', 'external', 'demo', 'none'] as const) assert.ok(dataKindLabel(kind).length > 0)
})

// ─── App gate ────────────────────────────────────────────────────────────────

test('demo never forces onboarding or tailoring', () => {
  const demo = info({ kind: 'demo' })
  assert.equal(needsOnboarding({ isOnboarded: false, repoPath: '/r', tailoringComplete: false, info: demo }), false)
  assert.equal(needsTailoring({ isOnboarded: true, repoPath: '/r', tailoringComplete: false, info: demo }), false)
  // …but a demo without a repo still needs one (nothing to show).
  assert.equal(needsOnboarding({ isOnboarded: false, repoPath: null, tailoringComplete: true, info: demo }), true)
})

test('own data keeps the existing gate', () => {
  const own = info()
  assert.equal(needsOnboarding({ isOnboarded: false, repoPath: '/r', tailoringComplete: true, info: own }), true)
  assert.equal(needsOnboarding({ isOnboarded: true, repoPath: null, tailoringComplete: true, info: own }), true)
  assert.equal(needsOnboarding({ isOnboarded: true, repoPath: '/r', tailoringComplete: true, info: own }), false)
  assert.equal(needsOnboarding({ isOnboarded: true, repoPath: '/r', tailoringComplete: true, forceOnboarding: true, info: own }), true)
  assert.equal(needsTailoring({ isOnboarded: true, repoPath: '/r', tailoringComplete: false, info: own }), true)
  assert.equal(needsTailoring({ isOnboarded: false, repoPath: '/r', tailoringComplete: false, info: own }), false)
})

// ─── Onboarding choice ───────────────────────────────────────────────────────

test('the choice screen shows only when a demo exists and nothing was chosen yet', () => {
  assert.equal(initialOnboardingPhase({ demoAvailable: true, intent: 'choose', kind: 'none', repoPath: '/r' }), 'choose')
  assert.equal(initialOnboardingPhase({ demoAvailable: false, intent: 'choose', kind: 'none', repoPath: '/r' }), 'init-private')
  assert.equal(initialOnboardingPhase({ demoAvailable: false, intent: 'choose', kind: 'private', repoPath: '/r' }), 'wizard')
  assert.equal(initialOnboardingPhase({ demoAvailable: true, intent: 'own', kind: 'private', repoPath: '/r' }), 'wizard')
  // No repo yet (packaged first launch): straight to the wizard's folder step.
  assert.equal(initialOnboardingPhase({ demoAvailable: false, intent: 'choose', kind: 'none', repoPath: null }), 'wizard')
})

test('choosing your own search runs private init first on a fresh checkout', () => {
  assert.equal(needsPrivateInit({ kind: 'none', repoPath: '/r' }), true)
  assert.equal(needsPrivateInit({ kind: 'none', repoPath: null }), false)
  assert.equal(needsPrivateInit({ kind: 'private', repoPath: '/r' }), false)
  assert.equal(needsPrivateInit({ kind: 'external', repoPath: '/r' }), false)
  assert.equal(phaseAfterChoosingOwn({ kind: 'none', repoPath: '/r' }), 'init-private')
  assert.equal(phaseAfterChoosingOwn({ kind: 'private', repoPath: '/r' }), 'wizard')
})

test('"Use my own data" leaves the demo when there is own data, else sets it up', () => {
  assert.equal(ownDataAction(info({ kind: 'demo', ownDataAvailable: true })), 'leave-demo')
  assert.equal(ownDataAction(info({ kind: 'demo', ownDataAvailable: false, privateExists: false })), 'setup')
  assert.equal(ownDataAction(null), 'setup')
})

test('Show demo data switch: on/off rules', () => {
  assert.deepEqual(demoToggleState(info()), { checked: false, disabled: false, hint: undefined })
  assert.equal(demoToggleState(info({ demoAvailable: false })).disabled, true)
  assert.deepEqual(demoToggleState(info({ kind: 'demo' })), { checked: true, disabled: false, hint: undefined })
  const stuck = demoToggleState(info({ kind: 'demo', ownDataAvailable: false, privateExists: false }))
  assert.equal(stuck.checked, true)
  assert.equal(stuck.disabled, true)
  assert.ok(stuck.hint)
  assert.equal(demoToggleState(info({ repoPath: null })).disabled, true)
  assert.equal(demoToggleState(null).disabled, true)
})

test('describePrivateInitFailure lists the message, conflicts and warnings', () => {
  assert.deepEqual(describePrivateInitFailure(null), ['No response from the app. Try again.'])
  assert.deepEqual(
    describePrivateInitFailure({ ok: false, message: 'refusing', conflicts: ['data/ is a real folder and private/data exists'], warnings: [{ message: 'no git' }] }),
    ['refusing', 'Conflict: data/ is a real folder and private/data exists', 'no git'],
  )
  assert.deepEqual(describePrivateInitFailure({ ok: false, error: 'cli' }), ['private init failed (cli)'])
})

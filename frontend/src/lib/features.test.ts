import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VIEW_FEATURE, FALLBACK_VIEW, isViewEnabled, resolveView } from '@/lib/features'
import { DEFAULT_FEATURE_PREFS, FEATURE_IDS, type FeaturePrefs } from '@/types'
import { VIEW_LABELS, type ViewId } from '@/store/nav'

const allOff: FeaturePrefs = Object.fromEntries(
  FEATURE_IDS.map(id => [id, false]),
) as FeaturePrefs

// ─── Defaults ────────────────────────────────────────────────────────────────

test('DEFAULT_FEATURE_PREFS covers every FeatureId and defaults to active', () => {
  for (const id of FEATURE_IDS) {
    assert.equal(DEFAULT_FEATURE_PREFS[id], true, `${id} must default to active`)
  }
  assert.equal(Object.keys(DEFAULT_FEATURE_PREFS).length, FEATURE_IDS.length)
})

test('VIEW_FEATURE only maps real ViewIds to real FeatureIds', () => {
  for (const [view, flag] of Object.entries(VIEW_FEATURE)) {
    assert.ok(view in VIEW_LABELS, `${view} is not a ViewId`)
    assert.ok((FEATURE_IDS as readonly string[]).includes(flag), `${flag} is not a FeatureId`)
  }
})

// ─── isViewEnabled / resolveView ─────────────────────────────────────────────

test('unmapped views are always enabled, whatever the flags say', () => {
  const permanent: ViewId[] = ['scouting', 'applying', 'database', 'reports', 'trends', 'pipeline', 'scan', 'settings', 'profile', 'company']
  for (const view of permanent) {
    assert.equal(isViewEnabled(view, allOff), true, `${view} must survive all-off`)
    assert.equal(resolveView(view, allOff), view)
  }
})

test('gated views follow their flag and fall back to the cockpit when off', () => {
  const gated: ViewId[] = ['today', 'outreach', 'offers']
  for (const view of gated) {
    assert.equal(isViewEnabled(view, DEFAULT_FEATURE_PREFS), true)
    assert.equal(resolveView(view, DEFAULT_FEATURE_PREFS), view)
    assert.equal(isViewEnabled(view, allOff), false)
    assert.equal(resolveView(view, allOff), FALLBACK_VIEW)
  }
})

test('the fallback view itself can never be feature-gated', () => {
  // resolveView must terminate at a view that is always visible — if someone
  // maps FALLBACK_VIEW in VIEW_FEATURE, an all-off config would strand the
  // app on a hidden view.
  assert.equal(VIEW_FEATURE[FALLBACK_VIEW], undefined)
})

test('deactivating one feature leaves the other gated views alone', () => {
  const offersOff: FeaturePrefs = { ...DEFAULT_FEATURE_PREFS, offersView: false }
  assert.equal(resolveView('offers', offersOff), FALLBACK_VIEW)
  assert.equal(resolveView('today', offersOff), 'today')
  assert.equal(resolveView('outreach', offersOff), 'outreach')
})

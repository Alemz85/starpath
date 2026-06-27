import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useNavStore, VIEW_LABELS, type ViewId } from '@/store/nav'
import { useConfigDirty } from '@/store/configDirty'

// The store is a singleton, so each test resets the data fields (the action
// closures stay intact) and clears any dirty config sections.
function reset() {
  useConfigDirty.getState().resetAll()
  useNavStore.setState({
    view: 'scouting',
    databaseFilter: '',
    companySlug: '',
    companyReturnView: 'database',
    pendingView: null,
    pendingDatabaseFilter: '',
    pendingCompanySlug: '',
  })
}

const nav = () => useNavStore.getState()

beforeEach(reset)

test('navigate to a normal view sets view + filter and clears company slug', () => {
  nav().navigate('database', 'archetype:Strategy')
  assert.equal(nav().view, 'database')
  assert.equal(nav().databaseFilter, 'archetype:Strategy')
  assert.equal(nav().companySlug, '')
})

test('navigating away from a company resets the slug', () => {
  nav().navigate('company', '', 'acme')
  assert.equal(nav().companySlug, 'acme')
  nav().navigate('reports')
  assert.equal(nav().view, 'reports')
  assert.equal(nav().companySlug, '')
})

test('opening a company records the origin as the return view', () => {
  nav().navigate('trends')
  nav().navigate('company', '', 'acme')
  assert.equal(nav().view, 'company')
  assert.equal(nav().companySlug, 'acme')
  assert.equal(nav().companyReturnView, 'trends')
})

test('company→company hop updates the slug but keeps the original return view', () => {
  nav().navigate('database')
  nav().navigate('company', '', 'acme')
  nav().navigate('company', '', 'globex')
  assert.equal(nav().view, 'company')
  assert.equal(nav().companySlug, 'globex')
  // back should still land on the view the user entered from
  assert.equal(nav().companyReturnView, 'database')
})

test('navigating to the same view + slug is a no-op (preserves filter)', () => {
  nav().navigate('database', 'tier:T1')
  // a redundant nav to the same view must not wipe the active filter
  nav().navigate('database')
  assert.equal(nav().databaseFilter, 'tier:T1')
})

test('navigating to the same company slug is a no-op', () => {
  nav().navigate('company', '', 'acme')
  const before = nav().companyReturnView
  nav().navigate('company', '', 'acme')
  assert.equal(nav().companyReturnView, before)
})

test('leaving a dirty gated origin captures the company slug as a pending nav', () => {
  useConfigDirty.getState().setDirty('identity', 'test-section', true)
  useNavStore.setState({ view: 'config' })

  nav().navigate('company', '', 'acme')
  // view does not change until the modal resolves
  assert.equal(nav().view, 'config')
  assert.equal(nav().pendingView, 'company')
  assert.equal(nav().pendingCompanySlug, 'acme')

  nav().confirmPendingNavigate()
  assert.equal(nav().view, 'company')
  assert.equal(nav().companySlug, 'acme')
  assert.equal(nav().companyReturnView, 'config')
  assert.equal(nav().pendingView, null)
  assert.equal(nav().pendingCompanySlug, '')
})

test('cancelling a pending nav drops the captured slug', () => {
  useConfigDirty.getState().setDirty('identity', 'test-section', true)
  useNavStore.setState({ view: 'profile' })

  nav().navigate('company', '', 'acme')
  assert.equal(nav().pendingCompanySlug, 'acme')

  nav().cancelPendingNavigate()
  assert.equal(nav().pendingView, null)
  assert.equal(nav().pendingCompanySlug, '')
  assert.equal(nav().view, 'profile')
})

test('navigate to pipeline sets the view and clears the company slug', () => {
  nav().navigate('company', '', 'acme')
  nav().navigate('pipeline')
  assert.equal(nav().view, 'pipeline')
  assert.equal(nav().companySlug, '')
  assert.equal(VIEW_LABELS.pipeline, 'Pipeline')
})

test('VIEW_LABELS covers every ViewId including company', () => {
  const ids: ViewId[] = [
    'today', 'scouting', 'applying', 'outreach', 'offers', 'database', 'reports', 'trends',
    'scoretrend', 'pipeline', 'scan', 'config', 'settings', 'profile', 'company',
  ]
  for (const id of ids) {
    assert.equal(typeof VIEW_LABELS[id], 'string')
    assert.ok(VIEW_LABELS[id].length > 0)
  }
  assert.equal(VIEW_LABELS.company, 'Company')
})

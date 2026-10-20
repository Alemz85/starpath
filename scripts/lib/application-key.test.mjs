import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applicationKey, applicationKeyAliases, indexByApplication, lookupApplication, groupByApplication,
} from './application-key.mjs'
import { companyRoleKey } from './merge-staging-core.mjs'

test('applicationKey is the scanner/score-history companyRoleKey', () => {
  assert.equal(applicationKey('Nimbus Robotics', 'Data Analyst'), companyRoleKey('Nimbus Robotics', 'Data Analyst'))
  assert.equal(applicationKey('Nimbus Robotics', 'Data Analyst'), 'nimbusrobotics\tdata analyst')
})

test('the same application written differently in two stores gets one key', () => {
  const a = applicationKey('Nimbus Robotics', 'Data Analyst')
  assert.equal(applicationKey('NIMBUS ROBOTICS.', '  data   analyst '), a)
  assert.equal(applicationKey('Nimbus Robotics', 'Data Analyst (m/f/d)'), a)
  assert.equal(applicationKey('Nimbus Robotics', 'Data Analyst - REQ-12345'), applicationKey('Nimbus Robotics', 'Data Analyst - REQ-12345'))
})

test('different roles at one company stay apart; blank sides give no key', () => {
  assert.notEqual(applicationKey('Fabrikam', 'Analyst'), applicationKey('Fabrikam', 'Senior Analyst'))
  assert.equal(applicationKey('', 'Analyst'), '')
  assert.equal(applicationKey('Fabrikam', ''), '')
  assert.equal(applicationKey('—', 'Analyst'), '')
})

test('aliases include the legacy company key for Latin names with diacritics', () => {
  const keys = applicationKeyAliases('Café Lumière', 'Barista Lead')
  assert.equal(keys[0], applicationKey('Café Lumière', 'Barista Lead'))
  assert.ok(keys.includes('caflumire\tbarista lead'))
  assert.deepEqual(applicationKeyAliases('', 'x'), [])
})

test('indexByApplication keeps the picked row per key and reports unkeyed rows', () => {
  const rows = [
    { company: 'Contoso', role: 'Ops Analyst', date: '2026-09-01', v: 1 },
    { company: 'contoso', role: 'Ops Analyst ', date: '2026-09-20', v: 2 },
    { company: 'Contoso', role: 'Ops Analyst', date: '2026-09-05', v: 3 },
    { company: '', role: 'Nobody', v: 4 },
  ]
  const latest = (a, b) => (b.date >= a.date ? b : a)
  const idx = indexByApplication(rows, { pick: latest })
  assert.equal(idx.byKey.size, 1)
  assert.equal(lookupApplication(idx, 'CONTOSO', 'ops analyst').v, 2)
  assert.equal(idx.unkeyed.length, 1)
  assert.equal(lookupApplication(idx, 'Contoso', 'Other'), undefined)
})

test('groupByApplication keeps every row', () => {
  const g = groupByApplication([
    { company: 'Woodgrove', role: 'Analyst', to: 'Applied' },
    { company: 'Woodgrove', role: 'analyst', to: 'Rejected' },
    { company: 'Fabrikam', role: 'Analyst', to: 'Applied' },
  ])
  assert.equal(g.get(applicationKey('Woodgrove', 'Analyst')).length, 2)
  assert.equal(g.size, 2)
})

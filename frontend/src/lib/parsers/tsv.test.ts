import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from '@/lib/parsers/tsv'

test('parseScoreHistory parses rows, normalizes tier and mode', () => {
  const tsv = [
    'date\tcompany\trole\toverall\ttier\tlocation\tmode',
    '2026-04-27\tAcme\tAnalyst\t8.4\tt1\tBerlin\tscouting',
    '2026-04-28\tGlobex\tPM\t6.0\tt2-high\tParis\toferta',
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].company, 'Acme')
  assert.equal(rows[0].overall, 8.4)
  assert.equal(rows[0].tier, 'T1')
  assert.equal(rows[0].mode, 'scouting')
  assert.equal(rows[1].tier, 'T2-high')
  assert.equal(rows[1].mode, 'oferta')
})

test('parseScoreHistory skips rows missing company or role', () => {
  const tsv = [
    'date\tcompany\trole\toverall',
    '2026-04-27\t\tAnalyst\t8.4',   // no company
    '2026-04-27\tAcme\t\t8.4',       // no role
    '2026-04-27\tAcme\tAnalyst\t8.4',
  ].join('\n')
  assert.equal(parseScoreHistory(tsv).length, 1)
})

test('parseScoreHistory pads short rows instead of dropping them', () => {
  // A row shorter than the header (e.g. before a later `url` column existed)
  // must still parse — the missing trailing fields default to empty.
  const tsv = [
    'date\tcompany\trole\toverall\turl',
    '2026-04-27\tAcme\tAnalyst',
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].overall, 0)   // num('') → 0
  assert.equal(rows[0].url, '')
})

test('parseScoreHistory returns [] for an empty/headerless input', () => {
  assert.deepEqual(parseScoreHistory(''), [])
  assert.deepEqual(parseScoreHistory('date\tcompany\trole'), [])  // header only
})

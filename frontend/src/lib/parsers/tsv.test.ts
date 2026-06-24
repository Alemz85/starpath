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

test('parseScoreHistory maps the legacy band names — growth is T3, not T4', () => {
  const tsv = [
    'date\tcompany\trole\toverall\ttier',
    '2026-06-24\tA\tAnalyst\t6.2\tgrowth',    // Pass/Growth Target band → T3
    '2026-06-24\tB\tAnalyst\t4.1\tskip',      // Skip band → T4
    '2026-06-24\tC\tAnalyst\t7.5\tshort',     // Strong/Decent → T2
    '2026-06-24\tD\tAnalyst\t6.0\tgap',       // alternate T3 name
    '2026-06-24\tE\tAnalyst\t3.0\tpipeline',  // → T4
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.equal(rows[0].tier, 'T3')   // growth — the fix (previously fell through to T4)
  assert.equal(rows[1].tier, 'T4')   // skip
  assert.equal(rows[2].tier, 'T2')   // short
  assert.equal(rows[3].tier, 'T3')   // gap
  assert.equal(rows[4].tier, 'T4')   // pipeline
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

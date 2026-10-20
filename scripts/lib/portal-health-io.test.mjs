import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHealthRows, readHealthRows, reviewFromFiles } from './portal-health-io.mjs'
import { HEALTH_HEADER } from './portal-health-core.mjs'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'portal-health-'))
  mkdirSync(join(root, 'user'))
  mkdirSync(join(root, 'data'))
  writeFileSync(join(root, 'user/portals.yml'), [
    'tracked_companies:',
    '  - name: Nimbus Robotics',
    '    enabled: true',
    '  - name: Old Mill Co',
    '    enabled: false',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'data/scan-history.tsv'), [
    'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates',
    'https://x/1\t2026-09-01\twebsearch\tAnalyst\tBright Harbor\tLyon\tadded\t2026-09-01',
    'https://x/2\t2026-10-01\twebsearch\tAnalyst II\tBright Harbor\tLyon\tadded\t2026-10-01',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'data/score-history.tsv'), [
    'date\tcompany\trole\tverdict',
    '2026-10-02\tOld Mill Co\tAnalyst\tgo',
    '',
  ].join('\n'))
  return root
}

test('append creates the file with its header once and validates records', () => {
  const root = sandbox()
  const path = join(root, 'data/portal-health.tsv')
  assert.equal(appendHealthRows([{ date: '2026-10-01', company: 'Nimbus Robotics', source: 'greenhouse-api', outcome: 'ok', jobs: 12, kept: 0 }], path), 1)
  assert.equal(appendHealthRows([{ date: '2026-10-08', company: 'Nimbus Robotics', source: 'greenhouse-api', outcome: 'error', note: 'HTTP 429' }], path), 1)
  const text = readFileSync(path, 'utf-8')
  assert.equal(text.split('\n')[0], HEALTH_HEADER)
  assert.equal(text.match(/^date\t/gm).length, 1, 'header written once')
  assert.equal(readHealthRows(path).length, 2)
  assert.throws(() => appendHealthRows([{ date: '2026-10-08', company: '', source: 's', outcome: 'ok' }], path), /company/)
  assert.equal(appendHealthRows([], path), 0)
})

test('reviewFromFiles reads the canonical files under root and tolerates missing ones', () => {
  const root = sandbox()
  const path = join(root, 'data/portal-health.tsv')
  for (const d of ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-20']) {
    appendHealthRows([{ date: d, company: 'Nimbus Robotics', source: 'greenhouse-api', outcome: 'ok', jobs: 30, kept: 0 }], path)
  }
  const review = reviewFromFiles({ root })
  assert.equal(review.pause.length, 1)
  assert.equal(review.pause[0].company, 'Nimbus Robotics')
  assert.deepEqual(review.promote.map((p) => p.company).sort(), ['Bright Harbor', 'Old Mill Co'])

  const empty = mkdtempSync(join(tmpdir(), 'portal-health-empty-'))
  assert.deepEqual(reviewFromFiles({ root: empty }), { fix: [], pause: [], promote: [] })
})

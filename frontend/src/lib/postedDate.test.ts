import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isoDayOf, parseReportPosted, pickPostedDate } from '@/lib/postedDate'

test('isoDayOf takes the leading ISO day and rejects everything else', () => {
  assert.equal(isoDayOf('2026-10-02'), '2026-10-02')
  assert.equal(isoDayOf('  2026-10-02 (from the ATS)'), '2026-10-02')
  assert.equal(isoDayOf('2026-10-02T09:30:00Z'), '2026-10-02')
  for (const bad of ['', '   ', 'n/d', 'N/D', '—', '-', 'Oct 2, 2026', '2026-10', '2026-13-01', '2026-02-30', '20261002', '2026-10-021', null, undefined]) {
    assert.equal(isoDayOf(bad as string | null | undefined), null, String(bad))
  }
})

test('parseReportPosted reads the header line and tolerates every odd shape', () => {
  const head = (posted: string) => `# Nimbus Robotics - Data Analyst\n\n**Date:** 2026-10-20\n${posted}\n**URL:** https://example.com/j/1\n\n## Summary\n`
  assert.equal(parseReportPosted(head('**Posted:** 2026-10-02')), '2026-10-02')
  assert.equal(parseReportPosted(head('**Posted:** 2026-10-02 (from the ATS)')), '2026-10-02')
  assert.equal(parseReportPosted(head('**posted:**   2026-10-02  ')), '2026-10-02')
  assert.equal(parseReportPosted(head('**Posted:** n/d')), null)
  assert.equal(parseReportPosted(head('**Posted:** —')), null)
  assert.equal(parseReportPosted(head('**Posted:**')), null)
  assert.equal(parseReportPosted(head('**Posted:** last Tuesday')), null)
  assert.equal(parseReportPosted(head('')), null)       // old report, no line
  assert.equal(parseReportPosted(null), null)
  assert.equal(parseReportPosted(''), null)
})

test('parseReportPosted ignores a Posted line below the first heading', () => {
  assert.equal(parseReportPosted('# T\n**Date:** 2026-10-20\n\n## Role\n**Posted:** 2026-09-01\n'), null)
})

test('pickPostedDate prefers scan, then report, then evaluation', () => {
  assert.deepEqual(pickPostedDate({ scanPosted: '2026-09-01', reportPosted: '2026-09-05', evaluated: '2026-10-20' }), { date: '2026-09-01', source: 'scan' })
  assert.deepEqual(pickPostedDate({ scanPosted: null, reportPosted: '2026-09-05', evaluated: '2026-10-20' }), { date: '2026-09-05', source: 'report' })
  assert.deepEqual(pickPostedDate({ scanPosted: '', reportPosted: 'n/d', evaluated: '2026-10-20' }), { date: '2026-10-20', source: 'evaluated' })
})

test('pickPostedDate skips a malformed higher source rather than inventing a date', () => {
  assert.deepEqual(pickPostedDate({ scanPosted: 'garbage', reportPosted: '2026-09-05 (ATS)' }), { date: '2026-09-05', source: 'report' })
  assert.equal(pickPostedDate({}), null)
  assert.equal(pickPostedDate({ scanPosted: 'n/d', reportPosted: '—', evaluated: 'soon' }), null)
})

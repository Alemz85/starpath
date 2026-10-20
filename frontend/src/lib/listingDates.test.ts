import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildListingDateQueries, compactSpan, dateCue, listingDateKey, postedDateOf,
} from './listingDates'

const NOW = new Date(2026, 9, 20, 15, 0, 0) // 20 Oct 2026, local

test('dateCue prefers the deadline, then the posting date, then the first scan', () => {
  const dates = { deadline: '2026-11-01', postedDate: '2026-10-08', firstSeen: '2026-10-09' }
  assert.equal(dateCue({ deadline: 'n/d' }, dates, NOW)?.kind, 'deadline')
  assert.equal(dateCue({ deadline: 'n/d' }, { ...dates, deadline: null }, NOW)?.kind, 'posted')
  assert.equal(dateCue({ deadline: 'Rolling' }, { deadline: null, postedDate: null, firstSeen: '2026-10-09' }, NOW)?.kind, 'scanned')
  assert.equal(dateCue({ deadline: 'n/d' }, undefined, NOW), null)
})

test("the application row's own deadline wins over the scan's", () => {
  const cue = dateCue({ deadline: '2026-10-25' }, { deadline: '2026-11-30', postedDate: null, firstSeen: null }, NOW)
  assert.equal(cue?.date, '2026-10-25')
  assert.equal(cue?.days, 5)
  assert.equal(cue?.label, '5d')
  assert.equal(cue?.soon, true)
  assert.match(cue!.title, /^Application deadline 25 Oct 2026 · in 5 days$/)
})

test('labels: ages for posted / scanned, "ago" only for a passed deadline', () => {
  const posted = dateCue({ deadline: '' }, { deadline: null, postedDate: '2026-10-08', firstSeen: null }, NOW)!
  assert.equal(posted.label, '12d')
  assert.equal(posted.days, -12)
  assert.equal(posted.soon, false)
  assert.match(posted.title, /^Posted 8 Oct 2026 · 12 days ago$/)

  const passed = dateCue({ deadline: '2026-10-15' }, null, NOW)!
  assert.equal(passed.label, '5d ago')
  assert.equal(passed.soon, false)

  const scanned = dateCue({ deadline: '' }, { deadline: null, postedDate: null, firstSeen: '2026-10-20' }, NOW)!
  assert.equal(scanned.label, 'today')
  assert.match(scanned.title, /no posting date on file/)
})

test('compactSpan', () => {
  assert.equal(compactSpan(0), 'today')
  assert.equal(compactSpan(-12), '12d')
  assert.equal(compactSpan(59), '59d')
  assert.equal(compactSpan(95), '3mo')
  assert.equal(compactSpan(800), '2y')
})

test('buildListingDateQueries: one query per listing, newest URL from score history', () => {
  const qs = buildListingDateQueries(
    [{ company: 'Nimbus Robotics', role: 'Strategy Analyst' }, { company: 'Contoso Labs', role: 'Ops Analyst' }],
    [
      { company: 'Nimbus Robotics', role: 'Strategy Analyst', url: 'https://x.example/old', date: '2026-09-01' },
      { company: 'nimbus robotics', role: 'strategy analyst', url: 'https://x.example/new', date: '2026-10-01' },
      { company: 'Nimbus Robotics', role: 'Strategy Analyst', url: 'n/d', date: '2026-10-05' },
    ],
  )
  assert.equal(qs.length, 2)
  const nimbus = qs.find(q => q.key === listingDateKey('Nimbus Robotics', 'Strategy Analyst'))!
  assert.equal(nimbus.url, 'https://x.example/new')
  const contoso = qs.find(q => q.company === 'Contoso Labs')!
  assert.equal(contoso.url, undefined)
})

test('postedDateOf reads the map by the company|role key', () => {
  const map = { [listingDateKey('Nimbus Robotics', 'Strategy Analyst')]: { deadline: null, postedDate: '2026-10-01', firstSeen: null } }
  assert.equal(postedDateOf(map, 'NIMBUS ROBOTICS', 'strategy analyst'), '2026-10-01')
  assert.equal(postedDateOf(map, 'Contoso Labs', 'Ops Analyst'), null)
})

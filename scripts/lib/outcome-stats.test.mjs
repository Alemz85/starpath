// outcome-stats.test.mjs — fictional fixtures only (docs § 3.7).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  easeBand, daysBetween, ledgerDateExact, rejectionTiming, buildRecord, agreementOf,
  sliceStats, compareBands, highNeverProgresses, easeCheck, gapSuggestion,
  analyzeApplicationOutcomes, formatOutcomesBlock, formatWhyTable, formatRate, rejectionPatterns,
} from './outcome-stats.mjs'
import { OUTCOME_GATES, OUTCOME_RULES } from './scoring-stats.mjs'

const TODAY = '2026-10-20'
const app = (over = {}) => ({ num: 1, date: '2026-09-01', company: 'Nimbus Robotics', role: 'Data Analyst', status: 'Applied', notes: '', ...over })
const move = (to, from, date, over = {}) => ({ num: 1, company: 'Nimbus Robotics', role: 'Data Analyst', to, from, date, stage: '', source: 'app', note: '', ...over })

/* ───── Small rules ──────────────────────────────────────────────── */

test('Ease bands are the verdict grid columns', () => {
  assert.equal(easeBand(4.99), 'low')
  assert.equal(easeBand(5.0), 'mid')
  assert.equal(easeBand(6.99), 'mid')
  assert.equal(easeBand(7.0), 'high')
  assert.equal(easeBand(null), 'unscored')
  assert.equal(easeBand(''), 'unscored')
})

test('dates: backfill is approximate unless the user corrected it', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-03'), 2)
  assert.equal(daysBetween('n/d', '2026-10-03'), null)
  assert.equal(ledgerDateExact({ date: '2026-10-01', source: 'app' }), true)
  assert.equal(ledgerDateExact({ date: '2026-10-01', source: 'backfill', note: 'seeded from applications.md' }), false)
  assert.equal(ledgerDateExact({ date: '2026-10-01', source: 'backfill', note: 'seeded; corrected 2026-10-19' }), true)
})

test('rejection timing classes', () => {
  assert.equal(rejectionTiming(0), 'fast')
  assert.equal(rejectionTiming(OUTCOME_RULES.fastRejectionDays), 'fast')
  assert.equal(rejectionTiming(3), 'normal')
  assert.equal(rejectionTiming(30), 'normal')
  assert.equal(rejectionTiming(31), 'late')
  assert.equal(rejectionTiming(null), null)
})

/* ───── One application ──────────────────────────────────────────── */

test('never reached the market → no record', () => {
  assert.equal(buildRecord(app({ status: 'Evaluated' }), { today: TODAY }), null)
  assert.equal(buildRecord(app({ status: 'SKIP' }), { today: TODAY }), null)
  assert.equal(buildRecord(app({ status: 'Discarded' }), { history: [move('Discarded', 'Evaluated', '2026-09-03')], today: TODAY }), null)
  assert.equal(buildRecord(app({ status: 'Rejected' }), { history: [move('Rejected', 'Evaluated', '2026-09-03')], today: TODAY }), null)
})

test('a rejection a day after sending is fast and exact', () => {
  const r = buildRecord(app({ status: 'Rejected' }), {
    history: [move('Applied', 'Evaluated', '2026-09-10'), move('Rejected', 'Applied', '2026-09-11')],
    today: TODAY,
  })
  assert.equal(r.outcome, 'rejected')
  assert.equal(r.reach, 'Applied')
  assert.deepEqual([r.rejected.days, r.rejected.exact, r.rejected.timing, r.rejected.stage], [1, true, 'fast', 'Applied'])
  assert.equal(r.firstReply.days, 1)
})

test('backfilled dates are kept but never timed', () => {
  const r = buildRecord(app({ status: 'Rejected' }), {
    history: [move('Rejected', '', '2026-09-01', { source: 'backfill', note: 'seeded from applications.md' })],
    today: TODAY,
  })
  assert.equal(r.outcome, 'rejected')
  assert.equal(r.sentExact, false)
  assert.equal(r.rejected.exact, false)
  assert.equal(r.rejected.timing, null)
  assert.equal(r.rejected.stage, 'unknown')
})

test('an interview followed by a rejection counts as progressed, stage from the status rejected from', () => {
  const r = buildRecord(app({ status: 'Rejected' }), {
    history: [
      move('Applied', 'Evaluated', '2026-09-01'),
      move('Interview', 'Applied', '2026-09-08'),
      move('Rejected', 'Interview', '2026-09-20', { stage: 'after the case study' }),
    ],
    today: TODAY,
  })
  assert.equal(r.outcome, 'progressed')
  assert.equal(r.reach, 'Interview')
  assert.equal(r.rejected.stage, 'after the case study')
  assert.equal(r.rejected.explicitStage, true)
  assert.equal(r.firstReply.to, 'Interview')
})

test('silence: pending, then no response after the configured days; a late rejection reclassifies it', () => {
  const sent = [move('Applied', 'Evaluated', '2026-09-01')]
  assert.equal(buildRecord(app(), { history: sent, today: '2026-09-20' }).outcome, 'pending')
  assert.equal(buildRecord(app(), { history: sent, today: '2026-10-01' }).outcome, 'no-response')
  assert.equal(buildRecord(app(), { history: sent, today: '2026-10-01', rules: { ...OUTCOME_RULES, noResponseDays: 45 } }).outcome, 'pending')
  const late = buildRecord(app({ status: 'Rejected' }), { history: [...sent, move('Rejected', 'Applied', '2026-12-04')], today: '2026-12-05' })
  assert.equal(late.outcome, 'rejected')
  assert.equal(late.rejected.timing, 'late')
  assert.equal(late.rejected.days, 94)
})

test('rejected in the tracker with no log row still counts as a rejection, untimed', () => {
  const r = buildRecord(app({ status: 'Rejected' }), { today: TODAY })
  assert.equal(r.outcome, 'rejected')
  assert.equal(r.rejected.timing, null)
  assert.equal(r.rejected.stage, 'unknown')
})

test('withdrawn after applying is its own outcome', () => {
  const r = buildRecord(app({ status: 'Discarded' }), {
    history: [move('Applied', 'Evaluated', '2026-09-01'), move('Discarded', 'Applied', '2026-09-05')],
    today: TODAY,
  })
  assert.equal(r.outcome, 'withdrawn')
})

test('the materials index sent date wins and is exact for a logged application', () => {
  const r = buildRecord(app({ status: 'Rejected' }), {
    history: [move('Applied', 'Evaluated', '2026-09-12'), move('Rejected', 'Applied', '2026-09-12')],
    material: { sent: '2026-09-11', materials: 'cv+cover', notes: 'tailored summary' },
    today: TODAY,
  })
  assert.equal(r.sentSource, 'materials')
  assert.equal(r.sentExact, true)
  assert.equal(r.rejected.days, 1)
  assert.equal(r.rejected.timing, 'fast')
  assert.equal(r.materials, 'cv+cover')
  assert.ok(r.notes.includes('tailored summary'))
})

test('an application that predates the log gets approximate dates, materials included', () => {
  const backfilled = [move('Applied', '', '2026-09-01', { source: 'backfill' }), move('Rejected', 'Applied', '2026-09-12')]
  const r = buildRecord(app({ status: 'Rejected' }), { history: backfilled, material: { sent: '2026-09-11' }, today: TODAY })
  assert.equal(r.sentSource, 'materials')
  assert.equal(r.sentExact, false)
  assert.equal(r.rejected.timing, null)
  const none = buildRecord(app({ status: 'Applied' }), { material: { sent: '2026-09-11' }, today: TODAY })
  assert.equal(none.sentExact, false)
  // A corrected Applied date is exact again, and wins over a reconstructed materials date.
  const corrected = buildRecord(app({ status: 'Rejected' }), {
    history: [move('Applied', '', '2026-09-10', { source: 'backfill', note: 'seeded; corrected 2026-10-19' }), move('Rejected', 'Applied', '2026-09-11')],
    material: { sent: '2026-09-01' },
    today: TODAY,
  })
  assert.deepEqual([corrected.sentSource, corrected.sentExact, corrected.rejected.timing], ['ledger', true, 'fast'])
})

test('agreement labels: outcomes that match the score agree; surprises are labels, not conclusions', () => {
  assert.equal(agreementOf('low', 'rejected', null), 'agrees')
  assert.equal(agreementOf('high', 'progressed', null), 'agrees')
  assert.equal(agreementOf('high', 'rejected', { timing: 'fast' }), 'surprise: high Ease, fast rejection')
  assert.equal(agreementOf('low', 'progressed', null), 'surprise: low Ease, progressed')
  assert.equal(agreementOf('mid', 'rejected', null), '')
  assert.equal(agreementOf('high', 'pending', null), '')
})

/* ───── Slices and gates ─────────────────────────────────────────── */

let seq = 0
const rec = (easeBandV, outcome, sentDate, over = {}) => ({
  num: ++seq, key: `k${seq}`, easeBand: easeBandV, outcome, sentDate, reach: outcome === 'progressed' ? 'Responded' : 'Applied',
  rejected: null, archetype: 'ops', city: 'Lyon', companySize: 'unknown', ...over,
})
const day = (i) => `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`

test('below the gate: counts stay, rates and timing are withheld', () => {
  const recs = [
    rec('mid', 'progressed', day(0)),
    rec('mid', 'rejected', day(1), { rejected: { exact: true, days: 1, timing: 'fast' } }),
    rec('mid', 'no-response', day(2)),
    rec('mid', 'pending', day(3)),
  ]
  const s = sliceStats(recs)
  assert.equal(s.counts.resolved, 3)
  assert.equal(s.counts.pending, 1)
  assert.equal(s.sample.sufficient, false)
  assert.equal(s.rates.progress.k, 1)
  assert.equal(s.rates.progress.value, null)
  assert.equal(s.timing.fast, 1)
  assert.equal(s.timing.fastShare, null)
  assert.equal(s.timing.medianDays, null)
  assert.equal(formatRate(s.rates.progress, s.sample), '1 of 3')
})

test('at the gate: rates appear, as counts at low confidence and with a percentage from moderate', () => {
  const eight = Array.from({ length: 8 }, (_, i) => rec('mid', i < 2 ? 'progressed' : 'rejected', day(i)))
  const s = sliceStats(eight)
  assert.equal(s.sample.confidence, 'low')
  assert.equal(s.rates.progress.value, 0.25)
  assert.equal(formatRate(s.rates.progress, s.sample), '2 of 8 (low)')
  const sixteen = Array.from({ length: 16 }, (_, i) => rec('mid', i < 4 ? 'progressed' : 'rejected', day(i)))
  const t = sliceStats(sixteen)
  assert.equal(formatRate(t.rates.progress, t.sample), '4 of 16 (25%, moderate)')
})

test('timing clears its own gate on exactly dated rejections only', () => {
  const timed = Array.from({ length: 8 }, (_, i) => rec('mid', 'rejected', day(i), { rejected: { exact: true, days: i < 6 ? 1 : 10, timing: i < 6 ? 'fast' : 'normal' } }))
  const approx = rec('mid', 'rejected', day(9), { rejected: { exact: false, days: 3, timing: null } })
  const s = sliceStats([...timed, approx])
  assert.equal(s.timing.sample.n, 8)
  assert.equal(s.timing.untimed, 1)
  assert.equal(s.timing.fastShare, 6 / 8)
  assert.equal(s.timing.medianDays, 1)
})

/* ───── The Ease check ───────────────────────────────────────────── */

// 16 resolved, interleaved by date so each half holds 4 low + 4 mid.
function interleaved(lowProgressedAt, midProgressedAt) {
  const out = []
  let li = 0, mi = 0
  for (let i = 0; i < 16; i++) {
    if (i % 2 === 0) { out.push(rec('low', lowProgressedAt.includes(li) ? 'progressed' : 'rejected', day(i))); li++ }
    else { out.push(rec('mid', midProgressedAt.includes(mi) ? 'progressed' : 'rejected', day(i))); mi++ }
  }
  return out
}

test('insufficient: a band under the gate states its shortfall', () => {
  const c = compareBands([rec('low', 'rejected', day(0)), rec('mid', 'progressed', day(1))], 'low', 'mid')
  assert.equal(c.status, 'insufficient')
  assert.deepEqual(c.shortfall.map((s) => [s.band, s.n, s.gate]), [['low', 1, 8], ['mid', 1, 8]])
})

test('agrees: the higher band doing at least as well is not a finding', () => {
  assert.equal(compareBands(interleaved([0], [0, 1, 2]), 'low', 'mid').status, 'agrees')
})

test('within resolution: an inversion one application could undo is not a gap', () => {
  assert.equal(compareBands(interleaved([0, 1], [0]), 'low', 'mid').status, 'within-resolution')
})

test('not persistent: an inversion only in one half of the search', () => {
  // low progressed 4 of 8, all in the earlier half; mid never.
  const c = compareBands(interleaved([0, 1, 2, 3], []), 'low', 'mid')
  assert.equal(c.status, 'not-persistent')
})

test('gap: robust and in both halves', () => {
  // low progressed 6 of 8 (3 per half); mid never.
  const c = compareBands(interleaved([0, 1, 2, 4, 5, 6], []), 'low', 'mid')
  assert.equal(c.status, 'gap')
  const s = gapSuggestion(c)
  assert.equal(s.id, 'outcomes:ease:inversion:low-mid')
  assert.equal(s.kind, 'suggestion')
  assert.match(s.body, /6 of 8/)
})

test('high Ease never progressing is a gap only past the gate and in both halves', () => {
  const few = Array.from({ length: 5 }, (_, i) => rec('high', 'rejected', day(i)))
  assert.equal(highNeverProgresses(few).status, 'insufficient')
  const eight = Array.from({ length: 8 }, (_, i) => rec('high', i === 3 ? 'no-response' : 'rejected', day(i)))
  const g = highNeverProgresses(eight)
  assert.equal(g.status, 'gap')
  assert.equal(gapSuggestion(g).id, 'outcomes:ease:high-no-progress')
  const withOne = [...eight.slice(1), rec('high', 'progressed', day(20))]
  assert.equal(highNeverProgresses(withOne).status, 'agrees')
})

test('easeCheck returns every comparison and only confirmed gaps as gaps', () => {
  const r = easeCheck(interleaved([0, 1, 2, 4, 5, 6], []))
  assert.equal(r.comparisons.length, 4)
  assert.deepEqual(r.gaps.map((g) => `${g.lower}-${g.higher}`), ['low-mid'])
})

/* ───── End to end ───────────────────────────────────────────────── */

const fixture = {
  applications: [
    { num: 1, date: '2026-09-01', company: 'Nimbus Robotics', role: 'Data Analyst (m/f/d)', status: 'Rejected', notes: 'referral asked' },
    { num: 2, date: '2026-09-15', company: 'Fabrikam', role: 'Strategy Associate', status: 'Interview', notes: '' },
    { num: 3, date: '2026-10-10', company: 'Woodgrove Bank', role: 'Risk Analyst', status: 'Applied', notes: '' },
    { num: 4, date: '2026-08-01', company: 'Contoso', role: 'Ops Analyst', status: 'Applied', notes: '' },
    { num: 5, date: '2026-10-01', company: 'Tailspin', role: 'PM Intern', status: 'Evaluated', notes: '' },
  ],
  ledger: [
    { num: 1, date: '2026-09-01', company: 'Nimbus Robotics', role: 'Data Analyst (m/f/d)', from: 'Evaluated', to: 'Applied', stage: '', source: 'app', note: '' },
    { num: 1, date: '2026-09-02', company: 'Nimbus Robotics', role: 'Data Analyst (m/f/d)', from: 'Applied', to: 'Rejected', stage: '', source: 'app', note: '' },
    { num: 2, date: '2026-09-15', company: 'Fabrikam', role: 'Strategy Associate', from: 'Evaluated', to: 'Applied', stage: '', source: 'app', note: '' },
    { num: 2, date: '2026-09-25', company: 'Fabrikam', role: 'Strategy Associate', from: 'Applied', to: 'Interview', stage: '', source: 'app', note: '' },
    { num: 3, date: '2026-10-10', company: 'Woodgrove Bank', role: 'Risk Analyst', from: 'Evaluated', to: 'Applied', stage: '', source: 'cli', note: '' },
    { num: 4, date: '2026-08-01', company: 'Contoso', role: 'Ops Analyst', from: '', to: 'Applied', stage: '', source: 'backfill', note: 'seeded from applications.md' },
  ],
  scores: [
    { date: '2026-08-20', company: 'Nimbus Robotics', role: 'Data Analyst', ease: 5.2, match: 7.1, verdict: 'solid', archetype: 'data', location: 'Lyon, France' },
    { date: '2026-08-30', company: 'Nimbus Robotics', role: 'Data Analyst', ease: 7.4, match: 7.3, verdict: 'go', archetype: 'data', location: 'Lyon, France' },
    { date: '2026-09-10', company: 'Fabrikam', role: 'Strategy Associate', ease: 4.1, match: 8.4, verdict: 'growth', archetype: 'strategy', location: 'Remote' },
  ],
  materials: [
    { company: 'Nimbus Robotics', role: 'Data Analyst (m/f/d)', app_num: '1', sent: '2026-09-01', materials: 'cv', notes: '' },
  ],
}

test('end to end: joins the stores on one key and withholds every conclusion at this size', () => {
  const r = analyzeApplicationOutcomes({ ...fixture, today: TODAY })
  assert.deepEqual(r.records.map((x) => [x.num, x.outcome]), [[4, 'no-response'], [1, 'rejected'], [2, 'progressed'], [3, 'pending']])
  const nimbus = r.records.find((x) => x.num === 1)
  assert.equal(nimbus.ease, 7.4, 'latest score row wins, joined across the role variant')
  assert.equal(nimbus.easeBand, 'high')
  assert.equal(nimbus.city, 'Lyon')
  assert.equal(nimbus.sentSource, 'materials')
  assert.equal(nimbus.rejected.timing, 'fast')
  assert.equal(nimbus.agreement, 'surprise: high Ease, fast rejection')
  const fab = r.records.find((x) => x.num === 2)
  assert.equal(fab.agreement, 'surprise: low Ease, progressed')
  assert.equal(r.records.find((x) => x.num === 4).easeBand, 'unscored')
  assert.equal(r.overall.counts.resolved, 3)
  assert.equal(r.overall.sample.sufficient, false)
  assert.equal(r.easeCheck.gaps.length, 0)
  assert.deepEqual(r.suggestions, [])
  assert.ok(r.easeCheck.comparisons.every((c) => c.status === 'insufficient'))
})

test('the chat block states counts, says what is withheld, and draws no conclusion', () => {
  const r = analyzeApplicationOutcomes({ ...fixture, today: TODAY })
  const block = formatOutcomesBlock(r)
  assert.match(block, /Overall: 4 sent · 1 progressed · 1 rejected · 1 no response · 1 pending/)
  assert.match(block, /rates withheld \(3 resolved, 8 needed\)/)
  assert.match(block, /timing conclusions withheld/)
  assert.match(block, /No conclusion about the scoring is supported yet/)
  assert.ok(!/%/.test(block), 'no percentage below the gate')
  assert.match(block, /\| 1 \| Nimbus Robotics \|/)
})

test('the why table marks approximate dates with ~ and escapes pipes', () => {
  const r = analyzeApplicationOutcomes({
    ...fixture,
    applications: fixture.applications.map((a) => (a.num === 4 ? { ...a, notes: 'a | b' } : a)),
    today: TODAY,
  })
  const t = formatWhyTable(r.records)
  assert.match(t, /\| ~2026-08-01 \|/)
  assert.match(t, /a \/ b/)
})

test('noResponseDays can be overridden, invalid overrides are ignored', () => {
  const r = analyzeApplicationOutcomes({ ...fixture, today: TODAY, rules: { noResponseDays: 90 } })
  assert.equal(r.records.find((x) => x.num === 4).outcome, 'pending')
  const bad = analyzeApplicationOutcomes({ ...fixture, today: TODAY, rules: { noResponseDays: -1 } })
  assert.equal(bad.rules.noResponseDays, OUTCOME_RULES.noResponseDays)
  assert.equal(OUTCOME_GATES.minResolved, 8)
})

test('rejection patterns come from the log: stages, timing and slices, gated', () => {
  const r = rejectionPatterns(analyzeApplicationOutcomes({ ...fixture, today: TODAY }))
  assert.equal(r.rejections, 1)
  assert.deepEqual(r.byStage, [{ stage: 'Applied', n: 1 }])
  assert.equal(r.timing.fast, 1)
  assert.equal(r.timing.sample.sufficient, false)
  assert.equal(r.timing.fastShare, null)
  assert.deepEqual(r.slices.archetype.map((s) => [s.value, s.rejected]), [['data', 1]])
})

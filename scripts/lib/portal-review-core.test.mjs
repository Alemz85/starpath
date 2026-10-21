// portal-review-core.test.mjs — keep / pause / add rules of the portal review.
// Fixtures are fictional.
//
// Run: node --test scripts/lib/portal-review-core.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS, parseProbation, postFromReview, readReviewConfig, reviewPortals, scanDaysOf, selectToPost,
} from './portal-review-core.mjs'

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const START = '2026-10-21'
/** `n` scan days starting at START, `step` days apart. */
const scans = (n, step = 7) => Array.from({ length: n }, (_, i) => addDays(START, i * step))

/** A busy board that makes every scan day visible (the API scanner re-sees its postings each time). */
const busy = (days) => ({
  url: 'https://example.com/busy/1', company: 'Busy Systems', title: 'Operations Analyst Intern', portal: 'greenhouse-api',
  first_seen: days[0], scan_dates: days,
})
const row = (company, n, over = {}) => ({
  url: `https://example.com/${company.toLowerCase().replace(/\W+/g, '-')}/${n}`, company, title: `Analyst ${n}`, portal: 'websearch-l3',
  first_seen: '2026-10-22', scan_dates: ['2026-10-22'], ...over,
})
const tracked = (name, over = {}) => ({ name, enabled: true, ...over })
const probation = (...names) => new Map(names.map((n) => [n.toLowerCase().replace(/\W/g, ''), { name: n, since: START }]))

const review = (input) => reviewPortals({ today: addDays(START, 400), ...input })
const actions = (list, action) => list.filter((s) => s.action === action).map((s) => s.company)

test('pause: not after a few quiet weeks, even across several scans', () => {
  const days = scans(7) // 42 days, 7 weekly scans
  const out = review({ tracked: [tracked('Quiet Labs')], probation: probation('Quiet Labs'), history: [busy(days)], apiCovered: ['Quiet Labs'] })
  assert.deepEqual(actions(out, 'pause'), [])
})

test('pause: not after many scans packed into a short span (needs the calendar time too)', () => {
  const days = scans(30, 1) // 30 daily scans = 29 days
  const out = review({ tracked: [tracked('Quiet Labs')], probation: probation('Quiet Labs'), history: [busy(days)], apiCovered: ['Quiet Labs'] })
  assert.deepEqual(actions(out, 'pause'), [])
})

test('pause: after a full quiet season (weekly scans over five months), evidence in the body', () => {
  const days = scans(23) // 154 days
  const out = review({ tracked: [tracked('Quiet Labs', { brand: 'low' })], probation: probation('Quiet Labs'), history: [busy(days)], apiCovered: ['Quiet Labs'] })
  const [s] = out.filter((x) => x.action === 'pause')
  assert.ok(s, 'a pause suggestion')
  assert.equal(s.company, 'Quiet Labs')
  assert.equal(s.key, 'portal-review:pause:quietlabs')
  assert.match(s.title, /Pause Quiet Labs\? No matching role in 23 scans/)
  assert.match(s.body, /23 scans spanning 154 days/)
  assert.match(s.body, /2026-10-21 → 2027-03-24/)
  assert.match(s.body, /Passing postings in that window: 0 \(none ever\)/)
  assert.match(s.body, /Brand: low/)
  assert.match(s.body, /On probation since 2026-10-21/)
  assert.equal(s.evidence.scans, 23)
  assert.equal(s.evidence.spanDays, 154)
})

test('pause: the quiet clock restarts at the last passing posting', () => {
  const days = scans(23)
  const lastHit = { ...row('Quiet Labs', 1, { portal: 'greenhouse-api', first_seen: days[16], scan_dates: days.slice(16) }) } // seen at scan 17
  const out = review({ tracked: [tracked('Quiet Labs')], probation: probation('Quiet Labs'), history: [busy(days), lastHit], apiCovered: ['Quiet Labs'] })
  assert.deepEqual(actions(out, 'pause'), [], 'only six quiet scans since the last hit')
  // …but the same company with a hit long ago is quiet again once a season passes since it.
  const old = { ...lastHit, first_seen: days[0], scan_dates: [days[0]] }
  const longer = scans(25)
  const later = review({ tracked: [tracked('Quiet Labs')], history: [busy(longer), { ...old, first_seen: longer[0], scan_dates: [longer[0]] }], apiCovered: ['Quiet Labs'] })
  assert.deepEqual(actions(later, 'pause'), ['Quiet Labs'])
  assert.match(later.find((s) => s.action === 'pause').body, /last one was on its board until 2026-10-21/)
})

test('pause: a posting that is still open counts as passing — a long-open role is not a quiet company', () => {
  const days = scans(30)
  const open = row('Open Role Co', 1, { portal: 'ashby-api', first_seen: days[0], scan_dates: days })
  const out = review({ tracked: [tracked('Open Role Co')], history: [open], apiCovered: ['Open Role Co'] })
  assert.deepEqual(actions(out, 'pause'), [])
})

test('pause: a company with a passing posting in the window is not quiet', () => {
  const days = scans(23)
  const hit = row('Active Works', 1, { portal: 'workday-api', first_seen: days[22], scan_dates: [days[22]] })
  const out = review({ tracked: [tracked('Active Works')], probation: probation('Active Works'), history: [busy(days), hit], apiCovered: ['Active Works'] })
  assert.deepEqual(actions(out, 'pause'), [])
})

test('pause: dream, lower-tier-dream and brand-affinity companies are never suggested', () => {
  const days = scans(30)
  const out = review({
    tracked: [tracked('Northwind Dream'), tracked('Tailspin Affinity'), tracked('Contoso Plain')],
    history: [busy(days)],
    protectedCompanies: ['Northwind Dream', 'Tailspin Affinity'],
    failing: [{ company: 'Northwind Dream', consecutive_404: 5 }],
    apiCovered: ['Northwind Dream', 'Tailspin Affinity', 'Contoso Plain'],
  })
  assert.deepEqual(actions(out, 'pause'), ['Contoso Plain'])
})

test('pause: companies the API scanner cannot reach are not judged on its scan days', () => {
  const out = review({ tracked: [tracked('Search Only')], history: [busy(scans(30))], apiCovered: ['Busy Systems'] })
  assert.deepEqual(actions(out, 'pause'), [])
})

test('pause: a disabled company is left alone', () => {
  const out = review({ tracked: [tracked('Off Co', { enabled: false })], history: [busy(scans(30))], apiCovered: ['Off Co'] })
  assert.deepEqual(out, [])
})

test('pause: a board that keeps failing, once it fails enough scans in a row', () => {
  const failing = (n) => [{ company: 'Broken Board', consecutive_404: 0, consecutive_errors: n, last_error: 'HTTP 503' }]
  assert.deepEqual(actions(review({ tracked: [tracked('Broken Board')], failing: failing(2) }), 'pause'), [])
  const [s] = review({ tracked: [tracked('Broken Board')], failing: failing(3) })
  assert.equal(s.action, 'pause')
  assert.equal(s.variant, 'failing')
  assert.equal(s.key, 'portal-review:pause:brokenboard')
  assert.match(s.body, /failed 3 scans in a row: HTTP 503/)
})

test('keep: a probation company with a passing posting, with the evidence', () => {
  const hit = row('Fresh Start', 1, { title: 'Strategy Intern', portal: 'ashby-api', first_seen: '2026-10-25', scan_dates: ['2026-10-25'] })
  const out = review({ today: '2026-11-04', tracked: [tracked('Fresh Start')], probation: probation('Fresh Start'), history: [hit] })
  const [s] = out
  assert.equal(s.action, 'keep')
  assert.equal(s.key, 'portal-review:keep:freshstart')
  assert.match(s.title, /Keep Fresh Start\? 1 posting passed your filters/)
  assert.match(s.body, /14 days on probation \(since 2026-10-21\)/)
  assert.match(s.body, /“Strategy Intern” \(first seen 2026-10-25\)/)
})

test('keep: a probation company with a go/stretch/solid score, even without a stored posting', () => {
  const scores = [{ company: 'Fresh Start', role: 'Data Analyst Intern', verdict: 'solid' }, { company: 'Fresh Start', role: 'Other', verdict: 'stretch' }]
  const [s] = review({ today: '2026-11-04', tracked: [tracked('Fresh Start')], probation: probation('Fresh Start'), scores })
  assert.equal(s.action, 'keep')
  assert.match(s.title, /A listing scored stretch/)
  assert.match(s.body, /stretch — Other; solid — Data Analyst Intern/)
})

test('keep: not for a company off probation, not for a probation company with nothing, not for thin/skip scores', () => {
  const hit = row('Settled Inc', 1, { portal: 'lever-api' })
  assert.deepEqual(actions(review({ tracked: [tracked('Settled Inc')], history: [hit] }), 'keep'), [])
  assert.deepEqual(actions(review({ tracked: [tracked('Nothing Yet')], probation: probation('Nothing Yet'), history: [] }), 'keep'), [])
  const weak = [{ company: 'Nothing Yet', verdict: 'thin' }, { company: 'Nothing Yet', verdict: 'skip' }]
  assert.deepEqual(actions(review({ tracked: [tracked('Nothing Yet')], probation: probation('Nothing Yet'), scores: weak }), 'keep'), [])
})

test('keep: a PROBATION notes prefix counts as probation when no dated comment exists', () => {
  const hit = row('Notes Co', 1, { portal: 'lever-api' })
  const out = review({ tracked: [tracked('Notes Co', { notes: 'PROBATION · brand mid. Lisbon.' })], history: [hit] })
  assert.deepEqual(actions(out, 'keep'), ['Notes Co'])
})

test('add: an untracked company surfaced by the queries on two scan days', () => {
  const history = [
    row('Wayne Analytics', 1, { first_seen: '2026-10-22', scan_dates: ['2026-10-22'] }),
    row('Wayne Analytics', 2, { first_seen: '2026-10-29', scan_dates: ['2026-10-29'], portal: 'jobspy-indeed' }),
  ]
  const [s] = review({ tracked: [], history })
  assert.equal(s.action, 'add')
  assert.equal(s.key, 'portal-review:add:wayneanalytics')
  assert.match(s.body, /via websearch-l3, jobspy-indeed/)
  assert.match(s.body, /filters: 2, over 2 scan days/)
})

test('add: one posting, or two on the same day, is not enough', () => {
  const one = [row('Single Hit', 1)]
  const sameDay = [row('Same Day', 1), row('Same Day', 2)]
  assert.deepEqual(review({ tracked: [], history: [...one, ...sameDay] }), [])
})

test('add: one listing scored go/stretch/solid is enough; a tracked company is never "added"', () => {
  const out = review({
    tracked: [tracked('Already Here')],
    history: [row('One Off', 1), row('Already Here', 1), row('Already Here', 2, { first_seen: '2026-11-05', scan_dates: ['2026-11-05'] })],
    scores: [{ company: 'One Off', role: 'Pricing Intern', verdict: 'go' }],
  })
  assert.deepEqual(actions(out, 'add'), ['One Off'])
  assert.match(out.find((s) => s.action === 'add').title, /scored go/)
})

test('add: a blacklisted company is not suggested; a disabled tracked one with a good score is suggested for re-enabling', () => {
  const history = [row('Blocked Co', 1), row('Blocked Co', 2, { first_seen: '2026-11-05', scan_dates: ['2026-11-05'] })]
  assert.deepEqual(review({ tracked: [], history, isBlacklisted: (c) => c === 'Blocked Co' }), [])
  const out = review({ tracked: [tracked('Paused Co', { enabled: false })], scores: [{ company: 'Paused Co', verdict: 'solid' }] })
  assert.equal(out[0].action, 'add')
  assert.equal(out[0].variant, 'reenable')
  assert.match(out[0].title, /Re-enable Paused Co/)
})

test('company names match through normalisation (case, punctuation, suffix dots)', () => {
  const hit = row('FRESH-START', 1, { portal: 'ashby-api' })
  const out = review({ tracked: [tracked('Fresh Start')], probation: probation('Fresh Start'), history: [hit] })
  assert.deepEqual(actions(out, 'keep'), ['Fresh Start'])
})

test('selectToPost: nothing is posted twice — open, dismissed and resolved messages all block their key', () => {
  const sugg = ['a', 'b', 'c', 'd'].map((k, i) => ({ key: `portal-review:keep:${k}`, rank: 10 - i }))
  const messages = [
    { key: 'portal-review:keep:a', status: 'open' },
    { key: 'portal-review:keep:b', status: 'dismissed' },
    { key: 'portal-review:keep:c', status: 'resolved' },
    { status: 'open' },
  ]
  assert.deepEqual(selectToPost(sugg, messages).map((s) => s.key), ['portal-review:keep:d'])
  assert.deepEqual(selectToPost(sugg, []).map((s) => s.key), sugg.map((s) => s.key))
})

test('selectToPost: one per key, strongest first, capped per run', () => {
  const sugg = [{ key: 'k1' }, { key: 'k1' }, { key: 'k2' }, { key: 'k3' }]
  assert.deepEqual(selectToPost(sugg, [], 2).map((s) => s.key), ['k1', 'k2'])
  assert.deepEqual(selectToPost(sugg, [], 0), [])
})

test('reviewPortals ranks scored companies ahead of plain evidence', () => {
  const out = review({
    tracked: [tracked('Plain Hit'), tracked('Scored Hit')],
    probation: probation('Plain Hit', 'Scored Hit'),
    history: [row('Plain Hit', 1, { portal: 'lever-api' })],
    scores: [{ company: 'Scored Hit', verdict: 'go' }],
  })
  assert.deepEqual(out.map((s) => s.company), ['Scored Hit', 'Plain Hit'])
})

test('postFromReview: a scan suggestion with the stable key, and it builds a valid post', async () => {
  const [s] = review({ tracked: [], history: [row('Wayne Analytics', 1), row('Wayne Analytics', 2, { first_seen: '2026-11-05', scan_dates: ['2026-11-05'] })] })
  const input = postFromReview(s)
  assert.equal(input.source, 'scan')
  assert.equal(input.kind, 'suggestion')
  assert.equal(input.key, s.key)
  const { buildPost } = await import('./messages-core.mjs')
  const post = buildPost(input, { id: 'm-20261021-deadbeef', now: new Date('2026-10-21T10:00:00Z') })
  assert.equal(post.key, s.key)
  assert.deepEqual(post.links, [{ kind: 'file', target: 'user/portals.yml' }])
})

test('parseProbation: dated comment above an entry; other comments in between are fine; it does not leak to the next entry', () => {
  const text = [
    'tracked_companies:',
    '  # probation since 2026-10-21',
    '  - name: Nimbus Robotics',
    '    careers_url: https://example.com/a',
    '',
    '  # probation since 2026-11-02',
    '  # a note about the next company',
    '  - name: "Fabrikam"   # quoted',
    '',
    '  - name: Contoso',
    '  # PROBATION since not-a-date',
    '  - name: Litware',
  ].join('\n')
  const marks = parseProbation(text)
  assert.deepEqual([...marks.values()], [
    { name: 'Nimbus Robotics', since: '2026-10-21' },
    { name: 'Fabrikam', since: '2026-11-02' },
  ])
})

test('scanDaysOf: API scan days win; other sources only when there are none', () => {
  const api = { portal: 'greenhouse-api', first_seen: '2026-10-21', scan_dates: ['2026-10-21', '2026-10-28'] }
  const idx = { portal: 'jobspy-indeed', first_seen: '2026-10-25', scan_dates: ['2026-10-25'] }
  assert.deepEqual(scanDaysOf([api, idx]), ['2026-10-21', '2026-10-28'])
  assert.deepEqual(scanDaysOf([idx]), ['2026-10-25'])
  assert.deepEqual(scanDaysOf([]), [])
})

test('readReviewConfig: defaults, overrides, junk falls back, enabled: false', () => {
  assert.deepEqual(readReviewConfig(null), {
    enabled: true, pauseMinScans: 12, pauseMinDays: 150, failingScans: 3, addMinPostings: 2, addMinScans: 2, maxPerRun: 8,
  })
  assert.equal(DEFAULTS.pauseMinDays, 150)
  const c = readReviewConfig({ scanner: { portal_review: { pause_min_scans: 20, pause_min_days: 'x', max_per_run: 0, enabled: false } } })
  assert.equal(c.pauseMinScans, 20)
  assert.equal(c.pauseMinDays, 150)
  assert.equal(c.maxPerRun, 0)
  assert.equal(c.enabled, false)
})

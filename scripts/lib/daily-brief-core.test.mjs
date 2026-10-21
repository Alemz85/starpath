// Unit tests for scripts/lib/daily-brief-core.mjs — the pure assembly behind the
// daily/weekly job-search brief. daily-brief.mjs only feeds these functions the
// already-computed outputs of the imported analysis cores, so this suite pins
// the composition logic: per-core normalization (which items qualify, their
// urgency/sort), section ordering, the headline "do this first" pick, the
// scoreboard counts, and the markdown render.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { countPendingPipelineLines } from './profile-core.mjs'
import {
  followupItems,
  outreachItems,
  warmPathItems,
  newHitItems,
  insightItems,
  deadlineItems,
  triageItems,
  patternHeadsUp,
  globalPriority,
  pickTopAction,
  buildPipelineHealthSummary,
  assembleBrief,
  renderBrief,
  buildBriefMarkdown,
  SECTION_ORDER,
  buildCrossProfileSection,
  countFreshScanRows,
  verdictStars,
  scoreCellInfo,
} from './daily-brief-core.mjs'

/* ───── followupItems ───────────────────────────────────────────────────────*/

test('followupItems surfaces only overdue/urgent, drops waiting/cold', () => {
  const result = {
    entries: [
      { company: 'Acme', role: 'Analyst', status: 'applied', urgency: 'overdue', daysSinceApplication: 12, followupCount: 0, contacts: [] },
      { company: 'Beta', role: 'PM', status: 'responded', urgency: 'urgent', daysSinceApplication: 1, followupCount: 0, contacts: [] },
      { company: 'Gamma', role: 'Lead', status: 'applied', urgency: 'waiting', daysSinceApplication: 3, followupCount: 0, contacts: [] },
      { company: 'Delta', role: 'Eng', status: 'applied', urgency: 'cold', daysSinceApplication: 40, followupCount: 2, contacts: [] },
    ],
  }
  const items = followupItems(result)
  assert.equal(items.length, 2)
  // urgent sorts before overdue
  assert.equal(items[0].label, 'Beta — PM')
  assert.equal(items[1].label, 'Acme — Analyst')
})

test('followupItems sorts more-days-overdue first within the same urgency', () => {
  const result = {
    entries: [
      { company: 'A', role: 'r', status: 'applied', urgency: 'overdue', daysSinceApplication: 9, followupCount: 0, contacts: [] },
      { company: 'B', role: 'r', status: 'applied', urgency: 'overdue', daysSinceApplication: 21, followupCount: 1, contacts: [] },
    ],
  }
  const items = followupItems(result)
  assert.equal(items[0].label, 'B — r')
  assert.equal(items[1].label, 'A — r')
})

test('followupItems includes a contact in the sub when present', () => {
  const items = followupItems({
    entries: [{ company: 'A', role: 'r', status: 'applied', urgency: 'overdue', daysSinceApplication: 10, followupCount: 1, contacts: [{ email: 'jo@a.test' }] }],
  })
  assert.match(items[0].sub, /jo@a\.test/)
})

test('followupItems shows Match · Ease + verdict stars from a v2 Score cell; legacy cells as-is', () => {
  const items = followupItems({
    entries: [
      { company: 'Northwind Analytics', role: 'Analyst', status: 'applied', urgency: 'overdue', daysSinceApplication: 10, followupCount: 0, score: 'M8.4 E7.2', contacts: [] },
      { company: 'Contoso Retail', role: 'Analyst', status: 'applied', urgency: 'overdue', daysSinceApplication: 10, followupCount: 0, score: '7.4/10', contacts: [] },
      { company: 'Fabrikam Labs', role: 'Analyst', status: 'applied', urgency: 'overdue', daysSinceApplication: 10, followupCount: 0, score: 'M7.0 E5.5', contacts: [] },
    ],
  })
  // Same urgency + days → higher Priority first (√(8.4·7.2)≈7.78 > 7.4 legacy > √(7·5.5)≈6.2).
  assert.deepEqual(items.map((i) => i.label.split(' — ')[0]), ['Northwind Analytics', 'Contoso Retail', 'Fabrikam Labs'])
  assert.match(items[0].sub, /M8\.4 · E7\.2 ★★/) // go
  assert.equal(items[0].meta.verdict, 'go')
  assert.equal(items[0].meta.scoreLabel, 'M8.4 · E7.2')
  assert.equal(items[0].meta.score, 'M8.4 E7.2') // raw cell passes through
  assert.match(items[1].sub, /· 7\.4\/10$/) // legacy shown as-is, no stars
  assert.equal(items[1].meta.verdict, null)
  assert.equal(items[1].meta.priority, 7.4)
  assert.match(items[2].sub, /M7 · E5\.5$/) // thin → no stars
  assert.equal(items[2].meta.verdict, 'thin')
})

test('followupItems tolerates error/empty/missing input', () => {
  assert.deepEqual(followupItems(null), [])
  assert.deepEqual(followupItems({ error: 'no apps' }), [])
  assert.deepEqual(followupItems({}), [])
  assert.deepEqual(followupItems({ entries: [] }), [])
})

/* ───── outreachItems ───────────────────────────────────────────────────────*/

test('outreachItems surfaces only nudge actions, longest-overdue first', () => {
  const result = {
    entries: [
      { company: 'Acme', role: 'PM', contact: 'Jo', channel: 'Email', action: 'nudge', daysSince: 6, reason: 'No reply yet' },
      { company: 'Beta', role: '', contact: 'Sam', channel: 'Connection', action: 'waiting', daysSince: 2, reason: 'On track' },
      { company: 'Gamma', role: 'Lead', contact: 'Lee', channel: 'InMail', action: 'nudge', daysSince: 14, reason: 'No reply yet' },
      { company: 'Delta', role: '', contact: 'Max', channel: 'Email', action: 'cold', daysSince: 30, reason: 'maxed' },
    ],
  }
  const items = outreachItems(result)
  assert.equal(items.length, 2)
  assert.equal(items[0].meta.contact, 'Lee') // 14d > 6d
  assert.equal(items[1].meta.contact, 'Jo')
  assert.match(items[0].sub, /Lee \(InMail\)/)
})

test('outreachItems falls back to company/contact label when role is blank', () => {
  const items = outreachItems({ entries: [{ company: 'Acme', role: '', contact: 'Jo', action: 'nudge', daysSince: 5, reason: 'x' }] })
  assert.equal(items[0].label, 'Acme')
})

test('outreachItems tolerates empty/missing input', () => {
  assert.deepEqual(outreachItems(null), [])
  assert.deepEqual(outreachItems({}), [])
  assert.deepEqual(outreachItems({ entries: [] }), [])
})

/* ───── newHitItems ─────────────────────────────────────────────────────────*/

function digestStub(over = {}) {
  return {
    items: [],
    prioritize: [],
    needsEval: [],
    ...over,
  }
}

test('newHitItems: go before stretch/solid before needs-eval, Priority desc within', () => {
  const digest = digestStub({
    prioritize: [
      { company: 'Contoso Retail', title: 'Analyst', match: 7.5, ease: 9.2, priority: 8.31, verdict: 'solid', verdictLabel: 'Solid', location: 'Lisbon', url: 'https://a.test/1', ageDays: 1 },
      { company: 'Northwind Analytics', title: 'Strategist', match: 8.4, ease: 7.1, priority: 7.72, verdict: 'go', verdictLabel: 'Go', location: 'Porto', url: 'https://b.test/2', ageDays: 0 },
      { company: 'Fabrikam Labs', title: 'Associate', match: 8.2, ease: 5.5, priority: 6.72, verdict: 'stretch', verdictLabel: 'Stretch', location: 'Lyon', url: 'https://d.test/4', ageDays: 3 },
    ],
    needsEval: [
      { company: 'Tailspin Toys', title: 'PM', location: 'Ghent', url: 'https://c.test/3', ageDays: 2 },
    ],
  })
  const items = newHitItems(digest)
  assert.equal(items.length, 4)
  // go first even though the solid row has the higher Priority
  assert.deepEqual(items.map((i) => i.label), [
    'Northwind Analytics — Strategist', 'Contoso Retail — Analyst', 'Fabrikam Labs — Associate', 'Tailspin Toys — PM',
  ])
  assert.equal(items[3].meta.kind, 'needs-eval') // unscored last
  assert.match(items[0].sub, /^M8\.4 · E7\.1 ★★ Go/) // go → double star
  assert.match(items[1].sub, /^M7\.5 · E9\.2 ★ Solid/) // solid → single star
  assert.match(items[2].sub, /^M8\.2 · E5\.5 ★ Stretch/) // stretch → single star
  assert.match(items[3].sub, /Unscored/)
  assert.doesNotMatch(items.map((i) => i.sub).join('\n'), /\/10/)
  assert.equal(items[0].meta.priority, 7.72)
  assert.equal(items[0].meta.verdict, 'go')
  assert.ok(!('overall' in items[0].meta) && !('band' in items[0].meta))
})

test('newHitItems never surfaces a blocked row and computes Priority when absent', () => {
  const items = newHitItems(digestStub({
    prioritize: [
      { company: 'Blocked Co', title: 't', match: null, ease: null, verdict: 'blocked', verdictLabel: 'blocked: no sponsorship' },
      { company: 'Contoso Retail', title: 't', match: 8, ease: 8, verdict: 'go' },
    ],
  }))
  assert.equal(items.length, 1)
  assert.equal(items[0].meta.priority, 8)
  assert.doesNotMatch(items[0].sub, /blocked/)
})

test('newHitItems respects the maxPrioritize / maxNeedsEval caps', () => {
  const digest = digestStub({
    prioritize: Array.from({ length: 12 }, (_, i) => ({ company: `P${i}`, title: 't', match: 7 + i / 100, ease: 7.5, verdict: 'solid' })),
    needsEval: Array.from({ length: 9 }, (_, i) => ({ company: `N${i}`, title: 't' })),
  })
  const items = newHitItems(digest, { maxPrioritize: 3, maxNeedsEval: 2 })
  assert.equal(items.filter((i) => i.meta.kind === 'prioritize').length, 3)
  assert.equal(items.filter((i) => i.meta.kind === 'needs-eval').length, 2)
})

/* ───── verdict markers / score cells ───────────────────────────────────────*/

test('verdictStars: go ★★, stretch/solid ★, none otherwise (blocked never)', () => {
  assert.equal(verdictStars('go'), '★★')
  assert.equal(verdictStars('stretch'), '★')
  assert.equal(verdictStars('solid'), '★')
  for (const v of ['thin', 'growth', 'skip', 'blocked', null, undefined]) assert.equal(verdictStars(v), '')
})

test('scoreCellInfo parses v2 and legacy Score cells through tracker-core', () => {
  assert.deepEqual(scoreCellInfo('M8.3 E5.6'), { scoreLabel: 'M8.3 · E5.6', priority: 6.82, match: 8.3, ease: 5.6, verdict: 'stretch' })
  assert.deepEqual(scoreCellInfo('7.4/10'), { scoreLabel: '7.4/10', priority: 7.4, match: null, ease: null, verdict: null })
  assert.deepEqual(scoreCellInfo('N/A'), { scoreLabel: null, priority: null, match: null, ease: null, verdict: null })
  assert.deepEqual(scoreCellInfo(undefined), { scoreLabel: null, priority: null, match: null, ease: null, verdict: null })
})

test('newHitItems tolerates null/empty digest', () => {
  assert.deepEqual(newHitItems(null), [])
  assert.deepEqual(newHitItems(digestStub()), [])
})

/* ───── insightItems ────────────────────────────────────────────────────────*/

test('insightItems renders the systemic constraint + cheapest lever', () => {
  const intel = {
    systemicConstraint: {
      dominant: { dimension: 'experience_bar', label: 'Experience bar', archetypes: ['Strategy', 'Ops', 'Finance', 'Product'], count: 4 },
      lever: { dimension: 'experience_bar', label: 'Experience bar', count: 3, avgLift: 1.2 },
    },
  }
  const items = insightItems(intel)
  assert.equal(items.length, 1)
  assert.match(items[0].label, /Experience bar is your systemic blocker/)
  assert.match(items[0].sub, /binding constraint across 4 archetype/)
  assert.match(items[0].sub, /\+2 more/) // 4 archetypes → "Strategy, Ops +2 more"
  assert.match(items[0].sub, /lift Experience bar \(moves the verdict for 3 archetype\(s\), avg \+1\.2\)/)
})

test('insightItems keys a rollup-level constraint (low_ease, dimension null) by its tally key', () => {
  const intel = {
    systemicConstraint: {
      dominant: { key: 'low_ease', label: 'Ease', dimension: null, check: null, archetypes: ['Strategy', 'Ops'], count: 2 },
      lever: null,
    },
  }
  const [item] = insightItems(intel)
  assert.equal(item.key, 'insight|low_ease')
  assert.equal(item.meta.constraint, 'low_ease')
  assert.doesNotMatch(item.key, /null/)
})

test('insightItems falls back to strongest archetype when nothing binds', () => {
  const intel = {
    systemicConstraint: { dominant: null, tally: [], lever: null },
    fingerprints: [{ archetype: 'Strategy', avgMatch: 7.82, avgEase: 6.14 }, { archetype: 'Ops', avgMatch: 6.1, avgEase: 5.0 }],
  }
  const items = insightItems(intel)
  assert.equal(items.length, 1)
  assert.match(items[0].label, /lean into Strategy/)
  assert.match(items[0].sub, /avg Match 7\.8 · Ease 6\.1/)
  assert.doesNotMatch(items[0].sub, /\/10/)
})

test('insightItems returns empty on error/empty intel', () => {
  assert.deepEqual(insightItems(null), [])
  assert.deepEqual(insightItems({ error: 'no scores' }), [])
  assert.deepEqual(insightItems({ systemicConstraint: { dominant: null }, fingerprints: [] }), [])
})

/* ───── assembleBrief ───────────────────────────────────────────────────────*/

test('assembleBrief orders sections, counts actions, and picks the top action', () => {
  const inputs = {
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', match: 7.5, ease: 7.5, verdict: 'solid', url: 'https://x.test/1' }] }),
    followupResult: { entries: [{ company: 'Acme', role: 'PM', status: 'responded', urgency: 'urgent', daysSinceApplication: 1, followupCount: 0, contacts: [] }] },
    outreachResult: { entries: [{ company: 'Beta', role: 'Lead', contact: 'Jo', action: 'nudge', daysSince: 8, reason: 'No reply' }] },
    positioningIntel: { systemicConstraint: { dominant: { dimension: 'd', label: 'Brand', archetypes: ['A'], count: 1 }, lever: null } },
  }
  const brief = assembleBrief(inputs, { asOf: '2026-06-25', period: 'daily' })

  // section order is fixed
  assert.deepEqual(brief.sections.map((s) => s.id), SECTION_ORDER)

  // counts
  assert.equal(brief.counts.followups, 1)
  assert.equal(brief.counts.outreach, 1)
  assert.equal(brief.counts.newhits, 1)
  assert.equal(brief.counts.insight, 1)

  // totalActions excludes the insight note
  assert.equal(brief.totalActions, 3)

  // top action = first item of the first ACTION section (followups), never insight
  assert.equal(brief.topAction.section, 'followups')
  assert.equal(brief.topAction.item.label, 'Acme — PM')
})

test('assembleBrief top action skips empty sections to the next non-empty one', () => {
  const inputs = {
    // no followups, no outreach → top action should be the new hit
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', match: 7.5, ease: 7.5, verdict: 'solid' }] }),
    followupResult: { entries: [] },
    outreachResult: { entries: [] },
    positioningIntel: null,
  }
  const brief = assembleBrief(inputs, { asOf: '2026-06-25' })
  assert.equal(brief.topAction.section, 'newhits')
  assert.equal(brief.totalActions, 1)
})

test('assembleBrief with nothing actionable has null topAction and zero totalActions', () => {
  const brief = assembleBrief({}, { asOf: '2026-06-25' })
  assert.equal(brief.totalActions, 0)
  assert.equal(brief.topAction, null)
  // insight is not an action; an empty insight still leaves all sections present
  assert.equal(brief.sections.length, SECTION_ORDER.length)
})

test('assembleBrief normalizes period and validates asOf', () => {
  assert.equal(assembleBrief({}, { asOf: '2026-06-25', period: 'weekly' }).period, 'weekly')
  assert.equal(assembleBrief({}, { asOf: '2026-06-25', period: 'nonsense' }).period, 'daily')
  assert.equal(assembleBrief({}, { asOf: 'bad-date' }).asOf, null)
  assert.equal(assembleBrief({}, {}).asOf, null)
})

/* ───── renderBrief ─────────────────────────────────────────────────────────*/

test('renderBrief produces a dated heading, do-this-first, scoreboard, and sections', () => {
  const inputs = {
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', match: 7.6, ease: 8.0, verdict: 'solid', location: 'Lisbon', url: 'https://x.test/1', ageDays: 1 }] }),
    followupResult: { entries: [{ company: 'Acme', role: 'PM', status: 'overdue' === 'overdue' ? 'applied' : '', urgency: 'overdue', daysSinceApplication: 12, followupCount: 1, contacts: [] }] },
    outreachResult: { entries: [] },
    positioningIntel: { systemicConstraint: { dominant: { dimension: 'd', label: 'Experience bar', archetypes: ['A', 'B'], count: 2 }, lever: { label: 'Experience bar', count: 2, avgLift: 1.0 } } },
  }
  const md = renderBrief(assembleBrief(inputs, { asOf: '2026-06-25', period: 'daily' }))

  assert.match(md, /^# Daily job-search brief — 2026-06-25/m)
  // The top-action headline wraps the label in bold and appends the sub-text
  assert.match(md, /\*\*Do this first:\*\* \*\*Acme — PM\*\*/)
  assert.match(md, /_2 action\(s\):_/)
  assert.match(md, /## Follow-ups due/)
  assert.match(md, /## Fresh high-fit postings/)
  // new-hit posting links to its url
  assert.match(md, /\[X — Analyst\]\(https:\/\/x\.test\/1\)/)
  // insight renders as prose under its own heading
  assert.match(md, /## Standing positioning note/)
  assert.match(md, /Experience bar is your systemic blocker/)
  // footer provenance
  assert.match(md, /scripts\/daily-brief\.mjs/)
})

test('renderBrief shows an all-clear message when nothing is actionable', () => {
  const md = renderBrief(assembleBrief({}, { asOf: '2026-06-25' }))
  assert.match(md, /Nothing time-sensitive right now/)
  assert.doesNotMatch(md, /## Follow-ups due/)
})

test('renderBrief weekly framing uses the weekly word', () => {
  const md = renderBrief(assembleBrief({}, { asOf: '2026-06-25', period: 'weekly' }))
  assert.match(md, /^# Weekly job-search brief/m)
})

test('renderBrief omits empty sections but keeps populated ones', () => {
  const inputs = {
    digest: null,
    followupResult: { entries: [{ company: 'Acme', role: 'PM', status: 'applied', urgency: 'overdue', daysSinceApplication: 10, followupCount: 0, contacts: [] }] },
    outreachResult: { entries: [] },
    positioningIntel: null,
  }
  const md = renderBrief(assembleBrief(inputs, { asOf: '2026-06-25' }))
  assert.match(md, /## Follow-ups due/)
  assert.doesNotMatch(md, /## Outreach nudges due/)
  assert.doesNotMatch(md, /## Fresh high-fit postings/)
  assert.doesNotMatch(md, /## Standing positioning note/)
})

/* ───── buildBriefMarkdown (convenience) ────────────────────────────────────*/

test('buildBriefMarkdown is renderBrief∘assembleBrief', () => {
  const inputs = { followupResult: { entries: [] } }
  const opts = { asOf: '2026-06-25' }
  assert.equal(buildBriefMarkdown(inputs, opts), renderBrief(assembleBrief(inputs, opts)))
})

/* ───── deadlineItems ───────────────────────────────────────────────────────*/

// Helper: build a minimal classifyDeadlines-shaped object
function classifiedDeadlinesStub(over = {}) {
  return {
    asOf: '2026-06-25',
    buckets: {
      urgent: [],
      near: [],
      medium: [],
      far: [],
      rolling: [],
      missed: [],
      ...over,
    },
    counts: { urgent: 0, near: 0, medium: 0, far: 0, rolling: 0, missed: 0, unknown: 0 },
  }
}

test('deadlineItems surfaces urgent bucket first, then near', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [
      { source: 'applications', num: 5, company: 'Acme', role: 'Analyst', status: 'Applied', deadline: '2026-06-27', parsed: { kind: 'date', iso: '2026-06-27' }, daysLeft: 2 },
    ],
    near: [
      { source: 'scouting', num: 3, company: 'Beta', role: 'PM', tier: 'T1', deadline: '2026-07-15', parsed: { kind: 'date', iso: '2026-07-15' }, daysLeft: 20 },
    ],
  })
  const items = deadlineItems(classified)
  assert.equal(items.length, 2)
  assert.equal(items[0].label, 'Acme — Analyst')
  assert.equal(items[0].urgency, 0) // urgent
  assert.match(items[0].sub, /2d left/)
  assert.match(items[0].sub, /Applied/)
  assert.equal(items[1].label, 'Beta — PM')
  assert.equal(items[1].urgency, 1) // near
  assert.match(items[1].sub, /20d left/)
  assert.match(items[1].sub, /T1/)
})

test('deadlineItems: scouting entries show Match · Ease + verdict stars, Priority breaks day ties', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [
      { source: 'scouting', num: 7, company: 'Contoso Retail', role: 'Analyst', tier: 'T2', match: 8.1, ease: 5.4, scoreLabel: 'M8.1 · E5.4', deadline: '2026-06-28', parsed: { kind: 'date' }, daysLeft: 3 },
      { source: 'scouting', num: 8, company: 'Northwind Analytics', role: 'Analyst', tier: 'T1', match: 8.6, ease: 7.4, scoreLabel: 'M8.6 · E7.4', deadline: '2026-06-28', parsed: { kind: 'date' }, daysLeft: 3 },
      { source: 'applications', num: 2, company: 'Fabrikam Labs', role: 'PM', status: 'Applied', deadline: '2026-06-28', parsed: { kind: 'date' }, daysLeft: 3 },
    ],
  })
  const items = deadlineItems(classified)
  assert.deepEqual(items.map((i) => i.label.split(' — ')[0]), ['Northwind Analytics', 'Contoso Retail', 'Fabrikam Labs'])
  assert.match(items[0].sub, /^3d left · T1 · M8\.6 · E7\.4 ★★ — decide now$/)
  assert.match(items[1].sub, /^3d left · T2 · M8\.1 · E5\.4 ★ — decide now$/) // stretch
  assert.match(items[2].sub, /^3d left · Applied — decide now$/) // no score on an app deadline
  assert.equal(items[0].meta.verdict, 'go')
  assert.equal(items[0].meta.priority, 7.98)
  assert.equal(items[2].meta.priority, null)
})

test('deadlineItems closes-today entry uses "closes today" wording', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [
      { source: 'scouting', num: 1, company: 'Corp', role: 'Dev', tier: 'T2', deadline: '2026-06-25', parsed: { kind: 'date', iso: '2026-06-25' }, daysLeft: 0 },
    ],
  })
  const items = deadlineItems(classified)
  assert.match(items[0].sub, /closes today/)
  assert.match(items[0].sub, /decide now/)
})

test('deadlineItems sorts urgent entries fewest-days-first', () => {
  // daysLeft: 1 should surface before daysLeft: 5
  const classified = classifiedDeadlinesStub({
    urgent: [
      { source: 'applications', num: 2, company: 'B', role: 'r', status: 'Applied', deadline: '2026-06-30', parsed: { kind: 'date', iso: '2026-06-30' }, daysLeft: 5 },
      { source: 'applications', num: 1, company: 'A', role: 'r', status: 'Applied', deadline: '2026-06-26', parsed: { kind: 'date', iso: '2026-06-26' }, daysLeft: 1 },
    ],
  })
  const items = deadlineItems(classified)
  assert.equal(items[0].label, 'A — r') // daysLeft: 1 first
  assert.equal(items[1].label, 'B — r')
})

test('deadlineItems respects maxUrgent / maxNear caps', () => {
  const classified = classifiedDeadlinesStub({
    urgent: Array.from({ length: 8 }, (_, i) => ({
      source: 'scouting', num: i, company: `U${i}`, role: 'r', tier: 'T1',
      deadline: '2026-06-26', parsed: { kind: 'date' }, daysLeft: 1,
    })),
    near: Array.from({ length: 8 }, (_, i) => ({
      source: 'scouting', num: i + 10, company: `N${i}`, role: 'r', tier: 'T2',
      deadline: '2026-07-10', parsed: { kind: 'date' }, daysLeft: 15,
    })),
  })
  const items = deadlineItems(classified, { maxUrgent: 3, maxNear: 2 })
  assert.equal(items.filter((it) => it.urgency === 0).length, 3) // urgent
  assert.equal(items.filter((it) => it.urgency === 1).length, 2) // near
})

test('deadlineItems shows scouting tier in label for scouting source', () => {
  const classified = classifiedDeadlinesStub({
    near: [{ source: 'scouting', num: 9, company: 'XYZ', role: 'Lead', tier: 'T1', deadline: '2026-07-10', parsed: { kind: 'date' }, daysLeft: 15 }],
  })
  const items = deadlineItems(classified)
  assert.match(items[0].sub, /T1/)
})

test('deadlineItems tolerates null / empty input', () => {
  assert.deepEqual(deadlineItems(null), [])
  assert.deepEqual(deadlineItems({}), [])
  assert.deepEqual(deadlineItems(classifiedDeadlinesStub()), [])
})

/* ───── buildPipelineHealthSummary ──────────────────────────────────────────*/

test('buildPipelineHealthSummary returns structured counts', () => {
  const ph = buildPipelineHealthSummary({ active: 3, evaluated: 5, inboxCount: 12 })
  assert.equal(ph.active, 3)
  assert.equal(ph.evaluated, 5)
  assert.equal(ph.inboxCount, 12)
  assert.equal(ph.hasData, true)
})

test('buildPipelineHealthSummary returns null when all counts are zero', () => {
  assert.equal(buildPipelineHealthSummary({ active: 0, evaluated: 0, inboxCount: 0 }), null)
  assert.equal(buildPipelineHealthSummary(null), null)
})

test('buildPipelineHealthSummary tolerates partial input (only some keys)', () => {
  const ph = buildPipelineHealthSummary({ active: 2 })
  assert.equal(ph.active, 2)
  assert.equal(ph.evaluated, 0)
  assert.equal(ph.inboxCount, 0)
  assert.equal(ph.hasData, true)
})

/* ───── assembleBrief — new inputs ─────────────────────────────────────────*/

test('assembleBrief includes deadlines section with items from classifiedDeadlines', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [{ source: 'applications', num: 1, company: 'KPMG', role: 'Analyst', status: 'Applied', deadline: '2026-06-27', parsed: { kind: 'date' }, daysLeft: 2 }],
  })
  const brief = assembleBrief(
    { classifiedDeadlines: classified },
    { asOf: '2026-06-25' },
  )
  const deadlinesSec = brief.sections.find((s) => s.id === 'deadlines')
  assert.ok(deadlinesSec, 'deadlines section should be present')
  assert.equal(deadlinesSec.items.length, 1)
  assert.equal(brief.counts.deadlines, 1)
  // deadline is an action → contributes to totalActions
  assert.equal(brief.totalActions, 1)
})

test('assembleBrief sets topAction to a deadline when it is the first non-empty action section', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [{ source: 'scouting', num: 2, company: 'Corp', role: 'Dev', tier: 'T2', deadline: '2026-06-26', parsed: { kind: 'date' }, daysLeft: 1 }],
  })
  const brief = assembleBrief(
    { classifiedDeadlines: classified, followupResult: { entries: [] } },
    { asOf: '2026-06-25' },
  )
  // followups empty → first non-empty action is deadlines
  assert.equal(brief.topAction.section, 'deadlines')
})

test('assembleBrief exposes pipelineHealth in the brief object', () => {
  const brief = assembleBrief(
    { pipelineHealth: { active: 4, evaluated: 2, inboxCount: 7 } },
    { asOf: '2026-06-25' },
  )
  assert.ok(brief.pipelineHealth)
  assert.equal(brief.pipelineHealth.active, 4)
  assert.equal(brief.pipelineHealth.evaluated, 2)
  assert.equal(brief.pipelineHealth.inboxCount, 7)
})

test('assembleBrief pipelineHealth is null when all zero', () => {
  const brief = assembleBrief(
    { pipelineHealth: { active: 0, evaluated: 0, inboxCount: 0 } },
    { asOf: '2026-06-25' },
  )
  assert.equal(brief.pipelineHealth, null)
})

/* ───── renderBrief — pipeline health + deadline top-action ─────────────────*/

test('renderBrief shows pipeline health summary when counts are non-zero', () => {
  const brief = assembleBrief(
    { pipelineHealth: { active: 3, evaluated: 1, inboxCount: 5 } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.match(md, /\*\*Pipeline:\*\*/)
  assert.match(md, /3 active apps in flight/)
  assert.match(md, /1 evaluated — pending decision/)
  assert.match(md, /5 URLs in pipeline inbox/)
})

test('renderBrief omits pipeline health line when all counts are zero', () => {
  const brief = assembleBrief(
    { pipelineHealth: { active: 0, evaluated: 0, inboxCount: 0 } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.doesNotMatch(md, /\*\*Pipeline:\*\*/)
})

test('renderBrief renders the deadlines section as a checklist', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [{ source: 'scouting', num: 1, company: 'Acme', role: 'PM', tier: 'T1', deadline: '2026-06-27', parsed: { kind: 'date' }, daysLeft: 2 }],
    near: [{ source: 'applications', num: 2, company: 'Beta', role: 'Dev', status: 'Evaluated', deadline: '2026-07-10', parsed: { kind: 'date' }, daysLeft: 15 }],
  })
  const md = renderBrief(assembleBrief({ classifiedDeadlines: classified }, { asOf: '2026-06-25' }))
  assert.match(md, /## Deadlines closing soon/)
  assert.match(md, /- \*\*Acme — PM\*\*/)
  assert.match(md, /2d left/)
  assert.match(md, /- \*\*Beta — Dev\*\*/)
  assert.match(md, /15d left/)
})

test('renderBrief top-action for a deadline entry includes days-left callout', () => {
  const classified = classifiedDeadlinesStub({
    urgent: [{ source: 'applications', num: 1, company: 'Tailspin Toys', role: 'Analyst', status: 'Applied', deadline: '2026-06-26', parsed: { kind: 'date' }, daysLeft: 1 }],
  })
  const brief = assembleBrief(
    { classifiedDeadlines: classified, followupResult: { entries: [] } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.match(md, /Do this first/)
  assert.match(md, /1d left/)
  assert.match(md, /decide\/apply now/)
})

test('renderBrief top-action for a new-hit entry links to its URL', () => {
  const digest = digestStub({
    prioritize: [{ company: 'Fabrikam Labs', title: 'PM', match: 8.5, ease: 7.4, verdict: 'go', url: 'https://fabrikam.test/jobs/1' }],
  })
  const brief = assembleBrief(
    { digest, followupResult: { entries: [] }, outreachResult: { entries: [] } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.match(md, /\[Fabrikam Labs — PM\]\(https:\/\/fabrikam\.test\/jobs\/1\)/)
})

test('renderBrief all-clear message mentions deadline pressure', () => {
  const md = renderBrief(assembleBrief({}, { asOf: '2026-06-25' }))
  assert.match(md, /deadline pressure/)
})

test('SECTION_ORDER contains deadlines between followups and outreach', () => {
  const fi = SECTION_ORDER.indexOf('followups')
  const di = SECTION_ORDER.indexOf('deadlines')
  const oi = SECTION_ORDER.indexOf('outreach')
  assert.ok(fi < di, 'followups should come before deadlines')
  assert.ok(di < oi, 'deadlines should come before outreach')
})

/* ───── patternHeadsUp ──────────────────────────────────────────────────────*/

test('patternHeadsUp surfaces the first high-impact recommendation', () => {
  const patterns = {
    metadata: { total: 14 },
    recommendations: [
      { action: 'Every application that progressed was verdict Solid or better', reasoning: 'Spend application effort on Solid+ listings.', impact: 'medium' },
      { action: 'Tighten location filters — 36% hit a geo-restriction blocker', reasoning: '5 of 14 are US-only.', impact: 'high' },
    ],
  }
  const items = patternHeadsUp(patterns)
  assert.equal(items.length, 1)
  // prefers the high-impact one even though it's second in the list
  assert.match(items[0].sub, /geo-restriction blocker/)
  assert.match(items[0].sub, /5 of 14 are US-only/) // reasoning appended
  assert.equal(items[0].meta.impact, 'high')
  assert.equal(items[0].meta.kind, 'pattern-recommendation')
})

test('patternHeadsUp falls back to the first rec when none are high-impact', () => {
  const items = patternHeadsUp({
    recommendations: [
      { action: 'Double down on Strategy roles', reasoning: '40% conversion.', impact: 'medium' },
      { action: 'Avoid global-remote roles', reasoning: '0% conversion.', impact: 'medium' },
    ],
  })
  assert.equal(items.length, 1)
  assert.match(items[0].sub, /Double down on Strategy roles/)
  assert.equal(items[0].meta.impact, 'medium')
})

test('patternHeadsUp tolerates error / empty / missing input', () => {
  assert.deepEqual(patternHeadsUp(null), [])
  assert.deepEqual(patternHeadsUp({ error: 'Not enough data' }), [])
  assert.deepEqual(patternHeadsUp({}), [])
  assert.deepEqual(patternHeadsUp({ recommendations: [] }), [])
  // a malformed rec (no action) yields nothing rather than a half-rendered note
  assert.deepEqual(patternHeadsUp({ recommendations: [{ reasoning: 'x', impact: 'high' }] }), [])
})

test('patternHeadsUp is an insight-kind section (a note, never an action)', () => {
  const brief = assembleBrief(
    { patterns: { recommendations: [{ action: 'Tighten filters', reasoning: 'waste', impact: 'high' }] } },
    { asOf: '2026-06-25' },
  )
  const headsup = brief.sections.find((s) => s.id === 'headsup')
  assert.ok(headsup)
  assert.equal(headsup.kind, 'insight')
  assert.equal(headsup.items.length, 1)
  // does NOT inflate the action scoreboard
  assert.equal(brief.totalActions, 0)
  assert.equal(brief.topAction, null)
})

test('renderBrief renders the heads-up section as prose', () => {
  const brief = assembleBrief(
    { patterns: { recommendations: [{ action: 'Tighten location filters', reasoning: 'wasted effort', impact: 'high' }] } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.match(md, /## Heads-up from your outcomes/)
  assert.match(md, /Tighten location filters/)
})

/* ───── globalPriority — cross-section time-criticality ─────────────────────*/

test('globalPriority: deadlines are scaled by days-left and clamped', () => {
  assert.equal(globalPriority('deadlines', { meta: { daysLeft: 0 } }), 0) // closes today
  assert.equal(globalPriority('deadlines', { meta: { daysLeft: 3 } }), 3)
  assert.equal(globalPriority('deadlines', { meta: { daysLeft: -2 } }), 0) // missed → most urgent
  assert.equal(globalPriority('deadlines', { meta: { daysLeft: 200 } }), 60) // clamped
})

test('globalPriority: any deadline ≤ 60d outranks every follow-up', () => {
  const farDeadline = globalPriority('deadlines', { meta: { daysLeft: 60 } })
  const urgentFollowup = globalPriority('followups', { urgency: 0, meta: { daysSince: 0 } })
  assert.ok(farDeadline < urgentFollowup, '60d deadline (60) should beat urgent follow-up (100)')
})

test('globalPriority: urgent follow-ups outrank overdue follow-ups', () => {
  const urgent = globalPriority('followups', { urgency: 0, meta: { daysSince: 1 } })
  const overdue = globalPriority('followups', { urgency: 1, meta: { daysSince: 20 } })
  assert.ok(urgent < overdue, 'urgent band (100s) should beat overdue band (200s)')
})

test('globalPriority: more-days-overdue follow-up surfaces before less-overdue', () => {
  const more = globalPriority('followups', { urgency: 1, meta: { daysSince: 30 } })
  const less = globalPriority('followups', { urgency: 1, meta: { daysSince: 9 } })
  assert.ok(more < less, 'more days overdue → smaller priority')
})

test('globalPriority: obligations (follow-ups, outreach) outrank opportunities (new hits)', () => {
  const overdueFollowup = globalPriority('followups', { urgency: 1, meta: { daysSince: 9 } })
  const outreach = globalPriority('outreach', { meta: { daysSince: 9 } })
  const strongHit = globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'go', priority: 9.5 } })
  assert.ok(overdueFollowup < outreach, 'follow-up band (200s) before outreach band (300s)')
  assert.ok(outreach < strongHit, 'outreach band (300s) before new-hits band (500s)')
})

test('globalPriority: new hits rank go > stretch/solid > needs-eval, higher Priority first', () => {
  const goHigh = globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'go', priority: 9 } })
  const goLow = globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'go', priority: 7.5 } })
  const solidHigh = globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'solid', priority: 9.5 } })
  const stretch = globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'stretch', priority: 6.5 } })
  const unscored = globalPriority('newhits', { meta: { kind: 'needs-eval' } })
  assert.ok(goHigh < goLow, 'higher Priority → smaller rank')
  assert.ok(goLow < solidHigh, 'any go before any solid, whatever the Priority')
  assert.ok(solidHigh < stretch)
  assert.ok(stretch < unscored, 'scored before needs-eval')
  for (const p of [goHigh, goLow, solidHigh, stretch, unscored]) assert.ok(p >= 500 && p < 600)
})

test('globalPriority: unknown section is lowest priority', () => {
  assert.equal(globalPriority('mystery', { meta: {} }), 999)
})

/* ───── pickTopAction — cross-section ranking ───────────────────────────────*/

function actionSections(over = {}) {
  // Minimal action-section list shaped like assembleBrief's `sections`.
  const base = { followups: [], deadlines: [], outreach: [], newhits: [], headsup: [], insight: [] }
  const items = { ...base, ...over }
  return [
    { id: 'followups', title: 'Follow-ups due', kind: 'action', items: items.followups },
    { id: 'deadlines', title: 'Deadlines closing soon', kind: 'action', items: items.deadlines },
    { id: 'outreach', title: 'Outreach nudges due', kind: 'action', items: items.outreach },
    { id: 'newhits', title: 'Fresh high-fit postings', kind: 'action', items: items.newhits },
    { id: 'headsup', title: 'Heads-up from your outcomes', kind: 'insight', items: items.headsup },
    { id: 'insight', title: 'Standing positioning note', kind: 'insight', items: items.insight },
  ]
}

test('pickTopAction: a deadline closing soon beats a mildly-overdue follow-up', () => {
  // This is the headline behavior change — section order would pick the follow-up.
  const sections = actionSections({
    followups: [{ label: 'Acme — Analyst', urgency: 1, meta: { daysSince: 9 } }],
    deadlines: [{ label: 'Beta — Lead', urgency: 0, meta: { daysLeft: 3 } }],
  })
  const top = pickTopAction(sections)
  assert.equal(top.section, 'deadlines')
  assert.equal(top.item.label, 'Beta — Lead')
})

test('pickTopAction: an extremely overdue follow-up still loses to a near deadline', () => {
  const sections = actionSections({
    followups: [{ label: 'Acme — Analyst', urgency: 1, meta: { daysSince: 60 } }],
    deadlines: [{ label: 'Beta — Lead', urgency: 1, meta: { daysLeft: 28 } }],
  })
  // deadline 28 (band 28) < overdue follow-up (band ~239) → deadline wins
  assert.equal(pickTopAction(sections).section, 'deadlines')
})

test('pickTopAction: with no deadline, the urgent follow-up wins', () => {
  const sections = actionSections({
    followups: [{ label: 'Acme — Analyst', urgency: 0, meta: { daysSince: 1 } }],
    outreach: [{ label: 'Gamma — PM', meta: { daysSince: 14 } }],
    newhits: [{ label: 'Delta — Growth', meta: { kind: 'prioritize', verdict: 'go', priority: 9 } }],
  })
  const top = pickTopAction(sections)
  assert.equal(top.section, 'followups')
})

test('pickTopAction: ignores insight-kind sections and returns null when no actions', () => {
  const sections = actionSections({
    headsup: [{ label: 'lesson', meta: {} }],
    insight: [{ label: 'note', meta: {} }],
  })
  assert.equal(pickTopAction(sections), null)
})

test('pickTopAction: exposes the numeric priority on the result', () => {
  const sections = actionSections({
    deadlines: [{ label: 'Beta — Lead', urgency: 0, meta: { daysLeft: 5 } }],
  })
  const top = pickTopAction(sections)
  assert.equal(top.priority, 5)
})

/* ───── assembleBrief — cross-section top action (integration) ──────────────*/

test('assembleBrief top action prefers a soon deadline over an overdue follow-up', () => {
  const brief = assembleBrief({
    followupResult: { entries: [{ company: 'Acme', role: 'Analyst', status: 'applied', urgency: 'overdue', daysSinceApplication: 11, followupCount: 0, contacts: [] }] },
    classifiedDeadlines: {
      asOf: '2026-06-25',
      buckets: {
        urgent: [{ source: 'scouting', num: 1, company: 'Beta', role: 'Lead', tier: 'T1', deadline: '2026-06-29', parsed: { kind: 'date', iso: '2026-06-29' }, daysLeft: 4 }],
        near: [], medium: [], far: [], rolling: [], missed: [],
      },
      counts: { urgent: 1, near: 0, medium: 0, far: 0, rolling: 0, missed: 0, unknown: 0 },
    },
  }, { asOf: '2026-06-25' })
  assert.equal(brief.topAction.section, 'deadlines')
  assert.equal(brief.topAction.item.label, 'Beta — Lead')
  // the overdue follow-up is still listed in its own section
  assert.equal(brief.counts.followups, 1)
})

/* ───── triageItems — the inbox's deep-eval-next slice ───────────────────────*/

const rankedTriage = [
  { url: 'https://a.io/1', company: 'Acme', title: 'Strategy Analyst', triageScore: 6.5, triageReasons: ['scan relevance 4.5', 'fresh (2d, +2)'], bucket: 'deep-eval' },
  { url: 'https://b.io/2', company: 'Globex', title: 'Data Analyst', triageScore: 2.0, triageReasons: ['scan relevance 2.0'], bucket: 'deep-eval' },
  { url: 'https://c.io/3', company: 'Initech', title: 'Senior Lead', triageScore: -1.0, triageReasons: ['senior-title signal (-4)'], bucket: 'deep-eval' },
  { url: 'https://d.io/4', company: 'Hooli', title: 'Analyst', triageScore: 1.0, triageReasons: [], bucket: 'hold' },
]

test('triageItems keeps only positively-scored deep-eval entries, capped', () => {
  const items = triageItems(rankedTriage)
  assert.equal(items.length, 2) // negative score + hold bucket dropped
  assert.equal(items[0].label, 'Acme — Strategy Analyst')
  assert.equal(items[0].meta.kind, 'triage')
  assert.equal(items[0].meta.url, 'https://a.io/1')
  assert.match(items[0].sub, /triage 6\.5 — scan relevance 4\.5; fresh/)
  const capped = triageItems(rankedTriage, { maxTriage: 1 })
  assert.equal(capped.length, 1)
})

test('triageItems handles null input and label fallbacks', () => {
  assert.deepEqual(triageItems(null), [])
  const items = triageItems([{ url: 'https://x.io', triageScore: 1, triageReasons: [], bucket: 'deep-eval' }])
  assert.equal(items[0].label, 'https://x.io')
})

test('globalPriority: triage sits in the 6xx band, higher score first, below newhits', () => {
  const high = globalPriority('triage', { meta: { score: 6.5 } })
  const low = globalPriority('triage', { meta: { score: 1.0 } })
  assert.ok(high >= 600 && high < 700)
  assert.ok(high < low)
  // Any fresh posting beats any triage pick.
  assert.ok(globalPriority('newhits', { meta: { kind: 'needs-eval', priority: null } }) < high)
})

test('assembleBrief folds the triage section in; a deadline still wins top action', () => {
  const brief = assembleBrief({
    triage: rankedTriage,
    classifiedDeadlines: {
      asOf: '2026-07-01',
      buckets: {
        urgent: [{ source: 'scouting', num: 1, company: 'Beta', role: 'Lead', tier: 'T1', deadline: '2026-07-05', parsed: { kind: 'date', iso: '2026-07-05' }, daysLeft: 4 }],
        near: [], medium: [], far: [], rolling: [], missed: [],
      },
      counts: { urgent: 1, near: 0, medium: 0, far: 0, rolling: 0, missed: 0, unknown: 0 },
    },
  }, { asOf: '2026-07-01' })
  assert.equal(brief.counts.triage, 2)
  assert.equal(brief.topAction.section, 'deadlines')
  const md = renderBrief(brief)
  assert.match(md, /## Deep-eval next \(inbox triage\)/)
  assert.match(md, /\[Acme — Strategy Analyst\]\(https:\/\/a\.io\/1\)/)
})

test('a triage pick becomes the top action only when nothing else exists', () => {
  const brief = assembleBrief({ triage: rankedTriage }, { asOf: '2026-07-01' })
  assert.equal(brief.topAction.section, 'triage')
  assert.equal(brief.topAction.item.label, 'Acme — Strategy Analyst')
  const md = renderBrief(brief)
  assert.match(md, /\*\*Do this first:\*\* \*\*\[Acme — Strategy Analyst\]\(https:\/\/a\.io\/1\)\*\*/)
})

/* ───── warmPathItems — untouched warm referral paths ────────────────────────*/

const warmOpps = [
  {
    company: 'Vandelay',
    play: 'warm-direct',
    target: { name: 'Dana Fox', title: 'Head of Strategy', leverage: 'manager', warmth: 3.9, degree: 1, via: null },
    topRole: { role: 'Strategy Analyst', score: 8.7, match: 9.1, ease: 8.3, scoreLabel: 'M9.1 · E8.3', source: 'application' },
    reason: 'Dana Fox is your warmest untouched path in (strong tie, manager).',
    channel: 'Direct message / email',
    cautions: [],
    counts: { paths: 2, untouched: 1 },
  },
  {
    company: 'Globex',
    play: 'warm-intro',
    target: { name: 'Kim Osei', title: 'Ops Manager', leverage: 'peer', warmth: 1.2, degree: 2, via: 'Dana Fox' },
    topRole: { role: 'Ops Associate', score: 6.27, match: 7.0, ease: 5.62, scoreLabel: 'M7 · E5.62', source: 'scouting' },
    reason: 'Kim Osei is a 2nd-degree path.',
    channel: 'Ask Dana Fox for the introduction',
    cautions: ['Cold thread — do not re-touch: Raj Patel.'],
    counts: { paths: 2, untouched: 1 },
  },
  {
    company: 'Initech',
    play: 'warm-direct',
    target: { name: 'Ana Ruiz', title: null, leverage: 'neutral', warmth: 2.0, degree: 1, via: null },
    topRole: { role: 'Analyst', score: 0, match: null, ease: null, scoreLabel: '', source: 'scouting' },
    reason: 'x',
    channel: 'y',
    cautions: [],
    counts: { paths: 1, untouched: 1 },
  },
]

test('warmPathItems: warm-direct says who to message; warm-intro names the bridge', () => {
  const items = warmPathItems(warmOpps)
  assert.equal(items.length, 3)
  assert.equal(items[0].label, 'Vandelay — Strategy Analyst')
  assert.match(items[0].sub, /Message Dana Fox \(Head of Strategy\) directly — untouched 1st-degree tie/)
  assert.match(items[0].sub, /· M9\.1 · E8\.3 ★★ role$/) // go → double star
  assert.equal(items[0].meta.kind, 'warm-direct')
  assert.equal(items[0].meta.rolePriority, 8.7)
  assert.equal(items[0].meta.roleVerdict, 'go')
  assert.equal(items[0].meta.roleScoreLabel, 'M9.1 · E8.3')
  assert.match(items[1].sub, /· M7 · E5\.62 role$/) // thin → no stars
  assert.equal(items[1].meta.roleVerdict, 'thin')
  assert.match(items[1].sub, /Ask Dana Fox for an intro to Kim Osei \(Ops Manager\) — 2nd-degree bridge/)
  assert.equal(items[1].meta.via, 'Dana Fox')
  assert.deepEqual(items[1].meta.cautions, ['Cold thread — do not re-touch: Raj Patel.'])
})

test('warmPathItems: unscored role gets no score suffix; input order is preserved; cap applies', () => {
  const items = warmPathItems(warmOpps)
  assert.equal(items[2].label, 'Initech — Analyst')
  assert.doesNotMatch(items[2].sub, / role$/)
  assert.equal(items[2].meta.rolePriority, null)
  const capped = warmPathItems(warmOpps, { maxWarmPaths: 1 })
  assert.equal(capped.length, 1)
  assert.equal(capped[0].meta.contact, 'Dana Fox')
})

test('warmPathItems tolerates null/empty input', () => {
  assert.deepEqual(warmPathItems(null), [])
  assert.deepEqual(warmPathItems([]), [])
})

test('globalPriority: warm paths sit in the 4xx band — after any nudge, before any fresh posting', () => {
  const warm = globalPriority('warmpaths', { meta: { rolePriority: 8.7 } })
  assert.ok(warm >= 400 && warm < 500)
  // Even a just-due nudge (0d overdue → worst outreach priority) beats a warm path…
  assert.ok(globalPriority('outreach', { meta: { daysSince: 0 } }) < warm)
  // …and even a perfect-score fresh posting loses to any warm path.
  assert.ok(warm < globalPriority('newhits', { meta: { kind: 'prioritize', verdict: 'go', priority: 10 } }))
  // Higher target-role Priority → earlier within the band.
  assert.ok(warm < globalPriority('warmpaths', { meta: { rolePriority: 6.0 } }))
})

test('assembleBrief folds warm paths in; a due nudge still wins the top action', () => {
  const brief = assembleBrief({
    warmOutreach: warmOpps,
    outreachResult: { entries: [{ company: 'Acme', role: 'PM', contact: 'Jo', channel: 'Email', action: 'nudge', daysSince: 6, reason: 'No reply yet' }] },
  }, { asOf: '2026-07-02' })
  assert.equal(brief.counts.warmpaths, 3)
  assert.equal(brief.topAction.section, 'outreach')
  const md = renderBrief(brief)
  assert.match(md, /## Warm outreach paths/)
  assert.match(md, /\*\*Vandelay — Strategy Analyst\*\* — Message Dana Fox/)
  // Section order: nudges render before warm paths.
  assert.ok(md.indexOf('## Outreach nudges due') < md.indexOf('## Warm outreach paths'))
})

test('a warm path becomes the top action when only opportunities exist', () => {
  const brief = assembleBrief({
    warmOutreach: warmOpps,
    digest: { items: [{}], prioritize: [{ company: 'X', title: 'Analyst', match: 9.9, ease: 9.9, verdict: 'go' }], needsEval: [] },
    triage: [{ url: 'https://a.io/1', company: 'Acme', title: 'Analyst', triageScore: 9.0, triageReasons: [], bucket: 'deep-eval' }],
  }, { asOf: '2026-07-02' })
  assert.equal(brief.topAction.section, 'warmpaths')
  assert.equal(brief.topAction.item.meta.contact, 'Dana Fox')
  const md = renderBrief(brief)
  assert.match(md, /\*\*Do this first:\*\* \*\*Vandelay — Strategy Analyst\*\* — Message Dana Fox/)
})

/* ───── countFreshScanRows (cross-profile "new this week" helper) ─────────────*/

const SCAN_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates'

test('countFreshScanRows counts rows first_seen within the trailing 7 days', () => {
  const tsv = [
    SCAN_HEADER,
    'https://a.io/1\t2026-07-07\tgh\tAnalyst\tAcme\tCPH\tadded\t2026-07-07', // today (0d)
    'https://a.io/2\t2026-07-01\tgh\tPM\tAcme\tCPH\tadded\t2026-07-01',      // 6d old — in
    'https://a.io/3\t2026-06-30\tgh\tEng\tAcme\tCPH\tadded\t2026-06-30',     // 7d old — OUT
    'https://a.io/4\t2026-05-01\tgh\tOps\tAcme\tCPH\tadded\t2026-05-01',     // old — OUT
  ].join('\n')
  assert.equal(countFreshScanRows(tsv, '2026-07-07'), 2)
})

test('countFreshScanRows boundary: exactly 7 days old is excluded, 6 included', () => {
  const tsv = [
    SCAN_HEADER,
    'https://a.io/a\t2026-07-01\tgh\tt\tC\tX\tadded\t2026-07-01', // 6d → in
    'https://a.io/b\t2026-06-30\tgh\tt\tC\tX\tadded\t2026-06-30', // 7d → out
  ].join('\n')
  assert.equal(countFreshScanRows(tsv, '2026-07-07'), 1)
})

test('countFreshScanRows skips the header row and never counts it as a date', () => {
  // Header-only file → 0 (no data rows, header not miscounted).
  assert.equal(countFreshScanRows(SCAN_HEADER + '\n', '2026-07-07'), 0)
})

test('countFreshScanRows tolerates empty input, malformed dates, and future dates', () => {
  assert.equal(countFreshScanRows('', '2026-07-07'), 0)
  assert.equal(countFreshScanRows('   ', '2026-07-07'), 0)
  const tsv = [
    SCAN_HEADER,
    'https://a.io/x\tnot-a-date\tgh\tt\tC\tX\tadded\t', // malformed → skipped
    'https://a.io/y\t\tgh\tt\tC\tX\tadded\t',           // blank first_seen → skipped
    'https://a.io/z\t2026-07-10\tgh\tt\tC\tX\tadded\t', // future → skipped
    'https://a.io/w\t2026-07-05\tgh\tt\tC\tX\tadded\t', // 2d → counted
  ].join('\n')
  assert.equal(countFreshScanRows(tsv, '2026-07-07'), 1)
})

test('countFreshScanRows returns 0 for an invalid today', () => {
  const tsv = SCAN_HEADER + '\nhttps://a.io/1\t2026-07-07\tgh\tt\tC\tX\tadded\t'
  assert.equal(countFreshScanRows(tsv, 'nope'), 0)
})

/* ───── buildCrossProfileSection (the "Other searches" footer) ───────────────*/

test('buildCrossProfileSection renders one line per profile with all three metrics', () => {
  const lines = buildCrossProfileSection([
    { slug: 'cph-student', label: 'Copenhagen student', pendingInbox: 12, urgentDeadlines: 2, freshThisWeek: 5 },
  ])
  assert.equal(lines[0], '## Other searches')
  const bullet = lines.find((l) => l.startsWith('- '))
  assert.equal(
    bullet,
    '- **cph-student** (Copenhagen student): 12 in inbox · 2 urgent deadlines · 5 new this week — switch: `npm run profile -- switch cph-student`'
  )
})

test('buildCrossProfileSection omits each metric when zero', () => {
  const lines = buildCrossProfileSection([
    { slug: 'a', label: 'A', pendingInbox: 3, urgentDeadlines: 0, freshThisWeek: 0 },
    { slug: 'b', label: 'B', pendingInbox: 0, urgentDeadlines: 1, freshThisWeek: 0 },
    { slug: 'c', label: 'C', pendingInbox: 0, urgentDeadlines: 0, freshThisWeek: 4 },
  ])
  assert.match(lines[2], /\*\*a\*\* \(A\): 3 in inbox — switch:/)
  assert.match(lines[3], /\*\*b\*\* \(B\): 1 urgent deadline — switch:/) // singular
  assert.match(lines[4], /\*\*c\*\* \(C\): 4 new this week — switch:/)
})

test('buildCrossProfileSection renders quiet when all three metrics are zero', () => {
  const lines = buildCrossProfileSection([
    { slug: 'quietone', label: 'Quiet', pendingInbox: 0, urgentDeadlines: 0, freshThisWeek: 0 },
  ])
  assert.match(lines[2], /- \*\*quietone\*\* \(Quiet\): quiet — switch: `npm run profile -- switch quietone`/)
})

test('buildCrossProfileSection drops the label parens when label equals slug or is missing', () => {
  const lines = buildCrossProfileSection([
    { slug: 'career', pendingInbox: 1 },
    { slug: 'same', label: 'same', freshThisWeek: 2 },
  ])
  assert.match(lines[2], /- \*\*career\*\*: 1 in inbox — switch:/)
  assert.match(lines[3], /- \*\*same\*\*: 2 new this week — switch:/)
})

test('buildCrossProfileSection returns [] for fewer than one summary / bad input', () => {
  assert.deepEqual(buildCrossProfileSection([]), [])
  assert.deepEqual(buildCrossProfileSection(null), [])
  assert.deepEqual(buildCrossProfileSection(undefined), [])
})

/* ───── Cross-profile footer wiring through assembleBrief + renderBrief ──────*/

test('assembleBrief passes crossProfile through; renderBrief appends the footer before the provenance line', () => {
  const brief = assembleBrief(
    { crossProfile: [{ slug: 'cph-student', label: 'Copenhagen student', pendingInbox: 12, urgentDeadlines: 2, freshThisWeek: 5 }] },
    { asOf: '2026-07-07' }
  )
  assert.equal(brief.crossProfile.length, 1)
  const md = renderBrief(brief)
  assert.match(md, /## Other searches/)
  assert.match(md, /- \*\*cph-student\*\* \(Copenhagen student\): 12 in inbox · 2 urgent deadlines · 5 new this week/)
  // The footer sits ABOVE the provenance/---, so a cron'd copy reads sensibly.
  assert.ok(md.indexOf('## Other searches') < md.lastIndexOf('---'))
})

test('renderBrief omits the Other searches footer entirely on a single-profile/pre-migration brief', () => {
  // No crossProfile input → assembleBrief defaults it to [] → footer absent.
  const brief = assembleBrief({}, { asOf: '2026-07-07' })
  assert.deepEqual(brief.crossProfile, [])
  const md = renderBrief(brief)
  assert.doesNotMatch(md, /## Other searches/)
})

test('renderBrief output is byte-identical with crossProfile:[] vs crossProfile omitted', () => {
  const a = renderBrief(assembleBrief({}, { asOf: '2026-07-07' }))
  const b = renderBrief(assembleBrief({ crossProfile: [] }, { asOf: '2026-07-07' }))
  assert.equal(a, b)
})

/* ───── pipeline inbox count — single source of truth (F2/F5) ────────────────
 * daily-brief.mjs once counted the pipeline inbox with a bespoke regex that
 * required the URL immediately after the bullet, so it matched ZERO real
 * scanner lines (`- [ ] url | Co | Title | relevance …`) and the "N URLs in
 * pipeline inbox" clause silently never rendered — while the cross-profile
 * footer used the correct countPendingPipelineLines. Both must now derive from
 * that one counter. These tests pin (a) the counter's behavior on real line
 * shapes and (b) that daily-brief.mjs no longer carries a rival URL-count regex.
 */

const REAL_PIPELINE = [
  '# Pipeline — Pending Evaluations',
  '',
  '## Pending',
  '',
  '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Analyst | relevance 4.5 — fresh',
  '- [ ] https://jobs.lever.co/globex/x1 | Globex | Ops Associate',
  '- [x] https://boards.greenhouse.io/acme/jobs/2 | Acme | Analyst II | relevance 6.0 — fresh',
  '- [ ] not a url line',
  'https://bare.example/no-checkbox',
].join('\n')

test('countPendingPipelineLines counts real scanner lines (checkbox + pipes), excludes checked-off', () => {
  // Two unchecked scanner lines with pipes + a relevance tail are counted; the
  // `- [x]` history line, the prose line, and the bare no-checkbox URL are not
  // (the counter requires an unchecked `- [ ] http…` bullet).
  assert.equal(countPendingPipelineLines(REAL_PIPELINE), 2)
})

test('the daily brief derives inboxCount from the shared counter — no rival URL regex', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'daily-brief.mjs'), 'utf8')
  // getPipelineHealth must call the shared counter for the inbox number …
  assert.match(src, /inboxCount\s*=\s*existsSync\(PIPELINE_FILE\)\s*\?\s*countPendingPipelineLines/)
  // … and must NOT re-count URLs with its own bullet-anchored regex anymore
  // (that bespoke `^[-*]\s+https?://` pattern was the F2 bug).
  assert.doesNotMatch(src, /\^\[-\*\]\\s\+https\?/)
})

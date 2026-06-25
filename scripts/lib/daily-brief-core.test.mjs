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
import {
  followupItems,
  outreachItems,
  newHitItems,
  insightItems,
  deadlineItems,
  buildPipelineHealthSummary,
  assembleBrief,
  renderBrief,
  buildBriefMarkdown,
  SECTION_ORDER,
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

test('newHitItems takes prioritize (scored) before needs-eval, scored sorted by overall desc', () => {
  const digest = digestStub({
    prioritize: [
      { company: 'A', title: 'Analyst', overall: 7.4, band: 'solid', location: 'Madrid', url: 'https://a.test/1', ageDays: 1 },
      { company: 'B', title: 'Strategist', overall: 8.9, band: 'strong', location: 'Berlin', url: 'https://b.test/2', ageDays: 0 },
    ],
    needsEval: [
      { company: 'C', title: 'PM', location: 'Paris', url: 'https://c.test/3', ageDays: 2 },
    ],
  })
  const items = newHitItems(digest)
  assert.equal(items.length, 3)
  assert.equal(items[0].label, 'B — Strategist') // 8.9 first
  assert.equal(items[1].label, 'A — Analyst')
  assert.equal(items[2].meta.kind, 'needs-eval') // unscored last
  assert.match(items[0].sub, /8\.9\/10 ★★/) // strong → double star
  assert.match(items[2].sub, /Unscored/)
})

test('newHitItems respects the maxPrioritize / maxNeedsEval caps', () => {
  const digest = digestStub({
    prioritize: Array.from({ length: 12 }, (_, i) => ({ company: `P${i}`, title: 't', overall: 7 + i / 100, band: 'solid' })),
    needsEval: Array.from({ length: 9 }, (_, i) => ({ company: `N${i}`, title: 't' })),
  })
  const items = newHitItems(digest, { maxPrioritize: 3, maxNeedsEval: 2 })
  assert.equal(items.filter((i) => i.meta.kind === 'prioritize').length, 3)
  assert.equal(items.filter((i) => i.meta.kind === 'needs-eval').length, 2)
})

test('newHitItems tolerates null/empty digest', () => {
  assert.deepEqual(newHitItems(null), [])
  assert.deepEqual(newHitItems(digestStub()), [])
})

/* ───── insightItems ────────────────────────────────────────────────────────*/

test('insightItems renders the systemic constraint + cheapest lever', () => {
  const intel = {
    systemicConstraint: {
      dominant: { dimension: 'ease_of_entry', label: 'Ease of Entry', archetypes: ['Strategy', 'Ops', 'Finance', 'Product'], count: 4 },
      lever: { dimension: 'ease_of_entry', label: 'Ease of Entry', count: 3, avgLift: 1.2 },
    },
  }
  const items = insightItems(intel)
  assert.equal(items.length, 1)
  assert.match(items[0].label, /Ease of Entry is your systemic blocker/)
  assert.match(items[0].sub, /binding constraint across 4 archetype/)
  assert.match(items[0].sub, /\+2 more/) // 4 archetypes → "Strategy, Ops +2 more"
  assert.match(items[0].sub, /lift Ease of Entry/)
})

test('insightItems falls back to strongest archetype when nothing binds', () => {
  const intel = {
    systemicConstraint: { dominant: null, tally: [], lever: null },
    fingerprints: [{ archetype: 'Strategy', avgOverall: 7.82 }, { archetype: 'Ops', avgOverall: 6.1 }],
  }
  const items = insightItems(intel)
  assert.equal(items.length, 1)
  assert.match(items[0].label, /lean into Strategy/)
  assert.match(items[0].sub, /7\.8\/10/)
})

test('insightItems returns empty on error/empty intel', () => {
  assert.deepEqual(insightItems(null), [])
  assert.deepEqual(insightItems({ error: 'no scores' }), [])
  assert.deepEqual(insightItems({ systemicConstraint: { dominant: null }, fingerprints: [] }), [])
})

/* ───── assembleBrief ───────────────────────────────────────────────────────*/

test('assembleBrief orders sections, counts actions, and picks the top action', () => {
  const inputs = {
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', overall: 8.0, band: 'solid', url: 'https://x.test/1' }] }),
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
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', overall: 8.0, band: 'solid' }] }),
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
    digest: digestStub({ prioritize: [{ company: 'X', title: 'Analyst', overall: 8.2, band: 'solid', location: 'Madrid', url: 'https://x.test/1', ageDays: 1 }] }),
    followupResult: { entries: [{ company: 'Acme', role: 'PM', status: 'overdue' === 'overdue' ? 'applied' : '', urgency: 'overdue', daysSinceApplication: 12, followupCount: 1, contacts: [] }] },
    outreachResult: { entries: [] },
    positioningIntel: { systemicConstraint: { dominant: { dimension: 'd', label: 'Ease of Entry', archetypes: ['A', 'B'], count: 2 }, lever: { label: 'Ease of Entry', count: 2, avgLift: 1.0 } } },
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
  assert.match(md, /Ease of Entry is your systemic blocker/)
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
    urgent: [{ source: 'applications', num: 1, company: 'Revolut', role: 'Analyst', status: 'Applied', deadline: '2026-06-26', parsed: { kind: 'date' }, daysLeft: 1 }],
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
    prioritize: [{ company: 'Stripe', title: 'PM', overall: 8.5, band: 'strong', url: 'https://stripe.test/jobs/1' }],
  })
  const brief = assembleBrief(
    { digest, followupResult: { entries: [] }, outreachResult: { entries: [] } },
    { asOf: '2026-06-25' },
  )
  const md = renderBrief(brief)
  assert.match(md, /\[Stripe — PM\]\(https:\/\/stripe\.test\/jobs\/1\)/)
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

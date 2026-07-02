import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBriefJson,
  buildBriefDisplay,
  briefItemTarget,
  briefTargetLabel,
  briefLabelCompany,
  type DailyBrief,
  type BriefItem,
} from './dailyBrief'

// ─── Fixtures (fictional companies/roles only) ────────────────────────────────

function item(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    key: 'aurora labs|strategy analyst',
    label: 'Aurora Labs — Strategy Analyst',
    sub: 'Follow up — Applied, 12d since applied, 0 sent',
    urgency: 1,
    sortKey: 12,
    meta: {},
    ...overrides,
  }
}

function briefJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    asOf: '2026-03-14',
    period: 'daily',
    sections: [
      { id: 'followups', title: 'Follow-ups due', kind: 'action', items: [] },
      { id: 'deadlines', title: 'Deadlines closing soon', kind: 'action', items: [] },
      { id: 'outreach', title: 'Outreach nudges due', kind: 'action', items: [] },
      { id: 'warmpaths', title: 'Warm outreach paths', kind: 'action', items: [] },
      { id: 'newhits', title: 'Fresh high-fit postings', kind: 'action', items: [] },
      { id: 'triage', title: 'Deep-eval next (inbox triage)', kind: 'action', items: [] },
      { id: 'headsup', title: 'Heads-up from your outcomes', kind: 'insight', items: [] },
      { id: 'insight', title: 'Standing positioning note', kind: 'insight', items: [] },
    ],
    counts: {},
    totalActions: 0,
    topAction: null,
    pipelineHealth: null,
    ...overrides,
  })
}

// ─── parseBriefJson ───────────────────────────────────────────────────────────

test('parseBriefJson: null/empty/garbage input → null', () => {
  assert.equal(parseBriefJson(null), null)
  assert.equal(parseBriefJson(undefined), null)
  assert.equal(parseBriefJson(''), null)
  assert.equal(parseBriefJson('not json {'), null)
  assert.equal(parseBriefJson('"just a string"'), null)
  assert.equal(parseBriefJson('{"no":"sections"}'), null)
})

test('parseBriefJson: parses a well-formed brief', () => {
  const brief = parseBriefJson(briefJson({
    totalActions: 1,
    sections: [
      {
        id: 'followups', title: 'Follow-ups due', kind: 'action',
        items: [item()],
      },
    ],
    topAction: { section: 'followups', sectionTitle: 'Follow-ups due', item: item() },
    pipelineHealth: { active: 2, evaluated: 5, inboxCount: 9 },
  }))
  assert.ok(brief)
  assert.equal(brief.asOf, '2026-03-14')
  assert.equal(brief.period, 'daily')
  assert.equal(brief.totalActions, 1)
  assert.equal(brief.sections.length, 1)
  assert.equal(brief.sections[0].items[0].label, 'Aurora Labs — Strategy Analyst')
  assert.equal(brief.topAction?.section, 'followups')
  assert.deepEqual(brief.pipelineHealth, { active: 2, evaluated: 5, inboxCount: 9 })
})

test('parseBriefJson: drops malformed items but keeps valid ones', () => {
  const brief = parseBriefJson(briefJson({
    sections: [
      {
        id: 'newhits', title: 'Fresh high-fit postings', kind: 'action',
        items: [
          { label: '' },              // empty label → dropped
          'not an object',            // → dropped
          { label: 'Nordwind GmbH — Ops Associate' }, // minimal valid
        ],
      },
    ],
  }))
  assert.ok(brief)
  assert.equal(brief.sections[0].items.length, 1)
  const it = brief.sections[0].items[0]
  assert.equal(it.label, 'Nordwind GmbH — Ops Associate')
  assert.equal(it.key, 'Nordwind GmbH — Ops Associate') // key falls back to label
  assert.equal(it.sub, '')
  assert.deepEqual(it.meta, {})
})

test('parseBriefJson: malformed topAction/pipelineHealth degrade to null', () => {
  const brief = parseBriefJson(briefJson({
    topAction: { section: 42, item: { nope: true } },
    pipelineHealth: 'broken',
  }))
  assert.ok(brief)
  assert.equal(brief.topAction, null)
  assert.equal(brief.pipelineHealth, null)
})

// ─── buildBriefDisplay ────────────────────────────────────────────────────────

function makeBrief(overrides: Partial<DailyBrief> = {}): DailyBrief {
  return {
    asOf: '2026-03-14',
    period: 'daily',
    sections: [],
    counts: {},
    totalActions: 0,
    topAction: null,
    pipelineHealth: null,
    ...overrides,
  }
}

test('buildBriefDisplay: empty brief → isEmpty', () => {
  const d = buildBriefDisplay(makeBrief())
  assert.equal(d.isEmpty, true)
  assert.equal(d.sections.length, 0)
  assert.equal(d.insights.length, 0)
  assert.equal(d.topAction, null)
})

test('buildBriefDisplay: drops empty sections, keeps ranked order, trims with hiddenCount', () => {
  const items = ['A', 'B', 'C', 'D', 'E'].map(n => item({
    key: `co-${n}|role`, label: `Company ${n} — Role`,
  }))
  const d = buildBriefDisplay(makeBrief({
    totalActions: 5,
    sections: [
      { id: 'followups', title: 'Follow-ups due', kind: 'action', items: [] },
      { id: 'newhits', title: 'Fresh high-fit postings', kind: 'action', items },
    ],
  }), { maxPerSection: 3 })
  assert.equal(d.isEmpty, false)
  assert.equal(d.sections.length, 1)
  assert.equal(d.sections[0].id, 'newhits')
  assert.deepEqual(d.sections[0].items.map(i => i.label),
    ['Company A — Role', 'Company B — Role', 'Company C — Role'])
  assert.equal(d.sections[0].hiddenCount, 2)
})

test('buildBriefDisplay: top action is lifted out of its section (never shown twice)', () => {
  const top = item({ key: 'top-co|role', label: 'Top Co — Role' })
  const other = item({ key: 'other-co|role', label: 'Other Co — Role' })
  const d = buildBriefDisplay(makeBrief({
    totalActions: 2,
    topAction: { section: 'deadlines', sectionTitle: 'Deadlines closing soon', item: top },
    sections: [
      { id: 'deadlines', title: 'Deadlines closing soon', kind: 'action', items: [top, other] },
    ],
  }))
  assert.equal(d.topAction?.item.key, 'top-co|role')
  assert.equal(d.sections.length, 1)
  assert.deepEqual(d.sections[0].items.map(i => i.key), ['other-co|role'])
})

test('buildBriefDisplay: section that only held the top action disappears', () => {
  const top = item({ key: 'solo-co|role', label: 'Solo Co — Role' })
  const d = buildBriefDisplay(makeBrief({
    totalActions: 1,
    topAction: { section: 'followups', sectionTitle: 'Follow-ups due', item: top },
    sections: [
      { id: 'followups', title: 'Follow-ups due', kind: 'action', items: [top] },
    ],
  }))
  assert.equal(d.topAction?.item.key, 'solo-co|role')
  assert.equal(d.sections.length, 0)
  assert.equal(d.isEmpty, false) // the top action alone is real content
})

test('buildBriefDisplay: insight sections flatten into insights, not sections', () => {
  const note = item({
    key: 'insight|skills', label: 'Targeting: lean into Ops archetypes',
    sub: 'Your strongest-scoring archetype — concentrate sourcing there.',
  })
  const d = buildBriefDisplay(makeBrief({
    sections: [
      { id: 'insight', title: 'Standing positioning note', kind: 'insight', items: [note] },
    ],
  }))
  assert.equal(d.sections.length, 0)
  assert.equal(d.insights.length, 1)
  assert.equal(d.insights[0].sectionId, 'insight')
  assert.equal(d.isEmpty, false)
})

// ─── briefItemTarget / labels ─────────────────────────────────────────────────

test('briefItemTarget: items with a listing URL open externally', () => {
  const it = item({ meta: { url: 'https://jobs.example.com/postings/123' } })
  assert.deepEqual(briefItemTarget('newhits', it),
    { type: 'url', url: 'https://jobs.example.com/postings/123' })
  assert.deepEqual(briefItemTarget('triage', it),
    { type: 'url', url: 'https://jobs.example.com/postings/123' })
  // A URL wins regardless of section
  assert.deepEqual(briefItemTarget('followups', it),
    { type: 'url', url: 'https://jobs.example.com/postings/123' })
})

test('briefItemTarget: non-http url meta is ignored', () => {
  const it = item({ meta: { url: 'local:jds/some-file.md' } })
  assert.deepEqual(briefItemTarget('followups', it), { type: 'view', view: 'applying' })
})

test('briefItemTarget: section-based navigation fallbacks', () => {
  assert.deepEqual(briefItemTarget('followups', item()), { type: 'view', view: 'applying' })
  assert.deepEqual(
    briefItemTarget('deadlines', item({ meta: { source: 'applications' } })),
    { type: 'view', view: 'applying' })
  assert.deepEqual(
    briefItemTarget('deadlines', item({ label: 'Borealis AG — Analyst', meta: { source: 'scouting' } })),
    { type: 'view', view: 'database', filter: 'Borealis AG' })
  assert.deepEqual(briefItemTarget('outreach', item()), { type: 'view', view: 'outreach' })
  assert.deepEqual(briefItemTarget('warmpaths', item()), { type: 'view', view: 'outreach' })
  assert.equal(briefItemTarget('newhits', item()), null) // no URL → nowhere cheap
  assert.equal(briefItemTarget('insight', item()), null)
  assert.equal(briefItemTarget('headsup', item()), null)
})

test('briefLabelCompany + briefTargetLabel', () => {
  assert.equal(briefLabelCompany('Aurora Labs — Strategy Analyst'), 'Aurora Labs')
  assert.equal(briefLabelCompany('SoloName'), 'SoloName')
  assert.equal(briefTargetLabel({ type: 'url', url: 'https://x.example' }), 'Open listing')
  assert.equal(briefTargetLabel({ type: 'view', view: 'applying' }), 'Open Applying')
  assert.equal(briefTargetLabel({ type: 'view', view: 'outreach' }), 'Open Outreach')
  assert.equal(briefTargetLabel({ type: 'view', view: 'database' }), 'Open Database')
  assert.equal(briefTargetLabel(null), null)
})

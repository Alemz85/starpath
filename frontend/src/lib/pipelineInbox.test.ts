import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inboxSource,
  classifyInboxItem,
  buildInbox,
  inboxStats,
  groupInboxBySource,
  evaluateInboxCommand,
  inboxSpawnId,
  type InboxItem,
} from '@/lib/pipelineInbox'
import { makeApplication, makeScoutingEntry } from '@/test-utils/fixtures'
import type { PipelineUrl } from '@/types'

function url(u: string, over: Partial<PipelineUrl> = {}): PipelineUrl {
  return { url: u, isStale: false, ...over }
}

// ─── inboxSource ──────────────────────────────────────────────────────────────

test('inboxSource collapses ATS subdomains to the registrable domain', () => {
  assert.equal(inboxSource('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse.io')
  assert.equal(inboxSource('https://jobs.ashbyhq.com/acme/role'), 'ashbyhq.com')
  assert.equal(inboxSource('https://www.lever.co/acme'), 'lever.co')
})

test('inboxSource keeps a plain two-label host as-is', () => {
  assert.equal(inboxSource('https://example.com/careers'), 'example.com')
})

test('inboxSource returns empty string for an unparseable URL', () => {
  assert.equal(inboxSource('not a url'), '')
})

// ─── classifyInboxItem ────────────────────────────────────────────────────────

const none = () => new Set<string>()

test('classifyInboxItem flags a malformed line as invalid', () => {
  const item = classifyInboxItem(url('local:jds/foo.md'), none(), none())
  assert.equal(item.reason, 'invalid')
  assert.equal(item.companyHint, null)
  assert.equal(item.source, '')
})

test('classifyInboxItem marks a fresh unknown URL as new', () => {
  const item = classifyInboxItem(url('https://boards.greenhouse.io/acme/jobs/1'), none(), none())
  assert.equal(item.reason, 'new')
  assert.equal(item.companyHint, 'Acme')
  assert.equal(item.source, 'greenhouse.io')
})

test('classifyInboxItem marks a URL whose company we already know as known', () => {
  // The known set holds normalized company keys (lowercased, role-stripped).
  const known = new Set(['acme'])
  const item = classifyInboxItem(url('https://boards.greenhouse.io/acme/jobs/1'), known, none())
  assert.equal(item.reason, 'known')
})

test('classifyInboxItem carries through stale + addedDate', () => {
  const item = classifyInboxItem(
    url('https://jobs.ashbyhq.com/acme/x', { isStale: true, addedDate: '2026-01-02' }),
    none(), none(),
  )
  assert.equal(item.isStale, true)
  assert.equal(item.addedDate, '2026-01-02')
})

test('classifyInboxItem prefers the scanner-parsed company over the URL hint', () => {
  const item = classifyInboxItem(
    url('https://careers.example-jobs.dev/12345', { company: 'Acme GmbH', title: 'Data Analyst' }),
    none(), none(),
  )
  assert.equal(item.companyHint, 'Acme GmbH')
  assert.equal(item.title, 'Data Analyst')
})

test('classifyInboxItem seeds triageScore from scan relevance with a reasons trail', () => {
  const item = classifyInboxItem(
    url('https://lever.co/acme/x', { relevance: 4.5, relevanceNote: 'fresh' }),
    none(), none(),
  )
  assert.equal(item.triageScore, 4.5)
  assert.match(item.scoreReasons.join(' '), /scan relevance 4\.5/)
  // Manual adds (no relevance) start at 0 with an explanatory reason.
  const manual = classifyInboxItem(url('https://lever.co/acme/y'), none(), none())
  assert.equal(manual.triageScore, 0)
  assert.match(manual.scoreReasons.join(' '), /no scan relevance/)
})

test('classifyInboxItem demotes senior titles and nudges entry-level ones', () => {
  const senior = classifyInboxItem(
    url('https://lever.co/a/x', { title: 'Senior Ops Lead', relevance: 3 }), none(), none())
  assert.equal(senior.triageScore, -1)   // 3 − 4
  const entry = classifyInboxItem(
    url('https://lever.co/a/y', { title: 'Graduate Analyst', relevance: 3 }), none(), none())
  assert.equal(entry.triageScore, 4)     // 3 + 1
})

// ─── buildInbox ───────────────────────────────────────────────────────────────

test('buildInbox derives the known set from applications AND scouting', () => {
  const pending = [
    url('https://boards.greenhouse.io/acme/jobs/1'),    // known via application
    url('https://jobs.ashbyhq.com/globex/role'),        // known via scouting
    url('https://lever.co/initech/x'),                  // genuinely new
  ]
  const out = buildInbox(
    pending,
    [makeApplication({ company: 'Acme' })],
    [makeScoutingEntry({ company: 'Globex' })],
  )
  const byHint = Object.fromEntries(out.map(i => [i.companyHint, i.reason]))
  assert.equal(byHint['Acme'], 'known')
  assert.equal(byHint['Globex'], 'known')
  assert.equal(byHint['Initech'], 'new')
})

test('buildInbox orders by triage score, invalid always last', () => {
  const pending = [
    url('bad-line'),                                        // invalid → last
    url('https://lever.co/known-co/x'),                     // known (−1)
    url('https://lever.co/fresh-co/y'),                     // new (0)
    url('https://lever.co/stale-co/z', { isStale: true }),  // stale new (−2)
  ]
  const out = buildInbox(pending, [makeApplication({ company: 'Known Co' })], [])
  // Score rule: fresh-new 0 > known −1 > stale-new −2 > invalid (pinned last).
  // A stale posting is likely closed, so it now sinks below a live known one.
  assert.equal(out[0].companyHint, 'Fresh Co')
  assert.equal(out[1].companyHint, 'Known Co')
  assert.equal(out[2].companyHint, 'Stale Co')
  assert.equal(out[3].reason, 'invalid')
})

test('buildInbox lets scan relevance outrank category demotions', () => {
  const pending = [
    url('https://lever.co/fresh-co/y'),                                      // new, no relevance → 0
    url('https://lever.co/known-co/x', { relevance: 5.0 }),                  // known → 5 − 1 = 4
  ]
  const out = buildInbox(pending, [makeApplication({ company: 'Known Co' })], [])
  assert.equal(out[0].companyHint, 'Known Co')   // strong scan signal wins
  assert.equal(out[0].triageScore, 4)
})

test('buildInbox demotes an exact (company, role) repost as evaluated', () => {
  const pending = [
    url('https://lever.co/acme/repost', { company: 'Acme', title: 'Strategy Analyst', relevance: 4 }),
    url('https://lever.co/acme/new-role', { company: 'Acme', title: 'Data Analyst', relevance: 1 }),
  ]
  const out = buildInbox(
    pending,
    [],
    [makeScoutingEntry({ company: 'Acme', role: 'Strategy Analyst' })],
  )
  // Exact repost: 4 − 5 = −1; same company, different role: 1 − 1 = 0.
  assert.equal(out[0].title, 'Data Analyst')
  assert.equal(out[0].reason, 'known')
  assert.equal(out[1].title, 'Strategy Analyst')
  assert.equal(out[1].reason, 'evaluated')
})

test('buildInbox is a stable sort within a priority bucket', () => {
  const pending = [
    url('https://lever.co/alpha/x'),
    url('https://lever.co/bravo/y'),
    url('https://lever.co/charlie/z'),
  ]
  const out = buildInbox(pending, [], [])
  assert.deepEqual(out.map(i => i.companyHint), ['Alpha', 'Bravo', 'Charlie'])
})

// ─── inboxStats ───────────────────────────────────────────────────────────────

test('inboxStats counts fresh excluding stale-new, folding evaluated into known', () => {
  const mk = (over: Partial<InboxItem>): InboxItem => ({
    url: 'u', companyHint: 'X', source: 's', isStale: false, reason: 'new',
    triageScore: 0, scoreReasons: [], ...over,
  })
  const items: InboxItem[] = [
    mk({ url: 'a' }),
    mk({ url: 'b', isStale: true }),
    mk({ url: 'c', reason: 'known' }),
    mk({ url: 'e', reason: 'evaluated' }),
    mk({ url: 'd', companyHint: null, source: '', reason: 'invalid' }),
  ]
  const stats = inboxStats(items)
  assert.equal(stats.total, 5)
  assert.equal(stats.fresh, 1)    // only the non-stale 'new'
  assert.equal(stats.known, 2)    // 'known' + 'evaluated'
  assert.equal(stats.stale, 1)
  assert.equal(stats.invalid, 1)
})

test('inboxStats on an empty queue is all zeros', () => {
  assert.deepEqual(inboxStats([]), { total: 0, fresh: 0, known: 0, stale: 0, invalid: 0 })
})

// ─── groupInboxBySource ───────────────────────────────────────────────────────

test('groupInboxBySource buckets by host, preserving first-seen order', () => {
  const items = buildInbox(
    [
      url('https://lever.co/a/x'),
      url('https://boards.greenhouse.io/b/1'),
      url('https://lever.co/c/y'),
    ],
    [], [],
  )
  const groups = groupInboxBySource(items)
  const sources = groups.map(g => g.source)
  assert.ok(sources.includes('lever.co'))
  assert.ok(sources.includes('greenhouse.io'))
  // lever.co holds two items (a, c).
  const lever = groups.find(g => g.source === 'lever.co')!
  assert.equal(lever.items.length, 2)
})

test('groupInboxBySource labels an unparseable URL bucket as (unknown)', () => {
  const items = buildInbox([url('garbage')], [], [])
  const groups = groupInboxBySource(items)
  assert.equal(groups[0].source, '(unknown)')
})

// ─── evaluateInboxCommand + inboxSpawnId ──────────────────────────────────────

test('evaluateInboxCommand embeds the URL and rides the compact eval bundle, not the skill router', () => {
  const cmd = evaluateInboxCommand('https://lever.co/acme/x')
  assert.ok(cmd.includes('https://lever.co/acme/x'))
  // Token-cost lever 3: no /career-ops slash command (which loads CLAUDE.md +
  // modes/* into every worker) — the rubric comes from batch/batch-prompt.md
  // via claudeEvalArgs' --append-system-prompt-file.
  assert.ok(!cmd.includes('/career-ops'))
  assert.ok(cmd.includes('relevance gate'))
  assert.ok(cmd.includes('FILTERED'))
})

test('inboxSpawnId is deterministic + filesystem-safe', () => {
  const a = inboxSpawnId('https://lever.co/acme/x?a=1&b=2')
  const b = inboxSpawnId('https://lever.co/acme/x?a=1&b=2')
  assert.equal(a, b)
  assert.match(a, /^inbox-eval-[a-z0-9-]+$/)
})

test('inboxSpawnId falls back to a stable id for an empty url', () => {
  assert.equal(inboxSpawnId(''), 'inbox-eval-url')
})

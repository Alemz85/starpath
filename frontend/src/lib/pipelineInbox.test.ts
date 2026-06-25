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

test('classifyInboxItem flags a malformed line as invalid', () => {
  const item = classifyInboxItem(url('local:jds/foo.md'), new Set())
  assert.equal(item.reason, 'invalid')
  assert.equal(item.companyHint, null)
  assert.equal(item.source, '')
})

test('classifyInboxItem marks a fresh unknown URL as new', () => {
  const item = classifyInboxItem(url('https://boards.greenhouse.io/acme/jobs/1'), new Set())
  assert.equal(item.reason, 'new')
  assert.equal(item.companyHint, 'Acme')
  assert.equal(item.source, 'greenhouse.io')
})

test('classifyInboxItem marks a URL whose company we already know as known', () => {
  // The known set holds normalized company keys (lowercased, role-stripped).
  const known = new Set(['acme'])
  const item = classifyInboxItem(url('https://boards.greenhouse.io/acme/jobs/1'), known)
  assert.equal(item.reason, 'known')
})

test('classifyInboxItem carries through stale + addedDate', () => {
  const item = classifyInboxItem(
    url('https://jobs.ashbyhq.com/acme/x', { isStale: true, addedDate: '2026-01-02' }),
    new Set(),
  )
  assert.equal(item.isStale, true)
  assert.equal(item.addedDate, '2026-01-02')
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

test('buildInbox orders fresh-new before known before stale before invalid', () => {
  const pending = [
    url('bad-line'),                                     // invalid → last
    url('https://lever.co/known-co/x'),                  // known
    url('https://lever.co/fresh-co/y'),                  // new
    url('https://lever.co/stale-co/z', { isStale: true }), // stale new
  ]
  const out = buildInbox(pending, [makeApplication({ company: 'Known Co' })], [])
  // Half-step rule: fresh-new = 0, stale-new = 0.5, known = 1.0, invalid = 3.
  // So a stale 'new' (0.5) still beats a 'known' (1.0).
  assert.deepEqual(
    out.map(i => i.reason),
    ['new', 'new', 'known', 'invalid'],
  )
  assert.equal(out[0].companyHint, 'Fresh Co')   // fresh new
  assert.equal(out[1].companyHint, 'Stale Co')   // stale new (0.5) beats known (1.0)
  assert.equal(out[2].companyHint, 'Known Co')   // known
  assert.equal(out[3].reason, 'invalid')
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

test('inboxStats counts fresh excluding stale-new', () => {
  const items: InboxItem[] = [
    { url: 'a', companyHint: 'A', source: 's', isStale: false, reason: 'new' },
    { url: 'b', companyHint: 'B', source: 's', isStale: true,  reason: 'new' },
    { url: 'c', companyHint: 'C', source: 's', isStale: false, reason: 'known' },
    { url: 'd', companyHint: null, source: '',  isStale: false, reason: 'invalid' },
  ]
  const stats = inboxStats(items)
  assert.equal(stats.total, 4)
  assert.equal(stats.fresh, 1)    // only the non-stale 'new'
  assert.equal(stats.known, 1)
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

test('evaluateInboxCommand embeds the URL and the pipeline filter mode', () => {
  const cmd = evaluateInboxCommand('https://lever.co/acme/x')
  assert.ok(cmd.includes('https://lever.co/acme/x'))
  assert.ok(cmd.includes('/career-ops pipeline'))
  assert.ok(cmd.includes('FILTER'))
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

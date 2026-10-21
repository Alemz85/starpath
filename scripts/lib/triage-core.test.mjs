import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePendingEntries,
  buildScanIndex,
  buildDedupKeySet,
  scorePendingEntry,
  triagePending,
  renderTriagePlan,
  emitBatchInput,
  BATCH_INPUT_HEADER,
  DEFAULT_WEIGHTS,
  DEFAULT_PER_COMPANY_CAP,
  normalizeBrand,
  buildCompanyBrands,
} from './triage-core.mjs'
import { triageOptsFromConfig } from './triage-config.mjs'

const PIPELINE_MD = `# Pipeline — Pending Evaluations

<!-- run notes -->

## Pending

- [ ] https://boards.greenhouse.io/acme/jobs/123 | Acme | Strategy Analyst | relevance 4.5 — positive phrase, fresh
- [ ] https://jobs.lever.co/globex/abc-def | Globex | Senior Data Lead
- [ ] https://jobs.ashbyhq.com/initech/uuid-1 | Initech | Graduate Business Analyst | relevance 2.0
not a checkbox line
- [x] https://example.com/processed | Done | Done

## Filtered Out
- [ ] https://example.com/should-not-parse | Nope | In Wrong Section

## Processed
`

// ─── parsePendingEntries ─────────────────────────────────────────────────────

test('parses only the Pending section, with and without relevance tails', () => {
  const entries = parsePendingEntries(PIPELINE_MD)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries[0], {
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    company: 'Acme',
    title: 'Strategy Analyst',
    relevanceScore: 4.5,
    relevanceReasons: 'positive phrase, fresh',
    raw: '- [ ] https://boards.greenhouse.io/acme/jobs/123 | Acme | Strategy Analyst | relevance 4.5 — positive phrase, fresh',
  })
  assert.equal(entries[1].relevanceScore, null)
  assert.equal(entries[2].relevanceScore, 2.0)
  assert.equal(entries[2].relevanceReasons, '')
})

test('empty or missing Pending section yields no entries', () => {
  assert.deepEqual(parsePendingEntries('# nothing here'), [])
  assert.deepEqual(parsePendingEntries('## Pending\n\n<!-- empty -->\n\n## Processed\n'), [])
})

// ─── buildScanIndex / buildDedupKeySet ───────────────────────────────────────

test('buildScanIndex keys by canonical URL and tolerates short rows', () => {
  const tsv = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates',
    'https://boards.greenhouse.io/acme/jobs/123?utm_source=x\t2026-06-28\tgreenhouse\tStrategy Analyst\tAcme\tMadrid\tadded\t2026-06-28',
    'https://jobs.lever.co/globex/abc-def\t2026-01-01',
    'garbage line',
  ].join('\n')
  const idx = buildScanIndex(tsv)
  // utm param canonicalized away — plain URL lookup hits
  const hit = idx.get([...idx.keys()].find(k => k.includes('acme')))
  assert.equal(hit.firstSeen, '2026-06-28')
  assert.equal(hit.status, 'added')
  assert.equal(idx.size, 2)
})

test('buildDedupKeySet reads normalized company+role pairs', () => {
  const keys = buildDedupKeySet('company_normalized\trole_normalized\tlast_seen_date\nacme\tstrategy analyst\t2026-05-01\n')
  assert.ok(keys.has('acme\tstrategy analyst'))
  assert.equal(keys.size, 1)
})

// ─── scorePendingEntry ───────────────────────────────────────────────────────

const BASE_ENTRY = {
  url: 'https://boards.greenhouse.io/acme/jobs/123',
  company: 'Acme',
  title: 'Strategy Analyst',
  relevanceScore: 4.0,
  relevanceReasons: '',
}

test('relevance score seeds the triage score', () => {
  const { score, reasons } = scorePendingEntry(BASE_ENTRY, {})
  assert.equal(score, 4.0)
  assert.match(reasons.join(' '), /scan relevance 4\.0/)
})

test('manual adds without relevance start at zero with an explanatory reason', () => {
  const { score, reasons } = scorePendingEntry({ ...BASE_ENTRY, relevanceScore: null }, {})
  assert.equal(score, 0)
  assert.match(reasons.join(' '), /no scan relevance/)
})

test('freshness bonus and staleness penalty from scan-history first_seen', () => {
  const scanIndex = buildScanIndex(
    'h\nhttps://boards.greenhouse.io/acme/jobs/123\t2026-06-28\tp\tt\tc\tl\tadded\td',
  )
  const fresh = scorePendingEntry(BASE_ENTRY, { scanIndex, today: '2026-07-01' })
  assert.equal(fresh.score, 4.0 + DEFAULT_WEIGHTS.freshWithin7d)

  const stale = scorePendingEntry(BASE_ENTRY, {
    scanIndex: buildScanIndex('h\nhttps://boards.greenhouse.io/acme/jobs/123\t2026-01-01\tp\tt\tc\tl\tadded\td'),
    today: '2026-07-01',
  })
  assert.equal(stale.score, 4.0 + DEFAULT_WEIGHTS.staleBeyond90d)
})

test('dream-company (top and lower) beats affinity; both are case-insensitive', () => {
  const opts = {
    dreamCompanies: [{ name: 'ACME', priority: 'top' }, { name: 'Globex', priority: 'lower' }],
    affinityCompanies: ['Initech'],
  }
  assert.equal(scorePendingEntry(BASE_ENTRY, opts).score, 4.0 + DEFAULT_WEIGHTS.dreamTop)
  assert.equal(
    scorePendingEntry({ ...BASE_ENTRY, company: 'globex' }, opts).score,
    4.0 + DEFAULT_WEIGHTS.dreamLower,
  )
  assert.equal(
    scorePendingEntry({ ...BASE_ENTRY, company: 'Initech' }, opts).score,
    4.0 + DEFAULT_WEIGHTS.affinity,
  )
})

test('senior titles are demoted; entry-level titles get a nudge', () => {
  const senior = scorePendingEntry({ ...BASE_ENTRY, title: 'Senior Data Lead' }, {})
  assert.equal(senior.score, 4.0 + DEFAULT_WEIGHTS.seniorTitle)
  const entry = scorePendingEntry({ ...BASE_ENTRY, title: 'Graduate Business Analyst' }, {})
  assert.equal(entry.score, 4.0 + DEFAULT_WEIGHTS.entryTitle)
  // Senior check wins over entry-level when both match ("Senior Graduate...")
  const both = scorePendingEntry({ ...BASE_ENTRY, title: 'Senior Graduate Program Lead' }, {})
  assert.equal(both.score, 4.0 + DEFAULT_WEIGHTS.seniorTitle)
})

test('already-evaluated (company, role) pairs are demoted via dedup keys', () => {
  const dedupKeys = buildDedupKeySet('h\nacme\tstrategy analyst\t2026-05-01')
  const { score, reasons } = scorePendingEntry(BASE_ENTRY, { dedupKeys })
  assert.equal(score, 4.0 + DEFAULT_WEIGHTS.alreadyEvaluated)
  assert.match(reasons.join(' '), /already evaluated/)
})

// ─── triagePending ───────────────────────────────────────────────────────────

test('ranks best-first, splits at topN, deterministic tie-break', () => {
  const entries = parsePendingEntries(PIPELINE_MD)
  const ranked = triagePending(entries, { topN: 2 })
  assert.equal(ranked.length, 3)
  assert.equal(ranked[0].company, 'Acme')             // 4.5
  assert.equal(ranked[1].company, 'Initech')          // 2.0 + 1 entry-title
  assert.equal(ranked[2].company, 'Globex')           // 0 - 4 senior
  assert.deepEqual(ranked.map(e => e.bucket), ['deep-eval', 'deep-eval', 'hold'])
})

// ─── renderTriagePlan ────────────────────────────────────────────────────────

test('renders a readable plan with both buckets', () => {
  const ranked = triagePending(parsePendingEntries(PIPELINE_MD), { topN: 2 })
  const md = renderTriagePlan(ranked, { topN: 2 })
  assert.match(md, /3 pending, top 2 recommended/)
  assert.match(md, /## Deep-eval now/)
  assert.match(md, /\| 1 \| .* Acme/)
  assert.match(md, /## Hold \(1\)/)
})

test('renders an explicit empty state', () => {
  assert.match(renderTriagePlan([], { topN: 15 }), /Pending inbox is empty/)
})

// ─── emitBatchInput ──────────────────────────────────────────────────────────

test('creates batch-input from scratch with header and sequential ids', () => {
  const ranked = triagePending(parsePendingEntries(PIPELINE_MD), { topN: 2 })
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  const { content, added, skipped } = emitBatchInput(deep, '')
  assert.equal(added, 2)
  assert.equal(skipped, 0)
  const lines = content.trim().split('\n')
  assert.equal(lines[0], BATCH_INPUT_HEADER)
  assert.match(lines[1], /^1\thttps:\/\/boards\.greenhouse\.io\/acme\/jobs\/123\ttriage\t/)
  assert.match(lines[2], /^2\thttps:\/\/jobs\.ashbyhq\.com\/initech\/uuid-1\ttriage\t/)
})

test('appends to existing batch-input, continuing ids and skipping known URLs', () => {
  const existing = [
    BATCH_INPUT_HEADER,
    '7\thttps://boards.greenhouse.io/acme/jobs/123\tmanual\tearlier row',
  ].join('\n') + '\n'
  const ranked = triagePending(parsePendingEntries(PIPELINE_MD), { topN: 2 })
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  const { content, added, skipped } = emitBatchInput(deep, existing)
  assert.equal(added, 1)   // Acme URL already present
  assert.equal(skipped, 1)
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[2], /^8\t/)  // id continues from 7
})

test('emitBatchInput is idempotent across re-runs', () => {
  const ranked = triagePending(parsePendingEntries(PIPELINE_MD), { topN: 2 })
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  const first = emitBatchInput(deep, '')
  const second = emitBatchInput(deep, first.content)
  assert.equal(second.added, 0)
  assert.equal(second.content, first.content)
})

// ─── expired postings ────────────────────────────────────────────────────────

test('triagePending: a posting scan-history marks expired goes to `closed` and does not use up a deep-eval slot', () => {
  const entries = parsePendingEntries(PIPELINE_MD)
  const scanIndex = buildScanIndex(
    'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates\n' +
    'https://boards.greenhouse.io/acme/jobs/123\t2026-10-01\tgreenhouse-api\tStrategy Analyst\tAcme\tX\texpired\t2026-10-01\n',
  )
  const ranked = triagePending(entries, { topN: 2, scanIndex, today: '2026-10-05' })
  const byUrl = Object.fromEntries(ranked.map(e => [e.url, e.bucket]))
  assert.equal(byUrl['https://boards.greenhouse.io/acme/jobs/123'], 'closed')
  assert.equal(ranked.filter(e => e.bucket === 'deep-eval').length, 2, 'the freed slot goes to a live posting')
  const md = renderTriagePlan(ranked, { topN: 2 })
  assert.match(md, /## Closed \(1\)/)
  assert.doesNotMatch(emitBatchInput(ranked.filter(e => e.bucket === "deep-eval"), "").content, /acme\/jobs\/123/)
})

// ─── brand gate ──────────────────────────────────────────────────────────────

test('normalizeBrand: high / mid / low, anything else reads as mid', () => {
  assert.equal(normalizeBrand('High'), 'high')
  assert.equal(normalizeBrand(' low '), 'low')
  assert.equal(normalizeBrand('mid'), 'mid')
  assert.equal(normalizeBrand(undefined), 'mid')
  assert.equal(normalizeBrand('mid-high'), 'mid')
})

test('buildCompanyBrands indexes only entries that state a brand, case-insensitively', () => {
  const brands = buildCompanyBrands([
    { name: 'Vandelay Industries', brand: 'low' },
    { name: 'Initech', brand: 'HIGH' },
    { name: 'Globex' },
    { brand: 'low' },
  ])
  assert.equal(brands.get('vandelay industries'), 'low')
  assert.equal(brands.get('initech'), 'high')
  assert.equal(brands.has('globex'), false)
  assert.equal(brands.size, 2)
  assert.equal(buildCompanyBrands(undefined).size, 0)
})

test('a low-brand company is demoted; mid, high and untagged are not', () => {
  const companyBrands = buildCompanyBrands([
    { name: 'Acme', brand: 'low' },
    { name: 'Initech', brand: 'high' },
  ])
  const low = scorePendingEntry(BASE_ENTRY, { companyBrands })
  assert.equal(low.score, 4.0 + DEFAULT_WEIGHTS.lowBrand)
  assert.match(low.reasons.join(' '), /low-brand company/)
  assert.equal(scorePendingEntry({ ...BASE_ENTRY, company: 'Initech' }, { companyBrands }).score, 4.0)
  assert.equal(scorePendingEntry({ ...BASE_ENTRY, company: 'Globex' }, { companyBrands }).score, 4.0)
})

test('the lowBrand weight is overridable like the others', () => {
  const companyBrands = buildCompanyBrands([{ name: 'Acme', brand: 'low' }])
  assert.equal(scorePendingEntry(BASE_ENTRY, { companyBrands, weights: { lowBrand: -10 } }).score, -6)
})

test('dream and affinity companies are never brand-penalized, even when tagged low', () => {
  const companyBrands = buildCompanyBrands([{ name: 'Acme', brand: 'low' }, { name: 'Initech', brand: 'low' }])
  const opts = { companyBrands, dreamCompanies: [{ name: 'Acme', priority: 'top' }], affinityCompanies: ['Initech'] }
  assert.equal(scorePendingEntry(BASE_ENTRY, opts).score, 4.0 + DEFAULT_WEIGHTS.dreamTop)
  assert.equal(scorePendingEntry({ ...BASE_ENTRY, company: 'Initech' }, opts).score, 4.0 + DEFAULT_WEIGHTS.affinity)
})

test('a low-brand posting reaches deep eval only when nothing better is waiting', () => {
  const entries = [
    { ...BASE_ENTRY, url: 'https://x.test/1', company: 'Vandelay Industries', relevanceScore: 5.0 },
    { ...BASE_ENTRY, url: 'https://x.test/2', company: 'Globex', relevanceScore: 3.0 },
  ]
  const companyBrands = buildCompanyBrands([{ name: 'Vandelay Industries', brand: 'low' }])
  const one = triagePending(entries, { topN: 1, companyBrands })
  assert.equal(one.find(e => e.bucket === 'deep-eval').company, 'Globex')
  // With a free slot it still gets evaluated: demoted, never dropped.
  const two = triagePending(entries, { topN: 2, companyBrands })
  assert.deepEqual(two.map(e => e.bucket), ['deep-eval', 'deep-eval'])
})

// ─── per-company cap ─────────────────────────────────────────────────────────

const noisyFeed = (company, n, score) =>
  Array.from({ length: n }, (_, i) => ({
    ...BASE_ENTRY, url: `https://x.test/${company}/${i}`, company, title: `Analyst ${i}`, relevanceScore: score,
  }))

test('one company fills at most perCompanyCap deep-eval slots; the rest go to others', () => {
  const entries = [...noisyFeed('Vandelay Industries', 8, 5.0), ...noisyFeed('Globex', 3, 2.0)]
  const ranked = triagePending(entries, { topN: 5, perCompanyCap: 3 })
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  assert.equal(deep.length, 5)
  assert.equal(deep.filter(e => e.company === 'Vandelay Industries').length, 3)
  assert.equal(deep.filter(e => e.company === 'Globex').length, 2)
  const capped = ranked.find(e => e.company === 'Vandelay Industries' && e.bucket === 'hold')
  assert.match(capped.triageReasons.join(' '), /company cap reached \(3/)
  assert.match(renderTriagePlan(ranked, { topN: 5 }), /company cap reached/)
})

test('the cap defaults to DEFAULT_PER_COMPANY_CAP, 0 turns it off, dream companies are exempt', () => {
  const entries = noisyFeed('Vandelay Industries', DEFAULT_PER_COMPANY_CAP + 3, 5.0)
  const deepCount = (opts) => triagePending(entries, { topN: 20, ...opts }).filter(e => e.bucket === 'deep-eval').length
  assert.equal(deepCount({}), DEFAULT_PER_COMPANY_CAP)
  assert.equal(deepCount({ perCompanyCap: 0 }), entries.length)
  assert.equal(deepCount({ dreamCompanies: [{ name: 'Vandelay Industries', priority: 'lower' }] }), entries.length)
})

test('a capped slice stays within topN; holds past topN carry no cap reason', () => {
  const entries = [...noisyFeed('Vandelay Industries', 4, 5.0), ...noisyFeed('Globex', 4, 4.0)]
  const ranked = triagePending(entries, { topN: 3, perCompanyCap: 2 })
  assert.equal(ranked.filter(e => e.bucket === 'deep-eval').length, 3)
  // Beyond topN, entries are plain holds without a cap reason.
  const plainHolds = ranked.filter(e => e.bucket === 'hold' && !e.triageReasons.some(r => r.includes('company cap')))
  assert.ok(plainHolds.length > 0)
})

// ─── triageOptsFromConfig ────────────────────────────────────────────────────

test('triageOptsFromConfig reads dreams, affinity, brands, weights and cap from parsed yaml', () => {
  const opts = triageOptsFromConfig({
    profile: {
      target_roles: { dream_companies: ['Initech', { name: 'Globex', priority: 'lower' }] },
      calibration: { brand_affinity_companies: ['Hooli'] },
      triage: { weights: { lowBrand: -6, notAWeight: 1, dreamTop: 'big' }, per_company_cap: 3 },
    },
    portals: { tracked_companies: [{ name: 'Vandelay Industries', brand: 'low' }] },
  })
  assert.deepEqual(opts.dreamCompanies, [{ name: 'Initech', priority: 'top' }, { name: 'Globex', priority: 'lower' }])
  assert.deepEqual(opts.affinityCompanies, ['Hooli'])
  assert.equal(opts.companyBrands.get('vandelay industries'), 'low')
  assert.deepEqual(opts.weights, { lowBrand: -6 })
  assert.equal(opts.perCompanyCap, 3)
  assert.equal(opts.warnings.length, 2)
})

test('triageOptsFromConfig with nothing configured leaves the core defaults in charge', () => {
  const opts = triageOptsFromConfig({ profile: null, portals: null })
  assert.deepEqual(opts.dreamCompanies, [])
  assert.equal(opts.companyBrands.size, 0)
  assert.deepEqual(opts.weights, {})
  assert.equal('perCompanyCap' in opts, false)
  assert.equal(triageOptsFromConfig({ profile: { triage: { per_company_cap: -1 } } }).warnings.length, 1)
})

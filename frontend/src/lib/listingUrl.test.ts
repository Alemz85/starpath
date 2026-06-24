import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guessCompanyFromUrl, isValidHttpUrl, normalizeUrl, prettify, TRACKING_PARAMS,
} from '@/lib/listingUrl'

// ─── normalizeUrl — the dedup key ────────────────────────────────────────────

test('normalizeUrl collapses www, trailing slash, fragment and tracking tags to one key', () => {
  const a = normalizeUrl('https://Acme.com/jobs/42/?utm_source=x#top')
  const b = normalizeUrl('http://www.acme.com/jobs/42')        // scheme differs ↓
  const c = normalizeUrl('https://acme.com/jobs/42')
  assert.equal(a, 'https://acme.com/jobs/42')
  assert.equal(c, 'https://acme.com/jobs/42')
  assert.equal(a, c)                       // same listing, different cosmetics → same key
  assert.notEqual(a, b)                    // http vs https are intentionally kept distinct
  assert.equal(b, 'http://acme.com/jobs/42')
})

test('normalizeUrl strips every known tracking param but preserves real listing params', () => {
  const key = normalizeUrl('https://jobs.lever.co/acme/123?gh_src=abc&utm_campaign=spring&jobId=999&ref=nl')
  // jobId survives; gh_src / utm_campaign / ref are stripped
  assert.equal(key, 'https://jobs.lever.co/acme/123?jobId=999')
})

test('normalizeUrl sorts surviving params so query order cannot defeat the match', () => {
  const x = normalizeUrl('https://acme.com/j?b=2&a=1')
  const y = normalizeUrl('https://acme.com/j?a=1&b=2')
  assert.equal(x, y)
  assert.equal(x, 'https://acme.com/j?a=1&b=2')
})

test('normalizeUrl tracking-param match is case-insensitive on the key', () => {
  assert.equal(normalizeUrl('https://acme.com/j?UTM_Source=x'), 'https://acme.com/j')
})

test('normalizeUrl reduces a bare host to a single-slash path', () => {
  assert.equal(normalizeUrl('https://acme.com'), 'https://acme.com/')
  assert.equal(normalizeUrl('https://acme.com/'), 'https://acme.com/')
})

test('normalizeUrl falls back to a lowered, trimmed string for non-URLs', () => {
  assert.equal(normalizeUrl('  Not A URL  '), 'not a url')
})

// ─── isValidHttpUrl ──────────────────────────────────────────────────────────

test('isValidHttpUrl accepts http/https and trims, rejects everything else', () => {
  assert.equal(isValidHttpUrl('  https://acme.com/x  '), true)
  assert.equal(isValidHttpUrl('http://acme.com'), true)
  assert.equal(isValidHttpUrl('ftp://acme.com'), false)
  assert.equal(isValidHttpUrl('mailto:a@b.com'), false)
  assert.equal(isValidHttpUrl('acme.com'), false)   // no scheme → not a valid URL
  assert.equal(isValidHttpUrl(''), false)
})

// ─── prettify ────────────────────────────────────────────────────────────────

test('prettify title-cases and de-slugs', () => {
  assert.equal(prettify('data-analyst'), 'Data Analyst')
  assert.equal(prettify('hello_fresh'), 'Hello Fresh')
  assert.equal(prettify('acme'), 'Acme')
})

// ─── guessCompanyFromUrl — ATS hosts ─────────────────────────────────────────

test('guessCompanyFromUrl reads the company slug from ATS hosts', () => {
  assert.equal(guessCompanyFromUrl('https://boards.greenhouse.io/acme/jobs/123'), 'Acme')
  assert.equal(guessCompanyFromUrl('https://jobs.lever.co/hello-fresh/abc'), 'Hello Fresh')
  assert.equal(guessCompanyFromUrl('https://jobs.ashbyhq.com/acme/role'), 'Acme')
  assert.equal(guessCompanyFromUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers'), 'Acme')
  assert.equal(guessCompanyFromUrl('https://www.welcometothejungle.com/en/companies/acme/jobs/x'), 'Acme')
})

test('guessCompanyFromUrl labels aggregator hosts rather than guessing', () => {
  assert.equal(guessCompanyFromUrl('https://www.linkedin.com/jobs/view/123'), 'LinkedIn job')
  assert.equal(guessCompanyFromUrl('https://es.indeed.com/viewjob?jk=abc'), 'Indeed listing')
})

test('guessCompanyFromUrl falls back to the registrable domain label', () => {
  assert.equal(guessCompanyFromUrl('https://careers.acme.com/job/42'), 'Acme')
  assert.equal(guessCompanyFromUrl('https://www.factorialhr.com/jobs/x'), 'Factorialhr')
})

// This is the regression the extraction fixed: the old `labels[length-2]`
// fallback returned the eSLD ("co" / "com") for multi-part country suffixes.
test('guessCompanyFromUrl resolves the org label across multi-part TLDs', () => {
  assert.equal(guessCompanyFromUrl('https://careers.bbc.co.uk/jobs/1'), 'Bbc')
  assert.equal(guessCompanyFromUrl('https://www.acme.com.au/careers'), 'Acme')
  assert.equal(guessCompanyFromUrl('https://jobs.acme.co.nz'), 'Acme')
})

test('guessCompanyFromUrl returns null for unparseable input', () => {
  assert.equal(guessCompanyFromUrl('not a url'), null)
  assert.equal(guessCompanyFromUrl(''), null)
})

// ─── TRACKING_PARAMS surface ─────────────────────────────────────────────────

test('TRACKING_PARAMS covers the utm family and common referral tags', () => {
  for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'gh_src', 'ref', 'src']) {
    assert.ok(TRACKING_PARAMS.has(p), `${p} should be treated as a tracking param`)
  }
})

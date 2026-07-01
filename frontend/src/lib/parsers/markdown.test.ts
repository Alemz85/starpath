import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseApplications,
  parseScouting,
  parsePipeline,
  parseReportPath,
} from '@/lib/parsers/markdown'

const APPS = [
  '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
  '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | **Applied** | ✅ | n/d | [#1](r) | hi |',
  '| 2 | 2026-04-28 | Globex | Analyst | 7.1/10 | Bogus | ❌ | n/d | [#2](r) |  |',
].join('\n')

test('parseApplications strips bold, normalizes unknown status, reads the PDF flag', () => {
  const rows = parseApplications(APPS)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].status, 'Applied')   // ** stripped
  assert.equal(rows[0].pdf, true)            // ✅
  assert.equal(rows[1].status, 'Evaluated')  // unknown → Evaluated
  assert.equal(rows[1].pdf, false)           // ❌
})

const SCOUTING = [
  '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |',
  '|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|',
  '| 7 | 2026-05-01 | Stripe | Strategy | 3.6/5 | T2+ | 3.7/3.0 | — | Rolling | promote | x |',
].join('\n')

test('parseScouting normalizes the display tier (T2+ → T2-high)', () => {
  const rows = parseScouting(SCOUTING)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].num, 7)
  assert.equal(rows[0].company, 'Stripe')
  assert.equal(rows[0].tier, 'T2-high')
})

test('parsePipeline reads bare, bulleted, task-list and local: URLs and flags stale', () => {
  const md = [
    'https://job.com/1',
    '- [ ] https://job.com/2 (2020-01-01)',
    '* local:jds/x.md',
    'just some prose, not a url',
    '- [x] https://job.com/3',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 4)
  assert.equal(urls[0].url, 'https://job.com/1')
  assert.equal(urls[1].url, 'https://job.com/2')
  assert.equal(urls[1].addedDate, '2020-01-01')
  assert.equal(urls[1].isStale, true)         // 2020 ≫ 14 days ago
  assert.equal(urls[2].url, 'local:jds/x.md')
  // Bare URLs carry no scanner metadata.
  assert.equal(urls[0].company, undefined)
  assert.equal(urls[0].relevance, undefined)
})

test('parsePipeline captures company/title/relevance from scanner-written lines', () => {
  const md = [
    '- [ ] https://boards.greenhouse.io/acme/jobs/9 | Acme | Strategy Analyst | relevance 4.5 — positive phrase, fresh',
    '- [ ] https://jobs.lever.co/globex/x1 | Globex | Senior Ops Lead',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 2)
  assert.equal(urls[0].company, 'Acme')
  assert.equal(urls[0].title, 'Strategy Analyst')
  assert.equal(urls[0].relevance, 4.5)
  assert.equal(urls[0].relevanceNote, 'positive phrase, fresh')
  assert.equal(urls[1].company, 'Globex')
  assert.equal(urls[1].title, 'Senior Ops Lead')
  assert.equal(urls[1].relevance, undefined)
})

test('parseReportPath extracts company/role/tier and rejects non-report paths', () => {
  const r = parseReportPath('reports/tier-1/Amazon - Business Analyst Intern 2026.md')
  assert.equal(r?.company, 'Amazon')
  assert.equal(r?.role, 'Business Analyst Intern 2026')
  assert.equal(r?.tier, 'T1')
  assert.equal(parseReportPath('user/cv.md'), null)
})

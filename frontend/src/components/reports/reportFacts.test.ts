import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contractLabel, firstSeenFor, reportSummary, roleSummaryFields, splitLocationLine,
} from './reportFacts'

const T1 = `# Scouting: Nimbus Robotics — Pricing Analyst

**Date:** 2026-09-07
**Location:** Lyon, France · hybrid, two office days
**URL:** https://example.com/jobs/nimbus/pricing-analyst

## A) Role summary
| Field | Value |
|-------|-------|
| Domain | Warehouse robotics |
| Seniority | Entry level, permanent |
| Remote | Hybrid, two office days in Lyon |
| TL;DR | A pricing seat with a real ladder, in your **first-choice** city. |

## D) Recommendation
Apply this week and lead with the pricing model.
It shows you can turn a model into a decision.

Second paragraph that is not the summary.
`

const T2 = `# Scouting: Lumen Freight — Operations Analyst

## Fit / gaps
Some fit notes.

## Recommendation
Only if your pipeline is thin: the
team is small.

## Path forward
More.
`

test('reportSummary: the TL;DR row, verbatim', () => {
  assert.deepEqual(reportSummary(T1), {
    text: 'A pricing seat with a real ladder, in your **first-choice** city.',
    source: 'tldr',
  })
})

test('reportSummary: a bold TL;DR line also counts', () => {
  assert.deepEqual(reportSummary('**TL;DR:** Short and sweet.\n'), { text: 'Short and sweet.', source: 'tldr' })
})

test('reportSummary: falls back to the Recommendation paragraph, joined onto one line', () => {
  assert.deepEqual(reportSummary(T2), {
    text: 'Only if your pipeline is thin: the team is small.',
    source: 'recommendation',
  })
})

test('reportSummary: null when the report has neither', () => {
  assert.equal(reportSummary('# Title\n\n## Eligibility\nAll clear.\n'), null)
})

test('roleSummaryFields: reads the Role summary table', () => {
  const f = roleSummaryFields(T1)
  assert.equal(f.Domain, 'Warehouse robotics')
  assert.equal(f.Seniority, 'Entry level, permanent')
  assert.equal(f.Remote, 'Hybrid, two office days in Lyon')
  assert.equal(f.Field, undefined)
  assert.deepEqual(roleSummaryFields(T2), {})
})

test('splitLocationLine: place and work mode', () => {
  assert.deepEqual(splitLocationLine('Lyon, France · hybrid, two office days'), { place: 'Lyon, France', workMode: 'hybrid, two office days' })
  assert.deepEqual(splitLocationLine('Porto, Portugal'), { place: 'Porto, Portugal', workMode: '' })
})

test('firstSeenFor: earliest first_seen for the URL, by header name', () => {
  const tsv = [
    'first_seen\turl\tcompany',
    '2026-09-10\thttps://example.com/a\tNimbus Robotics',
    '2026-09-06\thttps://example.com/a\tNimbus Robotics',
    '2026-09-01\thttps://example.com/b\tLumen Freight',
  ].join('\n')
  assert.equal(firstSeenFor(tsv, 'https://example.com/a'), '2026-09-06')
  assert.equal(firstSeenFor(tsv, 'https://example.com/zzz'), null)
  assert.equal(firstSeenFor('url\tother\nx\ty', 'x'), null)
  assert.equal(firstSeenFor(null, 'x'), null)
})

test('contractLabel: joins type and duration in sentence case', () => {
  assert.equal(contractLabel('full-time', 'permanent'), 'Full-time · permanent')
  assert.equal(contractLabel('Internship', '6 months'), 'Internship · 6 months')
  assert.equal(contractLabel('', ''), '')
  assert.equal(contractLabel('internship', 'Internship'), 'Internship')
})

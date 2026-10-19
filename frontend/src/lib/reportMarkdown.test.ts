import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMetadata, parseDimensionalScoring, parseRow,
  splitPeerBlock, parseReportHeader, splitEligibility, splitSalaryMath,
} from '@/lib/reportMarkdown'

// A representative v2 evaluation report (docs/scoring-v2.md §8.5): header
// lines, the Eligibility block, the dimensional table with its exact
// (want) / (hygiene) / (rollup) / (ease) / (context) tags, then a trailing
// section. Fictional company, placeholder location.
const REPORT = `# Acme — Analyst

**Date:** 2026-10-01
**Mode:** scouting
**Want:** 8.25/10 · **Ease:** 5.6/10
**Eligibility:** amber — start date not stated
**Verdict:** Stretch — apply with prep
**Tier:** T2
**URL:** https://jobs.example.com/acme/1
**Location:** City, Country

## Eligibility

| Check | Status | Reason |
|---|---|---|
| Start date | amber | start date not stated |
| Language | green | English C2 meets C1 |
| Other requirement | amber | STEM degree required |

**Ask the recruiter**
- When does the internship start?
- Does a Business Analytics MSc count as STEM?

## Dimensional scoring

| Dimension | Score | Reasoning |
|---|---|---|
| Growth / Mobility (want) | 8/10 | rotation programme |
| Optionality / Exit (want) | 8/10 | portable skills |
| Brand Value (want) | 9/10 | top-tier brand |
| Role content (want) | 7/10 | analytical core |
| City (hygiene) | 8/10 | preferred city |
| Salary Adj for City (hygiene) | 6/10 | ≈ baseline |
| Work-Life Balance (hygiene) | 6/10 | standard |
| **Want (rollup)** | **8.25/10** | M 8.0 + hygiene +0.25 |
| Skills Match (ease) | 8/10 | strong overlap |
| Experience bar (ease) | 6/10 | 1 year preferred |
| Competition (ease) | 5/10 | selective brand |
| **Ease (rollup)** | **5.6/10** | geometric 6.1 − 0.5 amber |
| Best-fit Early-career Roles (context) | text | Analyst, Associate |

## Role summary

Great role.
`

// ─── parseRow ────────────────────────────────────────────────────────────────

test('parseRow splits cells, strips whole-cell bold, the /10 suffix, and the tag', () => {
  const r = parseRow('| **Want (rollup)** | **8.25/10** | M 8.0 |')
  assert.deepEqual(r, { label: 'Want', score: '8.25', reasoning: 'M 8.0', tag: 'rollup' })
})

test('parseRow keeps inline emphasis inside a cell (only whole-cell bold is stripped)', () => {
  const r = parseRow('| Brand **value** (want) | 9/10 | the **brand** matters |')
  assert.equal(r?.label, 'Brand **value**')
  assert.equal(r?.reasoning, 'the **brand** matters')
})

test('parseRow handles a missing reasoning cell', () => {
  assert.deepEqual(parseRow('| Growth | 4 / 10 |'), { label: 'Growth', score: '4', reasoning: '', tag: null })
})

test('parseRow returns null for a row with fewer than two cells', () => {
  assert.equal(parseRow('| just-one |'), null)
  assert.equal(parseRow('|  |'), null)
})

test('parseRow detects each v2 tag case-insensitively', () => {
  assert.equal(parseRow('| X (want) | 7 |')?.tag, 'want')
  assert.equal(parseRow('| X (HYGIENE) | 7 |')?.tag, 'hygiene')
  assert.equal(parseRow('| X (ease) | 7 |')?.tag, 'ease')
  assert.equal(parseRow('| X (rollup) | 7 |')?.tag, 'rollup')
  assert.equal(parseRow('| X (context) | 7 |')?.tag, 'context')
  assert.equal(parseRow('| X | 7 |')?.tag, null)
})

// ─── parseReportHeader ───────────────────────────────────────────────────────

test('parseReportHeader reads Want, Ease, Eligibility, Verdict and Tier', () => {
  assert.deepEqual(parseReportHeader(REPORT), {
    want: 8.25, ease: 5.6,
    eligibility: 'amber', eligibilityReason: 'start date not stated',
    verdict: 'stretch', verdictAction: 'apply with prep',
    tier: 'T2',
  })
})

test('parseReportHeader maps every verdict label back to its key', () => {
  const v = (line: string) => parseReportHeader(`**Verdict:** ${line}`).verdict
  assert.equal(v('Go — apply now'), 'go')
  assert.equal(v('Growth target — close the gap first'), 'growth')
  assert.equal(v('Solid — apply'), 'solid')
  assert.equal(v('If pipeline thin — only if your pipeline is thin'), 'thin')
  assert.equal(v('Skip'), 'skip')
})

test('parseReportHeader: a red header is blocked with no scores', () => {
  const h = parseReportHeader('**Want:** —\n**Eligibility:** red — German C1 required\n**Verdict:** Blocked\n**Tier:** T4')
  assert.equal(h.want, null)
  assert.equal(h.ease, null)
  assert.equal(h.eligibility, 'red')
  assert.equal(h.eligibilityReason, 'German C1 required')
  assert.equal(h.verdict, 'blocked')
})

test('parseReportHeader on a header-less body returns all-null', () => {
  const h = parseReportHeader('# Title\n\nprose')
  assert.equal(h.want, null)
  assert.equal(h.verdict, null)
  assert.equal(h.tier, null)
})

// ─── splitEligibility ────────────────────────────────────────────────────────

test('splitEligibility parses the check table and the recruiter questions', () => {
  const { eligibility, rest } = splitEligibility(REPORT)
  assert.ok(eligibility)
  assert.deepEqual(eligibility!.checks.map(c => [c.check, c.status]), [
    ['start_date', 'amber'], ['language', 'green'], ['other', 'amber'],
  ])
  assert.equal(eligibility!.checks[0].reason, 'start date not stated')
  assert.deepEqual(eligibility!.questions, [
    'When does the internship start?',
    'Does a Business Analytics MSc count as STEM?',
  ])
  // one question per amber, in order → attached to its check
  assert.equal(eligibility!.checks[0].question, 'When does the internship start?')
  assert.equal(eligibility!.checks[2].question, 'Does a Business Analytics MSc count as STEM?')
  assert.equal(eligibility!.checks[1].question, undefined)
  // The block is carved out of the body; the rest is intact.
  assert.ok(!rest.includes('## Eligibility'))
  assert.ok(rest.includes('## Dimensional scoring'))
})

test('splitEligibility keeps an unknown check label for the renderer fallback', () => {
  const md = '## Eligibility\n\n| Check | Status | Reason |\n|---|---|---|\n| Security clearance | red | citizens only |\n'
  const { eligibility } = splitEligibility(md)
  assert.deepEqual(eligibility!.checks, [{ check: 'Security clearance', status: 'red', reason: 'citizens only' }])
})

test('splitEligibility is a no-op without the section', () => {
  const md = '# x\n\n## Role summary\nok\n'
  assert.deepEqual(splitEligibility(md), { eligibility: null, rest: md })
})

// ─── parseDimensionalScoring ─────────────────────────────────────────────────

test('parseDimensionalScoring groups rows by the v2 tags', () => {
  const { dims, before, after } = parseDimensionalScoring(REPORT)
  assert.ok(dims)
  assert.deepEqual(dims!.want.motivators.map(r => r.label),
    ['Growth / Mobility', 'Optionality / Exit', 'Brand Value', 'Role content'])
  assert.deepEqual(dims!.want.hygiene.map(r => r.label),
    ['City', 'Salary Adj for City', 'Work-Life Balance'])
  assert.equal(dims!.want.rollup, '8.25')
  assert.equal(dims!.want.reasoning, 'M 8.0 + hygiene +0.25')
  assert.deepEqual(dims!.ease.rows.map(r => r.label), ['Skills Match', 'Experience bar', 'Competition'])
  assert.equal(dims!.ease.rollup, '5.6')
  assert.deepEqual(dims!.context.rows.map(r => r.label), ['Best-fit Early-career Roles'])
  assert.ok(before.includes('# Acme — Analyst'))
  assert.ok(!before.includes('Dimensional scoring'))
  assert.ok(after.startsWith('## Role summary'))
})

test('parseDimensionalScoring: a tag wins over position', () => {
  const md = `## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Skills Match (ease) | 8/10 | listed first |
| Growth / Mobility (want) | 7/10 | after it |
| **Want (rollup)** | **7/10** | |
| City (hygiene) | 9/10 | after the rollup |
`
  const { dims } = parseDimensionalScoring(md)
  assert.deepEqual(dims!.ease.rows.map(r => r.label), ['Skills Match'])
  assert.deepEqual(dims!.want.motivators.map(r => r.label), ['Growth / Mobility'])
  assert.deepEqual(dims!.want.hygiene.map(r => r.label), ['City'])
})

test('parseDimensionalScoring: untagged rows fall back to their position', () => {
  const md = `## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Growth | 8/10 | before the Want rollup |
| Want (rollup) | 8/10 | |
| Skills | 7/10 | before the Ease rollup |
| Ease (rollup) | 7/10 | |
| Notes | text | after both |
`
  const { dims } = parseDimensionalScoring(md)
  assert.deepEqual(dims!.want.motivators.map(r => r.label), ['Growth'])
  assert.deepEqual(dims!.ease.rows.map(r => r.label), ['Skills'])
  assert.deepEqual(dims!.context.rows.map(r => r.label), ['Notes'])
})

test('parseDimensionalScoring leaves the trailing sections intact in after', () => {
  const md = `## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Skills Match (ease) | 8/10 | ok |
| **Ease (rollup)** | **7.0/10** | geometric |

## Gaps and opportunities
- Experience bar 3 caps Ease at 4.5.

## Role summary
Great role.
`
  const { dims, after } = parseDimensionalScoring(md)
  assert.ok(dims)
  assert.equal(dims!.ease.rollup, '7.0')
  assert.ok(after.startsWith('## Gaps and opportunities'))
  assert.ok(after.includes('## Role summary'))
})

test('parseDimensionalScoring returns dims:null and the full md when the heading is absent', () => {
  const md = '# A report\n\nNo scoring table here.\n'
  const res = parseDimensionalScoring(md)
  assert.equal(res.dims, null)
  assert.equal(res.before, md)
  assert.equal(res.after, '')
})

test('parseDimensionalScoring bails out when the table has no data rows', () => {
  const md = `## Dimensional scoring

| Dim | Score |
|---|---|

## Next
`
  assert.equal(parseDimensionalScoring(md).dims, null)
})

// ─── extractMetadata ─────────────────────────────────────────────────────────

test('extractMetadata keeps the contextual fields and drops the score header lines', () => {
  const { meta, rest } = extractMetadata(REPORT)
  assert.deepEqual(meta.map(m => m.key), ['Date', 'Mode', 'Location'])
  assert.equal(meta.find(m => m.key === 'Location')?.value, 'City, Country')
  assert.ok(rest.includes('# Acme — Analyst'))
  for (const dropped of ['**Want:**', '**Eligibility:**', '**Verdict:**', '**Tier:**', '**URL:**']) {
    assert.ok(!rest.includes(dropped), `${dropped} consumed`)
  }
})

test('extractMetadata flags an unconfirmed verification value through to the caller', () => {
  const { meta } = extractMetadata('**Verification:** unconfirmed (batch mode)\n')
  assert.deepEqual(meta, [{ key: 'Verification', value: 'unconfirmed (batch mode)' }])
})

test('extractMetadata collapses the blank-line run the dropped block leaves behind', () => {
  const { rest } = extractMetadata('A\n\n**URL:** x\n\nB\n')
  assert.ok(!/\n{3,}/.test(rest))   // no triple-newline gap where URL was
})

// ─── splitSalaryMath ─────────────────────────────────────────────────────────

test('splitSalaryMath carves the footer line out of the prose', () => {
  const md = '## Comp\n\nPays fine.\n\nSalary math: €42k gross → €29.8k net → ×0.92 COL → 6/10\n'
  const { salaryMath, rest } = splitSalaryMath(md)
  assert.equal(salaryMath, '€42k gross → €29.8k net → ×0.92 COL → 6/10')
  assert.ok(!rest.includes('Salary math'))
  assert.ok(rest.includes('Pays fine.'))
})

test('splitSalaryMath accepts a bold label and is a no-op without the line', () => {
  assert.equal(splitSalaryMath('**Salary math:** a → b').salaryMath, 'a → b')
  const md = '# x\n\nno footer\n'
  assert.deepEqual(splitSalaryMath(md), { salaryMath: null, rest: md })
})

test('an old report with a Why-this-score heading parses as ordinary prose', () => {
  const md = REPORT + '\n## Why this score\n\n- **Holding it back:** x\n'
  const { dims, after } = parseDimensionalScoring(md)
  assert.ok(dims)
  assert.ok(after.includes('## Why this score'))   // left for the prose renderer
})

// ─── splitPeerBlock ───────────────────────────────────────────────────────────

test('splitPeerBlock removes the unheaded rule + 3-line peer block (real report shape)', () => {
  const md = `| Best-fit Roles (context) | — | Analyst |

---
**Rank vs Strategy & Operations peers:** 7.4/10 — top 15% of 39 roles evaluated
**Dimension outliers:** Brand Value +2.6 above avg
**Closest comparables:** Beta Corp (7.5) · Gamma Inc (7.3)

## A) Role summary
| Field | Value |
`
  const { found, rest } = splitPeerBlock(md)
  assert.equal(found, true)
  assert.ok(!rest.includes('Rank vs'))
  assert.ok(!rest.includes('Dimension outliers'))
  assert.ok(!rest.includes('Closest comparables'))
  assert.ok(!rest.includes('---'))                  // the rule went with the block
  assert.ok(rest.includes('## A) Role summary'))
  assert.ok(rest.includes('Best-fit Roles'))
  assert.ok(!/\n{3,}/.test(rest))
})

test('splitPeerBlock also swallows the optional "## Peer ranking" template heading', () => {
  const md = `## Why this score
Solid.

## Peer ranking

---
**Rank vs Data Analyst peers:** 8.1/10 — top 5% of 18 roles evaluated
**Dimension outliers:** none ≥ ±1.5 from peer average
**Closest comparables:** Beta (8.0)

## A) Role summary
`
  const { found, rest } = splitPeerBlock(md)
  assert.equal(found, true)
  assert.ok(!rest.includes('## Peer ranking'))
  assert.ok(!rest.includes('Rank vs'))
  assert.ok(rest.includes('## Why this score'))
  assert.ok(rest.includes('## A) Role summary'))
})

test('splitPeerBlock leaves markdown without a peer block untouched', () => {
  const md = `## A) Role summary
No peer block here. A dimension outlier is mentioned in prose only.
`
  const { found, rest } = splitPeerBlock(md)
  assert.equal(found, false)
  assert.equal(rest, md)
})

test('splitPeerBlock handles a block at the very end of the document', () => {
  const md = `## E) Career path impact
Great trajectory.

---
**Rank vs Ops peers:** 7.0/10 — top half of 12 roles evaluated
**Closest comparables:** Beta (7.1)
`
  const { found, rest } = splitPeerBlock(md)
  assert.equal(found, true)
  assert.ok(!rest.includes('Rank vs'))
  assert.ok(rest.includes('Great trajectory.'))
})

// ─── Compact T3 report (no full prose sections) ──────────────────────────────
//
// T2 "short summary" and T3 "Gap & Growth" reports drop the full prose
// sections (Role summary / Comp & demand / Recommendation / Career path
// impact). The parser contract: header + the dimensional table must
// still parse, and the leaner remaining sections flow
// through as ordinary prose — no fallback path, no crash.
const COMPACT_T3_REPORT = `# Gap & Growth: Acme — Analyst

**Date:** 2026-10-02
**URL:** https://jobs.example.com/acme/123
**Location:** City, Country hybrid
**Archetype:** Strategy & Ops
**Want:** 8.5/10 · **Ease:** 4.5/10
**Eligibility:** green
**Verdict:** Growth target — close the gap first
**Tier:** T3
**Verification:** unconfirmed (batch mode)

## Dimensional scoring

| Dimension | Score | Reasoning |
|---|---|---|
| Growth / Mobility (want) | 8/10 | cohort program |
| Optionality / Exit (want) | 9/10 | portable |
| Brand Value (want) | 9/10 | strong brand |
| Role content (want) | 8/10 | no quota language |
| City (hygiene) | 6/10 | non-preferred city |
| Salary Adj for City (hygiene) | 6/10 | ≈ city baseline |
| Work-Life Balance (hygiene) | 6/10 | standard |
| **Want (rollup)** | **8.5/10** | M 8.5 |
| Skills Match (ease) | 7/10 | required covered |
| Experience bar (ease) | 3/10 | "2+ years" wall, quoted from JD |
| Competition (ease) | 6/10 | mid pool |
| **Ease (rollup)** | **4.5/10** | geometric 5.0, wall caps at 4.5 |

## Gaps and opportunities

- **Gap:** Experience bar — JD requires "2+ years operations experience".
- **Revisit when:** your CV clears the 2-year experience wall this JD gates on.
`

test('compact T3 report: header metadata still parses (kept fields only)', () => {
  const { meta, rest } = extractMetadata(COMPACT_T3_REPORT)
  const keys = meta.map(m => m.key.toLowerCase())
  assert.deepEqual(keys, ['date', 'location', 'archetype', 'verification'])
  assert.equal(meta.find(m => m.key === 'Verification')?.value, 'unconfirmed (batch mode)')
  assert.ok(!rest.includes('**URL:**'))
  assert.ok(!rest.includes('**Tier:**'))
  assert.ok(rest.includes('# Gap & Growth: Acme — Analyst'))
  const h = parseReportHeader(COMPACT_T3_REPORT)
  assert.equal(h.verdict, 'growth')
  assert.equal(h.eligibility, 'green')
  assert.equal(h.eligibilityReason, '')
})

test('compact T3 report: dimensional table parses with full Want / Ease / context grouping', () => {
  const { dims, after } = parseDimensionalScoring(COMPACT_T3_REPORT)
  assert.ok(dims)
  assert.equal(dims!.want.rollup, '8.5')
  assert.equal(dims!.ease.rollup, '4.5')
  assert.equal(dims!.want.motivators.length, 4)
  assert.equal(dims!.want.hygiene.length, 3)
  assert.deepEqual(dims!.ease.rows.map(r => r.label), ['Skills Match', 'Experience bar', 'Competition'])
  assert.equal(dims!.context.rows.length, 0)
  assert.ok(after.includes('## Gaps and opportunities'))
})

test('compact T3 report: the rest degrades to plain prose', () => {
  const { after } = parseDimensionalScoring(COMPACT_T3_REPORT)
  assert.ok(after.includes('## Gaps and opportunities'))
  for (const absent of ['Role summary', 'Comp & demand', 'Recommendation', 'Career path impact']) {
    assert.ok(!after.includes(absent), `compact report has no "${absent}" section`)
  }
  const peer = splitPeerBlock(after)
  assert.equal(peer.found, false)
  assert.equal(peer.rest, after)
})

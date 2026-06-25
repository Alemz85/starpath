import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMetadata, parseDimensionalScoring, parseRow,
  extractWhyThisScoreSection, parseWhyThisScore, splitWhyThisScore,
} from '@/lib/reportMarkdown'

// A representative evaluation report — header + metadata block, a dimensional
// scoring table with both rollups + Overall + a context row, then a trailing
// section. Mirrors the `reports/tier-*/{Company} - {Role}.md` shape.
const REPORT = `# Acme — Analyst

**Date:** 2026-06-01
**Mode:** scouting
**URL:** https://acme.com/job
**Score:** 7.6/10

## Dimensional scoring

| Dimension | Score | Reasoning |
|---|---|---|
| Skills match | 8/10 | strong overlap |
| Current Fit (rollup) | 7.5/10 | weighted CF |
| Brand value | 9/10 | top-tier brand |
| Aspirational Fit (rollup) | 8/10 | weighted AF |
| Overall | 7.6/10 | CF×0.7 + AF×0.3 |
| Salary (context) | 6/10 | below market |

## Role summary

Great role.
`

// ─── parseRow ────────────────────────────────────────────────────────────────

test('parseRow splits cells, strips whole-cell bold, the /N suffix, and the tag', () => {
  const r = parseRow('| **Current Fit (rollup)** | **7.5/10** | weighted |')
  assert.deepEqual(r, { label: 'Current Fit', score: '7.5', reasoning: 'weighted', tag: 'rollup' })
})

test('parseRow keeps inline emphasis inside a cell (only whole-cell bold is stripped)', () => {
  const r = parseRow('| Brand **value** | 9/10 | the **brand** matters |')
  assert.equal(r?.label, 'Brand **value**')
  assert.equal(r?.reasoning, 'the **brand** matters')
})

test('parseRow handles the old /5 scale and a missing reasoning cell', () => {
  const r = parseRow('| Growth | 4 / 5 |')
  assert.deepEqual(r, { label: 'Growth', score: '4', reasoning: '', tag: null })
})

test('parseRow returns null for a row with fewer than two cells', () => {
  assert.equal(parseRow('| just-one |'), null)
  assert.equal(parseRow('|  |'), null)
})

test('parseRow detects each tag variant case-insensitively', () => {
  assert.equal(parseRow('| X (signal) | 7 |')?.tag, 'signal')
  assert.equal(parseRow('| X (CONTEXT) | 7 |')?.tag, 'context')
  assert.equal(parseRow('| X | 7 |')?.tag, null)
})

// ─── parseDimensionalScoring ─────────────────────────────────────────────────

test('parseDimensionalScoring groups rows into CF / AF / context and reads Overall', () => {
  const { dims, before, after } = parseDimensionalScoring(REPORT)
  assert.ok(dims)
  assert.equal(dims!.overall?.score, '7.6')
  assert.equal(dims!.currentFit.rollup, '7.5')
  assert.equal(dims!.aspirationalFit.rollup, '8')
  assert.deepEqual(dims!.currentFit.rows.map(r => r.label), ['Skills match'])
  assert.deepEqual(dims!.aspirationalFit.rows.map(r => r.label), ['Brand value'])
  assert.deepEqual(dims!.context.rows.map(r => r.label), ['Salary'])
  // before stops at the heading; after resumes at the next section
  assert.ok(before.includes('# Acme — Analyst'))
  assert.ok(!before.includes('Dimensional scoring'))
  assert.ok(after.startsWith('## Role summary'))
})

test('parseDimensionalScoring surfaces a trailing "Why this score" block intact in after', () => {
  // The explainability block is rendered immediately after the dimensional
  // table (see modes/_shared.md § Why-this-score block). It must flow through
  // as `after` content so the slide-over renders + icons it, and it must not
  // disturb the table parse.
  const md = `## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Skills match | 8/10 | ok |
| Current Fit (rollup) | 7.5/10 | w |
| Overall | 7.0/10 | rollup |

## Why this score
Closest lever: Ease of Entry 4 → 5 (+1) would move this from T3 to T2.

- **Holding it back:** Ease of Entry 4/10 trips the experience-wall gate.

## Role summary
Great role.
`
  const { dims, after } = parseDimensionalScoring(md)
  assert.ok(dims)
  assert.equal(dims!.overall?.score, '7.0')
  assert.deepEqual(dims!.currentFit.rows.map(r => r.label), ['Skills match'])
  assert.ok(after.startsWith('## Why this score'))
  assert.ok(after.includes('Closest lever'))
  assert.ok(after.includes('## Role summary'))
})

test('parseDimensionalScoring routes a (context) row to context even before Overall', () => {
  const md = `## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Skills match | 8/10 | ok |
| Salary (context) | 5/10 | meh |
| Current Fit (rollup) | 7/10 | w |
`
  const { dims } = parseDimensionalScoring(md)
  // The context row appears in the CF phase but its tag wins — it must not
  // land in currentFit.rows.
  assert.deepEqual(dims!.currentFit.rows.map(r => r.label), ['Skills match'])
  assert.deepEqual(dims!.context.rows.map(r => r.label), ['Salary'])
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

test('extractMetadata keeps the contextual fields and drops the duplicated ones', () => {
  const { meta, rest } = extractMetadata(`# Acme — Analyst

**Date:** 2026-06-01
**Mode:** scouting
**URL:** https://acme.com/job
**Score:** 7.6/10
**Location:** Berlin

Some prose follows.`)
  const keys = meta.map(m => m.key)
  assert.deepEqual(keys, ['Date', 'Mode', 'Location'])   // URL + Score dropped
  assert.equal(meta.find(m => m.key === 'Location')?.value, 'Berlin')
  // Every "**Key:** value" line is consumed; only the title + prose remain.
  assert.ok(rest.includes('# Acme — Analyst'))
  assert.ok(rest.includes('Some prose follows.'))
  assert.ok(!rest.includes('**Score:**'))
  assert.ok(!rest.includes('**URL:**'))
})

test('extractMetadata flags an unconfirmed verification value through to the caller', () => {
  const { meta } = extractMetadata('**Verification:** unconfirmed (batch mode)\n')
  assert.deepEqual(meta, [{ key: 'Verification', value: 'unconfirmed (batch mode)' }])
})

test('extractMetadata collapses the blank-line run the dropped block leaves behind', () => {
  const { rest } = extractMetadata('A\n\n**URL:** x\n\nB\n')
  assert.ok(!/\n{3,}/.test(rest))   // no triple-newline gap where URL was
})

// ─── Why-this-score (fixability) ─────────────────────────────────────────────

const WHY_REPORT = `# Acme — Analyst

## Dimensional scoring

| Dim | Score | Why |
|---|---|---|
| Skills match | 8/10 | ok |
| Overall | 6.9/10 | rollup |

## Why this score
Strong aspirational pull, but the experience wall keeps Current Fit just under T2.

- **Holding it back:** Ease of Entry 4/10 trips the experience-wall gate.
- **Closest lever:** Skills match 7 → 8 (+1) crosses Current Fit into the T2 band.

## Role summary
Great role.
`

test('extractWhyThisScoreSection pulls just the block body, stopping at the next heading', () => {
  const sec = extractWhyThisScoreSection(WHY_REPORT)
  assert.ok(sec)
  assert.ok(sec!.includes('experience wall'))
  assert.ok(sec!.includes('Closest lever'))
  assert.ok(!sec!.includes('Role summary'))
  assert.ok(!sec!.includes('Dimensional scoring'))
})

test('extractWhyThisScoreSection returns null when the block is absent', () => {
  assert.equal(extractWhyThisScoreSection('# Report\n\n## Role summary\nx\n'), null)
})

test('parseWhyThisScore extracts headline, binding constraint, and lever', () => {
  const why = parseWhyThisScore(WHY_REPORT)
  assert.equal(why.present, true)
  assert.ok(why.headline.startsWith('Strong aspirational pull'))
  assert.equal(why.bindingConstraint, 'Ease of Entry 4/10 trips the experience-wall gate.')
  assert.equal(why.lever, 'Skills match 7 → 8 (+1) crosses Current Fit into the T2 band.')
})

test('parseWhyThisScore reports present:false and null fields when no block exists', () => {
  const why = parseWhyThisScore('# Report\n\n## Role summary\nx\n')
  assert.deepEqual(why, { headline: '', bindingConstraint: null, lever: null, present: false })
})

test('parseWhyThisScore treats a "no single lever" disclaimer as no lever', () => {
  const md = `## Why this score
Already a top-band match on every gating dimension.

- **Holding it back:** Nothing — all rollup dimensions clear their bands.
- **Closest lever:** No single dimension can cross alone; already top-band.
`
  const why = parseWhyThisScore(md)
  assert.equal(why.present, true)
  assert.equal(why.lever, null)
  // binding constraint still surfaces even when phrased as "Nothing — …"
  assert.ok(why.bindingConstraint?.startsWith('Nothing'))
})

test('parseWhyThisScore tolerates un-bolded labels and a missing lever bullet', () => {
  const md = `## Why this score
The comp gap is the only thing below band.

- Holding it back: Salary-adjusted comp 5/10 drags Current Fit.
`
  const why = parseWhyThisScore(md)
  assert.equal(why.bindingConstraint, 'Salary-adjusted comp 5/10 drags Current Fit.')
  assert.equal(why.lever, null)
  assert.ok(why.headline.startsWith('The comp gap'))
})

test('parseWhyThisScore accepts "Binding constraint" / "Cheapest lever" label synonyms', () => {
  const md = `## Why this score
- **Binding constraint:** Ease of Entry gate.
- **Cheapest lever:** Brand value 6 → 8 crosses the band.
`
  const why = parseWhyThisScore(md)
  assert.equal(why.bindingConstraint, 'Ease of Entry gate.')
  assert.equal(why.lever, 'Brand value 6 → 8 crosses the band.')
  assert.equal(why.headline, '')   // no non-bullet lede line
})

// ─── splitWhyThisScore (slide-over rendering split) ──────────────────────────

test('splitWhyThisScore parses the block and removes it from the trailing prose', () => {
  const after = `## Why this score
Strong aspirational pull, but the experience wall keeps Current Fit just under T2.

- **Holding it back:** Ease of Entry 4/10 trips the experience-wall gate.
- **Closest lever:** Skills match 7 → 8 (+1) crosses Current Fit into the T2 band.

## Role summary
Great role.
`
  const { why, rest } = splitWhyThisScore(after)
  assert.equal(why.present, true)
  assert.ok(why.headline.startsWith('Strong aspirational pull'))
  assert.equal(why.bindingConstraint, 'Ease of Entry 4/10 trips the experience-wall gate.')
  assert.equal(why.lever, 'Skills match 7 → 8 (+1) crosses Current Fit into the T2 band.')
  // The block is gone from rest; the following section survives intact.
  assert.ok(!rest.includes('## Why this score'))
  assert.ok(!rest.includes('Holding it back'))
  assert.ok(rest.includes('## Role summary'))
  assert.ok(rest.includes('Great role.'))
})

test('splitWhyThisScore preserves prose that precedes the block', () => {
  const after = `## Role summary
A solid match.

## Why this score
The comp gap is the only thing below band.

- **Holding it back:** Comp 5/10 drags Current Fit.

## Gaps
Need more SQL.
`
  const { why, rest } = splitWhyThisScore(after)
  assert.equal(why.bindingConstraint, 'Comp 5/10 drags Current Fit.')
  assert.ok(rest.includes('## Role summary'))
  assert.ok(rest.includes('A solid match.'))
  assert.ok(rest.includes('## Gaps'))
  assert.ok(rest.includes('Need more SQL.'))
  assert.ok(!rest.includes('## Why this score'))
})

test('splitWhyThisScore returns present:false and the md untouched when no block exists', () => {
  const after = `## Role summary
No why-block here.
`
  const { why, rest } = splitWhyThisScore(after)
  assert.equal(why.present, false)
  assert.equal(rest, after)
})

test('splitWhyThisScore drops a Why block that sits at the very end (no following heading)', () => {
  const after = `## Role summary
Great role.

## Why this score
Headline only, no bullets.
`
  const { why, rest } = splitWhyThisScore(after)
  assert.equal(why.present, true)
  assert.ok(why.headline.startsWith('Headline only'))
  assert.ok(rest.includes('## Role summary'))
  assert.ok(!rest.includes('## Why this score'))
  assert.ok(!/\n{3,}/.test(rest))   // no blank-line crater left behind
})

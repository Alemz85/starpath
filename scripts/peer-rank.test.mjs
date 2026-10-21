// peer-rank.test.mjs — unit tests for scripts/peer-rank.mjs (the Comparative
// Rank Block, scoring v2). Covers the below-5-peers omission rule, blocked
// rows excluded from the pool, a blocked target omitted with a reason, the
// Priority rank + separate Match / Ease placements, the
// docs/scoring-statistical-design.md confidence-tier contract (§ 3.1 / § 3.2),
// the formatted 3-bold-line render, outliers over the ten v2 dims, closest
// comparables, and the default read of data/score-history.tsv from the cwd.
//
// Most tests inject pre-parsed rows (`{ rows }`); one reads the file from a
// temp cwd, since that is what the CLI does. Fixtures use the shared v2
// builder; companies are fictional.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATES, confidenceTier } from './lib/scoring-stats.mjs'
import { parseScoreHistory } from './lib/targeting-core.mjs'
import { computePriority, rollupMatch, rollupEase } from './lib/score-bands.mjs'
import { historyTsv, BASE_DIMS } from './lib/testing/score-history-fixture.mjs'
import { peerRank, peerRankDetailed, normalizeTarget } from './peer-rank.mjs'

// ─── Fixture construction ──────────────────────────────────────────────────

/** N scored peers for `archetype`, distinct companies, spread so ties are rare. */
function peers(archetype, n, { match = (i) => 6 + i * 0.1, ease = (i) => 6 + i * 0.05 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    archetype,
    company: `${archetype.replace(/\W+/g, '')} Peer ${i}`,
    match: Number(match(i).toFixed(2)),
    ease: Number(ease(i).toFixed(2)),
  }))
}

const ROWS = parseScoreHistory(historyTsv(
  // ── Gate boundary archetypes (confidenceTier boundaries: g=5, 2g=10, 4g=20) ──
  ...peers('Arch4Peers', 4),
  ...peers('Arch5Peers', 5),
  ...peers('Arch9Peers', 9),
  ...peers('Arch10Peers', 10),
  ...peers('Arch19Peers', 19),
  ...peers('Arch20Peers', 20),

  // ── Blocked rows never count as peers: 4 scored + 3 blocked → below gate ──
  ...peers('BlockedMix', 4),
  { archetype: 'BlockedMix', company: 'Contoso Retail', eligibility: 'red', eligibility_flags: 'language:red:German C1 required' },
  { archetype: 'BlockedMix', company: 'Fabrikam Labs', eligibility: 'red' },
  { archetype: 'BlockedMix', company: 'Tailspin Toys', eligibility: 'red' },

  // ── Rank math, fixed Priority values: match = ease = p → priority = p ──
  ...[5.0, 5.5, 6.0, 6.5, 7.0].map((p, i) => ({ archetype: 'RankMath', company: `RM-${i}`, match: p, ease: p })),

  // ── Match and Ease placements disagree: peers match 6.0–6.4, ease 7.6–8.0 ──
  ...peers('SplitArch', 5, { match: (i) => 6 + i * 0.1, ease: (i) => 7.6 + i * 0.1 }),

  // ── Dimensional outliers: skills_match peer avg 5, brand_value peer avg 8 ──
  ...Array.from({ length: 5 }, (_, i) => ({
    archetype: 'OutlierArch', company: `OA-${i}`, skills_match: 5, brand_value: 8,
  })),

  // ── Closest comparables: TargetCo excluded, 5 others at varying deltas ──
  { archetype: 'ComparablesArch', company: 'TargetCo', match: 7.0, ease: 7.0 },
  { archetype: 'ComparablesArch', company: 'Near1', match: 7.1, ease: 7.1 },
  { archetype: 'ComparablesArch', company: 'Near2', match: 6.9, ease: 6.9 },
  { archetype: 'ComparablesArch', company: 'Near3', match: 7.3, ease: 7.3 },
  { archetype: 'ComparablesArch', company: 'Far1', match: 4.0, ease: 4.0 },
  { archetype: 'ComparablesArch', company: 'Far2', match: 9.5, ease: 9.5 },

  // ── Compound archetype matching: peers stored under the primary segment ──
  ...peers('Growth Ops', 5),
))

const rank = (input, opts = {}) => peerRank(input, { rows: ROWS, ...opts })
const T = (archetype, extra = {}) => ({ archetype, company: 'Outsider', match: 7.0, ease: 7.0, ...extra })

// ─── Below-gate omission: block is null, never a placeholder ──────────────

test('fewer than 5 same-archetype peers → null (block omitted entirely)', async () => {
  assert.equal(await rank(T('Arch4Peers')), null)
  const d = await peerRankDetailed(T('Arch4Peers'), { rows: ROWS })
  assert.equal(d.reason, 'below-gate')
})

test('exactly minPeers (5) peers → block is rendered, not null', async () => {
  const r = await rank(T('Arch5Peers'))
  assert.notEqual(r, null)
  assert.equal(r.n_peers, 5)
})

test('empty/missing archetype → null with a no-archetype reason', async () => {
  assert.equal(await rank(T('')), null)
  assert.equal(await rank(T(undefined)), null)
  assert.equal((await peerRankDetailed(T(''), { rows: ROWS })).reason, 'no-archetype')
})

test('a custom minPeers option gates the omission rule too', async () => {
  assert.equal(await rank(T('Arch9Peers'), { minPeers: 10 }), null)
})

// ─── Blocked rows and blocked targets ─────────────────────────────────────

test('blocked rows are not peers (4 scored + 3 blocked stays below the gate)', async () => {
  assert.equal(await rank(T('BlockedMix')), null)
  // Lowering the gate shows the pool is exactly the 4 scored rows.
  const r = await rank(T('BlockedMix'), { minPeers: 4 })
  assert.equal(r.n_peers, 4)
})

test('a blocked target (eligibility red) is omitted with a reason', async () => {
  const d = await peerRankDetailed(T('Arch20Peers', { eligibility: 'red', match: null, ease: null }), { rows: ROWS })
  assert.equal(d.block, null)
  assert.equal(d.reason, 'blocked')
  assert.match(d.message, /Blocked/)
})

test('a blocked target via verdict "blocked" is omitted even if numbers are passed', async () => {
  const d = await peerRankDetailed(T('Arch20Peers', { verdict: 'blocked' }), { rows: ROWS })
  assert.equal(d.block, null)
  assert.equal(d.reason, 'blocked')
})

test('a target with no Match / Ease / Priority / dims is omitted as no-score', async () => {
  const d = await peerRankDetailed({ archetype: 'Arch20Peers', company: 'X' }, { rows: ROWS })
  assert.equal(d.reason, 'no-score')
})

// ─── Confidence tiers at the documented boundaries (docs § 3.1 / § 3.2) ───

for (const [arch, n, tier] of [
  ['Arch5Peers', 5, 'low'], ['Arch9Peers', 9, 'low'],
  ['Arch10Peers', 10, 'moderate'], ['Arch19Peers', 19, 'moderate'],
  ['Arch20Peers', 20, 'high'],
]) {
  test(`confidence tier at n=${n} is ${tier}`, async () => {
    const r = await rank(T(arch))
    assert.equal(r.confidence, confidenceTier(n, GATES.peerMinPeers))
    assert.equal(r.confidence, tier)
  })
}

test('min_peers echoes the gate actually applied (default GATES.peerMinPeers)', async () => {
  const r = await rank(T('Arch5Peers'))
  assert.equal(r.min_peers, GATES.peerMinPeers)
})

// ─── Priority rank + Match / Ease placements ───────────────────────────────

test('n_peers, percentile, rank_position follow the documented formula on Priority', async () => {
  // Peers' Priority: 5.0, 5.5, 6.0, 6.5, 7.0. Target √(6.2·6.2) = 6.2 beats 3.
  const r = await rank(T('RankMath', { match: 6.2, ease: 6.2 }))
  assert.equal(r.priority, 6.2)
  assert.equal(r.n_peers, 5)
  assert.equal(r.percentile, 60)
  assert.equal(r.rank_position, 2)
  assert.equal(r.rank, 'top half')
})

test('rank label reads "bottom half (#N of total)" below the 50th percentile', async () => {
  const r = await rank(T('RankMath', { match: 4.5, ease: 4.5 }))
  assert.equal(r.percentile, 0)
  assert.equal(r.rank_position, 5)
  assert.equal(r.rank, 'bottom half (#5 of 5)')
})

test('an explicit priority wins over √(match·ease)', async () => {
  const r = await rank(T('RankMath', { match: 9, ease: 9, priority: 5.2 }))
  assert.equal(r.priority, 5.2)
  assert.equal(r.percentile, 20)
})

test('Match and Ease are placed among peers as separate claims', async () => {
  // Peers: match 6.0–6.4, ease 7.6–8.0. Target match 7.0 (beats all), ease 7.0 (beats none).
  const r = await rank(T('SplitArch', { match: 7.0, ease: 7.0 }))
  assert.equal(r.match.value, 7)
  assert.equal(r.match.percentile, 100)
  assert.equal(r.match.rank, 'top 5%')
  assert.equal(r.match.peer_n, 5)
  assert.equal(r.match.peer_avg, 6.2)
  assert.equal(r.match.confidence, 'low')
  assert.equal(r.ease.percentile, 0)
  assert.equal(r.ease.rank, 'bottom half (#5 of 5)')
  assert.equal(r.ease.peer_avg, 7.8)
})

test('the score-listing.mjs object form ({ score }) is accepted for match / ease', async () => {
  const r = await rank(T('RankMath', { match: { score: 6.2 }, ease: { score: 6.2 } }))
  assert.equal(r.priority, 6.2)
  assert.equal(r.score_source, 'input')
})

test('match / ease are derived from a full set of dims when not given', async () => {
  const dims = { ...BASE_DIMS }
  const t = normalizeTarget({ dims })
  assert.equal(t.match, rollupMatch(dims).score)
  assert.equal(t.ease, rollupEase(dims).score)
  assert.equal(t.priority, computePriority(t.match, t.ease))
  assert.equal(t.scoreSource, 'dims')
  const r = await rank({ archetype: 'Arch20Peers', company: 'X', dims })
  assert.equal(r.score_source, 'dims')
})

test('priority-only input ranks on Priority and omits the Match / Ease claims', async () => {
  const r = await rank({ archetype: 'RankMath', company: 'X', priority: 6.2 })
  assert.equal(r.percentile, 60)
  assert.equal(r.match, null)
  assert.equal(r.ease, null)
})

test('outliers and comparables are present as arrays even when empty', async () => {
  const r = await rank(T('RankMath', { match: 6.2, ease: 6.2 }))
  assert.ok(Array.isArray(r.outliers))
  assert.ok(Array.isArray(r.comparables))
  assert.equal(r.outliers.length, 0)
})

test('primary-archetype matching collapses compound archetypes', async () => {
  const r = await rank(T('Growth Ops + Something Else'))
  assert.notEqual(r, null)
  assert.equal(r.archetype, 'Growth Ops')
  assert.equal(r.n_peers, 5)
})

// ─── formatted rendering ──────────────────────────────────────────────────

test('formatted block states "of N peers", Match · Ease, and is exactly 3 bold lines', async () => {
  const r = await rank(T('Arch10Peers', { match: 8.25, ease: 5.6 }))
  const lines = r.formatted.split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) assert.match(line, /^\*\*/)
  assert.match(r.formatted, /of 10 peers/)
  assert.match(lines[0], /Match 8\.25 · Ease 5\.60/)
  assert.match(lines[0], /by priority \(Match .+, Ease .+\)/)
  assert.doesNotMatch(r.formatted, /\/10/)
  assert.doesNotMatch(r.formatted, /overall/i)
})

test('formatted block appends the low-confidence caveat only at low tier', async () => {
  assert.match((await rank(T('Arch5Peers'))).formatted, /at this sample read the half, not the quartile/)
  assert.doesNotMatch((await rank(T('Arch20Peers'))).formatted, /at this sample read the half/)
})

test('comparables render as M · E, never as a single score', async () => {
  const r = await rank({ archetype: 'ComparablesArch', company: 'TargetCo', match: 7.0, ease: 7.0 })
  assert.match(r.formatted.split('\n')[2], /Near1 \(M7\.10 · E7\.10\)/)
})

// ─── Dimensional outliers over the v2 dims (docs § 3.2) ────────────────────

test('flags a dimension ≥1.5 from the peer average and skips one below threshold', async () => {
  const r = await rank(T('OutlierArch', { dims: { skills_match: 7.2, brand_value: 8.4 } }))
  assert.equal(r.outliers.length, 1)
  const [o] = r.outliers
  assert.equal(o.dim, 'skills_match')
  assert.equal(o.label, 'Skills Match')
  assert.equal(o.group, 'ease')
  assert.equal(o.rollup, 'ease')
  assert.equal(o.peer_avg, 5)
  assert.equal(o.delta, 2.2)
  assert.equal(o.peer_n, 5)
  assert.equal(o.confidence, confidenceTier(5, GATES.peerMinPeers))
})

test('sorts multiple outliers by |delta| descending', async () => {
  const r = await rank(T('OutlierArch', { dims: { skills_match: 8.0, brand_value: 6.4 } }))
  assert.equal(r.outliers.length, 2)
  assert.equal(r.outliers[0].dim, 'skills_match')
  assert.equal(r.outliers[1].dim, 'brand_value')
  assert.equal(r.outliers[1].rollup, 'match')
  assert.ok(r.outliers[0].delta > 0)
  assert.ok(r.outliers[1].delta < 0)
})

test('the v2-only dims (role_content, experience_bar, competition) are compared', async () => {
  // Peers sit at BASE_DIMS: role_content 7, experience_bar 7, competition 6.
  const r = await rank(T('OutlierArch', { dims: { role_content: 3, experience_bar: 9, competition: 6 } }))
  const dims = r.outliers.map(o => o.dim).sort()
  assert.deepEqual(dims, ['experience_bar', 'role_content'])
})

test('a dimension absent from dims is skipped, not treated as a 0', async () => {
  const r = await rank(T('OutlierArch', { dims: { skills_match: 8.0 } }))
  assert.equal(r.outliers.length, 1)
  assert.equal(r.outliers[0].dim, 'skills_match')
})

test('this_dims is accepted as an alias of dims', async () => {
  const r = await rank(T('OutlierArch', { this_dims: { skills_match: 8.0 } }))
  assert.equal(r.outliers[0].dim, 'skills_match')
})

// ─── Closest comparables ──────────────────────────────────────────────────

test('excludes the listing\'s own company and returns the 3 closest by Priority', async () => {
  const r = await rank({ archetype: 'ComparablesArch', company: 'TargetCo', match: 7.0, ease: 7.0 })
  assert.equal(r.comparables.length, 3)
  assert.ok(!r.comparables.some(c => c.company === 'TargetCo'))
  assert.deepEqual(r.comparables.map(c => c.company).sort(), ['Near1', 'Near2', 'Near3'])
  const c = r.comparables.find(x => x.company === 'Near3')
  assert.deepEqual(Object.keys(c).sort(), ['company', 'delta', 'ease', 'match', 'priority', 'role', 'verdict'])
  assert.equal(c.match, 7.3)
  assert.equal(c.delta, 0.3)
  assert.equal(c.verdict, 'solid') // Match 7.3 < 8.0, Ease 7.3 ≥ 7.0
})

test('same-company exclusion is case/whitespace-insensitive', async () => {
  const r = await rank({ archetype: 'ComparablesArch', company: '  targetco  ', match: 7.0, ease: 7.0 })
  assert.ok(!r.comparables.some(c => c.company === 'TargetCo'))
})

// ─── Default history source: data/score-history.tsv under the cwd ─────────

test('reads data/score-history.tsv relative to the cwd at call time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peer-rank-test-'))
  const cwd = process.cwd()
  try {
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'score-history.tsv'), historyTsv(...peers('FileArch', 6)))
    process.chdir(dir)
    const r = await peerRank(T('FileArch'))
    assert.equal(r.n_peers, 6)
    // A missing file reads as an empty pool, not a crash.
    await mkdir(join(dir, 'empty'))
    process.chdir(join(dir, 'empty'))
    assert.equal(await peerRank(T('FileArch')), null)
  } finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
})

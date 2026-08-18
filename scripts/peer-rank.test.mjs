// peer-rank.test.mjs — unit tests for scripts/peer-rank.mjs (the Comparative
// Rank Block computation). Covers the pre-5-peers omission rule, the
// docs/scoring-statistical-design.md confidence-tier contract (§ 3.1 / § 3.2),
// the pre-contract field shape (§ 5 compatibility rule), the formatted
// 3-bold-line render, and dimensional outlier detection.
//
// cwd-binding constraint (verified by direct probe before writing this file):
// peerRank() reads data/score-history.tsv through readTsv() in
// scripts/lib/cache-tsv.mjs, which does `const REPO = process.cwd()` as a
// MODULE-LOAD-TIME top-level statement, not inside readTsv() itself. ESM
// modules are evaluated once and cached, so REPO is fixed forever the first
// time cache-tsv.mjs (directly, or transitively via peer-rank.mjs) is
// imported in this process. A static top-level `import { peerRank } from
// './peer-rank.mjs'` would therefore bind REPO to wherever `node --test` was
// invoked from (the repo root) — every `readTsv('data/score-history.tsv')`
// call would silently miss the fixture written under a temp dir. The fix:
// chdir into the fixture dir FIRST, then `await import('./peer-rank.mjs')`
// so cache-tsv.mjs's top-level `process.cwd()` read happens after the chdir.
// Confirmed empirically: importing before chdir reads zero rows from a
// fixture written after the import; importing after chdir reads it correctly.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATES, confidenceTier } from './lib/scoring-stats.mjs'

const ORIGINAL_CWD = process.cwd()
let FIXTURE_DIR
let peerRank // assigned in before(), after chdir + dynamic import

// ─── Fixture construction ──────────────────────────────────────────────────

const COLS = [
  'archetype', 'company', 'role', 'overall',
  'skills_match', 'ease_of_entry', 'brand_value',
]

function row(over = {}) {
  const base = {
    archetype: 'Strategy & Operations', company: 'PeerCo', role: 'Analyst',
    overall: '7.0', skills_match: '7', ease_of_entry: '7', brand_value: '7',
  }
  const merged = { ...base, ...over }
  return COLS.map(k => merged[k]).join('\t')
}

function tsv(...rows) {
  return [COLS.join('\t'), ...rows].join('\n') + '\n'
}

/** N peers for `archetype`, distinct companies, overall spread so ties are rare. */
function makePeers(archetype, n) {
  return Array.from({ length: n }, (_, i) =>
    row({ archetype, company: `${archetype.replace(/\s+/g, '')}Peer${i}`, overall: (5 + i * 0.1).toFixed(2) }),
  )
}

before(async () => {
  FIXTURE_DIR = await mkdtemp(join(tmpdir(), 'peer-rank-test-'))
  await mkdir(join(FIXTURE_DIR, 'data'), { recursive: true })

  const rows = [
    // ── Gate boundary archetypes (confidenceTier boundaries: g=5, 2g=10, 4g=20) ──
    ...makePeers('Arch4Peers', 4),
    ...makePeers('Arch5Peers', 5),
    ...makePeers('Arch9Peers', 9),
    ...makePeers('Arch10Peers', 10),
    ...makePeers('Arch19Peers', 19),
    ...makePeers('Arch20Peers', 20),

    // ── Rank/percentile math, fixed values (avoids the top-edge beats==n quirk) ──
    row({ archetype: 'RankMath', company: 'RM-A', overall: '5.0' }),
    row({ archetype: 'RankMath', company: 'RM-B', overall: '5.5' }),
    row({ archetype: 'RankMath', company: 'RM-C', overall: '6.0' }),
    row({ archetype: 'RankMath', company: 'RM-D', overall: '6.5' }),
    row({ archetype: 'RankMath', company: 'RM-E', overall: '7.0' }),

    // ── Bottom-half rank label ──
    row({ archetype: 'BottomHalf', company: 'BH-A', overall: '8.0' }),
    row({ archetype: 'BottomHalf', company: 'BH-B', overall: '8.2' }),
    row({ archetype: 'BottomHalf', company: 'BH-C', overall: '8.4' }),
    row({ archetype: 'BottomHalf', company: 'BH-D', overall: '8.6' }),
    row({ archetype: 'BottomHalf', company: 'BH-E', overall: '8.8' }),

    // ── Dimensional outliers: skills_match peer avg 5, brand_value peer avg 8 ──
    row({ archetype: 'OutlierArch', company: 'OA-A', skills_match: '5', brand_value: '8' }),
    row({ archetype: 'OutlierArch', company: 'OA-B', skills_match: '5', brand_value: '8' }),
    row({ archetype: 'OutlierArch', company: 'OA-C', skills_match: '5', brand_value: '8' }),
    row({ archetype: 'OutlierArch', company: 'OA-D', skills_match: '5', brand_value: '8' }),
    row({ archetype: 'OutlierArch', company: 'OA-E', skills_match: '5', brand_value: '8' }),

    // ── Closest comparables: TargetCo excluded, 5 others at varying deltas ──
    row({ archetype: 'ComparablesArch', company: 'TargetCo', overall: '7.0' }),
    row({ archetype: 'ComparablesArch', company: 'Near1', overall: '7.1' }),
    row({ archetype: 'ComparablesArch', company: 'Near2', overall: '6.9' }),
    row({ archetype: 'ComparablesArch', company: 'Near3', overall: '7.3' }),
    row({ archetype: 'ComparablesArch', company: 'Far1', overall: '4.0' }),
    row({ archetype: 'ComparablesArch', company: 'Far2', overall: '9.5' }),

    // ── Compound archetype matching: peer stored under the primary segment only ──
    ...makePeers('Growth Ops', 5),
  ]

  await writeFile(join(FIXTURE_DIR, 'data', 'score-history.tsv'), tsv(...rows))

  process.chdir(FIXTURE_DIR) // MUST happen before the dynamic import below
  ;({ peerRank } = await import('./peer-rank.mjs'))
})

after(async () => {
  process.chdir(ORIGINAL_CWD)
  await rm(FIXTURE_DIR, { recursive: true, force: true })
})

// ─── Below-gate omission: block is null, never a placeholder ──────────────

test('fewer than 5 same-archetype peers → null (block omitted entirely)', async () => {
  const result = await peerRank({ archetype: 'Arch4Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(result, null)
})

test('exactly minPeers (5) peers → block is rendered, not null', async () => {
  const result = await peerRank({ archetype: 'Arch5Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.notEqual(result, null)
  assert.equal(result.n_peers, 5)
})

test('empty/missing archetype → null without touching the peer pool', async () => {
  assert.equal(await peerRank({ archetype: '', company: 'X', this_overall: 7.0, this_dims: {} }), null)
  assert.equal(await peerRank({ archetype: undefined, company: 'X', this_overall: 7.0, this_dims: {} }), null)
})

test('a custom minPeers option gates the omission rule too', async () => {
  // 9 peers clears the default gate (5) but not a caller-supplied gate of 10.
  const gated = await peerRank(
    { archetype: 'Arch9Peers', company: 'X', this_overall: 7.0, this_dims: {} },
    { minPeers: 10 },
  )
  assert.equal(gated, null)
})

// ─── Confidence tiers at the documented boundaries (docs § 3.1 / § 3.2) ───
// g=5: [5,10) low, [10,20) moderate, [20,∞) high. Cross-checked against
// confidenceTier() from scoring-stats.mjs rather than hardcoded strings, so
// this suite breaks if peer-rank's tiering ever drifts from the shared rule.

test('confidence tier at n=5 (gate) is low', async () => {
  const r = await peerRank({ archetype: 'Arch5Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.confidence, confidenceTier(5, GATES.peerMinPeers))
  assert.equal(r.confidence, 'low')
})

test('confidence tier at n=9 (just under 2×gate) is still low', async () => {
  const r = await peerRank({ archetype: 'Arch9Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.confidence, confidenceTier(9, GATES.peerMinPeers))
  assert.equal(r.confidence, 'low')
})

test('confidence tier at n=10 (2×gate boundary) is moderate', async () => {
  const r = await peerRank({ archetype: 'Arch10Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.confidence, confidenceTier(10, GATES.peerMinPeers))
  assert.equal(r.confidence, 'moderate')
})

test('confidence tier at n=19 (just under 4×gate) is still moderate', async () => {
  const r = await peerRank({ archetype: 'Arch19Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.confidence, confidenceTier(19, GATES.peerMinPeers))
  assert.equal(r.confidence, 'moderate')
})

test('confidence tier at n=20 (4×gate boundary) is high', async () => {
  const r = await peerRank({ archetype: 'Arch20Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.confidence, confidenceTier(20, GATES.peerMinPeers))
  assert.equal(r.confidence, 'high')
})

test('min_peers echoes the gate actually applied (default GATES.peerMinPeers)', async () => {
  const r = await peerRank({ archetype: 'Arch5Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.equal(r.min_peers, GATES.peerMinPeers)
})

// ─── Pre-contract fields: unchanged semantics (docs § 5 compatibility rule) ──

test('n_peers, percentile, rank_position follow the documented formula', async () => {
  // Peers: 5.0, 5.5, 6.0, 6.5, 7.0. this_overall = 6.2 beats {5.0,5.5,6.0} = 3.
  const r = await peerRank({ archetype: 'RankMath', company: 'Outsider', this_overall: 6.2, this_dims: {} })
  assert.equal(r.n_peers, 5)
  assert.equal(r.percentile, 60)       // round(3/5 * 100)
  assert.equal(r.rank_position, 2)     // 5 - 3
  assert.equal(r.rank, 'top half')     // percentile >= 50
})

test('rank label reads "bottom half (#N of total)" below the 50th percentile', async () => {
  // Peers: 8.0..8.8 step 0.2. this_overall = 7.5 beats none → percentile 0.
  const r = await peerRank({ archetype: 'BottomHalf', company: 'Outsider', this_overall: 7.5, this_dims: {} })
  assert.equal(r.percentile, 0)
  assert.equal(r.rank_position, 5)     // 5 - 0
  assert.equal(r.rank, 'bottom half (#5 of 5)')
})

test('outliers and comparables are present as arrays even when empty', async () => {
  const r = await peerRank({ archetype: 'RankMath', company: 'Outsider', this_overall: 6.2, this_dims: {} })
  assert.ok(Array.isArray(r.outliers))
  assert.ok(Array.isArray(r.comparables))
  assert.equal(r.outliers.length, 0)   // this_dims is empty, nothing to compare
})

test('primary-archetype matching collapses compound archetypes on both sides', async () => {
  // Peers were seeded under the plain "Growth Ops" archetype; querying with a
  // compound "Growth Ops + Something Else" must still match via the ' + ' split,
  // case-insensitively.
  const r = await peerRank({ archetype: 'Growth Ops + Something Else', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.notEqual(r, null)
  assert.equal(r.archetype, 'Growth Ops + Something Else'.split(' + ')[0].trim())
  assert.equal(r.n_peers, 5)
})

// ─── formatted rendering: "of N peers" + the fixed 3-bold-line block shape ──

test('formatted block states "of N peers" and is exactly 3 bold-prefixed lines', async () => {
  const r = await peerRank({ archetype: 'Arch10Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  const lines = r.formatted.split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) assert.match(line, /^\*\*/)
  assert.match(r.formatted, /of 10 peers/)
})

test('formatted block appends the low-confidence caveat only at low tier', async () => {
  const low = await peerRank({ archetype: 'Arch5Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.match(low.formatted, /at this sample read the half, not the quartile/)

  const high = await peerRank({ archetype: 'Arch20Peers', company: 'X', this_overall: 7.0, this_dims: {} })
  assert.doesNotMatch(high.formatted, /at this sample read the half/)
})

// ─── Dimensional outlier detection (docs § 3.2) ────────────────────────────

test('flags a dimension ≥1.5 from the peer average and skips one below threshold', async () => {
  // Peer pool: skills_match avg 5, brand_value avg 8.
  const r = await peerRank(
    { archetype: 'OutlierArch', company: 'Outsider', this_overall: 7.0, this_dims: { skills_match: 7.2, brand_value: 8.4 } },
    // skills_match delta = 2.2 (≥1.5 → outlier), brand_value delta = 0.4 (<1.5 → not)
  )
  assert.equal(r.outliers.length, 1)
  const [o] = r.outliers
  assert.equal(o.dim, 'skills_match')
  assert.equal(o.label, 'Skills Match')
  assert.equal(o.peer_avg, 5)
  assert.equal(o.delta, 2.2)
  assert.equal(o.peer_n, 5)
  assert.equal(o.confidence, confidenceTier(5, GATES.peerMinPeers))
})

test('sorts multiple outliers by |delta| descending', async () => {
  // skills_match delta = +3.0 (peer avg 5, this 8.0), brand_value delta = -1.6 (peer avg 8, this 6.4).
  const r = await peerRank(
    { archetype: 'OutlierArch', company: 'Outsider', this_overall: 7.0, this_dims: { skills_match: 8.0, brand_value: 6.4 } },
  )
  assert.equal(r.outliers.length, 2)
  assert.equal(r.outliers[0].dim, 'skills_match')  // |3.0| > |1.6|
  assert.equal(r.outliers[1].dim, 'brand_value')
  assert.ok(r.outliers[0].delta > 0)
  assert.ok(r.outliers[1].delta < 0)
})

test('a dimension absent from this_dims is skipped, not treated as a 0', async () => {
  const r = await peerRank(
    { archetype: 'OutlierArch', company: 'Outsider', this_overall: 7.0, this_dims: { skills_match: 8.0 } },
  )
  // brand_value was never supplied — it must not be silently defaulted to 0
  // (which, against a peer avg of 8, would otherwise read as a huge outlier).
  assert.equal(r.outliers.length, 1)
  assert.equal(r.outliers[0].dim, 'skills_match')
  assert.ok(!r.outliers.some(o => o.dim === 'brand_value'))
})

// ─── Closest comparables: same-company exclusion + 3-closest-by-delta ─────

test('excludes the listing\'s own company and returns the 3 closest by overall', async () => {
  const r = await peerRank({ archetype: 'ComparablesArch', company: 'TargetCo', this_overall: 7.0, this_dims: {} })
  assert.equal(r.comparables.length, 3)
  assert.ok(!r.comparables.some(c => c.company === 'TargetCo'))
  // Deltas from 7.0: Near1=0.1, Near2=0.1, Near3=0.3, Far1=3.0, Far2=2.5 → closest 3 exclude the two Far*.
  const companies = r.comparables.map(c => c.company).sort()
  assert.deepEqual(companies, ['Near1', 'Near2', 'Near3'])
})

test('same-company exclusion is case/whitespace-insensitive', async () => {
  const r = await peerRank({ archetype: 'ComparablesArch', company: '  targetco  ', this_overall: 7.0, this_dims: {} })
  assert.ok(!r.comparables.some(c => c.company === 'TargetCo'))
})

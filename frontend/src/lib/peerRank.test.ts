import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  peerContext, primaryArchetype, dedupeLatestPerEntity,
  peerBand, compactRankLabel, buildPeerRankIndex,
  MIN_PEERS, OUTLIER_THRESHOLD, PEER_DIMS,
} from '@/lib/peerRank'
import { GATES } from '@/lib/scoringStats'
import { makeScoreEntry } from '@/test-utils/fixtures'
import type { ScoreEntry } from '@/types'

// Small cohort builder: N distinct-entity rows sharing one archetype.
function cohort(
  archetype: string,
  specs: Array<Partial<ScoreEntry> & { company: string; overall: number }>,
): ScoreEntry[] {
  return specs.map((s, i) =>
    makeScoreEntry({
      archetype,
      role: `Analyst ${i}`,          // distinct roles → distinct entities
      location: 'Berlin',
      date: '2026-05-01',
      ...s,
    }),
  )
}

// ─── primaryArchetype ─────────────────────────────────────────────────────────

test('primaryArchetype takes the first " + " segment', () => {
  assert.equal(primaryArchetype('Technology Consulting + AI Transformation'), 'Technology Consulting')
  assert.equal(primaryArchetype('Solo Archetype'), 'Solo Archetype')
  assert.equal(primaryArchetype(null), '')
})

test('primaryArchetype does NOT split on "&" or "/"', () => {
  assert.equal(primaryArchetype('Strategy & Operations'), 'Strategy & Operations')
  assert.equal(primaryArchetype('Tech Sales / Solutions Consultant'), 'Tech Sales / Solutions Consultant')
})

// ─── dedupeLatestPerEntity ────────────────────────────────────────────────────

test('dedupeLatestPerEntity keeps only the latest row per entity', () => {
  const older = makeScoreEntry({ company: 'Acme', role: 'Analyst', location: 'Berlin', date: '2026-04-01', overall: 6.0 })
  const newer = makeScoreEntry({ company: 'Acme', role: 'Analyst', location: 'Berlin', date: '2026-05-01', overall: 7.2 })
  const other = makeScoreEntry({ company: 'Beta', role: 'Analyst', location: 'Berlin', date: '2026-04-15', overall: 5.5 })
  const map = dedupeLatestPerEntity([older, newer, other])
  assert.equal(map.size, 2)
  const overalls = [...map.values()].map(r => r.overall).sort()
  assert.deepEqual(overalls, [5.5, 7.2])
})

test('dedupeLatestPerEntity drops rows without a usable overall', () => {
  const map = dedupeLatestPerEntity([
    makeScoreEntry({ company: 'Acme', overall: 0 }),
    makeScoreEntry({ company: 'Beta', overall: NaN }),
  ])
  assert.equal(map.size, 0)
})

// ─── cohort gating ────────────────────────────────────────────────────────────

test('returns null below MIN_PEERS cohort size', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 7 },
    { company: 'B', overall: 6 },
    { company: 'C', overall: 5 },
    { company: 'D', overall: 8 },
  ])
  // self (A) + 3 others = 4 < 5
  assert.equal(peerContext(rows[0], rows), null)
  assert.equal(MIN_PEERS, 5)
})

test('returns null when the entry has no overall score or archetype', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 7 }, { company: 'B', overall: 6 },
    { company: 'C', overall: 5 }, { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 },
  ])
  assert.equal(peerContext(makeScoreEntry({ archetype: 'Ops', overall: 0 }), rows), null)
  assert.equal(peerContext(makeScoreEntry({ archetype: '', overall: 7 }), rows), null)
})

test('archetype matching is case-insensitive and on the primary segment', () => {
  const rows = [
    ...cohort('strategy & operations', [
      { company: 'B', overall: 6 }, { company: 'C', overall: 5 },
      { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 },
    ]),
    // Hybrid whose primary segment matches
    makeScoreEntry({ company: 'F', role: 'Hybrid', archetype: 'Strategy & Operations + Data', overall: 6.5, location: 'Paris' }),
    // Different archetype — excluded
    makeScoreEntry({ company: 'G', role: 'Nope', archetype: 'Tech Sales', overall: 9.9, location: 'Paris' }),
  ]
  const self = makeScoreEntry({ company: 'A', role: 'Self', archetype: 'Strategy & Operations', overall: 7, location: 'Berlin' })
  const ctx = peerContext(self, [...rows, self])
  assert.ok(ctx)
  assert.equal(ctx.nPeers, 6)          // self + 5 matching, G excluded
  assert.equal(ctx.archetype, 'Strategy & Operations')
})

// ─── rank / percentile ────────────────────────────────────────────────────────

test('rank and percentile follow the script math (ties rank below)', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 8.0 },   // self
    { company: 'B', overall: 6.0 },
    { company: 'C', overall: 7.0 },
    { company: 'D', overall: 8.0 },   // tie with self
    { company: 'E', overall: 9.0 },
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.equal(ctx.nPeers, 5)
  // beats = 2 (B, C) → percentile 40, rank = 5 − 2 = 3 (E above, D tied)
  assert.equal(ctx.percentile, 40)
  assert.equal(ctx.rankPosition, 3)
  assert.match(ctx.rankLabel, /bottom half/)
  assert.deepEqual([...ctx.peerOveralls].sort(), [6, 7, 8, 9])
})

test('top of the cohort gets a top-N% label', () => {
  const others = Array.from({ length: 19 }, (_, i) => ({ company: `P${i}`, overall: 5 + i * 0.1 }))
  const rows = cohort('Ops', [{ company: 'Self', overall: 9.5 }, ...others])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.equal(ctx.rankPosition, 1)
  assert.equal(ctx.percentile, 95)
  assert.equal(ctx.rankLabel, 'top 5%')
})

test('re-evaluated peers count once, at their latest score', () => {
  const rows = [
    ...cohort('Ops', [
      { company: 'A', overall: 7.0 },
      { company: 'B', overall: 6.0, date: '2026-04-01' },
      { company: 'C', overall: 5.0 }, { company: 'D', overall: 5.5 }, { company: 'E', overall: 5.2 },
    ]),
    // B re-evaluated later, now ABOVE self — must replace, not add
    makeScoreEntry({ archetype: 'Ops', company: 'B', role: 'Analyst 1', location: 'Berlin', date: '2026-06-01', overall: 8.0 }),
  ]
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.equal(ctx.nPeers, 5)              // B not double-counted
  assert.equal(ctx.rankPosition, 2)        // only B(8.0) above
})

// ─── dimension deltas ─────────────────────────────────────────────────────────

test('dim deltas compare against the OTHER peers and flag ±1.5 outliers', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 8, skills_match: 9, brand_value: 4 },
    { company: 'B', overall: 6, skills_match: 6, brand_value: 7 },
    { company: 'C', overall: 6, skills_match: 7, brand_value: 7 },
    { company: 'D', overall: 6, skills_match: 6, brand_value: 7 },
    { company: 'E', overall: 6, skills_match: 5, brand_value: 7 },
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  const skills = ctx.deltas.find(d => d.dim === 'skills_match')
  assert.ok(skills)
  assert.equal(skills.peerAvg, 6)          // (6+7+6+5)/4 — self excluded
  assert.equal(skills.delta, 3)
  assert.equal(skills.outlier, true)
  const brand = ctx.deltas.find(d => d.dim === 'brand_value')
  assert.ok(brand)
  assert.equal(brand.delta, -3)
  assert.equal(brand.outlier, true)
  // Sorted strongest advantage first, biggest lag last
  assert.equal(ctx.deltas[0].dim, 'skills_match')
  assert.equal(ctx.deltas[ctx.deltas.length - 1].dim, 'brand_value')
  assert.equal(OUTLIER_THRESHOLD, 1.5)
})

test('dims the entry has not scored (0) are skipped, not treated as gaps', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 8, skills_match: 8 },   // all other dims 0
    { company: 'B', overall: 6, skills_match: 6, brand_value: 7 },
    { company: 'C', overall: 6, skills_match: 7, brand_value: 7 },
    { company: 'D', overall: 6, skills_match: 6, brand_value: 7 },
    { company: 'E', overall: 6, skills_match: 5, brand_value: 7 },
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.deepEqual(ctx.deltas.map(d => d.dim), ['skills_match'])
  assert.ok(PEER_DIMS.length === 6)
})

test('sub-outlier deltas are reported but not flagged', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 7, strategic_fit: 7 },
    { company: 'B', overall: 6, strategic_fit: 6 },
    { company: 'C', overall: 6, strategic_fit: 7 },
    { company: 'D', overall: 6, strategic_fit: 6 },
    { company: 'E', overall: 6, strategic_fit: 7 },
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  const sf = ctx.deltas.find(d => d.dim === 'strategic_fit')
  assert.ok(sf)
  assert.equal(sf.delta, 0.5)
  assert.equal(sf.outlier, false)
})

// ─── comparables ──────────────────────────────────────────────────────────────

test('comparables exclude the same company, sort by closeness, cap at 3', () => {
  const rows = cohort('Ops', [
    { company: 'Self', overall: 7.0 },
    { company: 'Self', overall: 7.1, role: 'Other Role' },  // same company — excluded
    { company: 'B', overall: 6.9 },
    { company: 'C', overall: 7.3 },
    { company: 'D', overall: 5.0 },
    { company: 'E', overall: 7.05 },
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.equal(ctx.comparables.length, 3)
  assert.deepEqual(ctx.comparables.map(c => c.company), ['E', 'B', 'C'])
  assert.ok(ctx.comparables.every(c => c.company !== 'Self'))
})

// ─── peerBand / compactRankLabel ──────────────────────────────────────────────

test('peerBand thresholds match the rankLabel bands', () => {
  assert.equal(peerBand(100), 'top5')
  assert.equal(peerBand(95),  'top5')
  assert.equal(peerBand(94),  'top10')
  assert.equal(peerBand(90),  'top10')
  assert.equal(peerBand(89),  'quartile')
  assert.equal(peerBand(75),  'quartile')
  assert.equal(peerBand(74),  'half')
  assert.equal(peerBand(50),  'half')
  assert.equal(peerBand(49),  'bottom')
  assert.equal(peerBand(0),   'bottom')
})

test('compactRankLabel maps bands to chip text', () => {
  assert.equal(compactRankLabel('top5', 1, 20),     'top 5%')
  assert.equal(compactRankLabel('top10', 2, 20),    'top 10%')
  assert.equal(compactRankLabel('quartile', 4, 20), 'top 25%')
  assert.equal(compactRankLabel('half', 8, 20),     'top 50%')
  assert.equal(compactRankLabel('bottom', 17, 20),  '#17/20')
})

// ─── buildPeerRankIndex — parity with peerContext ────────────────────────────
//
// The Database column renders from the batched index; the slide-over panel
// renders from peerContext. These tests pin the two to identical rank math so
// the surfaces can never disagree.

function assertRankParity(entry: ScoreEntry, history: ScoreEntry[], msg?: string) {
  const ctx = peerContext(entry, history)
  const summary = buildPeerRankIndex(history).rankOf(entry)
  if (ctx == null) {
    assert.equal(summary, null, msg)
    return
  }
  assert.ok(summary, msg)
  assert.equal(summary.archetype,    ctx.archetype,    msg)
  assert.equal(summary.nPeers,       ctx.nPeers,       msg)
  assert.equal(summary.rankPosition, ctx.rankPosition, msg)
  assert.equal(summary.percentile,   ctx.percentile,   msg)
  assert.equal(summary.rankLabel,    ctx.rankLabel,    msg)
  assert.equal(summary.band, peerBand(ctx.percentile), msg)
  // Contract fields must agree too, or the chip and the panel could state
  // different confidence for the same cohort.
  assert.equal(summary.confidence, ctx.confidence, msg)
  assert.equal(summary.minPeers,   ctx.minPeers,   msg)
}

test('rankOf matches peerContext on a plain cohort with ties', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 8.0 },
    { company: 'B', overall: 6.0 },
    { company: 'C', overall: 7.0 },
    { company: 'D', overall: 8.0 },   // tie with A
    { company: 'E', overall: 9.0 },
  ])
  for (const r of rows) assertRankParity(r, rows, `row ${r.company}`)
})

test('rankOf matches peerContext when peers were re-evaluated', () => {
  const rows = [
    ...cohort('Ops', [
      { company: 'A', overall: 7.0 },
      { company: 'B', overall: 6.0, date: '2026-04-01' },
      { company: 'C', overall: 5.0 }, { company: 'D', overall: 5.5 }, { company: 'E', overall: 5.2 },
    ]),
    makeScoreEntry({ archetype: 'Ops', company: 'B', role: 'Analyst 1', location: 'Berlin', date: '2026-06-01', overall: 8.0 }),
  ]
  for (const r of rows) assertRankParity(r, rows, `row ${r.company}@${r.date}`)
})

test('rankOf matches peerContext on hybrid / case-varied archetypes', () => {
  const rows = [
    ...cohort('strategy & operations', [
      { company: 'B', overall: 6 }, { company: 'C', overall: 5 },
      { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 },
    ]),
    makeScoreEntry({ company: 'F', role: 'Hybrid', archetype: 'Strategy & Operations + Data', overall: 6.5, location: 'Paris' }),
    makeScoreEntry({ company: 'G', role: 'Nope', archetype: 'Tech Sales', overall: 9.9, location: 'Paris' }),
    makeScoreEntry({ company: 'A', role: 'Self', archetype: 'Strategy & Operations', overall: 7, location: 'Berlin' }),
  ]
  for (const r of rows) assertRankParity(r, rows, `row ${r.company}`)
})

test('rankOf honors the MIN_PEERS omit rule exactly at the boundary', () => {
  const four = cohort('Ops', [
    { company: 'A', overall: 7 }, { company: 'B', overall: 6 },
    { company: 'C', overall: 5 }, { company: 'D', overall: 8 },
  ])
  assert.equal(buildPeerRankIndex(four).rankOf(four[0]), null)   // 4 < 5
  const five = [...four, makeScoreEntry({ archetype: 'Ops', company: 'E', role: 'Analyst 4', location: 'Berlin', overall: 7.5 })]
  const summary = buildPeerRankIndex(five).rankOf(five[0])
  assert.ok(summary)
  assert.equal(summary.nPeers, 5)
  assertRankParity(five[0], five)
})

test('rankOf returns null for unscored or archetype-less entries', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 7 }, { company: 'B', overall: 6 },
    { company: 'C', overall: 5 }, { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 },
  ])
  const idx = buildPeerRankIndex(rows)
  assert.equal(idx.rankOf(makeScoreEntry({ archetype: 'Ops', overall: 0 })), null)
  assert.equal(idx.rankOf(makeScoreEntry({ archetype: '', overall: 7 })), null)
})

test('rankOf matches peerContext for an entry NOT present in the history', () => {
  const rows = cohort('Ops', [
    { company: 'B', overall: 6 }, { company: 'C', overall: 5 },
    { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 }, { company: 'F', overall: 6.8 },
  ])
  const outsider = makeScoreEntry({ company: 'X', role: 'New Role', archetype: 'Ops', overall: 7.2, location: 'Madrid' })
  assertRankParity(outsider, rows)
  // Outsider joins as the +1: 5 peers in history + itself
  const summary = buildPeerRankIndex(rows).rankOf(outsider)
  assert.ok(summary)
  assert.equal(summary.nPeers, 6)
})

test('rankOf ranks the PASSED overall, like peerContext, when it differs from the deduped-latest row', () => {
  const rows = cohort('Ops', [
    { company: 'A', overall: 8.5, date: '2026-06-01' },
    { company: 'B', overall: 6 }, { company: 'C', overall: 5 },
    { company: 'D', overall: 8 }, { company: 'E', overall: 7.5 },
  ])
  // Caller holds A's OLDER evaluation (5.5) — both surfaces rank that value,
  // with A's latest row (8.5) excluded from the cohort as "self".
  const staleA = makeScoreEntry({ archetype: 'Ops', company: 'A', role: 'Analyst 0', location: 'Berlin', date: '2026-04-01', overall: 5.5 })
  assertRankParity(staleA, rows)
  const summary = buildPeerRankIndex(rows).rankOf(staleA)
  assert.ok(summary)
  assert.equal(summary.nPeers, 5)          // A counted once (as self), not twice
  assert.equal(summary.rankPosition, 4)    // beats only C(5.0); B/D/E at-or-above
})

test('rankOf parity sweep across a mixed multi-archetype landscape', () => {
  const rows: ScoreEntry[] = []
  for (let i = 0; i < 24; i++) {
    rows.push(makeScoreEntry({
      archetype: i % 3 === 0 ? 'Ops' : i % 3 === 1 ? 'Ops + Data' : 'Tech Sales',
      company: `Co${i % 8}`,
      role: `Role ${i % 6}`,
      location: i % 2 === 0 ? 'Berlin' : 'Madrid',
      date: `2026-0${(i % 6) + 1}-15`,
      overall: (i * 37) % 60 / 10 + 4,     // deterministic 4.0–9.9 spread with ties
    }))
  }
  for (const r of rows) {
    assertRankParity(r, rows, `${r.company}|${r.role}|${r.location}|${r.date}`)
  }
})

// ─── Statistical contract (docs/scoring-statistical-design.md § 3.2) ─────────
//
// The omission gate is unchanged; what's new is that every result carries the
// n it rests on and the confidence tier over that n, and that a dimension
// outlier carries its OWN n when fewer peers scored that dimension.

test('the omit gate is the contract gate, not a local literal', () => {
  assert.equal(MIN_PEERS, GATES.peerMinPeers)
  assert.equal(MIN_PEERS, 5)
})

// Cohort of exactly `size` distinct entities sharing one archetype, self first.
function cohortOfSize(size: number, selfOverall = 7): ScoreEntry[] {
  return cohort('Ops', [
    { company: 'Self', overall: selfOverall },
    ...Array.from({ length: size - 1 }, (_, i) => ({ company: `P${i}`, overall: 5 + (i % 5) * 0.1 })),
  ])
}

test('confidence tiers land exactly on the 5 / 10 / 20 peer boundaries', () => {
  const at = (n: number) => {
    const rows = cohortOfSize(n)
    const ctx = peerContext(rows[0], rows)
    assert.ok(ctx, `cohort of ${n} should render`)
    assert.equal(ctx.nPeers, n)
    return ctx.confidence
  }
  assert.equal(at(5),  'low')       // ← gate: the block renders, at its weakest
  assert.equal(at(9),  'low')
  assert.equal(at(10), 'moderate')  // ← 2× gate
  assert.equal(at(19), 'moderate')
  assert.equal(at(20), 'high')      // ← 4× gate
  assert.equal(at(40), 'high')
})

test('one peer below the gate renders nothing at all — no partial block', () => {
  const four = cohortOfSize(4)
  assert.equal(peerContext(four[0], four), null)
  assert.equal(buildPeerRankIndex(four).rankOf(four[0]), null)
})

test('the batched index reports the same tier as the panel at each boundary', () => {
  for (const n of [5, 9, 10, 19, 20]) {
    const rows = cohortOfSize(n)
    const ctx = peerContext(rows[0], rows)
    const summary = buildPeerRankIndex(rows).rankOf(rows[0])
    assert.ok(ctx && summary)
    assert.equal(summary.confidence, ctx.confidence, `n=${n}`)
    assert.equal(summary.nPeers, n)
  }
})

test('a dimension scored by fewer peers carries its own n and its own tier', () => {
  // 12 entities in the cohort; only 4 of the OTHER 11 scored strategic_fit,
  // so that dimension is weaker evidence than the block it sits in.
  const rows = cohort('Ops', [
    { company: 'Self', overall: 8, skills_match: 8, strategic_fit: 9 },
    ...Array.from({ length: 11 }, (_, i) => ({
      company: `P${i}`,
      overall: 6,
      skills_match: 6,
      ...(i < 4 ? { strategic_fit: 6 } : {}),
    })),
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  assert.equal(ctx.nPeers, 12)
  assert.equal(ctx.confidence, 'moderate')          // 12 peers, gate 5

  const skills = ctx.deltas.find(d => d.dim === 'skills_match')
  assert.ok(skills)
  assert.equal(skills.peerN, 11)                    // every other peer scored it
  assert.equal(skills.confidence, 'moderate')

  const sf = ctx.deltas.find(d => d.dim === 'strategic_fit')
  assert.ok(sf)
  assert.equal(sf.peerN, 4)                         // sparser than the cohort
  assert.equal(sf.confidence, 'insufficient')       // 4 < the 5-peer gate
  assert.equal(sf.delta, 3)
  assert.equal(sf.outlier, true)                    // still an outlier — a weaker one
})

test('the outlier threshold stays in RAW rubric points, not Overall points', () => {
  // 1.5 raw dimension points is deliberately unrelated to the 0.30 Overall
  // noise floor — confusing the two is the failure mode the contract names.
  assert.equal(OUTLIER_THRESHOLD, 1.5)
  const rows = cohort('Ops', [
    { company: 'Self', overall: 7, skills_match: 7.4 },
    ...Array.from({ length: 4 }, (_, i) => ({ company: `P${i}`, overall: 7, skills_match: 6 })),
  ])
  const ctx = peerContext(rows[0], rows)
  assert.ok(ctx)
  const sm = ctx.deltas.find(d => d.dim === 'skills_match')
  assert.ok(sm)
  assert.equal(sm.delta, 1.4)
  assert.equal(sm.outlier, false)   // 1.4 < 1.5, even though it dwarfs 0.30
})

test('every rendered peer result exposes the sample a renderer must print', () => {
  const rows = cohortOfSize(7)
  const ctx = peerContext(rows[0], rows)
  const summary = buildPeerRankIndex(rows).rankOf(rows[0])
  assert.ok(ctx && summary)
  // n, the gate, and the tier — the three things docs § 4 rule 1 requires.
  assert.equal(typeof ctx.nPeers, 'number')
  assert.equal(ctx.minPeers, GATES.peerMinPeers)
  assert.ok(['low', 'moderate', 'high'].includes(ctx.confidence))
  assert.equal(summary.minPeers, GATES.peerMinPeers)
})

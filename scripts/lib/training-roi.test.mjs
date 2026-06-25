// Unit tests for scripts/lib/training-roi.mjs — the deterministic ROI engine
// behind the `training` mode. It reuses targeting-core's dimensionDrag /
// archetypePerformance, so these tests pin the training-specific logic:
// dimension-key normalization, gap relevance scoring, archetype matching,
// effort banding, and the WORTH_IT / TIMEBOX / SKIP verdict tree.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from './targeting-core.mjs'
import {
  normalizeDimensionKey,
  gapRelevance,
  targetingRelevance,
  effortProfile,
  trainingVerdict,
} from './training-roi.mjs'

const HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

const COLS = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
]

function row(over = {}) {
  const base = {
    date: '2026-05-01', archetype: 'Data Analyst',
    skills_match: 8, ease_of_entry: 8, strategic_fit: 8, current_fit: 8,
    growth_mobility: 7, optionality_exit: 7, brand_value: 7, sales_trap_risk: 8,
    aspirational_fit: 7, overall: 7.7, best_cities: 'Madrid', salary_adj_city: 6,
    work_life_balance: 7, best_fit_roles: 'Analyst', mode: 'scouting',
    company: 'Acme', role: 'Analyst', tier: 'T2', source: 'pipeline',
    location: 'Madrid', employment_type: 'full-time', duration: 'permanent',
    salary_raw: 'n/d', url: 'https://x',
  }
  const merged = { ...base, ...over }
  return COLS.map((k) => merged[k]).join('\t')
}

function tsv(...rows) {
  return [HEADER, ...rows].join('\n')
}

// A corpus where Ease of Entry is a clear systemic drag (averages ~3, low in
// every eval) while every other dimension is healthy (~8). Archetype is a
// dense "Strategy & Operations" landscape.
function easeDragCorpus() {
  const rows = []
  for (let i = 0; i < 10; i++) {
    rows.push(row({
      archetype: 'Strategy & Operations',
      ease_of_entry: 3, skills_match: 8, strategic_fit: 8,
      growth_mobility: 8, optionality_exit: 8, brand_value: 8,
      overall: 7.0,
    }))
  }
  return parseScoreHistory(tsv(...rows))
}

// ───── normalizeDimensionKey ─────────────────────────────────────────────
test('normalizeDimensionKey maps loose aliases to canonical keys', () => {
  assert.equal(normalizeDimensionKey('ease of entry'), 'ease_of_entry')
  assert.equal(normalizeDimensionKey('EoE'), 'ease_of_entry')
  assert.equal(normalizeDimensionKey('skills'), 'skills_match')
  assert.equal(normalizeDimensionKey('brand'), 'brand_value')
  assert.equal(normalizeDimensionKey('analytical fit'), 'strategic_fit')
  assert.equal(normalizeDimensionKey('growth_mobility'), 'growth_mobility')
})

test('normalizeDimensionKey returns null for unknown tokens', () => {
  assert.equal(normalizeDimensionKey('blockchain'), null)
  assert.equal(normalizeDimensionKey(''), null)
  assert.equal(normalizeDimensionKey(null), null)
})

// ───── gapRelevance ──────────────────────────────────────────────────────
test('gapRelevance flags a targeted systemic drag with a high gapScore', () => {
  const rows = easeDragCorpus()
  const g = gapRelevance(rows, ['ease_of_entry'])
  assert.ok(g.best, 'has a best gap')
  assert.equal(g.best.key, 'ease_of_entry')
  assert.equal(g.best.dragRank, 1, 'ease of entry is the #1 drag')
  assert.equal(g.best.isSystemicDrag, true)
  assert.ok(g.best.gapScore > 0.5, `gapScore should be high, got ${g.best.gapScore}`)
})

test('gapRelevance: a healthy dimension is not a systemic drag', () => {
  const rows = easeDragCorpus()
  const g = gapRelevance(rows, ['brand_value'])
  assert.equal(g.best.key, 'brand_value')
  assert.equal(g.best.isSystemicDrag, false)
  assert.ok(g.best.gapScore < 0.3, `healthy dim gapScore should be low, got ${g.best.gapScore}`)
})

test('gapRelevance drops dimensions with no data in the corpus', () => {
  const rows = easeDragCorpus()
  const g = gapRelevance(rows, ['ease_of_entry', 'blockchain_unknown'])
  // unknown was already filtered by the caller normally; here it just isn't a
  // real dimension key so dimensionDrag never produced it.
  assert.equal(g.targeted.length, 1)
  assert.equal(g.targeted[0].key, 'ease_of_entry')
})

// ───── targetingRelevance ────────────────────────────────────────────────
test('targetingRelevance matches mapped archetypes against the corpus', () => {
  const rows = easeDragCorpus()
  const t = targetingRelevance(rows, ['Strategy & Operations'])
  assert.ok(t.best, 'matched an archetype')
  assert.equal(t.best.archetype, 'Strategy & Operations')
  assert.equal(t.best.count, 10)
  assert.equal(t.landscapeShare, 100)
})

test('targetingRelevance reports archetypes absent from the corpus', () => {
  const rows = easeDragCorpus()
  const t = targetingRelevance(rows, ['Blockchain Engineering'])
  assert.equal(t.best, null)
  assert.deepEqual(t.unmatched, ['Blockchain Engineering'])
})

test('targetingRelevance does substring/primary-segment matching', () => {
  const rows = parseScoreHistory(tsv(
    row({ archetype: 'Strategy & Operations / BizOps' }),
    row({ archetype: 'Strategy & Operations / BizOps' }),
  ))
  const t = targetingRelevance(rows, ['Strategy & Operations'])
  assert.ok(t.best, 'requested primary segment matched the compound archetype')
})

// ───── effortProfile ─────────────────────────────────────────────────────
test('effortProfile bands total hours correctly', () => {
  assert.equal(effortProfile({ weeks: 1, hoursPerWeek: 10 }).band, 'micro') // 10h
  assert.equal(effortProfile({ weeks: 4, hoursPerWeek: 10 }).band, 'light') // 40h
  assert.equal(effortProfile({ weeks: 10, hoursPerWeek: 10 }).band, 'heavy') // 100h
  assert.equal(effortProfile({ weeks: 12, hoursPerWeek: 20 }).band, 'major') // 240h
})

test('effortProfile clamps negatives and computes total + cost', () => {
  const e = effortProfile({ weeks: -3, hoursPerWeek: 8, costEur: -50 })
  assert.equal(e.totalHours, 0)
  assert.equal(e.costEur, 0)
  assert.equal(e.weeks, 0)
})

// ───── trainingVerdict ───────────────────────────────────────────────────
test('WORTH_IT: closes the systemic drag, matches a real archetype, proportionate effort, has artifact', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8, // 48h → light
    producesArtifact: true,
  })
  assert.equal(v.verdict, 'WORTH_IT')
  assert.equal(v.signals.attacksDrag, true)
  assert.equal(v.signals.archMatches, true)
  assert.ok(v.trace.length >= 3)
  assert.match(v.headline, /Ease of Entry/)
})

test('SKIP: targets a dimension that is not dragging anything', () => {
  const rows = easeDragCorpus() // brand_value is healthy (~8)
  const v = trainingVerdict(rows, {
    targetDimensions: ['brand'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 8, hoursPerWeek: 10,
    producesArtifact: true,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  // Context should still point at the dimension the user SHOULD target.
  assert.equal(v.context.topDrag.key, 'ease_of_entry')
})

test('SKIP: maps to an archetype absent from the corpus', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Blockchain Engineering'],
    weeks: 4, hoursPerWeek: 8,
    producesArtifact: true,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.archMatches, false)
})

test('TIMEBOX: right gap + archetype but the offer is over-scoped (major effort, modest gap breadth)', () => {
  // Build a corpus where ease of entry is only a MODERATE drag: avg ~5.5,
  // low (≤4) in 0% of evals — systemic by the avg<6 rule but a smaller gap,
  // so a bootcamp-scale (major) effort is disproportionate.
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 8 }, () => row({
      archetype: 'Strategy & Operations',
      ease_of_entry: 5, skills_match: 8, strategic_fit: 8,
      growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    })),
  ))
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 16, hoursPerWeek: 15, // 240h → major
    producesArtifact: true,
  })
  assert.equal(v.signals.attacksDrag, true)
  assert.equal(v.signals.archMatches, true)
  assert.equal(v.signals.proportionate, false)
  assert.equal(v.verdict, 'TIMEBOX')
})

test('TIMEBOX: right gap + archetype + proportionate but thin credential signal (no artifact, weak brand, modest gapScore)', () => {
  // Moderate drag (avg 5, low in 0%) → gapScore < 0.5; light effort is
  // proportionate; but no artifact and weak brand → not enough for WORTH_IT.
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 8 }, () => row({
      archetype: 'Strategy & Operations',
      ease_of_entry: 5, skills_match: 8, strategic_fit: 8,
      growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    })),
  ))
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 2, hoursPerWeek: 5, // 10h → micro, proportionate
    producesArtifact: false,
    brandStrength: 3,
  })
  assert.equal(v.signals.proportionate, true)
  assert.equal(v.signals.gapScore < 0.5, true)
  assert.equal(v.verdict, 'TIMEBOX')
})

test('verdict is deterministic — same offer + corpus yields identical result', () => {
  const rows = easeDragCorpus()
  const offer = {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8, producesArtifact: true,
  }
  const a = trainingVerdict(rows, offer)
  const b = trainingVerdict(rows, offer)
  assert.deepEqual(a, b)
})

test('unknown dimension tokens are surfaced, not silently dropped', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry', 'quantum computing'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8, producesArtifact: true,
  })
  assert.deepEqual(v.unknownDimensions, ['quantum computing'])
})

// ───── normalizeDimensionKey: additional aliases + edge cases ────────────
test('normalizeDimensionKey handles underscore-spaced aliases', () => {
  assert.equal(normalizeDimensionKey('skills_match'), 'skills_match')
  assert.equal(normalizeDimensionKey('strategic_fit'), 'strategic_fit')
  assert.equal(normalizeDimensionKey('optionality_exit'), 'optionality_exit')
  assert.equal(normalizeDimensionKey('growth_mobility'), 'growth_mobility')
  assert.equal(normalizeDimensionKey('brand_value'), 'brand_value')
})

test('normalizeDimensionKey is case-insensitive', () => {
  assert.equal(normalizeDimensionKey('Skills'), 'skills_match')
  assert.equal(normalizeDimensionKey('EASE OF ENTRY'), 'ease_of_entry')
  assert.equal(normalizeDimensionKey('BRAND'), 'brand_value')
})

test('normalizeDimensionKey handles extra whitespace', () => {
  assert.equal(normalizeDimensionKey('  ease  of  entry  '), 'ease_of_entry')
  assert.equal(normalizeDimensionKey('\tskills\t'), 'skills_match')
})

test('normalizeDimensionKey: all canonical keys round-trip cleanly', () => {
  const canonical = ['skills_match', 'ease_of_entry', 'strategic_fit', 'growth_mobility', 'optionality_exit', 'brand_value']
  for (const k of canonical) {
    assert.equal(normalizeDimensionKey(k), k, `canonical key ${k} should round-trip`)
  }
})

// ───── gapRelevance: empty corpus + empty dims ────────────────────────────
test('gapRelevance with empty rows → no targeted dims (corpus has no data)', () => {
  const g = gapRelevance([], ['ease_of_entry'])
  assert.equal(g.targeted.length, 0)
  assert.equal(g.best, null)
  assert.equal(g.dimsInCorpus, 0)
})

test('gapRelevance with empty targetDims → targeted is empty, dragTable still populated', () => {
  const rows = easeDragCorpus()
  const g = gapRelevance(rows, [])
  assert.equal(g.targeted.length, 0)
  assert.equal(g.best, null)
  assert.ok(g.dragTable.length > 0, 'drag table should still reflect the corpus')
})

test('gapRelevance returns targeted dims sorted by gapScore descending', () => {
  const rows = easeDragCorpus() // ease_of_entry is the deep drag; brand_value is healthy
  const g = gapRelevance(rows, ['ease_of_entry', 'brand_value'])
  assert.equal(g.targeted[0].key, 'ease_of_entry', 'higher gapScore should come first')
  assert.ok(g.targeted[0].gapScore >= g.targeted[1].gapScore)
})

// ───── effortProfile: boundary values ─────────────────────────────────────
test('effortProfile: totalHours exactly 20 → micro band', () => {
  assert.equal(effortProfile({ weeks: 4, hoursPerWeek: 5 }).band, 'micro') // 20h
})

test('effortProfile: totalHours exactly 21 → light band', () => {
  assert.equal(effortProfile({ weeks: 3, hoursPerWeek: 7 }).band, 'light') // 21h
})

test('effortProfile: totalHours exactly 60 → light band', () => {
  assert.equal(effortProfile({ weeks: 6, hoursPerWeek: 10 }).band, 'light') // 60h
})

test('effortProfile: totalHours exactly 61 → heavy band', () => {
  assert.equal(effortProfile({ weeks: 61, hoursPerWeek: 1 }).band, 'heavy') // 61h
})

test('effortProfile: totalHours exactly 150 → heavy band', () => {
  assert.equal(effortProfile({ weeks: 15, hoursPerWeek: 10 }).band, 'heavy') // 150h
})

test('effortProfile: totalHours exactly 151 → major band', () => {
  assert.equal(effortProfile({ weeks: 151, hoursPerWeek: 1 }).band, 'major') // 151h
})

test('effortProfile: non-numeric string inputs default to 0', () => {
  const e = effortProfile({ weeks: 'ten', hoursPerWeek: 'five', costEur: 'free' })
  assert.equal(e.totalHours, 0)
  assert.equal(e.costEur, 0)
  assert.equal(e.band, 'micro')
})

test('effortProfile: omitted params default to 0', () => {
  const e = effortProfile()
  assert.equal(e.totalHours, 0)
  assert.equal(e.weeks, 0)
  assert.equal(e.hoursPerWeek, 0)
  assert.equal(e.band, 'micro')
})

// ───── trainingVerdict: empty corpus / no signal ─────────────────────────
test('trainingVerdict with empty rows → SKIP (cannot measure gap or archetype)', () => {
  const v = trainingVerdict([], {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 4, hoursPerWeek: 8,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  assert.equal(v.signals.archMatches, false)
})

test('trainingVerdict with no targetDimensions → SKIP, trace mentions missing dim', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: [],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 4, hoursPerWeek: 8,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  assert.ok(v.trace.some((t) => /No target dimension/.test(t)))
})

test('trainingVerdict with no mappedArchetypes → SKIP, trace mentions missing archetypes', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: [],
    weeks: 4, hoursPerWeek: 8,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.archMatches, false)
  assert.ok(v.trace.some((t) => /No mapped archetypes/.test(t)))
})

test('trainingVerdict: context.topDrag is the weakest dimension in corpus', () => {
  const rows = easeDragCorpus() // ease_of_entry drags
  const v = trainingVerdict(rows, {
    targetDimensions: ['brand_value'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 4, hoursPerWeek: 8,
  })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.context.topDrag.key, 'ease_of_entry')
})

test('trainingVerdict: strong brand alone (no artifact) can push to WORTH_IT when gapScore >= 0.5', () => {
  const rows = easeDragCorpus() // gapScore for ease_of_entry is high (>> 0.5)
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8, // 48h → light, proportionate
    producesArtifact: false,
    brandStrength: 8, // strongBrand = true
  })
  assert.equal(v.verdict, 'WORTH_IT')
  assert.equal(v.signals.strongBrand, true)
  assert.equal(v.signals.hasArtifact, false)
})

test('trainingVerdict: weak brand + no artifact + gapScore < 0.5 → TIMEBOX', () => {
  // Corpus with moderate drag: ease avg ~5 (not < 4 ever, so lowShare=0)
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 6 }, () => row({
      archetype: 'Strategy & Operations',
      ease_of_entry: 5, skills_match: 8, strategic_fit: 8,
      growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    })),
  ))
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 2, hoursPerWeek: 5, // 10h → micro
    producesArtifact: false,
    brandStrength: 4, // weak brand
  })
  assert.equal(v.verdict, 'TIMEBOX')
  assert.equal(v.signals.strongBrand, false)
  assert.equal(v.signals.hasArtifact, false)
})

test('trainingVerdict: brandStrength undefined → no brand trace line', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8,
    producesArtifact: true,
    // brandStrength omitted
  })
  // No brand trace line should be added when brandStrength is null/undefined.
  const hasBrandTrace = v.trace.some((t) => /brand/i.test(t))
  assert.equal(hasBrandTrace, false)
})

test('trainingVerdict: topArchetypes in context have at most 5 entries', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 4, hoursPerWeek: 8,
    producesArtifact: true,
  })
  assert.ok(v.context.topArchetypes.length <= 5)
})

test('trainingVerdict: all signals are present in return value', () => {
  const rows = easeDragCorpus()
  const v = trainingVerdict(rows, {
    targetDimensions: ['ease of entry'],
    mappedArchetypes: ['Strategy & Operations'],
    weeks: 6, hoursPerWeek: 8, producesArtifact: true,
  })
  const signalKeys = ['attacksDrag', 'archMatches', 'proportionate', 'hasArtifact', 'strongBrand', 'gapScore', 'effortBand']
  for (const k of signalKeys) {
    assert.ok(k in v.signals, `signals.${k} should be present`)
  }
})

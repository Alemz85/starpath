import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidProfileSlug,
  slugValidationHint,
  profileInitial,
  formatProfileCounts,
  switchTargets,
  describeProfileFailure,
  type ProfileInfo,
} from '@/lib/profiles'

const profile = (over: Partial<ProfileInfo> = {}): ProfileInfo => ({
  slug: 'career',
  label: 'Career search',
  created: '2026-07-07',
  active: false,
  counts: { scouting: 210, applications: 34, pipeline: 12, reports: 118 },
  ...over,
})

// ─── slug validation ──────────────────────────────────────────────────────────

test('accepts spec-conformant slugs', () => {
  for (const s of ['career', 'cph-student', 'a', '0', 'x'.repeat(32), 'a-1-b-2']) {
    assert.equal(isValidProfileSlug(s), true, s)
  }
})

test('rejects malformed slugs', () => {
  for (const s of ['', 'Career', 'cph student', '-career', 'x'.repeat(33), 'café', 'career_2']) {
    assert.equal(isValidProfileSlug(s), false, JSON.stringify(s))
  }
})

test("rejects the reserved slug 'active'", () => {
  assert.equal(isValidProfileSlug('active'), false)
})

test('validation hint is empty for valid and empty input', () => {
  assert.equal(slugValidationHint(''), '')
  assert.equal(slugValidationHint('cph-student'), '')
})

test('validation hint names the reserved slug specifically', () => {
  assert.match(slugValidationHint('active'), /reserved/)
})

test('validation hint explains the shape for malformed input', () => {
  assert.match(slugValidationHint('Bad Slug'), /lowercase/)
})

// ─── initial letter ───────────────────────────────────────────────────────────

test('initial prefers the label, uppercased', () => {
  assert.equal(profileInitial(profile()), 'C')
  assert.equal(profileInitial({ slug: 'x', label: 'zeta' }), 'Z')
})

test('initial falls back to the slug when the label is empty', () => {
  assert.equal(profileInitial({ slug: 'cph-student', label: '' }), 'C')
  assert.equal(profileInitial({ slug: 'berlin' }), 'B')
})

test('initial degrades to ? when both are blank', () => {
  assert.equal(profileInitial({ slug: '  ', label: ' ' }), '?')
})

// ─── counts formatting ────────────────────────────────────────────────────────

test('counts line joins non-zero buckets with dots (pipeline shown as inbox)', () => {
  assert.equal(
    formatProfileCounts({ scouting: 210, applications: 34, pipeline: 12, reports: 118 }),
    '210 scouting · 34 applications · 12 inbox · 118 reports',
  )
})

test('counts line drops zero buckets', () => {
  assert.equal(
    formatProfileCounts({ scouting: 5, applications: 0, pipeline: 0, reports: 0 }),
    '5 scouting',
  )
})

test('a pipeline-only profile reads its inbox count, not empty (F6)', () => {
  // Before the fix the pipeline bucket was dropped, so a profile whose only
  // load is a full inbox misread as "empty" in the switcher/Settings.
  assert.equal(
    formatProfileCounts({ scouting: 0, applications: 0, pipeline: 12, reports: 0 }),
    '12 inbox',
  )
})

test('an all-zero profile reads empty; missing counts read blank', () => {
  assert.equal(formatProfileCounts({ scouting: 0, applications: 0, pipeline: 0, reports: 0 }), 'empty')
  assert.equal(formatProfileCounts(null), '')
  assert.equal(formatProfileCounts(undefined), '')
})

// ─── switch targets ───────────────────────────────────────────────────────────

test('switch targets exclude the active profile, preserve CLI order', () => {
  const list = [
    profile({ slug: 'career', active: true }),
    profile({ slug: 'cph-student', label: 'Copenhagen student' }),
    profile({ slug: 'berlin', label: 'Berlin search' }),
  ]
  assert.deepEqual(switchTargets(list).map(p => p.slug), ['cph-student', 'berlin'])
})

test('switch targets are empty for a single-profile list', () => {
  assert.deepEqual(switchTargets([profile({ active: true })]), [])
})

// ─── failure lines ────────────────────────────────────────────────────────────

test('guard failures surface verbatim and win over message', () => {
  const lines = describeProfileFailure({
    ok: false,
    error: 'guards',
    guardFailures: ['unmerged TSVs in batch/scouting-additions (3 files)', 'in-flight batch workers'],
    message: 'refused',
  })
  assert.deepEqual(lines, ['unmerged TSVs in batch/scouting-additions (3 files)', 'in-flight batch workers'])
})

test('message is the fallback, error code the last resort', () => {
  assert.deepEqual(
    describeProfileFailure({ ok: false, error: 'unknown-profile', message: "no profile 'x'" }),
    ["no profile 'x'"],
  )
  assert.deepEqual(describeProfileFailure({ ok: false, error: 'cli' }), ['cli'])
})

test('a success produces no failure lines', () => {
  assert.deepEqual(describeProfileFailure({ ok: true, active: 'career' }), [])
})

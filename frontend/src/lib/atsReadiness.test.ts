import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATS_STRONG,
  ATS_OK,
  normalizeCoverageFraction,
  parseAtsSidecar,
  findCvSidecar,
  findCvFile,
  atsReadiness,
  readinessFromInputs,
} from '@/lib/atsReadiness'

// ─── normalizeCoverageFraction ────────────────────────────────────────────────

test('normalizeCoverageFraction accepts fractions and percentages', () => {
  assert.equal(normalizeCoverageFraction(0.82), 0.82)
  assert.equal(normalizeCoverageFraction(82), 0.82)
  assert.equal(normalizeCoverageFraction(1), 1) // exactly 1 = fraction, not 1%
  assert.equal(normalizeCoverageFraction(100), 1)
  assert.equal(normalizeCoverageFraction('75'), 0.75) // numeric string
  assert.equal(normalizeCoverageFraction(0), 0)
})

test('normalizeCoverageFraction rejects out-of-range and junk', () => {
  assert.equal(normalizeCoverageFraction(150), null) // 1.5 fraction → out of range
  assert.equal(normalizeCoverageFraction(-5), null)
  assert.equal(normalizeCoverageFraction('abc'), null)
  assert.equal(normalizeCoverageFraction(null), null)
  assert.equal(normalizeCoverageFraction(undefined), null)
  assert.equal(normalizeCoverageFraction(NaN), null)
  assert.equal(normalizeCoverageFraction(''), null)
})

// ─── parseAtsSidecar (mirror of apply-kit-core) ───────────────────────────────

test('parseAtsSidecar reads coveragePct (0..100)', () => {
  assert.deepEqual(parseAtsSidecar('{"coveragePct": 82}'), {
    atsChecked: true,
    atsCoverage: 0.82,
  })
})

test('parseAtsSidecar reads coverage as fraction or percent', () => {
  assert.deepEqual(parseAtsSidecar('{"coverage": 0.6}'), { atsChecked: true, atsCoverage: 0.6 })
  assert.deepEqual(parseAtsSidecar('{"coverage": 60}'), { atsChecked: true, atsCoverage: 0.6 })
})

test('parseAtsSidecar prefers coveragePct over coverage', () => {
  // pdf mode writes the full ats-coverage --json blob; coveragePct is canonical.
  assert.deepEqual(parseAtsSidecar('{"coveragePct": 90, "coverage": 0.1}'), {
    atsChecked: true,
    atsCoverage: 0.9,
  })
})

test('parseAtsSidecar is tolerant — never throws, returns unchecked on junk', () => {
  assert.deepEqual(parseAtsSidecar(null), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar(undefined), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar(''), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('   '), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('not json'), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('{}'), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('[]'), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('null'), { atsChecked: false })
  assert.deepEqual(parseAtsSidecar('{"coveragePct": "x"}'), { atsChecked: false })
})

// ─── findCvSidecar ────────────────────────────────────────────────────────────

test('findCvSidecar matches the company token and picks the newest', () => {
  const files = [
    'cv-jane-doe-acme-2026-01-10.ats.json',
    'cv-jane-doe-acme-2026-03-22.ats.json', // newest by date suffix
    'cv-jane-doe-globex-2026-02-01.ats.json',
    'cv-jane-doe-acme-2026-03-22.pdf', // the CV itself, not a sidecar
    'random.txt',
  ]
  assert.equal(findCvSidecar('Acme', files), 'cv-jane-doe-acme-2026-03-22.ats.json')
  assert.equal(findCvSidecar('Globex', files), 'cv-jane-doe-globex-2026-02-01.ats.json')
})

test('findCvSidecar returns null when nothing matches', () => {
  assert.equal(findCvSidecar('Acme', []), null)
  assert.equal(findCvSidecar('Acme', ['cv-jane-doe-globex-2026-02-01.ats.json']), null)
  assert.equal(findCvSidecar('', ['cv-jane-doe-acme-2026-01-10.ats.json']), null)
})

test('findCvSidecar normalizes company names with spaces/diacritics', () => {
  const files = ['cv-jane-doe-banco-santander-2026-01-10.ats.json']
  assert.equal(findCvSidecar('Banco Santander', files), files[0])
})

// ─── findCvFile ───────────────────────────────────────────────────────────────

test('findCvFile resolves the newest cv-… file for a company', () => {
  const files = [
    'cv-jane-doe-acme-2026-01-10.pdf',
    'cv-jane-doe-acme-2026-03-22.html',
    'cv-jane-doe-acme-2026-03-22.pdf', // same date: .pdf sorts after .html → wins
    'cv-jane-doe-acme-2026-03-22.ats.json', // sidecar, not a CV
    'cv-jane-doe-globex-2026-02-01.pdf',
  ]
  assert.equal(findCvFile('Acme', files), 'cv-jane-doe-acme-2026-03-22.pdf')
  assert.equal(findCvFile('Globex', files), 'cv-jane-doe-globex-2026-02-01.pdf')
})

test('findCvFile excludes the .ats.json sidecar and returns null when absent', () => {
  assert.equal(findCvFile('Acme', ['cv-jane-doe-acme-2026-03-22.ats.json']), null)
  assert.equal(findCvFile('Acme', []), null)
  assert.equal(findCvFile('Acme', ['random.pdf']), null)
})

// ─── atsReadiness verdict bands (mirror cvCheck thresholds) ───────────────────

test('atsReadiness — absent when no CV', () => {
  const r = atsReadiness({ exists: false, atsChecked: false })
  assert.equal(r.verdict, 'absent')
  assert.equal(r.coveragePct, null)
  assert.equal(r.needsRetailor, false)
  assert.equal(r.tone, 'muted')
})

test('atsReadiness — unchecked when CV present but no sidecar', () => {
  const r = atsReadiness({ exists: true, atsChecked: false })
  assert.equal(r.verdict, 'unchecked')
  assert.equal(r.coveragePct, null)
  assert.equal(r.needsRetailor, true) // honest nudge to re-tailor
  assert.equal(r.tone, 'warning')
})

test('atsReadiness — strong at the 0.75 boundary', () => {
  const r = atsReadiness({ exists: true, atsChecked: true, atsCoverage: ATS_STRONG })
  assert.equal(r.verdict, 'strong')
  assert.equal(r.coveragePct, 75)
  assert.equal(r.needsRetailor, false)
  assert.equal(r.tone, 'success')
})

test('atsReadiness — ok between the floor and strong', () => {
  const r = atsReadiness({ exists: true, atsChecked: true, atsCoverage: ATS_OK })
  assert.equal(r.verdict, 'ok')
  assert.equal(r.coveragePct, 60)
  assert.equal(r.needsRetailor, false)
  assert.equal(r.tone, 'accent')

  const justBelowStrong = atsReadiness({ exists: true, atsChecked: true, atsCoverage: 0.74 })
  assert.equal(justBelowStrong.verdict, 'ok')
})

test('atsReadiness — low below the 0.60 readiness floor', () => {
  const r = atsReadiness({ exists: true, atsChecked: true, atsCoverage: 0.59 })
  assert.equal(r.verdict, 'low')
  assert.equal(r.coveragePct, 59)
  assert.equal(r.needsRetailor, true)
  assert.equal(r.tone, 'warning')
})

test('atsReadiness — rounds coverage to a whole percent', () => {
  assert.equal(atsReadiness({ exists: true, atsChecked: true, atsCoverage: 0.826 }).coveragePct, 83)
  assert.equal(atsReadiness({ exists: true, atsChecked: true, atsCoverage: 0.824 }).coveragePct, 82)
})

// ─── readinessFromInputs (end-to-end convenience) ─────────────────────────────

test('readinessFromInputs threads existence + sidecar text through', () => {
  assert.equal(readinessFromInputs(false, null).verdict, 'absent')
  assert.equal(readinessFromInputs(true, null).verdict, 'unchecked')
  assert.equal(readinessFromInputs(true, '{"coveragePct": 88}').verdict, 'strong')
  assert.equal(readinessFromInputs(true, '{"coveragePct": 65}').verdict, 'ok')
  assert.equal(readinessFromInputs(true, '{"coveragePct": 40}').verdict, 'low')
  // A CV with a corrupt sidecar reads as unchecked, not as ready.
  assert.equal(readinessFromInputs(true, 'corrupt{').verdict, 'unchecked')
})

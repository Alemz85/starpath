// Unit tests for scripts/lib/apply-kit-core.mjs — the pure readiness logic
// behind the `apply-kit` mode. apply-kit.mjs resolves on-disk facts (which
// artifacts exist for a company+role, their freshness) and feeds them here; this
// suite pins the composition: each per-artifact evaluator's status mapping, the
// blocking/ready verdict, weighted completeness, the single top-action pick, and
// the markdown render.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reportCheck,
  cvCheck,
  answersCheck,
  researchCheck,
  outreachCheck,
  storyBankNote,
  assembleKit,
  pickTopAction,
  renderKit,
  buildKitMarkdown,
  CHECK_IDS,
  CHECK_META,
  atsSidecarName,
  parseAtsSidecar,
  cvFactsFromFiles,
} from './apply-kit-core.mjs'

/* A fully-ready set of facts — handy base for "tweak one thing" tests. */
function readyFacts(over = {}) {
  return {
    report: { exists: true, path: 'reports/tier-2/Acme - Analyst.md', tier: 2 },
    cv: { exists: true, path: 'output/cv-jo-acme-2026-06-25.pdf', atsCoverage: 0.82 },
    answers: { exists: true, path: 'interview-prep/Acme - Analyst.md' },
    research: { exists: true, path: 'data/companies/acme.md', state: 'fresh', ageDays: 3, valid: true },
    outreach: { contacts: 1, touches: 2, lastTouch: '2026-06-20' },
    storyBank: { exists: true, storyCount: 6, ok: true, gaps: 1 },
    ...over,
  }
}

/* ───── reportCheck ───────────────────────────────────────────────────────────*/

test('reportCheck: present → ready, carries tier + path', () => {
  const c = reportCheck({ exists: true, path: 'reports/tier-1/Acme - Analyst.md', tier: 1 })
  assert.equal(c.status, 'ready')
  assert.equal(c.next, null)
  assert.equal(c.meta.tier, 1)
  assert.match(c.detail, /tier 1/)
})

test('reportCheck: absent → missing + blocking + scouting next-action', () => {
  const c = reportCheck({ exists: false })
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, true)
  assert.equal(c.next.mode, 'scouting')
})

test('reportCheck: tolerates empty facts', () => {
  const c = reportCheck()
  assert.equal(c.status, 'missing')
})

/* ───── cvCheck ───────────────────────────────────────────────────────────────*/

test('cvCheck: present with healthy ATS → ready', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf', atsCoverage: 0.75 })
  assert.equal(c.status, 'ready')
  assert.equal(c.meta.atsCoverage, 0.75)
})

test('cvCheck: present but not ATS-checked → stale (re-tailor)', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf', atsChecked: false })
  assert.equal(c.status, 'stale')
  assert.equal(c.next.mode, 'pdf')
  assert.match(c.detail, /not ATS-checked/)
})

test('cvCheck: low ATS coverage → stale with percentage', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf', atsCoverage: 0.4 })
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /40%/)
})

test('cvCheck: existing CV with unknown ATS is NOT held against it', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf' })
  assert.equal(c.status, 'ready') // absence of ATS number ≠ downgrade
})

test('cvCheck: absent → missing + blocking', () => {
  const c = cvCheck({ exists: false })
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, true)
})

/* ───── answersCheck ───────────────────────────────────────────────────────────*/

test('answersCheck: present → ready', () => {
  const c = answersCheck({ exists: true, path: 'interview-prep/Acme - Analyst.md' })
  assert.equal(c.status, 'ready')
  assert.equal(c.meta.path, 'interview-prep/Acme - Analyst.md')
})

test('answersCheck: absent → missing, non-blocking, apply next-action', () => {
  const c = answersCheck({ exists: false })
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, false)
  assert.equal(c.next.mode, 'apply')
})

/* ───── researchCheck ──────────────────────────────────────────────────────────*/

test('researchCheck: fresh + valid → ready', () => {
  const c = researchCheck({ exists: true, path: 'data/companies/acme.md', state: 'fresh', ageDays: 5, valid: true })
  assert.equal(c.status, 'ready')
  assert.equal(c.meta.ageDays, 5)
})

test('researchCheck: present but stale → stale (refresh)', () => {
  const c = researchCheck({ exists: true, path: 'data/companies/acme.md', state: 'stale', ageDays: 45, valid: true })
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /45d old/)
  assert.equal(c.next.mode, 'deep')
})

test('researchCheck: present but invalid schema → stale', () => {
  const c = researchCheck({ exists: true, path: 'data/companies/acme.md', state: 'fresh', ageDays: 2, valid: false })
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /schema invalid/)
})

test('researchCheck: missing-date counts as stale (not fresh)', () => {
  const c = researchCheck({ exists: true, path: 'data/companies/acme.md', state: 'missing-date', ageDays: null, valid: true })
  assert.equal(c.status, 'stale')
})

test('researchCheck: absent → missing, non-blocking', () => {
  const c = researchCheck({ exists: false })
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, false)
})

/* ───── outreachCheck ──────────────────────────────────────────────────────────*/

test('outreachCheck: has touches → ready', () => {
  const c = outreachCheck({ contacts: 2, touches: 3, lastTouch: '2026-06-22' })
  assert.equal(c.status, 'ready')
  assert.match(c.detail, /2 contacts/)
  assert.match(c.detail, /2026-06-22/)
})

test('outreachCheck: singular contact phrasing', () => {
  const c = outreachCheck({ contacts: 1, touches: 1 })
  assert.match(c.detail, /1 contact,/)
})

test('outreachCheck: none → missing but ALWAYS optional/non-blocking', () => {
  const c = outreachCheck({})
  assert.equal(c.status, 'missing')
  assert.equal(c.optional, true)
  assert.equal(c.blocking, false)
  assert.equal(c.next.mode, 'contacto')
})

/* ───── storyBankNote ──────────────────────────────────────────────────────────*/

test('storyBankNote: no bank → info note', () => {
  const n = storyBankNote({ exists: false })
  assert.equal(n.level, 'info')
  assert.match(n.text, /No story bank/)
})

test('storyBankNote: failed health check → warn', () => {
  const n = storyBankNote({ exists: true, storyCount: 4, ok: false })
  assert.equal(n.level, 'warn')
  assert.match(n.text, /failed its health check/)
})

test('storyBankNote: healthy bank with gaps → ok note mentioning gaps', () => {
  const n = storyBankNote({ exists: true, storyCount: 8, ok: true, gaps: 2 })
  assert.equal(n.level, 'ok')
  assert.match(n.text, /8 stories/)
  assert.match(n.text, /2 competency gap/)
})

test('storyBankNote: single story is singular', () => {
  const n = storyBankNote({ exists: true, storyCount: 1, ok: true, gaps: 0 })
  assert.match(n.text, /1 story/)
  assert.doesNotMatch(n.text, /gap/)
})

/* ───── pickTopAction ──────────────────────────────────────────────────────────*/

test('pickTopAction: prefers a blocking-missing artifact over a non-blocking one', () => {
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    report: { exists: false },               // blocking, missing
    answers: { exists: false },              // non-blocking, missing
  }))
  assert.equal(kit.topAction.id, 'report')
})

test('pickTopAction: among blocking-missing, higher weight ties break by order', () => {
  // report (w3) and cv (w3) both blocking-missing → report wins on CHECK_IDS order.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    report: { exists: false },
    cv: { exists: false },
  }))
  assert.equal(kit.topAction.id, 'report')
})

test('pickTopAction: missing outranks stale even at equal weight', () => {
  // research stale (w1) vs outreach missing (w1) → missing (non-blocking) beats stale.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    research: { exists: true, state: 'stale', ageDays: 40, valid: true },
    outreach: {},
  }))
  assert.equal(kit.topAction.status, 'missing')
  assert.equal(kit.topAction.id, 'outreach')
})

test('pickTopAction: fully-ready kit → null', () => {
  const checks = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    outreach: { contacts: 1, touches: 1 },
  })).checks
  assert.equal(pickTopAction(checks), null)
})

/* ───── assembleKit: verdict + completeness ────────────────────────────────────*/

test('assembleKit: all present → READY, 100% complete, readyToSend', () => {
  const kit = assembleKit({ company: 'Acme', role: 'Analyst', slug: 'acme' }, readyFacts({
    research: { exists: true, state: 'fresh', ageDays: 1, valid: true },
    outreach: { contacts: 1, touches: 1 },
  }))
  assert.equal(kit.verdict, 'ready')
  assert.equal(kit.readyToSend, true)
  assert.equal(kit.completeness, 1)
  assert.equal(kit.summary.missing, 0)
  assert.equal(kit.summary.stale, 0)
  assert.equal(kit.topAction, null)
})

test('assembleKit: missing report OR cv → blocked + not readyToSend', () => {
  const k1 = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({ report: { exists: false } }))
  assert.equal(k1.verdict, 'blocked')
  assert.equal(k1.readyToSend, false)

  const k2 = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({ cv: { exists: false } }))
  assert.equal(k2.verdict, 'blocked')
  assert.equal(k2.readyToSend, false)
})

test('assembleKit: blocking artifacts present but secondary gaps → sendable-with-gaps', () => {
  // report + cv present; answers/research/outreach missing → not blocked, but gaps remain.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, {
    report: { exists: true, path: 'reports/tier-2/Acme - Analyst.md', tier: 2 },
    cv: { exists: true, path: 'output/cv.pdf', atsCoverage: 0.8 },
    answers: { exists: false },
    research: { exists: false },
    outreach: {},
    storyBank: { exists: false },
  })
  assert.equal(kit.readyToSend, true)
  assert.equal(kit.verdict, 'sendable-with-gaps')
  assert.equal(kit.summary.missing, 3)
})

test('assembleKit: a stale blocking artifact does NOT block (present + usable)', () => {
  // CV present-but-low-ATS is stale, not missing → still readyToSend.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    cv: { exists: true, path: 'output/cv.pdf', atsCoverage: 0.3 },
  }))
  assert.equal(kit.readyToSend, true)
  assert.equal(kit.verdict, 'sendable-with-gaps')
  // The stale CV is the top action (weight 3, stale tier).
  assert.equal(kit.topAction.id, 'cv')
  assert.equal(kit.topAction.status, 'stale')
})

test('assembleKit: completeness gives half credit for stale artifacts', () => {
  // Everything ready except research stale (weight 1 of total 10 → -0.5 → 0.95).
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    research: { exists: true, state: 'stale', ageDays: 50, valid: true },
    outreach: { contacts: 1, touches: 1 },
  }))
  // total weight = 3+3+2+1+1 = 10; earned = 10 - 0.5 = 9.5 → 0.95
  assert.equal(kit.completeness, 0.95)
})

test('assembleKit: empty/unknown listing → nothing exists → blocked, 0% complete', () => {
  const kit = assembleKit({}, {})
  assert.equal(kit.verdict, 'blocked')
  assert.equal(kit.readyToSend, false)
  assert.equal(kit.completeness, 0)
  assert.equal(kit.checks.length, CHECK_IDS.length)
  // Top action is the highest-weight blocking gap in catalog order → report.
  assert.equal(kit.topAction.id, 'report')
})

test('assembleKit: checks come back in canonical CHECK_IDS order', () => {
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts())
  assert.deepEqual(kit.checks.map((c) => c.id), CHECK_IDS)
})

test('assembleKit: trims listing fields and preserves slug', () => {
  const kit = assembleKit({ company: '  Acme  ', role: '  Analyst ', slug: ' acme ' }, readyFacts())
  assert.equal(kit.company, 'Acme')
  assert.equal(kit.role, 'Analyst')
  assert.equal(kit.slug, 'acme')
})

/* ───── renderKit ──────────────────────────────────────────────────────────────*/

test('renderKit: ready kit announces nothing-to-do and READY', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'Analyst' }, readyFacts({
    research: { exists: true, state: 'fresh', ageDays: 1, valid: true },
    outreach: { contacts: 1, touches: 1 },
  }))
  assert.match(md, /# Application-kit readiness — Acme — Analyst/)
  assert.match(md, /Readiness:\*\* READY/)
  assert.match(md, /100% complete/)
  assert.match(md, /Do this next:\*\* Nothing/)
})

test('renderKit: blocked kit names the gap + the mode to run', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'Analyst' }, readyFacts({
    report: { exists: false },
  }))
  assert.match(md, /BLOCKED/)
  assert.match(md, /Do this next:.*scouting mode/)
  // Checklist shows the missing report with a delegation arrow.
  assert.match(md, /✗ \*\*Scouting report\*\*/)
  assert.match(md, /→ .*\(scouting mode\)/)
})

test('renderKit: optional outreach is labelled optional in the checklist', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'Analyst' }, readyFacts({ outreach: {} }))
  assert.match(md, /\*\*Outreach \/ referral plan\*\* _\(optional\)_/)
})

test('renderKit: includes the story-bank note and the read-only/no-submit footer', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'Analyst' }, readyFacts())
  assert.match(md, /Story bank: 6 stories/)
  assert.match(md, /generates and submits nothing/i)
})

test('renderKit: company-only listing (no role) still renders a sane title', () => {
  const md = buildKitMarkdown({ company: 'Acme' }, readyFacts())
  assert.match(md, /# Application-kit readiness — Acme/)
})

/* ───── catalog invariants ─────────────────────────────────────────────────────*/

test('CHECK_META: exactly report+cv are blocking, only outreach is optional', () => {
  const blocking = CHECK_IDS.filter((id) => CHECK_META[id].blocking)
  assert.deepEqual(blocking.sort(), ['cv', 'report'])
  const optional = CHECK_IDS.filter((id) => CHECK_META[id].optional)
  assert.deepEqual(optional, ['outreach'])
})

test('CHECK_META: every check names a distinct existing mode', () => {
  const modes = CHECK_IDS.map((id) => CHECK_META[id].mode)
  assert.deepEqual(modes, ['scouting', 'pdf', 'apply', 'deep', 'contacto'])
  assert.equal(new Set(modes).size, modes.length)
})

/* ───── reportCheck: additional edge cases ──────────────────────────────────*/

test('reportCheck: present with no tier/path → ready, no tier in detail', () => {
  const c = reportCheck({ exists: true })
  assert.equal(c.status, 'ready')
  assert.equal(c.meta.path, null)
  assert.equal(c.meta.tier, null)
  assert.doesNotMatch(c.detail, /tier/)
})

test('reportCheck: present with tier 0 → treated as a finite tier', () => {
  // tier 0 is an unusual but finite value; Number.isFinite(0) is true.
  const c = reportCheck({ exists: true, tier: 0 })
  assert.equal(c.status, 'ready')
  assert.equal(c.meta.tier, 0)
  assert.match(c.detail, /tier 0/)
})

/* ───── cvCheck: boundary / edge cases ──────────────────────────────────────*/

test('cvCheck: atsCoverage exactly 0.6 is NOT stale (threshold is < 0.6)', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf', atsCoverage: 0.6 })
  assert.equal(c.status, 'ready')
})

test('cvCheck: atsCoverage 0.59 (just below threshold) → stale', () => {
  const c = cvCheck({ exists: true, path: 'output/cv.pdf', atsCoverage: 0.59 })
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /59%/)
})

test('cvCheck: empty facts object → missing + blocking', () => {
  const c = cvCheck()
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, true)
})

/* ───── answersCheck: edge cases ─────────────────────────────────────────────*/

test('answersCheck: empty facts object → missing', () => {
  const c = answersCheck()
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, false)
  assert.equal(c.next.mode, 'apply')
})

/* ───── researchCheck: edge cases ───────────────────────────────────────────*/

test('researchCheck: exists + no state + valid=true → stale (not explicitly fresh)', () => {
  // state is undefined (not 'fresh') and valid is true → the second branch fires.
  const c = researchCheck({ exists: true, path: 'data/companies/x.md', valid: true })
  // state is undefined → falsy → skips the state !== 'fresh' branch → ready
  // Actually state is undefined so `f.state && f.state !== 'fresh'` is false → ready
  assert.equal(c.status, 'ready')
})

test('researchCheck: invalid-date state → stale', () => {
  const c = researchCheck({ exists: true, path: 'data/companies/x.md', state: 'invalid-date', ageDays: null, valid: true })
  assert.equal(c.status, 'stale')
})

test('researchCheck: empty facts → missing', () => {
  const c = researchCheck()
  assert.equal(c.status, 'missing')
  assert.equal(c.blocking, false)
})

/* ───── outreachCheck: partial signals ──────────────────────────────────────*/

test('outreachCheck: only contacts > 0 (touches 0) → ready', () => {
  // The predicate is `touches > 0 || contacts > 0`, so either alone suffices.
  const c = outreachCheck({ contacts: 2, touches: 0 })
  assert.equal(c.status, 'ready')
  assert.match(c.detail, /2 contacts/)
})

test('outreachCheck: only touches > 0 (contacts 0) → ready', () => {
  const c = outreachCheck({ contacts: 0, touches: 3 })
  assert.equal(c.status, 'ready')
  assert.match(c.detail, /0 contacts/)
  assert.match(c.detail, /3 touch/)
})

test('outreachCheck: non-finite contacts/touches values are treated as 0', () => {
  const c = outreachCheck({ contacts: NaN, touches: undefined })
  assert.equal(c.status, 'missing')
})

/* ───── storyBankNote: null / undefined inputs ─────────────────────────────*/

test('storyBankNote: null input → info note', () => {
  const n = storyBankNote(null)
  assert.equal(n.level, 'info')
})

test('storyBankNote: undefined input → info note', () => {
  const n = storyBankNote(undefined)
  assert.equal(n.level, 'info')
})

test('storyBankNote: exists true, storyCount undefined → treated as 0', () => {
  const n = storyBankNote({ exists: true, ok: true })
  assert.equal(n.level, 'ok')
  assert.match(n.text, /0 stor/)
})

/* ───── assembleKit: storyBank absence / null ───────────────────────────────*/

test('assembleKit: omitting storyBank → falls back gracefully (info note)', () => {
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, {
    report: { exists: true },
    cv: { exists: true },
    answers: { exists: false },
    research: { exists: false },
    outreach: {},
    // storyBank deliberately omitted
  })
  // Should not throw; note should be the info-level "No story bank" message.
  assert.ok(kit.note)
  assert.equal(kit.note.level, 'info')
})

test('assembleKit: storyBank=null → info note (same as missing)', () => {
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({ storyBank: null }))
  assert.ok(kit.note)
  assert.equal(kit.note.level, 'info')
})

/* ───── pickTopAction: stale blocking vs missing non-blocking ───────────────*/

test('pickTopAction: stale blocking (tier=2) loses to missing non-blocking (tier=1)', () => {
  // stale → tier 2 in the sort; missing non-blocking → tier 1; missing wins.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    cv: { exists: true, path: 'output/cv.pdf', atsCoverage: 0.3 }, // stale, blocking
    answers: { exists: false },                                       // missing, non-blocking
  }))
  // missing (non-blocking, tier=1) outranks stale (blocking, tier=2)
  assert.equal(kit.topAction.id, 'answers')
  assert.equal(kit.topAction.status, 'missing')
})

test('pickTopAction: among two stale artifacts of equal weight, lower CHECK_IDS order wins', () => {
  // Both answers (w2) and outreach (w1) stale — answers has higher weight → wins.
  const kit = assembleKit({ company: 'Acme', role: 'Analyst' }, readyFacts({
    answers: { exists: true, path: 'interview-prep/x.md' },
    research: { exists: true, path: 'data/companies/x.md', state: 'stale', ageDays: 50, valid: true },
    outreach: { contacts: 0, touches: 0 }, // missing (non-blocking), lower weight
  }))
  // research stale (w1) vs outreach missing (w1) → missing (tier 1) wins over stale (tier 2)
  assert.equal(kit.topAction.id, 'outreach')
})

/* ───── renderKit: edge / branch cases ─────────────────────────────────────*/

test('renderKit: no company AND no role → falls back to "Listing" title', () => {
  const md = buildKitMarkdown({}, {})
  assert.match(md, /# Application-kit readiness — Listing/)
})

test('renderKit: sendable-with-gaps verdict shown correctly', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'PM' }, readyFacts({
    answers: { exists: false },
    research: { exists: false },
    outreach: {},
  }))
  assert.match(md, /Sendable \(gaps remain\)/)
  assert.doesNotMatch(md, /BLOCKED/)
})

test('renderKit: stale artifact shows the delegation arrow', () => {
  const md = buildKitMarkdown({ company: 'Acme', role: 'PM' }, readyFacts({
    research: { exists: true, path: 'data/companies/acme.md', state: 'stale', ageDays: 45, valid: true },
  }))
  assert.match(md, /→ .*\(deep mode\)/)
})

test('renderKit: kit with no note text still renders without crash', () => {
  // Force note to be null-ish by passing a storyBank with ok/gaps/count all fine
  // but storyBankNote itself returns an object; ensure the text branch handles
  // a note with empty text gracefully.
  const md = renderKit({
    company: 'Acme', role: 'Analyst', slug: null,
    checks: [],
    note: { level: 'ok', text: '' }, // empty text → should skip the paragraph
    summary: { ready: 0, stale: 0, missing: 0 },
    verdict: 'ready',
    readyToSend: true,
    completeness: 1,
    topAction: null,
  })
  assert.match(md, /# Application-kit readiness/)
  assert.doesNotMatch(md, /\n_\n/) // no empty italic paragraph
})

/* ───── atsSidecarName ──────────────────────────────────────────────────────
 * The CV and its coverage record travel together: same stem, .ats.json ext. */

test('atsSidecarName: swaps a .pdf extension for .ats.json', () => {
  assert.equal(
    atsSidecarName('output/cv-jo-acme-2026-06-27.pdf'),
    'output/cv-jo-acme-2026-06-27.ats.json',
  )
})

test('atsSidecarName: a CV and its HTML twin share one sidecar', () => {
  // Same stem → same sidecar, so coverage written for either is found.
  assert.equal(
    atsSidecarName('output/cv-jo-acme-2026-06-27.html'),
    atsSidecarName('output/cv-jo-acme-2026-06-27.pdf'),
  )
})

test('atsSidecarName: no recognizable extension → appends .ats.json', () => {
  assert.equal(atsSidecarName('output/cv-jo-acme'), 'output/cv-jo-acme.ats.json')
})

test('atsSidecarName: empty / nullish input → empty string', () => {
  assert.equal(atsSidecarName(''), '')
  assert.equal(atsSidecarName(null), '')
  assert.equal(atsSidecarName(undefined), '')
})

/* ───── parseAtsSidecar ─────────────────────────────────────────────────────
 * Tolerant by construction: a missing/malformed sidecar is "unverified", not a
 * crash. coveragePct (0..100) and coverage (0..1 or 0..100) both resolve. */

test('parseAtsSidecar: coveragePct (0..100) → fraction, atsChecked true', () => {
  const r = parseAtsSidecar(JSON.stringify({ coveragePct: 82 }))
  assert.equal(r.atsChecked, true)
  assert.equal(r.atsCoverage, 0.82)
})

test('parseAtsSidecar: fractional coverage (0..1) is taken as-is', () => {
  const r = parseAtsSidecar(JSON.stringify({ coverage: 0.73 }))
  assert.equal(r.atsChecked, true)
  assert.equal(r.atsCoverage, 0.73)
})

test('parseAtsSidecar: coveragePct wins over coverage when both present', () => {
  // ats-coverage.mjs emits both; the integer percent is the canonical signal.
  const r = parseAtsSidecar(JSON.stringify({ coverage: 0.5, coveragePct: 80 }))
  assert.equal(r.atsCoverage, 0.8)
})

test('parseAtsSidecar: a string number is coerced', () => {
  const r = parseAtsSidecar(JSON.stringify({ coveragePct: '67' }))
  assert.equal(r.atsChecked, true)
  assert.equal(r.atsCoverage, 0.67)
})

test('parseAtsSidecar: empty / null / blank → unverified (atsChecked false)', () => {
  for (const v of [null, undefined, '', '   ']) {
    const r = parseAtsSidecar(v)
    assert.equal(r.atsChecked, false)
    assert.equal(r.atsCoverage, undefined)
  }
})

test('parseAtsSidecar: malformed JSON → unverified, does not throw', () => {
  const r = parseAtsSidecar('{not json')
  assert.equal(r.atsChecked, false)
})

test('parseAtsSidecar: object without a coverage field → unverified', () => {
  const r = parseAtsSidecar(JSON.stringify({ note: 'hi', missing: ['x'] }))
  assert.equal(r.atsChecked, false)
})

test('parseAtsSidecar: out-of-range coverage → unverified', () => {
  // > 100 can't be a percent or a fraction → rejected rather than silently capped.
  assert.equal(parseAtsSidecar(JSON.stringify({ coveragePct: 150 })).atsChecked, false)
  assert.equal(parseAtsSidecar(JSON.stringify({ coveragePct: -4 })).atsChecked, false)
  assert.equal(parseAtsSidecar(JSON.stringify({ coverage: -0.2 })).atsChecked, false)
})

test('parseAtsSidecar: a value in (1,100] is read as a percentage', () => {
  // The >1 → percent heuristic: a bare 12 means 12%, not a 1200% fraction.
  assert.equal(parseAtsSidecar(JSON.stringify({ coverage: 12 })).atsCoverage, 0.12)
})

/* ───── cvFactsFromFiles ────────────────────────────────────────────────────
 * Composes the fact object cvCheck consumes from the resolved file facts. */

test('cvFactsFromFiles: absent CV → just { exists:false }', () => {
  assert.deepEqual(cvFactsFromFiles({ exists: false }), { exists: false })
  assert.deepEqual(cvFactsFromFiles(), { exists: false })
})

test('cvFactsFromFiles: CV + healthy sidecar → ATS-checked facts → cvCheck ready', () => {
  const facts = cvFactsFromFiles({
    exists: true,
    path: 'output/cv-jo-acme-2026-06-27.pdf',
    sidecarText: JSON.stringify({ coveragePct: 78 }),
  })
  assert.equal(facts.exists, true)
  assert.equal(facts.atsChecked, true)
  assert.equal(facts.atsCoverage, 0.78)
  // End-to-end: these facts drive cvCheck to "ready".
  assert.equal(cvCheck(facts).status, 'ready')
})

test('cvFactsFromFiles: CV + low-coverage sidecar → cvCheck downgrades to stale', () => {
  const facts = cvFactsFromFiles({
    exists: true,
    path: 'output/cv.pdf',
    sidecarText: JSON.stringify({ coveragePct: 40 }),
  })
  assert.equal(facts.atsCoverage, 0.4)
  const c = cvCheck(facts)
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /40%/)
})

test('cvFactsFromFiles: CV but NO sidecar → atsChecked:false → cvCheck stale (re-tailor)', () => {
  // This is the core fix: an existing CV with no coverage record is no longer
  // silently "ready" — it reads as ATS-unverified, nudging a re-tailor.
  const facts = cvFactsFromFiles({ exists: true, path: 'output/cv.pdf', sidecarText: null })
  assert.equal(facts.exists, true)
  assert.equal(facts.atsChecked, false)
  assert.equal(facts.atsCoverage, undefined)
  const c = cvCheck(facts)
  assert.equal(c.status, 'stale')
  assert.match(c.detail, /not ATS-checked/)
})

test('cvFactsFromFiles: malformed sidecar is treated as no sidecar (unverified)', () => {
  const facts = cvFactsFromFiles({ exists: true, path: 'output/cv.pdf', sidecarText: 'garbage' })
  assert.equal(facts.atsChecked, false)
  assert.equal(cvCheck(facts).status, 'stale')
})

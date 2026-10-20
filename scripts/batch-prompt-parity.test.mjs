// batch-prompt-parity.test.mjs — pins structural agreement between the
// canonical rubric (modes/_shared.md) and the compact batch worker prompt
// (batch/batch-prompt.md), plus the per-tier output shapes in
// modes/scouting.md. Scoring contract: docs/scoring-v2.md.
//
// History: the batch prompt once carried a hand-copied rubric that drifted
// two generations behind _shared.md while keeping a MATCHING scoring-version
// stamp — so the runner's version check passed while workers scored with a
// different framework, auto-generated PDFs, and wrote a wrong-shaped TSV.
// The version stamp only proves someone bumped a comment; these checks prove
// the load-bearing structures actually agree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = readFileSync(join(ROOT, 'modes/_shared.md'), 'utf8')
const prompt = readFileSync(join(ROOT, 'batch/batch-prompt.md'), 'utf8')
const scouting = readFileSync(join(ROOT, 'modes/scouting.md'), 'utf8')

const BOTH = [['_shared.md', shared], ['batch prompt', prompt]]

function versionOf(text) {
  const m = text.match(/<!-- scoring-version: ([0-9-]+) -->/)
  return m ? m[1] : null
}

test('scoring-version stamps match', () => {
  assert.equal(versionOf(prompt), versionOf(shared))
  assert.ok(versionOf(shared), 'shared.md must carry a scoring-version stamp')
})

// ─── score-history.tsv (spec §8.1) ───────────────────────────────────────────

const V2_HEADER = [
  'date', 'archetype', 'skills_match', 'experience_bar', 'competition', 'ease',
  'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
  'best_cities', 'salary_adj_city', 'work_life_balance', 'want', 'priority',
  'eligibility', 'eligibility_flags', 'verdict', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

test('score-history.tsv header line is byte-identical in both files and matches spec §8.1', () => {
  const headerRe = /^date\tarchetype\t.*\turl$/m
  const inShared = shared.match(headerRe)?.[0]
  const inPrompt = prompt.match(headerRe)?.[0]
  assert.ok(inShared, '_shared.md must contain the score-history header')
  assert.ok(inPrompt, 'batch-prompt.md must contain the score-history header')
  assert.equal(inPrompt, inShared)
  assert.equal(inShared, V2_HEADER)
  assert.equal(inShared.split('\t').length, 29, 'header is 29 columns')
})

test('blocked rows leave scores empty, never 0', () => {
  for (const [name, text] of BOTH) {
    assert.match(text, /empty\**\s*\(not 0\)/, `${name} states blocked scores are empty, not 0`)
  }
})

// ─── Engine delegation + the model's vocabulary ──────────────────────────────

test('both files delegate the math to score-listing.mjs and run eligibility first', () => {
  for (const [name, text] of BOTH) {
    assert.match(text, /score-listing\.mjs/, `${name} names the script`)
    assert.match(text, /--eligibility-only/, `${name} runs the eligibility gate first`)
  }
})

test('no Overall, no v1 rollups or dimensions survive', () => {
  for (const [name, text] of BOTH) {
    assert.match(text, /no \**Overall/i, `${name} states there is no Overall`)
    for (const banned of [
      'Current Fit', 'Aspirational Fit', 'Sales-Trap', 'Ease of Entry',
      'Strategic/Analytical Fit', 'Stellar', 'CF × 0.70', '**Overall**',
      'current_fit', 'aspirational_fit', 'ease_of_entry', 'strategic_fit',
      'sales_trap_risk', 'Language-barrier exception',
    ]) {
      assert.ok(!text.includes(banned), `${name} must not contain "${banned}"`)
    }
  }
})

test('all ten judgment dimensions are named in both files', () => {
  for (const dim of [
    'Growth / Mobility', 'Optionality / Exit', 'Brand Value', 'Role content',
    'City', 'Salary Adj for City', 'Work-Life Balance',
    'Skills Match', 'Experience bar', 'Competition',
  ]) {
    for (const [name, text] of BOTH) assert.ok(text.includes(dim), `${name} names ${dim}`)
  }
  // The input keys the script expects (spec §6).
  for (const key of [
    'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
    'best_cities', 'work_life_balance', 'skills_match', 'experience_bar', 'competition',
  ]) {
    for (const [name, text] of BOTH) assert.ok(text.includes(`"${key}"`), `${name} passes judgment key ${key}`)
  }
})

test('the six eligibility checks are named in both files', () => {
  for (const check of ['start_date', 'duration', 'graduation', 'language', 'work_auth', 'other']) {
    for (const [name, text] of BOTH) {
      assert.ok(text.includes(`\`${check}\``), `${name} names eligibility check ${check}`)
    }
  }
  for (const [name, text] of BOTH) {
    assert.match(text, /"eligibility_facts"/, `${name} shows the eligibility_facts input`)
  }
})

test('verdict keys and labels agree (spec §4)', () => {
  const LABELS = {
    go: 'Go', stretch: 'Stretch', growth: 'Growth target', solid: 'Solid',
    thin: 'If pipeline thin', skip: 'Skip', blocked: 'Blocked',
  }
  // _shared.md carries the canonical label list; the bundle names every key.
  for (const [key, label] of Object.entries(LABELS)) {
    assert.ok(shared.includes(`\`${key}\` "${label}"`), `_shared.md labels ${key} as "${label}"`)
    assert.ok(prompt.includes(key), `batch prompt names verdict ${key}`)
  }
  for (const [name, text] of BOTH) {
    assert.match(text, /`READY` for `go`/, `${name} maps READY to go`)
    assert.match(text, /`MONITOR` for `stretch` (?:and|\/) `solid`/, `${name} maps MONITOR to stretch/solid`)
  }
})

test('tier-folder mapping line is identical in both files', () => {
  const lineRe = /^.*Tier folders: .*$/m
  const inShared = shared.match(lineRe)?.[0]?.replace(/^>\s*/, '')
  const inPrompt = prompt.match(lineRe)?.[0]
  assert.ok(inShared && inPrompt, 'both files state the tier-folder mapping')
  assert.equal(inPrompt, inShared)
  assert.match(inShared, /`T4` → no report file/)
})

test('key Competition / work_auth constants agree with _shared.md', () => {
  // The numbers most likely to silently diverge in a rewrite.
  for (const token of ['£38,700', '−1 to −4', 'CEMS Corporate Partner', 'max −1.0']) {
    assert.ok(shared.includes(token), `_shared.md contains ${token}`)
    assert.ok(prompt.includes(token), `batch prompt contains ${token}`)
  }
})

// ─── Report shape (spec §8.5) ────────────────────────────────────────────────

test('report header lines and dimensional-table tags agree', () => {
  for (const [name, text] of [...BOTH, ['scouting mode', scouting]]) {
    for (const token of [
      '**Want:**', '**Ease:**', '**Eligibility:**', '**Verdict:**', '**TL;DR:**', '**Tier:**', '**URL:**',
      '## Eligibility', '## Dimensional scoring', 'Salary math:',
    ]) {
      assert.ok(text.includes(token), `${name} carries ${token}`)
    }
  }
  for (const [name, text] of BOTH) {
    for (const row of [
      'Growth / Mobility (want)', 'Role content (want)', 'City (hygiene)',
      'Salary Adj for City (hygiene)', 'Work-Life Balance (hygiene)', '**Want (rollup)**',
      'Skills Match (ease)', 'Experience bar (ease)', 'Competition (ease)', '**Ease (rollup)**',
      'Best-fit Early-career Roles (context)',
    ]) {
      assert.ok(text.includes(row), `${name} carries table row ${row}`)
    }
  }
})

test('no "## Why this score" section anywhere; explanation drives what leads instead', () => {
  for (const [name, text] of [...BOTH, ['scouting mode', scouting]]) {
    assert.ok(!/^## Why this score/m.test(text), `${name} must not render a Why-this-score section`)
    assert.ok(!text.includes('Holding it back:'), `${name} must not template the old Holding-it-back line`)
    assert.ok(!text.includes('Closest lever:'), `${name} must not template the old Closest-lever line`)
  }
  for (const [name, text] of BOTH) {
    assert.match(text, /bindingConstraints\[0\]/, `${name} still uses the explanation to choose what leads`)
  }
})

test('salary cell is the one-line summary; the math chain is the report footer', () => {
  for (const [name, text] of BOTH) {
    assert.ok(text.includes('salary_adj_for_city.summary'), `${name} puts the summary in the Salary cell`)
    assert.ok(text.includes('Salary math: {salary_adj_for_city.math}'), `${name} carries the footer line`)
  }
  assert.ok(scouting.includes('Salary math: {salary_adj_for_city.math}'), 'scouting mode carries the footer line')
})

test('report voice: lead with the deciding factor, plain cells, length targets', () => {
  for (const [name, text] of [...BOTH, ['scouting mode', scouting]]) {
    assert.match(text, /[Ll]ead with what decides this listing/, `${name} states the lead rule`)
  }
  for (const [name, text] of [['batch prompt', prompt], ['scouting mode', scouting]]) {
    assert.match(text, /T1 roughly \**600–900/, `${name} states the T1 length target`)
  }
  for (const [name, text] of BOTH) {
    assert.match(text, /no score without a reason a person can check/i, `${name} keeps the one hard evidence rule`)
  }
})

// ─── Scouting flow writes ────────────────────────────────────────────────────

test('batch workers write the scouting flow, not the applications tracker', () => {
  assert.match(prompt, /batch\/scouting-additions\//)
  assert.match(prompt, /merge-scouting\.mjs/)
  assert.match(prompt, /12 tab-separated columns/)
  // The 12-col scouting TSV shape must match modes/scouting.md's definition.
  assert.ok(scouting.includes('12 tab-separated columns'))
  const row = '{num}\t{date}\t{company}\t{role}\t{want}\t{ease}\t{tier}\t{eligibility}\t'
  assert.ok(prompt.includes(row.replace('{date}', '{{DATE}}')), 'batch prompt TSV column order')
  assert.ok(scouting.includes(row), 'scouting mode TSV column order')
})

test('report-summaries row shape agrees between the bundle and modes/scouting.md', () => {
  const row = '{date}\t{company}\t{role}\t{archetype}\t{tier}\t{want}\t{ease}\t{eligibility}\t{key_gaps}\t{verdict}'
  assert.ok(prompt.includes(row), 'batch prompt report-summaries row')
  assert.ok(scouting.includes(row), 'scouting mode report-summaries row')
})

test('final JSON carries the v2 keys and score = Priority (spec §8.6)', () => {
  for (const key of ['"want"', '"ease"', '"eligibility"', '"verdict"', '"tier"', '"score"']) {
    assert.ok(prompt.includes(key), `final JSON has ${key}`)
  }
  assert.match(prompt, /`score` carries \*\*Priority\*\*/)
})

test('legacy drifted content stays dead', () => {
  for (const banned of [
    'Personalization Plan',   // CV tailoring belongs to modes/pdf.md
    'Interview Plan',         // belongs to modes/interview-prep.md
    'Posting Legitimacy',     // dropped from the scoring model
    'Extracted keywords',     // explicit token waste per modes/scouting.md
    'LLMOps',                 // hardcoded archetype from another user's profile
    'generate-pdf.mjs',       // evaluation NEVER auto-generates PDFs
    'cv-template.html',
    'A-H',                    // the pre-consolidation report format
    'tracker-additions',      // batch evals land in scouting, not applications
    '11 tab-separated',       // the v1 scouting TSV width
    'cite exact CV lines',    // evidence quota that forced CV-splashing
    'silent CV section',      // the old four-part Gaps quota
    '[no gate stated]',       // bracket tokens leak into the app's reasoning cells
  ]) {
    assert.ok(!prompt.includes(banned), `batch prompt must not contain "${banned}"`)
  }
})

test('batch prompt reads the generated CV summary with a documented full-CV fallback', () => {
  // Token-cost lever 3: workers ingest batch/cv-summary.md (generated by
  // scripts/cv-summary.mjs) instead of the full CV — but the fallback to
  // user/cv.md must stay documented so a missing artifact never fails a run.
  assert.match(prompt, /batch\/cv-summary\.md/)
  assert.match(prompt, /scripts\/cv-summary\.mjs/)
  assert.match(prompt, /missing[\s\S]{0,80}user\/cv\.md/i)
})

test('batch prompt documents the unresolved-placeholder contract', () => {
  // Both the batch runner and the frontend pass this file verbatim via
  // --append-system-prompt-file (no per-worker substitution — a byte-identical
  // system prompt is what makes prompt caching work, token-cost lever 4).
  assert.match(prompt, /Unresolved placeholders/i)
  assert.match(prompt, /task message/i)
  assert.match(prompt, /verbatim/i)
})

test('batch mode marks verification as unconfirmed', () => {
  assert.match(prompt, /\*\*Verification:\*\* unconfirmed \(batch mode\)/)
})

// ─── Tiered report output (token-cost lever 5) ───────────────────────────────
// Every eval is logged (score-history row + scouting TSV are tier-independent),
// but the PROSE report depth is tiered: full sections only for T1, compact
// formats below, no file at all for T4 (skip + blocked).

test('verdict → tier → report depth agrees between the bundle and modes/scouting.md', () => {
  assert.match(prompt, /`go` → `T1` full report/)
  assert.match(prompt, /`stretch` \/ `solid` \/ `thin` → `T2` short report/)
  assert.match(prompt, /`growth` → `T3` Gap & Growth report/)
  assert.match(prompt, /`skip` \/ `blocked` → `T4` \(NO report file\)/)
  assert.match(scouting, /Generate a \*\*full report\*\*/)
  assert.match(scouting, /Generate a \*\*short summary report\*\*/)
  assert.match(scouting, /Generate a \*\*Gap & Growth Report\*\*/)
  assert.match(scouting, /Do NOT write a report file/)
  // The grid itself lives in _shared.md.
  for (const cell of ['`go` — Go: apply now (T1)', '`stretch` — Stretch: apply with prep (T2)',
                      '`growth` — Growth target: close the gap first (T3)', '`solid` — Solid: apply (T2)',
                      '`thin` — Only if your pipeline is thin (T2)', '`blocked` (T4)']) {
    assert.ok(shared.includes(cell), `_shared.md grid cell "${cell}"`)
  }
})

test('compact tiers still carry the header and the dimensional table', () => {
  // The frontend parser (frontend/src/lib/reportMarkdown.ts) keys on the
  // literal "## Dimensional scoring" heading and the **URL:** header line.
  assert.match(prompt, /Body \(all tiers that write a file\):.*`## Dimensional scoring`/)
  assert.match(scouting, /Always compute the full dimensional table first/)
})

test('skips and Blocked listings stay logged — data writes happen for ALL tiers', () => {
  assert.match(prompt, /Step 7 — Data writes \(ALL tiers, including T4 skips and Blocked\)/)
  assert.match(scouting, /regardless of tier \(including Tier 4 skips and Blocked listings\)/)
  assert.match(scouting, /\*\*Still compute the full dimensional table\*\*/)
  for (const [name, text] of [['batch prompt', prompt], ['scouting mode', scouting]]) {
    assert.match(text, /Revisit next cycle:/, `${name} documents the dream-company Blocked note`)
  }
})

test('Gap & Growth title and no-fabricated-timelines agree', () => {
  for (const [name, text] of [['batch prompt', prompt], ['scouting mode', scouting]]) {
    assert.ok(text.includes('# Gap & Growth:'), `${name} carries the T3 title prefix`)
    assert.match(text, /[Nn]o fabricated timelines/)
  }
})

test('report naming follows the canonical human-readable convention', () => {
  assert.match(prompt, /reports\/tier-\{N\}\/\{Company\} - \{Role\}\.md/)
  assert.ok(!/reports\/tier-\{N\}\/\{\{REPORT_NUM\}\}/.test(prompt),
    'no sequence-numbered report filenames')
})

test('the report number is a reserved claim in both files, not "log filenames only" or a best-effort max', () => {
  for (const [name, text] of BOTH) {
    assert.match(text, /reserve-report-num\.mjs/, `${name} points at the reservation script`)
    assert.ok(!/filenames only/.test(text), `${name} no longer calls the report number log-only`)
    assert.ok(!/best-effort next sequential/.test(text), `${name} no longer derives {num} from the trackers`)
  }
  assert.match(prompt, /`\{\{REPORT_NUM\}\}` \| The report number reserved for this listing/)
})

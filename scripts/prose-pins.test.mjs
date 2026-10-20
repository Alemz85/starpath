// prose-pins.test.mjs — pins the prose agents follow.
//
// Mode files, the batch prompt and the repo guides are instructions, not
// code: when two of them (or one of them and a script) drift apart nothing
// fails, an agent just does the wrong thing. batch-prompt-parity.test.mjs
// pins the scoring rubric between _shared.md and the batch bundle; this file
// pins the other cross-file promises:
//
//   1. a file that sends an agent to the web carries the untrusted-content rule
//   2. every status a mode tells an agent to write is in templates/states.yml
//   3. every scripts/*.mjs a guide names exists
//   4. the report header is the same sequence in the batch prompt, the
//      scouting mode and _shared.md
//
// Each check reads the files fresh and reports the file and line, so a failure
// says what to edit. The career-ops router (skill list vs modes/) has its own
// test; it is not repeated here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headerLabels, isSubsequence, scriptPaths, sharedHeaderLabels, statusWrites } from './lib/prose-pins.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const MODE_FILES = readdirSync(join(ROOT, 'modes'))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => `modes/${f}`)
/** Every file that is a prompt an agent follows, as repo-relative paths. */
const PROMPT_FILES = [...MODE_FILES, 'batch/batch-prompt.md', '.claude/skills/career-ops/SKILL.md']

// ─── 1. Untrusted-content marker ─────────────────────────────────────────────
//
// A page fetched with WebFetch, a search result or a Playwright snapshot is
// text a stranger wrote. A prompt that sends an agent there must say that the
// fetched text is data, not instructions. The marker below is the literal
// every such file has to carry. Session I1 (wave 3) is adding the rule; until
// its text lands, each file that fails is named in PENDING_RULE with the
// tools it uses, so the test is green but the gap is written down, and a file that
// gains the marker has to leave the map (the stale-exclusion check below).

/** The tools whose output is untrusted page text. */
const WEB_TOOLS = /\b(WebFetch|WebSearch|Playwright|browser_navigate|browser_snapshot)\b/

/** The literal the rule carries (one word, case-insensitive, so any phrasing of "untrusted content" counts). */
const UNTRUSTED_MARKER = /untrusted/i

/** file → why it has no marker yet. Empty it as the rule lands. */
const PENDING_RULE = {
  'modes/scan.md': 'sends the agent to Playwright, WebFetch and WebSearch for career pages',
  'modes/pipeline.md': 'verifies postings with Playwright and WebFetch, researches with WebSearch',
  'modes/chat.md': 'lets chat call WebFetch and WebSearch',
  'modes/deep.md': 'company research through WebSearch and WebFetch',
  'modes/training.md': 'course research through WebSearch and WebFetch',
  'modes/apply.md': 'drives the live application form with Playwright',
  'modes/deadlines.md': 'checks posting pages with Playwright, WebFetch and WebSearch',
  'modes/scouting.md': 'market and comp research through WebSearch',
  'modes/contacto.md': 'looks up contacts with WebSearch',
  'modes/interview-prep.md': 'looks up interview reports with WebSearch',
  'modes/_shared.md': 'the shared verification and research sections name every web tool',
  'batch/batch-prompt.md': 'the worker fetches the JD (WebFetch) and researches (WebSearch)',
  '.claude/skills/career-ops/SKILL.md': 'the router names Playwright for offer verification',
}

test('every prompt that sends an agent to the web carries the untrusted-content marker', () => {
  const missing = []
  for (const rel of PROMPT_FILES) {
    const text = read(rel)
    if (!WEB_TOOLS.test(text)) continue
    if (UNTRUSTED_MARKER.test(text)) continue
    if (rel in PENDING_RULE) continue
    missing.push(rel)
  }
  assert.deepEqual(missing, [], `these files use a web tool without the untrusted-content rule: ${missing.join(', ')}`)
})

test('PENDING_RULE only names files that still lack the marker', () => {
  for (const rel of Object.keys(PENDING_RULE)) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is in PENDING_RULE but no longer exists`)
    const text = read(rel)
    assert.ok(WEB_TOOLS.test(text), `${rel} no longer uses a web tool: drop it from PENDING_RULE`)
    assert.ok(!UNTRUSTED_MARKER.test(text), `${rel} now carries the marker: drop it from PENDING_RULE`)
  }
})

// ─── 2. Status values ────────────────────────────────────────────────────────

/** Canonical labels from templates/states.yml (the only values a status cell may hold). */
function canonicalStatuses() {
  const labels = [...read('templates/states.yml').matchAll(/^\s+label:\s*(.+?)\s*$/gm)].map((m) => m[1])
  assert.ok(labels.length >= 8, 'templates/states.yml lists the states')
  return labels
}

test('every status a prompt tells an agent to write is a canonical state', () => {
  const canon = new Set(canonicalStatuses())
  const bad = []
  let seen = 0
  for (const rel of [...PROMPT_FILES, 'CLAUDE.md', 'AGENTS.md']) {
    for (const w of statusWrites(read(rel))) {
      seen += 1
      if (!canon.has(w.value)) bad.push(`${rel}:${w.line} writes "${w.value}"`)
    }
  }
  assert.ok(seen >= 5, `the status extractor still finds status writes (found ${seen})`)
  assert.deepEqual(bad, [], `not in templates/states.yml: ${bad.join('; ')}`)
})

test('the status lists in CLAUDE.md, AGENTS.md and chat.md are exactly the canonical states', () => {
  const canon = canonicalStatuses()
  const listLine = {
    'CLAUDE.md': /^Source of truth: .*Statuses are (.+)$/m,
    'AGENTS.md': /^Source of truth: .*Statuses are (.+)$/m,
    'modes/chat.md': /Canonical only, from `templates\/states\.yml`:\s*([^.|]+)\./,
  }
  for (const [rel, re] of Object.entries(listLine)) {
    const m = read(rel).match(re)
    assert.ok(m, `${rel} lists the canonical statuses`)
    const listed = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1])
    assert.deepEqual(listed, canon, `${rel} lists the states in states.yml order`)
  }
})

test('statuses a prompt calls non-canonical never come back', () => {
  // Aliases normalize-statuses.mjs still reads. Prompts must write the label.
  const aliases = [...read('templates/states.yml').matchAll(/aliases:\s*\[(.*)\]/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter((a) => a && a !== 'skip' && a !== 'sent' && a !== 'monitor')
  for (const rel of [...PROMPT_FILES, 'CLAUDE.md', 'AGENTS.md']) {
    for (const w of statusWrites(read(rel))) {
      assert.ok(!aliases.includes(w.value.toLowerCase()), `${rel}:${w.line} writes the alias "${w.value}"`)
    }
  }
})

// ─── 3. Script paths named in the guides ─────────────────────────────────────

const GUIDES = ['CLAUDE.md', 'AGENTS.md', 'docs/REPO-GUIDE.md']

test('every scripts/*.mjs a guide names exists', () => {
  const missing = []
  let seen = 0
  for (const rel of GUIDES) {
    for (const s of scriptPaths(read(rel))) {
      seen += 1
      if (!existsSync(join(ROOT, s.path))) missing.push(`${rel}:${s.line} names ${s.path}`)
    }
  }
  assert.ok(seen >= 20, `the guides still name scripts (found ${seen})`)
  assert.deepEqual(missing, [], `no such file: ${missing.join('; ')}`)
})

test('CLAUDE.md and AGENTS.md name the same scripts', () => {
  const names = (rel) => [...new Set(scriptPaths(read(rel)).map((s) => s.path))].sort()
  assert.deepEqual(names('AGENTS.md'), names('CLAUDE.md'))
})

// ─── 4. Report header order ──────────────────────────────────────────────────

/** Header lines only the batch worker writes (it runs without a browser and has a run id). */
const BATCH_ONLY = new Set(['Verification', 'Batch ID'])

test('the report header has the same lines in the same order in the batch prompt and modes/scouting.md', () => {
  const scouting = headerLabels(read('modes/scouting.md'))
  const batch = headerLabels(read('batch/batch-prompt.md')).filter((l) => !BATCH_ONLY.has(l))
  assert.deepEqual(batch, scouting)
})

test('the header carries TL;DR between Verdict and Tier, and the URL last (plus any Posted line, in the same place everywhere)', () => {
  const scouting = headerLabels(read('modes/scouting.md'))
  const iVerdict = scouting.indexOf('Verdict')
  assert.equal(scouting[iVerdict + 1], 'TL;DR')
  assert.equal(scouting[iVerdict + 2], 'Tier')
  assert.equal(scouting.at(-1), 'URL')
  const batch = headerLabels(read('batch/batch-prompt.md'))
  assert.equal(batch.at(-1 - [...BATCH_ONLY].filter((l) => batch.includes(l)).length), 'URL', 'batch-only lines follow the URL')
  assert.deepEqual(batch.slice(-2), ['Verification', 'Batch ID'])
  // Posted is added by wave 3 (I1); once any file has it, all three must.
  const sharedLabels = sharedHeaderLabels(read('modes/_shared.md'))
  const withPosted = [scouting, batch, sharedLabels].filter((l) => l.includes('Posted'))
  assert.ok(withPosted.length === 0 || withPosted.length === 3, 'Posted appears in the batch prompt, scouting mode and _shared.md together')
})

test('_shared.md header block is the tail of the scouting header, in order', () => {
  const scouting = headerLabels(read('modes/scouting.md'))
  const shared = sharedHeaderLabels(read('modes/_shared.md'))
  assert.ok(isSubsequence(shared, scouting), `_shared.md header [${shared.join(', ')}] is not an ordered part of [${scouting.join(', ')}]`)
  assert.deepEqual(shared.slice(0, 2), ['Want', 'Ease'])
  assert.equal(shared.at(-1), 'URL')
  assert.ok(shared.includes('TL;DR'), '_shared.md carries the TL;DR line')
})

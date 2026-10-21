/**
 * score-rows.test.mjs — the locked append behind scripts/append-score-rows.mjs.
 * Fictional rows in a temp dir.
 *
 * Run: node --test scripts/lib/score-rows.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { SCORE_HISTORY_HEADER } from './profile-core.mjs'
import { HISTORY_COLUMNS, SUMMARY_COLUMNS, buildRow, appendLine, appendScoreRows } from './score-rows.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'score-rows-'))
const files = (d) => ({ historyFile: join(d, 'score-history.tsv'), summariesFile: join(d, 'report-summaries.tsv') })
const HISTORY = {
  date: '2026-10-21', archetype: 'Operations', ease: 6.5, want: 7.25, priority: 6.85, eligibility: 'green', verdict: 'stretch',
  mode: 'scouting', company: "O'Brien & Sons", role: 'Depot Analyst', tier: 'T2', source: 'batch', location: 'Aldervale',
  salary_raw: '$45,000 / yr', url: 'https://jobs.example.com/aldervale/123?x=1&y=2',
}
const SUMMARY = { date: '2026-10-21', company: "O'Brien & Sons", role: 'Depot Analyst', archetype: 'Operations', tier: 'T2', want: 7.25, ease: 6.5, eligibility: 'green', key_gaps: '—', verdict: 'stretch' }

test('column lists are the canonical 29 and 10', () => {
  assert.equal(HISTORY_COLUMNS.join('\t'), SCORE_HISTORY_HEADER)
  assert.equal(HISTORY_COLUMNS.length, 29)
  assert.equal(SUMMARY_COLUMNS.length, 10)
})

test('buildRow: columns by name, unlisted columns empty, tabs/newlines in values flattened', () => {
  const line = buildRow(HISTORY_COLUMNS, { ...HISTORY, best_fit_roles: 'A\tB\nC' }, ['date'], 'h')
  const cells = line.split('\t')
  assert.equal(cells.length, 29)
  assert.equal(cells[HISTORY_COLUMNS.indexOf('company')], "O'Brien & Sons")
  assert.equal(cells[HISTORY_COLUMNS.indexOf('best_fit_roles')], 'A B C')
  assert.equal(cells[HISTORY_COLUMNS.indexOf('skills_match')], '')
  assert.equal(cells[HISTORY_COLUMNS.indexOf('salary_raw')], '$45,000 / yr')
})

test('buildRow: an unknown column or a missing required one is an error, not a silently wrong row', () => {
  assert.throws(() => buildRow(HISTORY_COLUMNS, { ...HISTORY, wnat: 7 }, [], 'score_history'), /unknown column\(s\) wnat/)
  assert.throws(() => buildRow(HISTORY_COLUMNS, { ...HISTORY, verdict: '' }, ['verdict'], 'score_history'), /missing required column\(s\) verdict/)
  assert.throws(() => buildRow(HISTORY_COLUMNS, 'x', [], 'score_history'), /expected an object/)
})

test('appendScoreRows: creates score-history with the header, summaries headerless; second call is a no-op duplicate', () => {
  const d = tmp()
  try {
    const f = files(d)
    assert.deepEqual(appendScoreRows({ score_history: HISTORY, report_summary: SUMMARY }, f), { score_history: 'appended', report_summary: 'appended' })
    const hist = readFileSync(f.historyFile, 'utf8').split('\n')
    assert.equal(hist[0], SCORE_HISTORY_HEADER)
    assert.equal(hist.length, 3, 'header + row + trailing newline')
    assert.equal(hist[1].split('\t').length, 29)
    const sum = readFileSync(f.summariesFile, 'utf8')
    assert.equal(sum, "2026-10-21\tO'Brien & Sons\tDepot Analyst\tOperations\tT2\t7.25\t6.5\tgreen\t—\tstretch\n")
    assert.deepEqual(appendScoreRows({ score_history: HISTORY, report_summary: SUMMARY }, f), { score_history: 'duplicate', report_summary: 'duplicate' })
    assert.equal(readFileSync(f.historyFile, 'utf8').split('\n').length, 3)
    appendScoreRows({ score_history: { ...HISTORY, role: 'Other' } }, f)
    assert.equal(readFileSync(f.historyFile, 'utf8').trim().split('\n').length, 3)
    assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('.')), [], 'no lock or temp file left behind')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('appendLine: appends to a file with no trailing newline; refuses a different header; validates before writing anything', () => {
  const d = tmp()
  try {
    const f = files(d)
    writeFileSync(f.summariesFile, 'a\tb')
    appendLine(f.summariesFile, 'c\td')
    assert.equal(readFileSync(f.summariesFile, 'utf8'), 'a\tb\nc\td\n')

    writeFileSync(f.historyFile, 'date\tcompany\n2026-01-01\tx\n')
    assert.throws(() => appendScoreRows({ score_history: HISTORY }, f), /header does not match/)
    assert.equal(readFileSync(f.historyFile, 'utf8'), 'date\tcompany\n2026-01-01\tx\n', 'untouched')

    const g = files(tmp())
    assert.throws(() => appendScoreRows({ score_history: HISTORY, report_summary: { ...SUMMARY, bogus: 1 } }, g), /unknown column/)
    assert.equal(existsSync(g.historyFile), false, 'the valid half is not written when the other half is invalid')
    assert.throws(() => appendScoreRows({}, g), /nothing to append/)
    assert.throws(() => appendScoreRows({ score_row: {} }, g), /unknown top-level key/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('the CLI reads a JSON file and appends under CAREER_OPS_ROOT/data (parallel workers do not lose rows)', async () => {
  const d = tmp()
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const script = join(here, '..', 'append-score-rows.mjs')
    const env = { ...process.env, CAREER_OPS_ROOT: d }
    const run = (n) => new Promise((resolve) => {
      const input = join(d, `rows-${n}.json`)
      writeFileSync(input, JSON.stringify({ score_history: { ...HISTORY, role: `Role ${n}` }, report_summary: { ...SUMMARY, role: `Role ${n}` } }))
      const c = spawn(process.execPath, [script, '--input', input], { env })
      let out = ''
      c.stdout.on('data', (b) => { out += b })
      c.on('close', (code) => resolve({ code, out }))
    })
    mkdirSync(join(d, 'data'))
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => run(n)))
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results))
    assert.equal(JSON.parse(results[0].out).score_history, 'appended')
    const rows = readFileSync(join(d, 'data/score-history.tsv'), 'utf8').trim().split('\n')
    assert.equal(rows.length, 7, 'header + six rows, none lost')
    assert.equal(readFileSync(join(d, 'data/report-summaries.tsv'), 'utf8').trim().split('\n').length, 6)

    const bad = spawnSync(process.execPath, [script, '--input', join(d, 'missing.json')], { env, encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /append-score-rows:/)
    assert.equal(spawnSync(process.execPath, [script], { env, encoding: 'utf8' }).status, 2)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

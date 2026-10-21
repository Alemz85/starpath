import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateScoreHistoryText, migrateScoutingText, migrateScoreCellsText, migrateTsvScoreCellsText,
  migrateReportText, migrateProfileYmlText, migrateProfileMdText, needsMigration,
} from './match-rename-migrate.mjs'
import { runMigration } from '../migrate-match-rename.mjs'
import { SCORE_HISTORY_HEADER, SCOUTING_SCAFFOLD } from './profile-core.mjs'
import { parseScoreCell } from './tracker-core.mjs'

const OLD_HISTORY_HEADER = SCORE_HISTORY_HEADER.replace('\tmatch\t', '\twant\t')

test('score-history: the want column becomes match, rows untouched, idempotent', () => {
  const row = '2026-10-01\tAnalyst\t7\t6\t5\t6.03\t8\t8\t7\t9\t8\t7\t7\t8.5\t7.16\tgreen\t\tgo\t\tbatch\tNimbus Robotics\tAnalyst\tT1\tscan\tLyon\tfull-time\t\t\thttps://example.com/1'
  const { text, changes } = migrateScoreHistoryText(`${OLD_HISTORY_HEADER}\n${row}\n`)
  assert.equal(changes, 1)
  assert.equal(text, `${SCORE_HISTORY_HEADER}\n${row}\n`)
  assert.equal(migrateScoreHistoryText(text).changes, 0)
})

test('scouting: only the header row changes', () => {
  const old = SCOUTING_SCAFFOLD.replace('| Match |', '| Want |')
  const body = '| 1 | 2026-10-01 | Nimbus Robotics | Analyst | 8.5 | 7 | T1 | green | — | n/d | APPLY | Want more? |\n'
  const { text, changes } = migrateScoutingText(old + body)
  assert.equal(changes, 1)
  assert.equal(text, SCOUTING_SCAFFOLD + body)
  assert.equal(migrateScoutingText(text).changes, 0)
})

test('score cells: W pairs at the start of a cell become M, anything else stays', () => {
  const md = [
    '| 1 | 2026-10-01 | Nimbus Robotics | Analyst | W8 E7.43 | Applied | ❌ | n/d | — | |',
    '| 2 | 2026-10-02 | Lumen Freight | Ops | **W8.3 · E5.6** | Evaluated | ❌ | n/d | — | |',
    '| 3 | 2026-10-03 | Contoso | Analyst | 7.4/10 | Rejected | ❌ | n/d | — | W8 E7 in the notes stays |',
    '- [x] #4 | https://example.com | Contoso | Analyst | W7 E6 | T2 | solid',
  ].join('\n')
  const { text, changes } = migrateScoreCellsText(md)
  assert.equal(changes, 3)
  assert.match(text, /\| M8 E7\.43 \|/)
  assert.match(text, /\| \*\*M8\.3 · E5\.6\*\* \|/)
  assert.match(text, /\| 7\.4\/10 \|/)
  assert.match(text, /W8 E7 in the notes stays/)
  assert.match(text, /\| M7 E6 \|/)
  assert.deepEqual(parseScoreCell('M8 E7.43'), { match: 8, ease: 7.43 })
  assert.equal(migrateScoreCellsText(text).changes, 0)
})

test('tracker additions: the score field between tabs', () => {
  const tsv = '5\t2026-10-01\tNimbus Robotics\tAnalyst\tEvaluated\tW8.5 E7\t❌\tn/d\t[5](reports/tier-1/x.md)\tnote\n'
  const { text, changes } = migrateTsvScoreCellsText(tsv)
  assert.equal(changes, 1)
  assert.equal(text, tsv.replace('W8.5 E7', 'M8.5 E7'))
  assert.equal(migrateTsvScoreCellsText(text).changes, 0)
})

test('reports: header line, (want) tags and the rollup row; prose stays', () => {
  const md = [
    '# Scouting: Nimbus Robotics — Analyst',
    '**Want:** 8.5/10 · **Ease:** 7.34/10',
    '## Dimensional scoring',
    '| Dimension | Score | Reasoning |',
    '|-----------|-------|-----------|',
    '| Growth / Mobility (want) | 8/10 | They want a fast learner. |',
    '| **Want (rollup)** | **8.5/10** | Carried by the work you want to do |',
    '| Skills Match (ease) | 8/10 | Covered |',
    'Want is not touched in prose.',
  ].join('\n')
  const { text, changes } = migrateReportText(md)
  assert.equal(changes, 3)
  assert.match(text, /^\*\*Match:\*\* 8\.5\/10 · \*\*Ease:\*\* 7\.34\/10$/m)
  assert.match(text, /^\| Growth \/ Mobility \(match\) \| 8\/10 \| They want a fast learner\. \|$/m)
  assert.match(text, /^\| \*\*Match \(rollup\)\*\* \| \*\*8\.5\/10\*\* \| Carried by the work you want to do \|$/m)
  assert.match(text, /^Want is not touched in prose\.$/m)
  assert.equal(migrateReportText(text).changes, 0)
})

test('profile.yml: the weights key and "Want" in comments; values and plain words stay', () => {
  const yml = [
    'scoring:',
    '  # Want motivators equal; Ease as default.',
    '  want_weights: { growth_mobility: 1, role_content: 1 }',
    'calibration:',
    '  lower_tier_dream_companies: ["Contoso"]   # +0.25 Want (preference)',
    '  note: "Want me to stay"',
  ].join('\n')
  const { text, changes } = migrateProfileYmlText(yml)
  assert.equal(changes, 3)
  assert.match(text, /# Match motivators equal/)
  assert.match(text, /^ {2}match_weights: \{/m)
  assert.match(text, /# \+0\.25 Match \(preference\)/)
  assert.match(text, /note: "Want me to stay"/)
  assert.equal(migrateProfileYmlText(text).changes, 0)
})

test('_profile.md: only the scoring phrases', () => {
  const md = 'Dream companies get a Want floor of 8. Preference goes into Want; Top → +0.25 Want.\nWhat I want: steep learning.'
  const { text, changes } = migrateProfileMdText(md)
  assert.equal(changes, 3)
  assert.equal(text, 'Dream companies get a Match floor of 8. Preference goes into Match; Top → +0.25 Match.\nWhat I want: steep learning.')
  assert.equal(needsMigration('profile-md', text), false)
})

test('runMigration: report only, then --apply through a link, then nothing left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'match-rename-'))
  const cwd = process.cwd()
  try {
    mkdirSync(join(dir, 'private/data'), { recursive: true })
    mkdirSync(join(dir, 'reports/tier-1'), { recursive: true })
    mkdirSync(join(dir, 'batch/tracker-additions/merged'), { recursive: true })
    symlinkSync(join(dir, 'private/data'), join(dir, 'data'))
    writeFileSync(join(dir, 'private/data/score-history.tsv'), `${OLD_HISTORY_HEADER}\n`)
    writeFileSync(join(dir, 'private/data/applications.md'), '| # | Date |\n| 1 | 2026-10-01 | Nimbus Robotics | Analyst | W8 E7 | Applied | ❌ | n/d | — | |\n')
    writeFileSync(join(dir, 'reports/tier-1/Nimbus Robotics - Analyst.md'), '**Want:** 8/10 · **Ease:** 7/10\n')
    writeFileSync(join(dir, 'batch/tracker-additions/5-nimbus.tsv'), '5\t2026-10-01\tNimbus Robotics\tAnalyst\tEvaluated\tW8 E7\t❌\tn/d\t—\t\n')
    writeFileSync(join(dir, 'batch/tracker-additions/merged/4-old.tsv'), '4\t2026-09-01\tContoso\tAnalyst\tEvaluated\tW6 E6\t❌\tn/d\t—\t\n')
    process.chdir(dir)
    const log = () => {}
    const planned = runMigration({ log })
    assert.deepEqual(planned.map(r => r.path).sort(), [
      'batch/tracker-additions/5-nimbus.tsv', 'data/applications.md', 'data/score-history.tsv', 'reports/tier-1/Nimbus Robotics - Analyst.md',
    ])
    assert.match(readFileSync('data/applications.md', 'utf8'), /W8 E7/, 'report only writes nothing')
    runMigration({ apply: true, log })
    assert.match(readFileSync('private/data/applications.md', 'utf8'), /\| M8 E7 \|/)
    assert.equal(readFileSync('data/score-history.tsv', 'utf8'), `${SCORE_HISTORY_HEADER}\n`)
    assert.match(readFileSync('batch/tracker-additions/merged/4-old.tsv', 'utf8'), /W6 E6/, 'merged additions are history')
    assert.deepEqual(runMigration({ log }), [])
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

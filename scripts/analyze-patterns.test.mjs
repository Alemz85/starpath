// analyze-patterns.test.mjs — the CLI against a fictional scoring-v2 tree:
// reports carry the archetype in the header (no `| Archetype |` row), and
// score-history.tsv carries it too. Neither may fall into "Unknown".
//
// Run: node --test scripts/analyze-patterns.test.mjs   (or `npm test`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPLICATIONS_SCAFFOLD, SCORE_HISTORY_HEADER } from './lib/profile-core.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'analyze-patterns.mjs')

const report = (company, role, archetype) => `# Scouting: ${company} — ${role}

**Date:** 2026-06-01
**Location:** Lyon, France hybrid
${archetype ? `**Archetype:** ${archetype}\n` : ''}**Match:** 8.2/10 · **Ease:** 6.1/10
**Eligibility:** green
**Verdict:** Stretch — apply with prep
**Tier:** T2
**URL:** https://example.com/jobs/1

## Dimensional scoring

| Dimension | Score |
|-----------|-------|
| Skills match | 8 |
`

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'starpath-patterns-'))
  for (const d of ['data', 'reports/tier-2']) mkdirSync(join(root, d), { recursive: true })
  const apps = [
    ['1', 'Nimbus Robotics', 'Strategy Analyst', 'Applied'],
    ['2', 'Nimbus Robotics', 'Ops Analyst', 'Rejected'],
    ['3', 'Contoso Labs', 'Data Analyst', 'Interview'],
    ['4', 'Fabrikam Energy', 'Planning Analyst', 'Applied'],
  ]
  writeFileSync(join(root, 'data/applications.md'), APPLICATIONS_SCAFFOLD + apps.map(([n, c, r, st]) =>
    `| ${n} | 2026-06-0${n} | ${c} | ${r} | M8.2 E6.1 | ${st} | ❌ | n/d | [${n}](reports/tier-2/${c} - ${r}.md) |  |`).join('\n') + '\n')
  // 1-2: archetype in the report header · 3: only in score-history · 4: nowhere
  writeFileSync(join(root, 'reports/tier-2/Nimbus Robotics - Strategy Analyst.md'), report('Nimbus Robotics', 'Strategy Analyst', 'Strategy & Ops'))
  writeFileSync(join(root, 'reports/tier-2/Nimbus Robotics - Ops Analyst.md'), report('Nimbus Robotics', 'Ops Analyst', 'Strategy & Ops'))
  writeFileSync(join(root, 'reports/tier-2/Contoso Labs - Data Analyst.md'), report('Contoso Labs', 'Data Analyst', null))
  writeFileSync(join(root, 'reports/tier-2/Fabrikam Energy - Planning Analyst.md'), report('Fabrikam Energy', 'Planning Analyst', null))
  const cols = SCORE_HISTORY_HEADER.split('\t')
  const row = (o) => cols.map((c) => o[c] ?? '').join('\t')
  writeFileSync(join(root, 'data/score-history.tsv'), SCORE_HISTORY_HEADER + '\n' + row({
    date: '2026-06-03', archetype: 'Data & Analytics', match: '8.2', ease: '6.1', eligibility: 'green', verdict: 'stretch',
    mode: 'scouting', company: 'Contoso Labs', role: 'Data Analyst', tier: 'T2', source: 'batch',
  }) + '\n')
  return root
}

test('analyze-patterns: v2 archetypes come from the report header and score-history, "Unknown" only when neither has one', () => {
  const root = makeTree()
  try {
    const r = spawnSync('node', [SCRIPT, '--min-threshold', '1'], { env: { ...process.env, STARPATH_DATA: root }, encoding: 'utf-8' })
    assert.equal(r.status, 0, r.stderr)
    const { archetypeBreakdown } = JSON.parse(r.stdout)
    const totals = Object.fromEntries(archetypeBreakdown.map((a) => [a.archetype, a.total]))
    assert.deepEqual(totals, { 'Strategy & Ops': 2, 'Data & Analytics': 1, Unknown: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

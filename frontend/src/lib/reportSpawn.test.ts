import test from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_SPAWN_PREFIX, reportPrompt, reportSpawnId } from './reportSpawn'
import { resolveReport } from './reportMatch'
import { claudeArgs, NON_INTERACTIVE_SUFFIX } from './spawnFormat'
import type { ReportFile } from '@/types'

// Fictional fixtures only.
const A = { company: 'Nimbus Robotics', role: 'Data Analyst Intern', url: 'https://jobs.example.com/nimbus/1' }
const B = { company: 'Nimbus Robotics', role: 'Strategy Intern, Summer 2027 - Lyon', url: 'https://jobs.example.com/nimbus/2' }
const C = { company: 'Lumen Freight', role: 'Data Analyst Intern', url: null }

test('each listing gets its own report spawn id, stable across clicks', () => {
  const ids = [A, B, C].map(reportSpawnId)
  assert.equal(new Set(ids).size, 3, 'different listings run side by side')
  assert.equal(reportSpawnId({ ...A }), ids[0], 'the same listing maps to the same id (no double run)')
  assert.ok(ids.every((id) => id.startsWith(REPORT_SPAWN_PREFIX)))
  assert.equal(reportSpawnId(B), 'report-nimbus-robotics--strategy-intern-summer-2027-lyon')
})

test('the report prompt is render-only, uses the URL when there is one, and never touches the tracker', () => {
  const withUrl = reportPrompt(A)
  assert.ok(withUrl.startsWith('/career-ops scouting https://jobs.example.com/nimbus/1 — '))
  assert.ok(withUrl.includes('RENDER-ONLY mode: do not re-score'))
  assert.ok(withUrl.includes('never edit data/scouting.md'))
  assert.ok(withUrl.includes('under reports/tier-4/'), 'a Blocked or Skip listing gets its report on request')
  assert.ok(reportPrompt(C).startsWith('/career-ops scouting for Lumen Freight — Data Analyst Intern — '))
  assert.ok(reportPrompt({ ...A, url: 'local:jds/x.md' }).startsWith('/career-ops scouting for '), 'a non-http URL is not passed on')
})

test('a report written as {Company} - {Role}.md is found without a tracker link', () => {
  const file: ReportFile = { path: `reports/tier-2/${B.company} - ${B.role}.md`, company: B.company, role: B.role, tier: 'T2', url: '' }
  assert.equal(resolveReport([file], B, []), file)
})

test('every worker prompt carries the shell rule from its first call', () => {
  const last = claudeArgs(reportPrompt(A), 'opus', 'report').at(-1) ?? ''
  assert.ok(last.endsWith(NON_INTERACTIVE_SUFFIX))
  for (const bit of ['one per Bash call', 'no `cd`', 'no `echo $?`', 'no `>` redirects', 'no `mkdir`', 'never `cat`, `sed`']) {
    assert.ok(NON_INTERACTIVE_SUFFIX.includes(bit), bit)
  }
})

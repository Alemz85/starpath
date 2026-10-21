import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mirroredPathCandidates, reportFileStem, reportIdentity, reportKey, reportLinkTarget,
  reportPathCandidates, reportTitle, resolveReport, sameReportListing, trackerReportLinks,
} from './reportMatch'
import { findReport } from '@/components/chat/cards/cardData'
import { parseReportPath } from '@/lib/parsers/markdown'
import { reportNumberFor } from '@/lib/jdArchive'
import type { ApplicationEntry, ReportFile, ScoutingEntry } from '@/types'

// Fictional fixtures only.
const report = (path: string, company: string, role: string): ReportFile =>
  ({ path, company, role, tier: 'T1', url: '' })

const LYON = report(
  'reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 Lyon.md',
  'Nimbus Robotics', 'Process Analyst Intern 2027 Lyon',
)
const SIBLING = report(
  'reports/tier-1/Nimbus Robotics - Program Analyst Intern, Lyon 2027.md',
  'Nimbus Robotics', 'Program Analyst Intern, Lyon 2027',
)
const DASH = report(
  'reports/tier-2/Harbor Labs - Data Analyst – Growth, Lisbon.md',
  'Harbor Labs', 'Data Analyst – Growth, Lisbon',
)
const REPORTS = [SIBLING, LYON, DASH]

// ─── File-name rule ──────────────────────────────────────────────────────────

test('reportFileStem drops the characters scouting mode drops and collapses spaces', () => {
  assert.equal(
    reportFileStem('Nimbus Robotics', 'Data Analyst (Lyon, autumn start)'),
    'Nimbus Robotics - Data Analyst Lyon, autumn start',
  )
  assert.equal(reportFileStem('Acme', 'Ops: Intern [2027] / EU?'), 'Acme - Ops Intern 2027 EU')
  // Commas and dashes stay: they're legal in file names.
  assert.equal(reportFileStem('Harbor Labs', 'Data Analyst – Growth, Lisbon'), 'Harbor Labs - Data Analyst – Growth, Lisbon')
})

test('reportKey / sameReportListing ignore case, spacing and dropped characters, nothing else', () => {
  assert.equal(reportKey('Nimbus Robotics', 'Process Analyst Intern 2027 (Lyon)'), reportKey('nimbus  robotics', 'process analyst intern 2027 lyon'))
  assert.ok(sameReportListing(
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' },
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 Lyon' },
  ))
  assert.ok(!sameReportListing(
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' },
    { company: 'Nimbus Robotics', role: 'Program Analyst Intern, Lyon 2027' },
  ))
})

// ─── Tracker links ───────────────────────────────────────────────────────────

test('reportLinkTarget reads plain, percent-encoded, angle-bracket and literal-parenthesis links', () => {
  assert.equal(
    reportLinkTarget('[11](reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 Lyon.md)'),
    LYON.path,
  )
  assert.equal(
    reportLinkTarget('[11](reports/tier-1/Nimbus%20Robotics%20-%20Process%20Analyst%20Intern%202027%20%28Lyon%29.md)'),
    'reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 (Lyon).md',
  )
  assert.equal(
    reportLinkTarget('[#3](reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 (Lyon).md)'),
    'reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 (Lyon).md',
  )
  assert.equal(reportLinkTarget('[4](<reports/tier-2/Harbor Labs - Data Analyst.md>)'), 'reports/tier-2/Harbor Labs - Data Analyst.md')
  assert.equal(reportLinkTarget('—'), null)
  assert.equal(reportLinkTarget(''), null)
  assert.equal(reportLinkTarget('[x](https://example.com/job/1)'), null)
})

test('trackerReportLinks collects the listing\'s links only', () => {
  const rows = [
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)', report: '[11](reports/tier-1/X.md)' },
    { company: 'Nimbus Robotics', role: 'Program Analyst Intern, Lyon 2027', report: '[10](reports/tier-1/Y.md)' },
    { company: 'NIMBUS ROBOTICS', role: 'Process Analyst Intern 2027 (Lyon)', report: '[1](reports/tier-1/X.md)' },
  ]
  assert.deepEqual(trackerReportLinks(rows, 'Nimbus Robotics', 'Process Analyst Intern 2027 (Lyon)'), ['reports/tier-1/X.md'])
})

// ─── resolveReport ───────────────────────────────────────────────────────────

test('a role with parentheses finds the report saved without them', () => {
  const hit = resolveReport(REPORTS, { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' })
  assert.equal(hit?.path, LYON.path)
})

test('the tracker link wins, percent-encoded or not', () => {
  const renamed = report('reports/tier-1/Nimbus Robotics - Lyon ops internship.md', 'Nimbus Robotics', 'Lyon ops internship')
  const reports = [...REPORTS, renamed]
  const role = 'Process Analyst Intern 2027 (Lyon)'
  const encoded = [{ company: 'Nimbus Robotics', role, report: '[11](reports/tier-1/Nimbus%20Robotics%20-%20Lyon%20ops%20internship.md)' }]
  assert.equal(resolveReport(reports, { company: 'Nimbus Robotics', role }, encoded)?.path, renamed.path)
  const plain = [{ company: 'Nimbus Robotics', role, report: '[11](reports/tier-1/Nimbus Robotics - Lyon ops internship.md)' }]
  assert.equal(resolveReport(reports, { company: 'Nimbus Robotics', role }, plain)?.path, renamed.path)
  // A link to a file that isn't indexed falls through to the file-name rule.
  const stale = [{ company: 'Nimbus Robotics', role, report: '[11](reports/tier-1/Gone.md)' }]
  assert.equal(resolveReport(reports, { company: 'Nimbus Robotics', role }, stale)?.path, LYON.path)
})

test('a role with a comma and a dash matches its own file', () => {
  assert.equal(resolveReport(REPORTS, { company: 'Harbor Labs', role: 'Data Analyst – Growth, Lisbon' })?.path, DASH.path)
  assert.equal(resolveReport(REPORTS, { company: 'Harbor Labs', role: 'Data Analyst – Growth' }), null)
})

test('two listings at the same company never share a report', () => {
  assert.equal(resolveReport(REPORTS, { company: 'Nimbus Robotics', role: 'Program Analyst Intern, Lyon 2027' })?.path, SIBLING.path)
  assert.equal(resolveReport(REPORTS, { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' })?.path, LYON.path)
  assert.equal(resolveReport(REPORTS, { company: 'Nimbus Robotics', role: 'Data Analyst Intern (Lisbon)' }), null)
  // Even a sibling's tracker row pointing elsewhere doesn't leak across listings.
  const rows = [{ company: 'Nimbus Robotics', role: 'Program Analyst Intern, Lyon 2027', report: `[10](${LYON.path})` }]
  assert.equal(resolveReport(REPORTS, { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' }, rows)?.path, LYON.path)
  assert.equal(resolveReport([SIBLING], { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' }, rows), null)
})

test('findReport (chat card) uses the same resolver', () => {
  assert.equal(findReport(REPORTS, 'Nimbus Robotics', 'Process Analyst Intern 2027 (Lyon)')?.path, LYON.path)
  const rows = [{ company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)', report: '[11](reports/tier-1/Nimbus%20Robotics%20-%20Process%20Analyst%20Intern%202027%20Lyon.md)' }]
  assert.equal(findReport(REPORTS, 'Nimbus Robotics', 'Process Analyst Intern 2027 (Lyon)', rows)?.path, LYON.path)
})

// ─── Disk candidates ─────────────────────────────────────────────────────────

test('reportPathCandidates: tracker links, then each tier as written and as cleaned, then flat', () => {
  const rows = [{ company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)', report: '[11](reports/tier-1/Nimbus%20Robotics%20-%20Process%20Analyst%20Intern%202027%20%28Lyon%29.md)' }]
  const c = reportPathCandidates('Nimbus Robotics', 'Process Analyst Intern 2027 (Lyon)', rows)
  assert.equal(c[0], 'reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 (Lyon).md')
  assert.ok(c.includes('reports/tier-1/Nimbus Robotics - Process Analyst Intern 2027 Lyon.md'))
  assert.ok(c.includes('reports/tier-3/Nimbus Robotics - Process Analyst Intern 2027 Lyon.md'))
  assert.equal(c.at(-1), 'reports/Nimbus Robotics - Process Analyst Intern 2027 Lyon.md')
  assert.equal(new Set(c).size, c.length)
  // A clean name yields one stem per folder.
  assert.equal(reportPathCandidates('Harbor Labs', 'Data Analyst').length, 5)
  assert.deepEqual(mirroredPathCandidates('interview-prep', 'Nimbus Robotics', 'Analyst (Lyon)'), [
    'interview-prep/Nimbus Robotics - Analyst (Lyon).md',
    'interview-prep/Nimbus Robotics - Analyst Lyon.md',
  ])
})

// ─── Report identity (cache sync) ────────────────────────────────────────────

test('reportTitle reads the scouting, growth and bare title forms', () => {
  assert.deepEqual(reportTitle('# Scouting: Nimbus Robotics — Process Analyst Intern 2027 (Lyon)\n\n**Date:** x'),
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' })
  assert.deepEqual(reportTitle('# Gap & Growth: Harbor Labs — Data Analyst – Growth, Lisbon'),
    { company: 'Harbor Labs', role: 'Data Analyst – Growth, Lisbon' })
  assert.deepEqual(reportTitle('# Harbor Labs — Data Analyst'), { company: 'Harbor Labs', role: 'Data Analyst' })
  assert.equal(reportTitle('no title here'), null)
})

test('reportIdentity keeps the title spelling only when it names the file\'s listing', () => {
  const fromPath = parseReportPath(LYON.path)!
  assert.deepEqual(
    reportIdentity(fromPath, '# Scouting: Nimbus Robotics — Process Analyst Intern 2027 (Lyon)\n'),
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)' },
  )
  // A title for some other listing (copy-paste slip) never renames the file's listing.
  assert.deepEqual(
    reportIdentity(fromPath, '# Scouting: Nimbus Robotics — Program Analyst Intern, Lyon 2027\n'),
    { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 Lyon' },
  )
  assert.deepEqual(reportIdentity(fromPath, ''), { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 Lyon' })
})

// ─── JD archive number ───────────────────────────────────────────────────────

test('reportNumberFor finds the row by a percent-encoded link to the report', () => {
  const scouting = [{ num: 11, company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)', report: '[11](reports/tier-1/Nimbus%20Robotics%20-%20Process%20Analyst%20Intern%202027%20Lyon.md)' }] as unknown as ScoutingEntry[]
  const applications = [] as ApplicationEntry[]
  assert.equal(reportNumberFor({ scouting, applications, reportPath: LYON.path, company: 'x', role: 'y' }), 11)
  // And by the file-name rule when there's no path yet.
  assert.equal(reportNumberFor({ scouting, applications, reportPath: null, company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 Lyon' }), 11)
})

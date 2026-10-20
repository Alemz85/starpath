import test from 'node:test'
import assert from 'node:assert/strict'
import { loadJdArchive, normalizeUrl, parseArchive, pickByName, reportNumberFor, slugify } from './jdArchive'
import type { ApplicationEntry, ScoutingEntry } from '@/types'

const scoutingRow = (num: number, company: string, role: string, report: string) =>
  ({ num, company, role, report }) as unknown as ScoutingEntry
const appRow = (num: number, company: string, role: string, report: string) =>
  ({ num, company, role, report }) as unknown as ApplicationEntry

const STRUCTURED = `# Nimbus Robotics — Data Analyst

- **Company:** Nimbus Robotics
- **Role:** Data Analyst
- **URL:** https://jobs.example.com/roles/42
- **Fetched:** 2026-10-20
- **Source:** greenhouse-api

---

## About the role

Build dashboards.
`

test('slugify matches the script side', () => {
  assert.equal(slugify('Nimbus Robotics & Co.'), 'nimbus-robotics-and-co')
  assert.equal(slugify('Chargé d’affaires (Lyon)'), 'charge-d-affaires-lyon')
})

test('reportNumberFor: the row linking the report wins, then company + role', () => {
  const scouting = [
    scoutingRow(12, 'Nimbus Robotics', 'Data Analyst', '[12](reports/tier-1/Nimbus Robotics - Data Analyst.md)'),
    scoutingRow(30, 'Tailspin Toys', 'Analyst', '—'),
  ]
  const applications = [appRow(7, 'Fabrikam Energy', 'Ops', '[#7](reports/tier-2/Fabrikam%20Energy%20-%20Ops.md)')]
  const base = { scouting, applications }
  assert.equal(reportNumberFor({ ...base, reportPath: 'reports/tier-1/Nimbus Robotics - Data Analyst.md', company: 'x', role: 'y' }), 12)
  assert.equal(reportNumberFor({ ...base, reportPath: 'reports/tier-2/Fabrikam Energy - Ops.md', company: 'x', role: 'y' }), 7)
  assert.equal(reportNumberFor({ ...base, reportPath: null, company: 'tailspin toys', role: 'ANALYST' }), 30)
  assert.equal(reportNumberFor({ ...base, reportPath: null, company: 'Nobody', role: 'None' }), null)
})

test('pickByName: padded or unpadded number, then slug', () => {
  const names = ['012-nimbus-robotics-data-analyst.md', 'contoso-ops.md', '.unrecoverable.tsv', 'notes.txt']
  assert.equal(pickByName(names, { num: 12, company: '', role: '' }), '012-nimbus-robotics-data-analyst.md')
  assert.equal(pickByName(names, { num: 99, company: 'Contoso', role: 'Ops' }), 'contoso-ops.md')
  assert.equal(pickByName(names, { num: null, company: 'Other', role: 'Role' }), null)
})

test('parseArchive: structured file splits header from the posting', () => {
  const p = parseArchive(STRUCTURED)
  assert.equal(p.structured, true)
  assert.equal(p.fetched, '2026-10-20')
  assert.equal(p.url, 'https://jobs.example.com/roles/42')
  assert.equal(p.source, 'greenhouse-api')
  assert.equal(p.body, '## About the role\n\nBuild dashboards.')
})

test('parseArchive: a hand-saved file renders whole', () => {
  const legacy = '# Join Fabrikam\n\nURL: https://careers.example.com/jobs/9\n\nText.\n'
  const p = parseArchive(legacy)
  assert.equal(p.structured, false)
  assert.equal(p.url, 'https://careers.example.com/jobs/9')
  assert.equal(p.fetched, '')
  assert.match(p.body, /^# Join Fabrikam/)
})

test('loadJdArchive finds by number, then by URL among un-numbered files, else null', async () => {
  const files: Record<string, string> = {
    'jds/012-nimbus-robotics-data-analyst.md': STRUCTURED,
    'jds/fabrikam-old.md': 'URL: https://careers.example.com/jobs/9/?utm_source=x\n\nText.\n',
  }
  const io = { list: async () => Object.keys(files).map(p => p.slice(4)), read: async (p: string) => files[p] ?? null }
  const byNum = await loadJdArchive({ num: 12, company: 'a', role: 'b', url: '' }, io)
  assert.equal(byNum?.path, 'jds/012-nimbus-robotics-data-analyst.md')
  assert.equal(byNum?.fetched, '2026-10-20')
  const byUrl = await loadJdArchive({ num: 3, company: 'a', role: 'b', url: 'https://careers.example.com/jobs/9' }, io)
  assert.equal(byUrl?.path, 'jds/fabrikam-old.md')
  assert.equal(await loadJdArchive({ num: 3, company: 'a', role: 'b', url: 'https://nope.example.com/' }, io), null)
  assert.equal(normalizeUrl('https://careers.example.com/jobs/9/?utm_source=x'), 'careers.example.com/jobs/9')
})

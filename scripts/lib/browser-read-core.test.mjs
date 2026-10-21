// Tests for browser-read-core.mjs: parking a listing only a browser can read,
// requeueing it once its posting is saved, and the parsers that must keep
// ignoring a parked line. Fixtures are fictional.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PARKED_HEADING, cell, jdSavedPath, malformedParkedLines, messageKey, parkInPipeline, parkMessage,
  parkedEntries, parseParkedLine, requeueInPipeline, savedJdEntries, savedJdFor, suggestedJdPath, urlId, checkJdPath,
} from './browser-read-core.mjs'
import { parsePendingEntries } from './triage-core.mjs'
import { countPendingPipelineLines } from './profile-core.mjs'
import { countPending } from './scheduled-run-core.mjs'

const URL_A = 'https://careers.nimbus-robotics.example/jobs/strategy-analyst-4417?utm_source=board'
const URL_B = 'https://jobs.example.com/contoso/ops-analyst-12'

const PIPE = [
  '# Pipeline — Pending Evaluations',
  '',
  '## Pending',
  `- [ ] ${URL_A} | Nimbus Robotics | Strategy Analyst | relevance 6.2 — matches 2 target keywords | NOT EVALUATED 2026-10-18: HTTP 403 to every fetch`,
  `- [ ] ${URL_B} | Contoso | Ops Analyst`,
  '',
  '## Filtered Out',
  '- [!] FILTERED | https://example.com/x | Fabrikam | Senior Director | wrong seniority',
  '',
  '## Processed',
  '- [x] #1 | https://example.com/y | Tailspin Toys | Analyst | M8 E6 | T2 | stretch',
  '',
].join('\n')

const DATE = '2026-10-21'

test('urlId and the message key are stable across tracking params, www and fragments', () => {
  const a = urlId('https://www.careers.nimbus-robotics.example/jobs/strategy-analyst-4417#apply')
  assert.equal(a, urlId(URL_A))
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.notEqual(a, urlId(URL_B))
  assert.equal(messageKey(URL_A), `browser-read:${a}`)
})

test('cell strips pipes and newlines so a field can never split the line', () => {
  assert.equal(cell('Ops | Analyst\nLyon'), 'Ops / Analyst / Lyon')
  assert.equal(cell(null), '')
})

test('park moves the pending line into its own section, named from the line', () => {
  const r = parkInPipeline(PIPE, { url: URL_A, why: 'HTTP 403 to every script', date: DATE })
  assert.equal(r.company, 'Nimbus Robotics')
  assert.equal(r.role, 'Strategy Analyst')
  assert.equal(r.wasPending, true)
  assert.equal(r.line, `- [!] BROWSER READ | ${URL_A} | Nimbus Robotics | Strategy Analyst | ${DATE}: HTTP 403 to every script`)
  const lines = r.text.split('\n')
  // The section sits right after Pending, before Filtered Out.
  const at = (h) => lines.indexOf(h)
  assert.ok(at('## Pending') < at(PARKED_HEADING) && at(PARKED_HEADING) < at('## Filtered Out'))
  assert.equal(lines[at(PARKED_HEADING) + 1], r.line)
  assert.ok(!r.text.includes('NOT EVALUATED'), 'the old note leaves with the pending line')
  assert.ok(r.text.includes(`- [ ] ${URL_B} | Contoso | Ops Analyst`), 'other pending lines stay')
  assert.ok(r.text.includes('## Processed') && r.text.endsWith('stretch\n'))
})

test('every Pending parser ignores a parked line', () => {
  const { text } = parkInPipeline(PIPE, { url: URL_A, why: '403', date: DATE })
  assert.deepEqual(parsePendingEntries(text).map((e) => e.url), [URL_B])
  assert.equal(countPendingPipelineLines(text), 1)
  assert.equal(countPending('/x', () => text), 1)
})

test('parking twice refreshes the line instead of duplicating it; a second listing joins the section', () => {
  const once = parkInPipeline(PIPE, { url: URL_A, why: '403', date: '2026-10-20' }).text
  const twice = parkInPipeline(once, { url: URL_A, why: 'still 403', date: DATE })
  assert.equal(twice.wasParked, true)
  assert.equal(twice.wasPending, false)
  assert.deepEqual(parkedEntries(twice.text).map((p) => [p.company, p.date, p.why]), [['Nimbus Robotics', DATE, 'still 403']])
  const both = parkInPipeline(twice.text, { url: URL_B, why: 'blank page', date: DATE }).text
  assert.deepEqual(parkedEntries(both).map((p) => p.company), ['Nimbus Robotics', 'Contoso'])
  assert.equal(both.split('\n').filter((l) => l === PARKED_HEADING).length, 1)
  assert.deepEqual(parsePendingEntries(both), [])
})

test('park takes explicit names, needs them for a URL the pipeline does not have, and needs a reason', () => {
  const r = parkInPipeline(PIPE, { url: 'https://jobs.example.com/new-1', company: 'Lumen Freight', role: 'Planning Graduate', why: '403', date: DATE })
  assert.equal(r.wasPending, false)
  assert.equal(parkedEntries(r.text)[0].role, 'Planning Graduate')
  assert.throws(() => parkInPipeline(PIPE, { url: 'https://jobs.example.com/new-1', why: '403', date: DATE }), /--company and --role/)
  assert.throws(() => parkInPipeline(PIPE, { url: URL_B, why: ' ', date: DATE }), /--why/)
  assert.throws(() => parkInPipeline(PIPE, { url: 'not a url', why: 'x', date: DATE }), /http\(s\) URL/)
})

test('park on an empty or missing file starts from the scaffold', () => {
  const r = parkInPipeline('', { url: URL_B, company: 'Contoso', role: 'Ops Analyst', why: '403', date: DATE })
  assert.match(r.text, /^# Pipeline — Pending Evaluations\n\n## Pending\n\n## Needs a browser read\n- \[!\] BROWSER READ/)
})

test('requeue puts the listing back in Pending with the saved-JD note and drops the empty section', () => {
  const parked = parkInPipeline(PIPE, { url: URL_A, why: '403', date: '2026-10-20' }).text
  const r = requeueInPipeline(parked, { url: URL_A, jdFile: 'jds/nimbus-robotics-strategy-analyst.md', date: DATE })
  assert.equal(r.wasParked, true)
  assert.equal(r.line, `- [ ] ${URL_A} | Nimbus Robotics | Strategy Analyst | JD saved: jds/nimbus-robotics-strategy-analyst.md (browser read ${DATE})`)
  assert.ok(!r.text.includes(PARKED_HEADING))
  const pending = parsePendingEntries(r.text)
  assert.deepEqual(pending.map((e) => [e.company, e.title]), [['Contoso', 'Ops Analyst'], ['Nimbus Robotics', 'Strategy Analyst']])
  assert.equal(savedJdFor(r.text, URL_A.replace('?utm_source=board', '')), 'jds/nimbus-robotics-strategy-analyst.md')
  assert.equal(savedJdFor(r.text, URL_B), null)
  assert.deepEqual(savedJdEntries(r.text), [{ url: URL_A, path: 'jds/nimbus-robotics-strategy-analyst.md' }])
  // Requeueing again replaces the note rather than adding a second line.
  const again = requeueInPipeline(r.text, { url: URL_A, jdFile: 'jds/other.md', date: DATE })
  assert.equal(again.text.split('\n').filter((l) => l.includes(URL_A)).length, 1)
  assert.equal(savedJdFor(again.text, URL_A), 'jds/other.md')
})

test('requeue keeps another parked listing and its section', () => {
  let text = parkInPipeline(PIPE, { url: URL_A, why: '403', date: DATE }).text
  text = parkInPipeline(text, { url: URL_B, why: '403', date: DATE }).text
  const r = requeueInPipeline(text, { url: URL_B, jdFile: 'jds/contoso-ops-analyst.md', date: DATE })
  assert.deepEqual(parkedEntries(r.text).map((p) => p.company), ['Nimbus Robotics'])
})

test('the saved-JD path must stay under jds/', () => {
  assert.equal(checkJdPath('./jds/a.md'), 'jds/a.md')
  for (const bad of ['', '/etc/passwd', 'jds/../user/cv.md', 'data/pipeline.md', 'jds/a.pdf']) {
    assert.throws(() => checkJdPath(bad), /jd-file/, bad)
  }
  assert.throws(() => requeueInPipeline(PIPE, { url: 'https://jobs.example.com/unknown', jdFile: 'jds/a.md', date: DATE }), /--company and --role/)
})

test('parsers: parked lines round-trip; malformed ones are reported', () => {
  const line = `- [!] BROWSER READ | ${URL_B} | Contoso | Ops Analyst | ${DATE}: 403: forbidden`
  assert.deepEqual(parseParkedLine(line), { url: URL_B, company: 'Contoso', role: 'Ops Analyst', date: DATE, why: '403: forbidden' })
  assert.equal(parseParkedLine(`- [ ] ${URL_B}`), null)
  assert.deepEqual(malformedParkedLines(`${line}\n- [!] BROWSER READ | no url here\n- [!] FILTERED | x`), ['- [!] BROWSER READ | no url here'])
  assert.equal(jdSavedPath('- [ ] u | A | B | JD saved: jds/x.md (browser read 2026-10-21)'), 'jds/x.md')
})

test('the message is one keyed alert with the link, the reason and what to do', () => {
  const m = parkMessage({ url: URL_B, company: 'Contoso', role: 'Ops Analyst', why: 'HTTP 403 to every script' })
  assert.equal(m.kind, 'alert')
  assert.equal(m.source, 'eval')
  assert.equal(m.key, messageKey(URL_B))
  assert.equal(m.title, 'Needs a browser read: Contoso — Ops Analyst')
  assert.deepEqual(m.links, [URL_B])
  assert.match(m.body, /HTTP 403 to every script/)
  assert.match(m.body, /Open the link in your browser/)
  assert.match(m.body, /chat/)
  assert.match(m.body, /Claude Code session/)
  assert.ok(m.body.includes(`requeue --url '${URL_B}' --jd-file jds/contoso-ops-analyst.md`))
  assert.equal(suggestedJdPath({ company: 'Contoso', role: 'Ops Analyst' }), 'jds/contoso-ops-analyst.md')
  assert.equal(parkMessage({ url: URL_B, company: 'C', role: 'R', why: 'x', source: 'scan' }).source, 'scan')
})

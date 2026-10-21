// The demo workspace (demo/) is generated, fictional and public. These tests
// pin that it reproduces byte-for-byte, parses with the project's own
// parsers, stays internally consistent (scores, tiers, links) and contains no
// real brand, real-looking contact detail or term derived from a private data
// root.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

import { DEFAULT_OUT, META_FILE, REPO_ROOT, listDemoFiles, writeDemo } from './build-demo.mjs'
import { SCORE_HISTORY_HEADER, countPendingPipelineLines } from '../lib/profile-core.mjs'
import { parseScoutingRow, validateScoutingRow } from '../lib/scouting-core.mjs'
import { parseAppRow, parseScoreCell, CANONICAL_STATES } from '../lib/tracker-core.mjs'
import { parseScoreHistory } from '../lib/targeting-core.mjs'
import { parseScanHistory } from '../lib/whats-new-core.mjs'
import { parseNetwork } from '../lib/network-core.mjs'
import { parseLog } from '../outreach-cadence.mjs'
import { parseFollowups } from '../lib/followup-cadence-core.mjs'
import { openMessages, parseRecords, foldMessages } from '../lib/messages-core.mjs'
import { parsePendingEntries } from '../lib/triage-core.mjs'
import { HEADER as DEDUP_HEADER, buildIndexLines } from '../lib/dedup-index.mjs'
import { parseStoryBank, validateBank, resultIsQuantified } from '../lib/story-bank.mjs'
import { assignVerdict } from '../lib/score-bands.mjs'
import { dataRootFor } from '../lib/data-root.mjs'

const BUILD = join(REPO_ROOT, 'scripts', 'demo', 'build-demo.mjs')
const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

function build(asOf) {
  const dir = mkdtempSync(join(tmpdir(), 'starpath-demo-'))
  temps.push(dir)
  execFileSync(process.execPath, [BUILD, '--out', dir, '--as-of', asOf], { stdio: 'pipe' })
  return dir
}

function snapshot(dir) {
  return new Map(listDemoFiles(dir).map(rel => [rel, readFileSync(join(dir, rel), 'utf8')]))
}

const read = (rel) => readFileSync(join(DEFAULT_OUT, rel), 'utf8')
const meta = JSON.parse(read(META_FILE))
const committed = snapshot(DEFAULT_OUT)
const rowsOf = (text, parse) => text.split('\n').map(parse).filter(Boolean)

// ── Reproducibility ─────────────────────────────────────────────────────────

test('same seed and the same --as-of give byte-identical output', () => {
  const a = snapshot(build('2027-03-02'))
  const b = snapshot(build('2027-03-02'))
  assert.deepEqual([...a.keys()], [...b.keys()])
  for (const [rel, content] of a) assert.equal(b.get(rel), content, `${rel} differs between two builds`)
  assert.ok(a.has('reports/briefs/2027-03-02-brief.md'))
})

test('the committed demo/ reproduces from its .demo-meta.json as-of', () => {
  assert.match(meta.asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(meta.generator, 'scripts/demo/build-demo.mjs')
  assert.ok(Number.isInteger(meta.seedVersion))
  const fresh = snapshot(build(meta.asOf))
  const missing = [...fresh.keys()].filter(k => !committed.has(k))
  const extra = [...committed.keys()].filter(k => !fresh.has(k))
  const changed = [...fresh.keys()].filter(k => committed.has(k) && committed.get(k) !== fresh.get(k))
  assert.deepEqual({ missing, extra, changed }, { missing: [], extra: [], changed: [] },
    'demo/ is stale: run `npm run demo:build -- --as-of ' + meta.asOf + '` (or rebuild as of today) and commit the result')
})

test('the build refuses to replace a folder that is not a demo build, and keeps chat/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpath-demo-guard-'))
  temps.push(dir)
  writeFileSync(join(dir, 'notes.md'), 'not a demo\n')
  assert.throws(() => writeDemo(dir, new Map([['README.md', 'x\n']])), /isn't a demo build/)
  rmSync(join(dir, 'notes.md'))
  writeDemo(dir, new Map([[META_FILE, '{}\n'], ['a/old.md', 'old\n']]))
  mkdirSync(join(dir, 'chat'))
  writeFileSync(join(dir, 'chat', 'session.json'), '{}\n')
  writeDemo(dir, new Map([[META_FILE, '{}\n'], ['b/new.md', 'new\n']]))
  assert.ok(!existsSync(join(dir, 'a')), 'files from the previous build are removed')
  assert.ok(existsSync(join(dir, 'b', 'new.md')))
  assert.ok(existsSync(join(dir, 'chat', 'session.json')), 'the demo chat store survives a rebuild')
})

// ── Trackers parse with the project's parsers ───────────────────────────────

const scouting = rowsOf(read('data/scouting.md'), parseScoutingRow)
const apps = rowsOf(read('data/applications.md'), parseAppRow)
const history = parseScoreHistory(read('data/score-history.tsv'))

test('scouting.md: 25 valid v2 rows covering every verdict, two of them blocked', () => {
  assert.equal(scouting.length, 25)
  for (const row of scouting) {
    const { errors, warnings } = validateScoutingRow(row)
    assert.deepEqual({ errors, warnings }, { errors: [], warnings: [] }, `scouting #${row.num}`)
  }
  const verdicts = new Set(history.map(r => r.verdict))
  for (const v of ['go', 'stretch', 'solid', 'thin', 'growth', 'skip', 'blocked']) assert.ok(verdicts.has(v), `no ${v} listing`)
  const blocked = scouting.filter(r => r.eligibilityStatus === 'red')
  assert.equal(blocked.length, 2)
  for (const r of blocked) assert.match(r.notes, /^(Revisit next cycle: )?\w+:/, 'blocked rows carry their reason')
  assert.deepEqual(scouting.map(r => r.num), [...Array(25).keys()].map(i => 25 - i), 'newest row on top, numbered 1..25')
})

test('applications.md: 10-column rows, canonical statuses, v2 score cells', () => {
  assert.equal(apps.length, 7)
  const statuses = new Set(apps.map(a => a.status))
  for (const s of ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded']) assert.ok(statuses.has(s), `no ${s} application`)
  for (const a of apps) {
    assert.ok(a.hasDeadline, `application #${a.num} has the Deadline column`)
    assert.ok(CANONICAL_STATES.includes(a.status), `application #${a.num} status ${a.status}`)
    const cell = parseScoreCell(a.score)
    assert.ok(cell && Number.isFinite(cell.want) && Number.isFinite(cell.ease), `application #${a.num} score ${a.score}`)
  }
  // Each application is a promoted scouting row (hint PROMOTED-{num}) with the same scores.
  for (const a of apps) {
    const s = scouting.find(r => r.company === a.company && r.role === a.role)
    assert.ok(s, `application #${a.num} has a scouting row`)
    assert.equal(s.hint, `PROMOTED-${a.num}`)
    assert.equal(a.score, `W${s.want} E${s.ease}`)
    assert.equal(a.report, s.report)
  }
})

test('score-history.tsv: canonical header, one row per evaluation, blocked rows unscored', () => {
  assert.equal(read('data/score-history.tsv').split('\n')[0], SCORE_HISTORY_HEADER)
  assert.equal(history.length, 25)
  for (const r of history) {
    assert.equal(r.mode, 'scouting')
    assert.match(r.url, /^https:\/\/example\.com\/jobs\//)
    if (r.blocked) {
      assert.ok(Number.isNaN(r.want) && Number.isNaN(r.ease), `${r.company} blocked row has no scores`)
      assert.ok(r.eligibilityFlags.some(f => f.status === 'red'))
    } else {
      assert.equal(assignVerdict({ want: r.want, ease: r.ease, eligibility: r.eligibility }).verdict, r.verdict, `${r.company} — ${r.role} verdict`)
    }
  }
})

test('scouting Want / Ease / tier match score-history', () => {
  for (const s of scouting) {
    const h = history.find(r => r.company === s.company && r.role === s.role)
    assert.ok(h, `score-history row for ${s.company} — ${s.role}`)
    assert.equal(s.tier, h.tier)
    if (h.blocked) {
      assert.equal(s.want, '—')
      assert.equal(s.ease, '—')
    } else {
      assert.equal(s.wantNum, h.want, `${s.company} Want`)
      assert.equal(s.easeNum, h.ease, `${s.company} Ease`)
    }
  }
})

test('report-summaries.tsv: headerless, 10 columns, one row per evaluation', () => {
  const lines = read('data/report-summaries.tsv').trim().split('\n')
  assert.equal(lines.length, 25)
  for (const l of lines) {
    const c = l.split('\t')
    assert.equal(c.length, 10, l)
    const h = history.find(r => r.company === c[1] && r.role === c[2])
    assert.ok(h)
    assert.equal(c[4], h.tier)
    assert.equal(c[9], h.verdict)
  }
})

test('dedup-index.tsv is what rebuild-dedup-index.mjs would write', () => {
  const expected = [DEDUP_HEADER, ...buildIndexLines(read('data/scouting.md'), read('data/applications.md'))].join('\n') + '\n'
  assert.equal(read('data/dedup-index.tsv'), expected)
})

test('pipeline.md and scan-history.tsv: pending inbox, processed rows, first_seen dates', () => {
  const pipeline = read('data/pipeline.md')
  const pending = parsePendingEntries(pipeline)
  assert.equal(pending.length, 30)
  assert.equal(countPendingPipelineLines(pipeline), 30)
  for (const p of pending) {
    assert.match(p.url, /^https:\/\/example\.com\/jobs\//)
    assert.ok(p.company && p.title && Number.isFinite(p.relevanceScore))
  }
  assert.equal((pipeline.match(/^- \[x\] #\d+ \|/gm) || []).length, 25)
  const scan = parseScanHistory(read('data/scan-history.tsv'))
  const scanUrls = new Set(scan.map(r => r.url))
  for (const p of pending) assert.ok(scanUrls.has(p.url), `${p.url} is in scan-history`)
  for (const r of scan) {
    assert.match(r.first_seen, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(r.scan_dates_list[0], r.first_seen)
    assert.equal(r.status, 'added')
  }
})

test('network, outreach and follow-up logs parse', () => {
  const contacts = parseNetwork(read('data/network.md'))
  assert.equal(contacts.length, 6)
  assert.ok(contacts.some(c => c.degree === 2 && c.via))
  const touches = parseLog(read('data/outreach.md'))
  assert.ok(touches.length >= 4)
  const followups = parseFollowups(read('data/follow-ups.md'))
  assert.ok(followups.length >= 2)
  for (const f of followups) assert.ok(apps.some(a => a.num === f.appNum && a.company === f.company), `follow-up #${f.num} points at its application`)
})

test('one open sample message points at a demo report and application', () => {
  const { records, skipped } = parseRecords(read('data/agent-messages.jsonl'))
  assert.equal(skipped, 0)
  const open = openMessages(foldMessages(records))
  assert.equal(open.length, 1)
  const [m] = open
  assert.match(m.id, /^m-\d{8}-[0-9a-f]{8}$/)
  const report = m.links.find(l => l.kind === 'report')
  assert.ok(report && existsSync(join(DEFAULT_OUT, report.target)), 'the report link resolves inside demo/')
  const app = m.links.find(l => l.kind === 'application')
  assert.ok(app && apps.some(a => String(a.num) === app.target), 'the application link names a demo application')
})

test('story bank: six complete, quantified STAR+R stories', () => {
  const stories = parseStoryBank(read('interview-prep/story-bank.md'))
  assert.equal(stories.length, 6)
  const bank = validateBank(stories)
  assert.ok(bank.ok, JSON.stringify(bank.perStory.filter(s => !s.ok)))
  for (const s of stories) assert.ok(resultIsQuantified(s), `${s.title} result has a number`)
})

test('user/profile.yml has the blocks the scorer, triage and app read', () => {
  const p = yaml.load(read('user/profile.yml'))
  assert.match(p.candidate.email, /@example\.com$/)
  for (const k of ['available_from', 'graduations', 'languages', 'work_authorisation', 'duration_months']) assert.ok(k in p.eligibility, `eligibility.${k}`)
  for (const k of ['dream_companies', 'lower_tier_dream_companies', 'brand_affinity_companies', 'extra_brand_bonuses']) assert.ok(Array.isArray(p.calibration[k]), `calibration.${k}`)
  assert.ok(p.location.preferred_cities.length >= 5)
  assert.ok(p.target_roles.dream_companies.every(d => d.name && d.priority))
  const portals = yaml.load(read('user/portals.yml'))
  assert.ok(portals.title_filter.positive.length > 0)
  for (const c of portals.tracked_companies) assert.match(c.careers_url, /^https:\/\/example\.com\//)
})

// ── Links and headers ───────────────────────────────────────────────────────

const linkOf = (cell) => (String(cell).match(/\]\(([^)]+)\)/) || [])[1] || null
const reportFiles = [...committed.keys()].filter(k => /^reports\/tier-[1-4]\//.test(k))

test('every report link resolves, and every report is linked from scouting.md', () => {
  const linked = new Set()
  for (const row of [...scouting, ...apps]) {
    const rel = linkOf(row.report)
    if (!rel) continue
    assert.ok(committed.has(rel), `#${row.num} links ${rel}, which does not exist`)
    linked.add(rel)
  }
  for (const rel of reportFiles) assert.ok(linked.has(rel), `${rel} is not linked from the trackers`)
  assert.ok(!reportFiles.some(r => r.startsWith('reports/tier-4/')), 'T4 writes no report file')
  for (const rel of [...committed.keys()].filter(k => k.startsWith('interview-prep/') && !k.endsWith('story-bank.md'))) {
    const link = linkOf(committed.get(rel).match(/^\*\*Report:\*\* .*$/m)?.[0])
    assert.ok(link && committed.has(link), `${rel} links its report`)
  }
})

test('report headers agree with the trackers and their tier folder', () => {
  for (const rel of reportFiles) {
    const md = committed.get(rel)
    const header = (label) => (md.match(new RegExp(`^\\*\\*${label}:\\*\\* (.+)$`, 'm')) || [])[1]
    const url = header('URL')
    const h = history.find(r => r.url === url)
    assert.ok(h, `${rel}: URL matches a score-history row`)
    assert.equal(header('Tier'), h.tier, `${rel} tier`)
    assert.equal(rel.split('/')[1], `tier-${h.tier.slice(1)}`)
    assert.match(md, new RegExp(`^\\*\\*Want:\\*\\* ${h.want}/10 · \\*\\*Ease:\\*\\* ${h.ease}/10$`, 'm'), `${rel} Want · Ease`)
    assert.match(md, /^## Eligibility$/m)
    assert.match(md, /^## Dimensional scoring$/m)
    assert.match(md.trimEnd().split('\n').pop(), /^Salary math: comp €/, `${rel} ends with the Salary math footer`)
  }
})

// ── Fiction only ────────────────────────────────────────────────────────────

const REAL_BRANDS = [
  'Google', 'Alphabet', 'Amazon', 'Microsoft', 'Apple', 'Meta', 'Facebook', 'Netflix', 'Stripe', 'Revolut', 'Spotify',
  'Adyen', 'Datadog', 'Salesforce', 'Oracle', 'SAP', 'IBM', 'Nvidia', 'Tesla', 'Uber', 'Airbnb', 'Shopify', 'HubSpot',
  'Zalando', 'Booking.com', 'OpenAI', 'Anthropic', 'McKinsey', 'BCG', 'Boston Consulting', 'Bain', 'Deloitte',
  'Accenture', 'PwC', 'KPMG', 'Ernst & Young', 'Goldman Sachs', 'JPMorgan', 'J.P. Morgan', 'Morgan Stanley',
  'Mastercard', 'L\'Oréal', 'LVMH', 'Danone', 'Nestlé', 'Unilever', 'Siemens', 'Allianz', 'AXA', 'ING Bank',
  'Glassdoor', 'LinkedIn', 'Levels.fyi', 'Numbeo', 'Indeed', 'Esade', 'IESE', 'INSEAD', 'HEC Paris', 'Bocconi', 'ESSEC', 'ESCP',
]

test('demo/ names no real brand and no contact detail outside example.com', () => {
  const hits = []
  for (const [rel, text] of committed) {
    for (const brand of REAL_BRANDS) {
      const re = new RegExp(`(^|[^A-Za-z])${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z])`)
      if (re.test(text)) hits.push(`${rel}: ${brand}`)
    }
    for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []) {
      if (!/@example\.com$/.test(email)) hits.push(`${rel}: email ${email}`)
    }
    if (/\+\d[\d\s().-]{7,}\d/.test(text)) hits.push(`${rel}: phone number`)
    if (/\/Users\/|\/home\/[a-z]/.test(text)) hits.push(`${rel}: home-folder path`)
    for (const url of text.match(/https?:\/\/[^\s)|"'>]+/g) || []) {
      const host = new URL(url).host
      if (!['example.com', 'boards-api.greenhouse.io', 'api.ashbyhq.com', 'api.lever.co', 'api.smartrecruiters.com'].includes(host)) hits.push(`${rel}: url host ${host}`)
      if (host !== 'example.com' && !/-demo(\/|\?|$)/.test(url)) hits.push(`${rel}: ATS url without a -demo slug`)
    }
  }
  assert.deepEqual(hits, [])
})

test('demo/ contains no term derived from a private data root (terms are never printed)', async (t) => {
  const root = dataRootFor(REPO_ROOT, { env: {} })
  if (!existsSync(join(root, 'user', 'profile.yml')) && !existsSync(join(root, 'user', 'cv.md'))) {
    t.skip('no private data root in this checkout')
    return
  }
  const { extractPersonalData } = await import('../lib/hygiene-guard.mjs')
  if (typeof extractPersonalData !== 'function') {
    t.skip('hygiene-guard has no extractPersonalData(); the leak gate covers demo/ instead')
    return
  }
  const pd = extractPersonalData(root)
  // The CV extractor also picks up bolded job titles; those are generic, so
  // only names (people, schools, employers, projects) count here.
  const JOB_TITLE = /\b(intern|internship|assistant|analyst|manager|consultant|associate|engineer|developer|lead|head|officer|coordinator|representative|specialist|president|director|teaching|student|volunteer|tutor)\b/i
  const names = [...(pd.employers || []), ...(pd.projectNames || [])].filter(s => !JOB_TITLE.test(s))
  const terms = [pd.fullName, pd.email, ...(pd.schools || []), ...names]
    .filter(s => typeof s === 'string' && s.trim().length >= 6)
    .map(s => s.trim())
  const digits = pd.phoneDigits && pd.phoneDigits.length >= 7 ? pd.phoneDigits : null
  const res = terms.map(term => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'))
  const files = new Set()
  for (const [rel, text] of committed) {
    if (res.some(re => re.test(text))) files.add(rel)
    if (digits && text.replace(/\D/g, '').includes(digits)) files.add(rel)
  }
  assert.equal(files.size, 0, `private-derived term(s) found in ${[...files].join(', ')} (terms withheld)`)
})

// ── Smoke: a data-root-aware script reads the demo ──────────────────────────

test('daily-brief.mjs reads the demo through STARPATH_DATA', () => {
  const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'daily-brief.mjs'), '--json', '--as-of', meta.asOf], {
    env: { ...process.env, STARPATH_DATA: DEFAULT_OUT },
    encoding: 'utf8',
  })
  const brief = JSON.parse(out)
  const empty = brief.sections.filter(s => !s.items || s.items.length === 0).map(s => s.id)
  assert.deepEqual(empty, [], 'every brief section has items')
  for (const id of ['followups', 'deadlines', 'outreach', 'warmpaths', 'newhits', 'triage', 'insight']) {
    assert.ok(brief.sections.some(s => s.id === id), `brief has a ${id} section`)
  }
})

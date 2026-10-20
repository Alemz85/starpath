/**
 * scan.test.mjs — end-to-end runScan() against fixture ATS payloads.
 *
 * A fake HTTP client stands in for the network and the test runs inside a temp
 * directory (scan.mjs reads/writes cwd-relative paths), so nothing real is
 * fetched and no private data is touched. Every company and city is fictional.
 *
 * Run: node --test scripts/scan.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runScan,
  parseGreenhouse,
  parseAshby,
  parseLever,
  parseSmartRecruiters,
  parseWorkday,
  applyWorkdayDetail,
} from './scan.mjs';
import { createHttp } from './lib/http.mjs';
import { HISTORY_COLUMNS, getCell, parseHistoryFile } from './lib/scan-history.mjs';

const PORTALS = `
title_filter:
  positive: ["Analyst", "Planner"]
  negative: ["Senior"]
location_allowlist: ["germany", "aldervale", "remote"]
tracked_companies:
  - name: Nimbus Robotics
    api: https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs
  - name: Lumen Freight
    careers_url: https://jobs.ashbyhq.com/lumen-demo
  - name: Harbor Light
    careers_url: https://jobs.lever.co/harborlight-demo
  - name: Contoso Demo
    careers_url: https://contoso.wd3.myworkdayjobs.com/ext
`;

const GREENHOUSE = { jobs: [
  { id: 4417, requisition_id: 'REQ-77', title: 'Operations Analyst', absolute_url: 'https://boards.example.com/nimbus/4417',
    location: { name: 'Germany, Larkspur, Rosewood' }, first_published: '2026-10-01T09:00:00-04:00', application_deadline: '2026-11-30' },
  { id: 4418, title: 'Pricing Analyst', absolute_url: 'https://boards.example.com/nimbus/4418',
    location: { name: 'Zenith Bay' }, first_published: '2026-10-02T09:00:00Z' },
  { id: 4419, title: 'Senior Analyst', absolute_url: 'https://boards.example.com/nimbus/4419', location: { name: 'Aldervale' } },
  // ambiguous deadline text -> absent
  { id: 4420, title: 'Data Analyst', absolute_url: 'https://boards.example.com/nimbus/4420',
    location: { name: 'Aldervale' }, first_published: '2026-10-03', application_deadline: '03/04/2026' },
] };

const ASHBY = { jobs: [
  { id: 'a-1', title: 'Supply Planner', jobUrl: 'https://jobs.example.com/lumen/a-1', location: 'Zenith Bay',
    secondaryLocations: [{ location: 'Aldervale' }], publishedAt: '2026-10-05T10:00:00.000Z',
    descriptionPlain: 'Join us. Apply by 2026-12-01 at the latest.' },
] };

const LEVER = [
  { id: 'lv-1', text: 'Logistics Analyst', hostedUrl: 'https://jobs.example.com/harbor/lv-1',
    categories: { location: 'Zenith Bay', allLocations: ['Zenith Bay', 'Remote'] }, createdAt: 1760000000000,
    descriptionPlain: 'Closing date: 31/12/2026' },
];

const WORKDAY_LIST = { total: 1, jobPostings: [
  { title: 'Finance Analyst', externalPath: '/job/Hub/Finance-Analyst_R-1042', locationsText: '2 Locations', bulletFields: ['R-1042'] },
] };
const WORKDAY_DETAIL = { jobPostingInfo: {
  id: 'wd-id-1', jobPostingId: 'Finance-Analyst_R-1042', jobReqId: 'R-1042', title: 'Finance Analyst',
  location: 'Aldervale', additionalLocations: ['Zenith Bay'], startDate: '2026-10-07', endDate: '2026-11-20',
  jobDescription: '<p>Great job</p>',
} };

function fakeClient(table, seen = []) {
  const find = (url) => {
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`HTTP 404 (${url})`);
    return hit[1];
  };
  return {
    seen,
    getJson: async (url, opts) => { seen.push({ method: 'GET', url, type: opts?.type }); return find(url); },
    postJson: async (url, body, opts) => { seen.push({ method: 'POST', url, type: opts?.type }); return find(url); },
  };
}

const TABLE = {
  'boards/nimbus-demo/jobs': GREENHOUSE,
  'job-board/lumen-demo': ASHBY,
  'postings/harborlight-demo': LEVER,
  '/wday/cxs/contoso/ext/jobs': WORKDAY_LIST,
  '/wday/cxs/contoso/ext/job/Hub/Finance-Analyst_R-1042': WORKDAY_DETAIL,
};

function sandbox(history) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  mkdirSync(join(dir, 'user'), { recursive: true });
  writeFileSync(join(dir, 'user/portals.yml'), PORTALS);
  if (history !== undefined) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
    if (history) writeFileSync(join(dir, 'data/scan-history.tsv'), history);
  }
  return dir;
}

async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

const quiet = () => {};

// ── parsers ────────────────────────────────────────────────────────────────

test('parsers carry posting id, req id, posted date and (only unambiguous) deadline', () => {
  const [g1, , , g4] = parseGreenhouse(GREENHOUSE, 'Nimbus Robotics');
  assert.equal(g1.externalId, '4417');
  assert.equal(g1.requisitionId, 'REQ-77');
  assert.equal(g1.deadline, '2026-11-30');
  assert.equal(g1.postedDate, '2026-10-01T09:00:00-04:00');
  assert.equal(g4.deadline, null, 'a slashed date is ambiguous -> absent');

  const [a] = parseAshby(ASHBY, 'Lumen Freight');
  assert.equal(a.deadline, '2026-12-01', 'explicit ISO date in the JD body');
  assert.deepEqual(a.extraLocations, ['Aldervale']);

  const [l] = parseLever(LEVER, 'Harbor Light');
  assert.equal(l.deadline, null, '31/12/2026 is not ISO -> absent');
  assert.deepEqual(l.extraLocations, ['Zenith Bay', 'Remote']);
  assert.equal(l.externalId, 'lv-1');

  const [s] = parseSmartRecruiters([{
    id: 'sr-1', name: 'Buyer', refNumber: 'REF-5', company: { identifier: 'Orchard' }, releasedDate: '2026-10-01T00:00:00Z',
    location: { city: 'Aldervale' },
    customField: [{ fieldLabel: 'Application deadline', valueLabel: '2026-12-15' }, { fieldLabel: 'Brands', valueLabel: 'X' }],
  }], 'Orchard Demo');
  assert.equal(s.deadline, '2026-12-15');
  assert.equal(s.requisitionId, 'REF-5');
  assert.equal(s.externalId, 'sr-1');

  const [w] = parseWorkday(WORKDAY_LIST, 'Contoso Demo', 'https://contoso.wd3.myworkdayjobs.com');
  assert.equal(w.postedDate, null);
  assert.equal(w.requisitionId, 'R-1042');
  assert.equal(applyWorkdayDetail(w, WORKDAY_DETAIL).deadline, '2026-11-20');
  assert.equal(applyWorkdayDetail(w, WORKDAY_DETAIL).postedDate, '2026-10-07');
  assert.equal(applyWorkdayDetail(w, { jobPostingInfo: { endDate: 'soon' } }).deadline, null);
  assert.equal(applyWorkdayDetail(w, null), w);
});

// ── dry run ────────────────────────────────────────────────────────────────

test('dry run against fixture portals finds listings and writes nothing', async () => {
  const dir = sandbox(); // no data/ dir at all
  try {
    const { rankedOffers, errors } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: fakeClient(TABLE), log: quiet }));
    assert.deepEqual(errors, []);
    const titles = rankedOffers.map((o) => o.title).sort();
    assert.deepEqual(titles, ['Data Analyst', 'Finance Analyst', 'Logistics Analyst', 'Operations Analyst', 'Supply Planner']);
    assert.equal(existsSync(join(dir, 'data')), false, 'no data/ directory created on a dry run');
    assert.deepEqual(readdirSync(dir), ['user']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-city: kept when ANY city is allowed, stored as separate locations; non-target cities are dropped', async () => {
  const dir = sandbox();
  try {
    const { rankedOffers } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: fakeClient(TABLE), log: quiet }));
    const byTitle = Object.fromEntries(rankedOffers.map((o) => [o.title, o]));
    assert.deepEqual(byTitle['Operations Analyst'].locations, ['Larkspur, Germany', 'Rosewood, Germany']);
    assert.ok(!byTitle['Pricing Analyst'], 'Zenith Bay alone is not an allowed city');
    assert.deepEqual(byTitle['Supply Planner'].locations, ['Zenith Bay', 'Aldervale'], 'secondary location makes it eligible');
    assert.deepEqual(byTitle['Logistics Analyst'].locations, ['Zenith Bay', 'Remote']);
    assert.deepEqual(byTitle['Finance Analyst'].locations, ['Aldervale', 'Zenith Bay'], 'Workday detail replaces the "2 Locations" placeholder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── real run: what lands on disk ───────────────────────────────────────────

test('a real run persists posted_date, deadline, ids and locations as header-named columns', async () => {
  const dir = sandbox('');
  try {
    await inDir(dir, () => runScan({ argv: [], http: fakeClient(TABLE), log: quiet }));
    const { columns, rows } = parseHistoryFile(readFileSync(join(dir, 'data/scan-history.tsv'), 'utf-8'));
    assert.deepEqual(columns, HISTORY_COLUMNS);
    const row = (title) => rows.find((r) => getCell(r, columns, 'title') === title);
    const cell = (title, name) => getCell(row(title), columns, name);

    assert.equal(cell('Operations Analyst', 'posted_date'), '2026-10-01');
    assert.equal(cell('Operations Analyst', 'deadline'), '2026-11-30');
    assert.equal(cell('Operations Analyst', 'posting_id'), '4417');
    assert.equal(cell('Operations Analyst', 'req_id'), 'REQ-77');
    assert.equal(cell('Operations Analyst', 'location'), 'Germany, Larkspur, Rosewood', 'display string unchanged');
    assert.equal(cell('Operations Analyst', 'locations'), 'Larkspur, Germany|Rosewood, Germany');

    assert.equal(cell('Data Analyst', 'deadline'), '', 'ambiguous deadline is absent, not guessed');
    assert.equal(cell('Data Analyst', 'posted_date'), '2026-10-03');
    assert.equal(cell('Supply Planner', 'deadline'), '2026-12-01');
    assert.equal(cell('Logistics Analyst', 'posted_date'), '2025-10-09', 'Lever epoch ms normalised');
    assert.equal(cell('Finance Analyst', 'deadline'), '2026-11-20');
    assert.equal(cell('Finance Analyst', 'posted_date'), '2026-10-07');
    assert.equal(cell('Finance Analyst', 'req_id'), 'R-1042');

    // pipeline.md keeps its established line shape (URL | Company | Title | relevance …)
    const pipeline = readFileSync(join(dir, 'data/pipeline.md'), 'utf-8');
    assert.match(pipeline, /- \[ \] https:\/\/boards\.example\.com\/nimbus\/4417 \| Nimbus Robotics \| Operations Analyst \| relevance /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an old 8-column scan-history is upgraded in place; re-seen rows are bumped and back-filled', async () => {
  const oldHeader = HISTORY_COLUMNS.slice(0, 8).join('\t');
  const oldRow = ['https://boards.example.com/nimbus/4417', '2026-09-01', 'greenhouse-api', 'Operations Analyst', 'Nimbus Robotics', 'Germany, Larkspur, Rosewood', 'added', '2026-09-01'].join('\t');
  const dir = sandbox(`${oldHeader}\n${oldRow}\n`);
  try {
    await inDir(dir, () => runScan({ argv: [], http: fakeClient(TABLE), log: quiet }));
    const { columns, rows } = parseHistoryFile(readFileSync(join(dir, 'data/scan-history.tsv'), 'utf-8'));
    assert.deepEqual(columns, HISTORY_COLUMNS, 'header upgraded');
    const r = rows.find((x) => getCell(x, columns, 'title') === 'Operations Analyst');
    assert.equal(getCell(r, columns, 'first_seen'), '2026-09-01', 'original cells untouched');
    assert.match(getCell(r, columns, 'scan_dates'), /^2026-09-01\|\d{4}-\d{2}-\d{2}$/);
    assert.equal(getCell(r, columns, 'deadline'), '2026-11-30', 'back-filled');
    assert.equal(getCell(r, columns, 'posting_id'), '4417');
    assert.equal(getCell(r, columns, 'locations'), 'Larkspur, Germany|Rosewood, Germany');
    assert.equal(rows.filter((x) => getCell(x, columns, 'title') === 'Operations Analyst').length, 1, 'not duplicated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the same ATS posting id under a renamed URL is a re-seen bump, not a new pipeline entry', async () => {
  const header = HISTORY_COLUMNS.join('\t');
  const oldRow = ['https://boards.example.com/nimbus/old-slug', '2026-09-01', 'greenhouse-api', 'Ops Analyst (old title)', 'Nimbus Robotics', 'Aldervale', 'added', '2026-09-01', '', '', '4417', '', ''].join('\t');
  const dir = sandbox(`${header}\n${oldRow}\n`);
  try {
    const { rankedOffers } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: fakeClient(TABLE), log: quiet }));
    assert.ok(!rankedOffers.some((o) => o.title === 'Operations Analyst'), 'known posting id is not re-added');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('companies with non-Latin names do not collide with each other on the same role', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'user/portals.yml'), `
title_filter:
  positive: ["Analyst"]
location_allowlist: ["aldervale"]
tracked_companies:
  - name: Северный Ветер
    api: https://boards-api.greenhouse.io/v1/boards/a-demo/jobs
  - name: Золотой Луч
    api: https://boards-api.greenhouse.io/v1/boards/b-demo/jobs
`);
  const job = (id) => ({ jobs: [{ id, title: 'Business Analyst', absolute_url: `https://boards.example.com/x/${id}`, location: { name: 'Aldervale' } }] });
  try {
    const { rankedOffers } = await inDir(dir, () => runScan({
      argv: ['--dry-run'], log: quiet,
      http: fakeClient({ 'boards/a-demo/jobs': job(1), 'boards/b-demo/jobs': job(2) }),
    }));
    assert.deepEqual(rankedOffers.map((o) => o.company).sort(), ['Золотой Луч', 'Северный Ветер']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── transport wiring ───────────────────────────────────────────────────────

test('every fetch passes its ATS type, so the host allowlist is enforced end to end', async () => {
  const dir = sandbox();
  const seen = [];
  try {
    await inDir(dir, () => runScan({ argv: ['--dry-run'], http: fakeClient(TABLE, seen), log: quiet }));
    assert.ok(seen.length >= 5);
    assert.ok(seen.every((c) => c.type), 'no untyped (unrestricted) request');
    assert.deepEqual([...new Set(seen.map((c) => c.type))].sort(), ['ashby', 'greenhouse', 'lever', 'workday']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a portals.yml URL pointing at an internal/foreign host is refused before any request', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'user/portals.yml'), `
title_filter:
  positive: ["Analyst"]
tracked_companies:
  - name: Trap One
    api: https://evil.example/v1/boards/x/jobs?greenhouse
  - name: Trap Two
    api: https://169.254.169.254/latest/meta-data/greenhouse
  - name: Trap Three
    api: http://boards-api.greenhouse.io/v1/boards/x/jobs
`);
  let requests = 0;
  const http = createHttp({ request: async () => { requests++; return { status: 200, headers: {}, body: Buffer.from('{"jobs":[]}') }; } });
  try {
    const { errors } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http, log: quiet }));
    assert.equal(requests, 0, 'nothing was sent');
    assert.equal(errors.length, 3);
    assert.ok(errors.every((e) => /not an allowed|not allowed|only https/.test(e.error)), JSON.stringify(errors));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── providers, blacklist, board health, revival ────────────────────────────

import { HttpError } from './lib/http.mjs';
import { parseHealth } from './lib/portal-health.mjs';
import { buildHistoryRow } from './lib/scan-history.mjs';

const GH_ONLY = `
title_filter:
  positive: ["Analyst"]
location_allowlist: ["aldervale"]
tracked_companies:
  - name: Nimbus Robotics
    api: https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs
  - name: Lumen Freight
    careers_url: https://jobs.ashbyhq.com/lumen-demo
`;

function sandboxWith(portals, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  mkdirSync(join(dir, 'user'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'user/portals.yml'), portals);
  writeFileSync(join(dir, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const GH_BOARD = { jobs: [{ id: 1, title: 'Ops Analyst', absolute_url: 'https://boards.example.com/nimbus/1', location: { name: 'Aldervale' } }] };

/** Client where the Greenhouse board answers with `gh` (value or Error) and Ashby with its fixture. */
function boardClient({ gh, ashby = ASHBY }) {
  const calls = [];
  const answer = (v) => { if (v instanceof Error) throw v; return v; };
  return {
    calls,
    getJson: async (url) => { calls.push(url); return answer(url.includes('greenhouse') ? gh : ashby); },
    postJson: async () => ({}),
  };
}

test('a malformed provider in the providers directory is skipped and the scan still finds listings', async () => {
  const pdir = mkdtempSync(join(tmpdir(), 'providers-'));
  const real = (name) => readFileSync(new URL(`./providers/${name}.mjs`, import.meta.url), 'utf8').replace(/from '\.\.\/lib\//g, `from '${new URL('./lib/', import.meta.url).href}`);
  writeFileSync(join(pdir, 'greenhouse.mjs'), real('greenhouse'));
  writeFileSync(join(pdir, 'a-broken.mjs'), 'export default { id: 42 };\n');
  writeFileSync(join(pdir, 'b-syntax.mjs'), 'export default {{{');
  const dir = sandboxWith(GH_ONLY);
  const logs = [];
  try {
    const { rankedOffers, errors } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: boardClient({ gh: GH_BOARD }), log: (l) => logs.push(l), providersDir: pdir }));
    assert.deepEqual(errors, []);
    assert.deepEqual(rankedOffers.map((o) => o.title), ['Ops Analyst']);
    assert.equal(logs.filter((l) => /provider .* skipped/.test(l)).length, 2);
    assert.match(logs.join('\n'), /1 skipped — no API detected/, 'the Ashby entry has no provider here');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(pdir, { recursive: true, force: true }); }
});

test('data/blacklist.md: a blacklisted company is not fetched; a blacklisted domain is dropped', async () => {
  const dir = sandboxWith(GH_ONLY, { 'data/blacklist.md': '- company: Lumen Freight\n- domain: spam-board.test\n' });
  const board = { jobs: [
    ...GH_BOARD.jobs,
    { id: 2, title: 'Risk Analyst', absolute_url: 'https://jobs.spam-board.test/2', location: { name: 'Aldervale' } },
  ] };
  const client = boardClient({ gh: board });
  const logs = [];
  try {
    const res = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: client, log: (l) => logs.push(l) }));
    assert.deepEqual(res.rankedOffers.map((o) => o.title), ['Ops Analyst']);
    assert.ok(!client.calls.some((u) => u.includes('ashbyhq')), 'the blacklisted company is never requested');
    assert.equal(res.blacklisted, 1);
    assert.match(logs.join('\n'), /Blacklisted:\s+1 companies not fetched, 1 postings removed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dead-board memory: three real 404s on three scans skip the board; --company still probes it', async () => {
  const dir = sandboxWith(GH_ONLY);
  const dead = () => new HttpError('HTTP 404', { code: 'ESTATUS', status: 404 });
  try {
    for (const today of ['2026-10-01', '2026-10-08', '2026-10-15']) {
      const client = boardClient({ gh: dead() });
      const res = await inDir(dir, () => runScan({ argv: [], http: client, log: quiet, today }));
      assert.equal(res.errors.length, 1, `${today}: the 404 is reported`);
      assert.ok(client.calls.some((u) => u.includes('greenhouse')));
    }
    const health = parseHealth(readFileSync(join(dir, 'data/portal-health.tsv'), 'utf-8'));
    const row = [...health.values()][0];
    assert.equal(row.consecutive_404, 3);
    assert.equal(row.skip_until, '2026-11-14');

    const logs = [];
    const skipping = boardClient({ gh: dead() });
    const res = await inDir(dir, () => runScan({ argv: [], http: skipping, log: (l) => logs.push(l), today: '2026-10-22' }));
    assert.ok(!skipping.calls.some((u) => u.includes('greenhouse')), 'skipped: not requested');
    assert.equal(res.skippedBoards.length, 1);
    assert.match(logs.join('\n'), /dead board .* skipped until 2026-11-14/);

    const probe = boardClient({ gh: GH_BOARD });
    await inDir(dir, () => runScan({ argv: ['--dry-run', '--company', 'nimbus'], http: probe, log: quiet, today: '2026-10-22' }));
    assert.ok(probe.calls.some((u) => u.includes('greenhouse')), '--company always probes');

    // after the window a healthy answer clears the memory
    await inDir(dir, () => runScan({ argv: [], http: boardClient({ gh: GH_BOARD }), log: quiet, today: '2026-11-14' }));
    assert.equal(parseHealth(readFileSync(join(dir, 'data/portal-health.tsv'), 'utf-8')).size, 0, 'a healthy board has no row');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('timeouts and 5xx never count toward the dead-board streak', async () => {
  const dir = sandboxWith(GH_ONLY);
  try {
    for (const today of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      const client = boardClient({ gh: new HttpError('HTTP 503', { code: 'ESTATUS', status: 503, retryable: true }) });
      await inDir(dir, () => runScan({ argv: [], http: client, log: quiet, today }));
    }
    const logs = [];
    const client = boardClient({ gh: GH_BOARD });
    await inDir(dir, () => runScan({ argv: ['--dry-run'], http: client, log: (l) => logs.push(l), today: '2026-10-05' }));
    assert.ok(client.calls.some((u) => u.includes('greenhouse')), 'still scanned');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a row an earlier liveness check marked expired is revived when its posting is on the board again', async () => {
  const row = buildHistoryRow({ url: 'https://boards.example.com/nimbus/1', source: 'greenhouse-api', title: 'Ops Analyst', company: 'Nimbus Robotics', location: 'Aldervale', externalId: '1' }, '2026-10-01');
  const base = HISTORY_COLUMNS.join('\t') + '\n' + row + '\n';
  const { columns, rows } = parseHistoryFile(base);
  const expired = rows[0].split('\t');
  expired[columns.indexOf('status')] = 'expired';
  expired[columns.indexOf('expired_reason')] = 'unreachable';
  expired[columns.indexOf('fetch_attempts')] = '3';
  expired[columns.indexOf('first_unreachable')] = '2026-10-01T09:00:00.000Z';
  expired[columns.indexOf('last_error')] = 'ETIMEDOUT';
  const dir = sandboxWith(GH_ONLY, { 'data/scan-history.tsv': HISTORY_COLUMNS.join('\t') + '\n' + expired.join('\t') + '\n' });
  try {
    await inDir(dir, () => runScan({ argv: [], http: boardClient({ gh: GH_BOARD }), log: quiet, today: '2026-10-20' }));
    const after = parseHistoryFile(readFileSync(join(dir, 'data/scan-history.tsv'), 'utf-8'));
    const r = after.rows[0];
    assert.equal(getCell(r, after.columns, 'status'), 'added');
    for (const c of ['expired_reason', 'fetch_attempts', 'first_unreachable', 'last_error']) assert.equal(getCell(r, after.columns, c), '', c);
    assert.match(getCell(r, after.columns, 'scan_dates'), /2026-10-20$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requisition ids are labels: two postings sharing one are both new', async () => {
  const board = { jobs: [
    { id: 11, requisition_id: 'REQ-1', title: 'Ops Analyst', absolute_url: 'https://boards.example.com/nimbus/11', location: { name: 'Aldervale' } },
    { id: 12, requisition_id: 'REQ-1', title: 'Pricing Analyst', absolute_url: 'https://boards.example.com/nimbus/12', location: { name: 'Aldervale' } },
  ] };
  const dir = sandboxWith(GH_ONLY);
  try {
    const { rankedOffers } = await inDir(dir, () => runScan({ argv: ['--dry-run'], http: boardClient({ gh: board }), log: quiet }));
    assert.deepEqual(rankedOffers.map((o) => o.title).sort(), ['Ops Analyst', 'Pricing Analyst']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

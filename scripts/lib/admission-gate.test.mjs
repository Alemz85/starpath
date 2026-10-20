/**
 * admission-gate.test.mjs — one gate, every writer. Unit tests for the stages
 * and their order, the blacklist file format, and a parity test that pushes the
 * SAME fixture listings through scan.mjs (live ATS path) and merge-scan-staging.mjs
 * (JobSpy path) and demands the same admitted set.
 *
 * Run: node --test scripts/lib/admission-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlacklist, blacklistReason, createAdmissionGate, gateFromPortals } from './admission-gate.mjs';
import { seedScanSeen } from './merge-staging-core.mjs';
import { HISTORY_COLUMNS, buildHistoryRow, parseHistoryFile, getCell } from './scan-history.mjs';
import { runScan } from '../scan.mjs';
import { runMerge } from '../merge-scan-staging.mjs';

const PORTALS_CFG = {
  title_filter: { positive: ['Analyst'], negative: ['Senior'] },
  lang_blocklist: ['(m/w/d)'],
  location_allowlist: ['aldervale', 'remote'],
};

// ── blacklist file ─────────────────────────────────────────────────────────

test('parseBlacklist: list items only; company:/domain: prefixes; bare host-looking values are domains', () => {
  const bl = parseBlacklist([
    '# Blacklist', 'Prose the user wrote is ignored.', '',
    '- company: Shadow Staffing GmbH', '* Quiet Agency Ltd  # never again', '- domain: spam-board.test',
    '- https://www.recruit-farm.test/jobs', '- Domain: Mixed.Case.Test', '-', '- company:',
  ].join('\n'));
  assert.equal(bl.companies.size, 2);
  assert.deepEqual(bl.domains, ['spam-board.test', 'recruit-farm.test', 'mixed.case.test']);
  assert.equal(parseBlacklist('').count, 0);
  assert.equal(parseBlacklist(undefined).count, 0);
});

test('blacklistReason: company by normalized name, domain incl. subdomains, nothing else', () => {
  const bl = parseBlacklist('- company: Shadow Staffing GmbH\n- domain: spam-board.test');
  assert.match(blacklistReason(bl, { company: 'shadow  staffing gmbh', url: 'https://x.test/1' }), /company/);
  assert.match(blacklistReason(bl, { company: 'Nimbus', url: 'https://jobs.spam-board.test/7' }), /domain spam-board.test/);
  assert.match(blacklistReason(bl, { company: 'Nimbus', url: 'https://www.spam-board.test/7' }), /domain/);
  assert.equal(blacklistReason(bl, { company: 'Nimbus', url: 'https://notspam-board.test/7' }), '', 'a suffix match is not a subdomain');
  assert.equal(blacklistReason(null, { company: 'x' }), '');
});

// ── the stages and their order ─────────────────────────────────────────────

const gate = (extra = {}) => gateFromPortals(PORTALS_CFG, { blacklistText: '- company: Shadow Staffing\n- domain: spam-board.test', ...extra });
const job = (o) => ({ url: 'https://boards.example.com/1', company: 'Nimbus Robotics', title: 'Ops Analyst', location: 'Aldervale', source: 'greenhouse-api', externalId: '1', ...o });

test('admit: blacklist → title → language → location → seen, rejected at the first failing stage', () => {
  const g = gate();
  assert.deepEqual(g.admit(job({ company: 'Shadow Staffing', title: 'Senior Analyst', location: 'Nowhere' })).stage, 'blacklist', 'blacklist beats everything after it');
  assert.equal(g.admit(job({ title: 'Senior Analyst', location: 'Nowhere' })).stage, 'title');
  assert.equal(g.admit(job({ title: 'Analyst (m/w/d)', location: 'Nowhere' })).stage, 'language');
  assert.equal(g.admit(job({ location: 'Zenith Bay' })).stage, 'location');
  assert.equal(g.admit(job()).ok, true);
  const again = g.admit(job());
  assert.deepEqual([again.ok, again.stage, again.decision], [false, 'seen', 'duplicate-url']);
});

test('multi-city: kept when ANY location is allowed', () => {
  const g = gate();
  assert.equal(g.admit(job({ location: 'Zenith Bay; Aldervale', url: 'https://b/2', externalId: '2', title: 'Data Analyst' })).ok, true);
  assert.equal(g.admit(job({ location: 'Zenith Bay', extraLocations: ['Remote'], url: 'https://b/3', externalId: '3', title: 'Risk Analyst' })).ok, true, 'extras count');
});

test('seen stage: canonical url → posting id → (company, role)', () => {
  const seen = seedScanSeen({
    urls: ['https://boards.example.com/known?utm_source=x'],
    historyRows: [buildHistoryRow({ url: 'https://boards.example.com/old', source: 'greenhouse-api', title: 'Renamed Analyst', company: 'Nimbus Robotics', externalId: 'g9' }, '2026-10-01')],
    companyRolePairs: [['Nimbus Robotics', 'Role Dup Analyst (m/f/d)']],
    historyColumns: HISTORY_COLUMNS,
  });
  const g = gate({ seen });
  const d = (o) => g.admit(job(o)).decision;
  assert.equal(d({ url: 'https://boards.example.com/known', externalId: '', title: 'Known Analyst' }), 'duplicate-url');
  assert.equal(d({ url: 'https://boards.example.com/new', externalId: 'g9', title: 'Renamed Analyst v2' }), 'duplicate-id');
  assert.equal(d({ url: 'https://boards.example.com/n2', externalId: '', title: 'Role Dup Analyst' }), 'duplicate-role');
  assert.equal(g.admit(job({ url: 'https://boards.example.com/n3', externalId: 'g10', title: 'Fresh Analyst' })).ok, true);
});

test('a provider dedupKey overrides the id key; a requisition id alone is no identity', () => {
  const g = gate();
  const a = g.admit(job({ url: 'https://b/a', title: 'A Analyst', externalId: '', requisitionId: 'R-1', dedupKey: '' }));
  const b = g.admit(job({ url: 'https://b/b', title: 'B Analyst', externalId: '', requisitionId: 'R-1', dedupKey: '' }));
  assert.equal(a.ok && b.ok, true, 'two postings sharing a requisition id are both admitted');
  const c = g.admit(job({ url: 'https://b/c', title: 'C Analyst', dedupKey: 'custom:1' }));
  const d = g.admit(job({ url: 'https://b/d', title: 'D Analyst', dedupKey: 'custom:1' }));
  assert.equal(c.ok, true);
  assert.equal(d.decision, 'duplicate-id');
});

test('screen / locate / classify / claim are the same stages admit() composes', () => {
  const g = gate();
  const j = g.withLocations(job({ title: 'Staged Analyst' }));
  assert.equal(g.screen(j).ok, true);
  assert.equal(g.locate(j).ok, true);
  const c = g.classify(j);
  assert.equal(c.decision, 'new');
  assert.equal(g.classify(j).decision, 'new', 'classify is read-only');
  g.claim(c);
  assert.equal(g.classify(j).decision, 'duplicate-url');
  assert.equal(g.blocksCompany('shadow staffing'), true);
  assert.equal(g.blocksCompany('Nimbus Robotics'), false);
});

test('an empty gate admits everything new', () => {
  const g = createAdmissionGate();
  assert.equal(g.admit(job()).ok, true);
});

// ── parity: scan.mjs and merge-scan-staging.mjs agree ──────────────────────

const PORTALS_YML = `
title_filter:
  positive: ["Analyst"]
  negative: ["Senior"]
lang_blocklist: ["(m/w/d)"]
location_allowlist: ["aldervale", "remote"]
tracked_companies:
  - name: Nimbus Robotics
    api: https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs
  - name: Shadow Staffing
    api: https://boards-api.greenhouse.io/v1/boards/shadow-demo/jobs
`;
const BLACKLIST = '# hand-edited\n- company: Shadow Staffing\n- domain: spam-board.test\n';

// [title, company, location, url, id]
const LISTINGS = [
  ['Ops Analyst', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/1', 'g1'],            // new
  ['Senior Analyst', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/2', 'g2'],         // title
  ['Analyst (m/w/d)', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/3', 'g3'],       // language
  ['Pricing Analyst', 'Nimbus Robotics', 'Zenith Bay', 'https://boards.example.com/nimbus/4', 'g4'],      // location
  ['Data Analyst', 'Nimbus Robotics', 'Zenith Bay; Aldervale', 'https://boards.example.com/nimbus/5', 'g5'], // new (multi-city)
  ['Credit Analyst', 'Shadow Staffing', 'Aldervale', 'https://boards.example.com/shadow/6', 'g6'],        // blacklisted company
  ['Risk Analyst', 'Nimbus Robotics', 'Aldervale', 'https://jobs.spam-board.test/7', 'g7'],               // blacklisted domain
  ['Known Analyst', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/8', 'g8'],         // known url
  ['Renamed Analyst', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/9-new', 'g9'],   // known id
  ['Role Dup Analyst', 'Nimbus Robotics', 'Aldervale', 'https://boards.example.com/nimbus/10-new', 'g10'], // known (company, role)
];
const EXPECTED_NEW = ['Data Analyst', 'Ops Analyst'];

/** Existing scan-history: the three known postings. */
function historyText() {
  const rows = [
    ['https://boards.example.com/nimbus/8', 'Known Analyst', 'g8'],
    ['https://boards.example.com/nimbus/9-old', 'Renamed Analyst Old Title', 'g9'],
    ['https://boards.example.com/nimbus/10-old', 'Role Dup Analyst', 'g10-old'],
  ].map(([url, title, id]) => buildHistoryRow({ url, source: 'greenhouse-api', title, company: 'Nimbus Robotics', location: 'Aldervale', externalId: id }, '2026-10-01'));
  return HISTORY_COLUMNS.join('\t') + '\n' + rows.join('\n') + '\n';
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-parity-'));
  mkdirSync(join(dir, 'user'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'user/portals.yml'), PORTALS_YML);
  writeFileSync(join(dir, 'data/blacklist.md'), BLACKLIST);
  writeFileSync(join(dir, 'data/scan-history.tsv'), historyText());
  writeFileSync(join(dir, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
  return dir;
}
async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}
const titlesAdded = (dir) => {
  const { columns, rows } = parseHistoryFile(readFileSync(join(dir, 'data/scan-history.tsv'), 'utf-8'));
  return rows.filter((r) => getCell(r, columns, 'first_seen') !== '2026-10-01').map((r) => getCell(r, columns, 'title')).sort();
};

test('parity: the same listings admit the same set through scan.mjs and through the JobSpy merge', async () => {
  // — live scan: Nimbus board lists every fixture row except Shadow's; Shadow's board must not even be fetched
  const scanDir = sandbox();
  const requested = [];
  const board = LISTINGS.filter((l) => l[1] === 'Nimbus Robotics').map(([title, , location, url, id]) => ({
    id, title, absolute_url: url, location: { name: location }, first_published: '2026-10-05T00:00:00Z',
  }));
  const client = {
    getJson: async (url) => { requested.push(url); return { jobs: board }; },
    postJson: async () => ({}),
  };
  try {
    const res = await inDir(scanDir, () => runScan({ argv: [], http: client, log: () => {} }));
    assert.deepEqual(requested, ['https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs'], 'a blacklisted company is not fetched');
    assert.equal(res.blacklisted, 1);
    const scanned = titlesAdded(scanDir);
    assert.deepEqual(scanned, EXPECTED_NEW);

    // — merge: every fixture listing arrives as a JobSpy-style staging row
    const mergeDir = sandbox();
    try {
      const stagingRows = LISTINGS.map(([title, company, location, url, id]) =>
        buildHistoryRow({ url, source: 'greenhouse-api', title, company, location, externalId: id }, '2026-10-05'));
      writeFileSync(join(mergeDir, 'data/scan-history.jobspy.tsv'), HISTORY_COLUMNS.join('\t') + '\n' + stagingRows.join('\n') + '\n');
      writeFileSync(join(mergeDir, 'data/pipeline.jobspy.md'), LISTINGS.map(([title, company, , url]) => `- [ ] ${url} | ${company} | ${title}`).join('\n') + '\n');
      const lines = [];
      inDirSync(mergeDir, () => runMerge({ log: (l) => lines.push(l) }));
      const merged = titlesAdded(mergeDir);
      assert.deepEqual(merged, scanned, 'scan and merge admit the same listings');
      assert.match(lines.join('\n'), /admission gate \(.*blacklist/);

      // the pipeline got exactly the admitted listings, no more
      const pipeline = readFileSync(join(mergeDir, 'data/pipeline.md'), 'utf-8');
      for (const t of EXPECTED_NEW) assert.match(pipeline, new RegExp(`\\| ${t}`));
      for (const t of ['Senior Analyst', 'Credit Analyst', 'Risk Analyst', 'Pricing Analyst', 'm/w/d']) assert.doesNotMatch(pipeline, new RegExp(t.replace(/[()/]/g, '\\$&')));
    } finally { rmSync(mergeDir, { recursive: true, force: true }); }
  } finally { rmSync(scanDir, { recursive: true, force: true }); }
});

function inDirSync(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

test('the merge without a blacklist or portals.yml still runs (filters default open, dedup intact)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-merge-bare-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const row = buildHistoryRow({ url: 'https://boards.example.com/z/1', source: 'jobspy-indeed', title: 'Any Role', company: 'Orchard Demo', location: 'Remote' }, '2026-10-05');
    writeFileSync(join(dir, 'data/scan-history.jobspy.tsv'), HISTORY_COLUMNS.join('\t') + '\n' + row + '\n');
    inDirSync(dir, () => runMerge({ log: () => {} }));
    assert.ok(existsSync(join(dir, 'data/scan-history.tsv')));
    assert.deepEqual(titlesAdded(dir), ['Any Role']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

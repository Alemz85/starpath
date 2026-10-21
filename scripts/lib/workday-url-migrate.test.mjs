import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSitelessWorkdayUrl, makeSiteResolver, addSite, migrateHistoryText, migratePipelineText,
} from './workday-url-migrate.mjs';
import { runMigration } from '../migrate-workday-urls.mjs';
import { canonicalizeUrl, workdayIdentityPath } from './merge-staging-core.mjs';
import { HISTORY_COLUMNS } from './scan-history.mjs';
import workday, { parseWorkday, workdayJobUrl } from '../providers/workday.mjs';

const CONFIG = {
  tracked_companies: [
    { name: 'Contoso Demo', careers_url: 'https://contoso.wd3.myworkdayjobs.com/ext' },
    { name: 'Fabrikam Demo', api: 'https://fabrikam.wd1.myworkdayjobs.com/wday/cxs/fabrikam/Careers/jobs' },
    { name: 'Northwind Retail', careers_url: 'https://northwind.wd5.myworkdayjobs.com/Retail' },
    { name: 'Northwind Corporate', careers_url: 'https://northwind.wd5.myworkdayjobs.com/en-US/Corporate' },
  ],
};
const OLD = 'https://contoso.wd3.myworkdayjobs.com/job/Hub/Finance-Analyst_R-1042';
const NEW = 'https://contoso.wd3.myworkdayjobs.com/ext/job/Hub/Finance-Analyst_R-1042';

test('provider stores the full page URL, with the site segment', () => {
  const list = { jobPostings: [{ title: 'Finance Analyst', externalPath: '/job/Hub/Finance-Analyst_R-1042' }] };
  const base = 'https://contoso.wd3.myworkdayjobs.com';
  assert.equal(parseWorkday(list, 'Contoso Demo', base, 'ext')[0].url, NEW);
  assert.equal(parseWorkday(list, 'Contoso Demo', base)[0].url, OLD, 'no site known: the old shape, never a crash');
  assert.equal(workdayJobUrl(base, 'ext', ''), '');
});

test('detect hands the provider the site (careers_url, locale-prefixed careers_url, explicit api)', () => {
  assert.equal(workday.detect({ careers_url: 'https://contoso.wd3.myworkdayjobs.com/ext' }).site, 'ext');
  const loc = workday.detect({ careers_url: 'https://northwind.wd5.myworkdayjobs.com/en-US/Corporate' });
  assert.equal(loc.site, 'Corporate');
  assert.equal(loc.url, 'https://northwind.wd5.myworkdayjobs.com/wday/cxs/northwind/Corporate/jobs');
  const api = workday.detect({ api: 'https://fabrikam.wd1.myworkdayjobs.com/wday/cxs/fabrikam/Careers/jobs' });
  assert.equal(api.site, 'Careers');
  assert.equal(api.baseUrl, 'https://fabrikam.wd1.myworkdayjobs.com');
});

test('identity: the siteless and full URL canonicalize to the same posting', () => {
  assert.equal(canonicalizeUrl(OLD), canonicalizeUrl(NEW));
  assert.equal(canonicalizeUrl(OLD), canonicalizeUrl('https://contoso.wd3.myworkdayjobs.com/en-US/ext/job/Hub/Finance-Analyst_R-1042?source=x'));
  assert.notEqual(canonicalizeUrl(OLD), canonicalizeUrl(OLD.replace('R-1042', 'R-1043')));
  assert.equal(workdayIdentityPath('jobs.example.com', '/ext/job/x'), '/ext/job/x', 'other hosts are untouched');
  assert.equal(workdayIdentityPath('contoso.wd3.myworkdayjobs.com', '/ext'), '/ext', 'no job segment: untouched');
});

test('resolver: company first, then the host\'s only site, else unknown', () => {
  const r = makeSiteResolver(CONFIG);
  assert.equal(r(OLD, 'Contoso Demo'), 'ext');
  assert.equal(r(OLD, 'Someone Else'), 'ext', 'one site on the host');
  const nw = 'https://northwind.wd5.myworkdayjobs.com/job/X/Y_R-1';
  assert.equal(r(nw, 'Northwind Retail'), 'Retail');
  assert.equal(r(nw, 'northwind corporate'), 'Corporate');
  assert.equal(r(nw, 'Unknown Co'), null, 'two sites and no company match: never guess');
  assert.equal(r('https://elsewhere.wd3.myworkdayjobs.com/job/a/b_R-1', 'X'), null);
  assert.equal(r(NEW, 'Contoso Demo'), null, 'already has a site');
  assert.equal(isSitelessWorkdayUrl(NEW), false);
  assert.equal(addSite(OLD, 'ext'), NEW);
});

const HEADER = HISTORY_COLUMNS.join('\t');
const histRow = (url, company, id = 'Finance-Analyst_R-1042') =>
  [url, '2026-10-01', 'workday-api', 'Finance Analyst', company, 'Aldervale', 'added', '2026-10-01', '', '', id, 'R-1042', 'Aldervale', '', '', '', ''].join('\t');

test('scan-history: only the url cell changes; ids, dates and other rows stay byte-identical', () => {
  const other = histRow('https://boards.example.com/nimbus/1', 'Nimbus Demo', 'gh-1');
  const text = `${HEADER}\n${histRow(OLD, 'Contoso Demo')}\n${other}\n${histRow('https://northwind.wd5.myworkdayjobs.com/job/X/Y_R-1', 'Unknown Co')}\n`;
  const out = migrateHistoryText(text, makeSiteResolver(CONFIG));
  assert.equal(out.rewritten, 1);
  assert.equal(out.unresolved, 1);
  const lines = out.text.split('\n');
  assert.equal(lines[1], histRow(NEW, 'Contoso Demo'));
  assert.equal(lines[2], other);
  assert.equal(lines[3].split('\t')[0], 'https://northwind.wd5.myworkdayjobs.com/job/X/Y_R-1');
  // idempotent
  assert.equal(migrateHistoryText(out.text, makeSiteResolver(CONFIG)).rewritten, 0);
});

test('pipeline.md: the leading URL is rewritten, the tail and other lines are kept', () => {
  const text = `# Pipeline\n\n## Pending\n\n- [ ] ${OLD} | Contoso Demo | Finance Analyst | relevance 7.1 — x\n- [x] https://boards.example.com/a/1 | Nimbus Demo | Planner\n- [ ] ${OLD}\n\n## Processed\n`;
  const out = migratePipelineText(text, makeSiteResolver(CONFIG));
  assert.equal(out.rewritten, 2);
  assert.ok(out.text.includes(`- [ ] ${NEW} | Contoso Demo | Finance Analyst | relevance 7.1 — x\n`));
  assert.ok(out.text.includes('- [x] https://boards.example.com/a/1 | Nimbus Demo | Planner\n'));
  assert.ok(out.text.includes(`- [ ] ${NEW}\n`));
});

test('pipeline.md processed forms: the URL in any field of a "- [" line is rewritten, the company picked from the line', () => {
  const nw = 'https://northwind.wd5.myworkdayjobs.com/job/X/Y_R-1';
  const text = `## Processed\n- [x] #13 | ${OLD} | Contoso Demo | Finance Analyst | 7.1 | PDF\n- [!] FILTERED | Northwind Corporate | ${nw}| Analyst | visa-locked\n- [x] SKIPPED duplicate | ${OLD} | whatever\nplain prose ${OLD} stays\n`;
  const out = migratePipelineText(text, makeSiteResolver(CONFIG));
  assert.equal(out.rewritten, 3);
  assert.ok(out.text.includes(`- [x] #13 | ${NEW} | Contoso Demo |`));
  assert.ok(out.text.includes('| Northwind Corporate | https://northwind.wd5.myworkdayjobs.com/Corporate/job/X/Y_R-1| Analyst |'));
  assert.ok(out.text.includes(`- [x] SKIPPED duplicate | ${NEW} | whatever`));
  assert.ok(out.text.includes(`plain prose ${OLD} stays`), 'only entry lines are touched');
});

test('CLI migration: report mode writes nothing, --apply rewrites both files and a second run is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-migrate-'));
  const prev = process.cwd();
  try {
    mkdirSync(join(dir, 'user')); mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'user/portals.yml'), 'tracked_companies:\n  - name: Contoso Demo\n    careers_url: https://contoso.wd3.myworkdayjobs.com/ext\n');
    const hist = `${HEADER}\n${histRow(OLD, 'Contoso Demo')}\n`;
    const pipe = `## Pending\n\n- [ ] ${OLD} | Contoso Demo | Finance Analyst\n`;
    writeFileSync(join(dir, 'data/scan-history.tsv'), hist);
    writeFileSync(join(dir, 'data/pipeline.md'), pipe);
    process.chdir(dir);
    const quiet = () => {};
    assert.deepEqual(runMigration({ log: quiet }).map((r) => r.rewritten), [1, 1]);
    assert.equal(readFileSync('data/scan-history.tsv', 'utf-8'), hist, 'report mode writes nothing');
    runMigration({ apply: true, log: quiet });
    assert.ok(readFileSync('data/scan-history.tsv', 'utf-8').includes(NEW));
    assert.ok(readFileSync('data/pipeline.md', 'utf-8').includes(`- [ ] ${NEW} |`));
    assert.deepEqual(runMigration({ apply: true, log: quiet }).map((r) => r.rewritten), [0, 0]);
  } finally { process.chdir(prev); rmSync(dir, { recursive: true, force: true }); }
});

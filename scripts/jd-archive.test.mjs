// End-to-end for the JD archive tools on a fictional temp tree: the checker,
// verify-pipeline's warning, and the backfill (dry run, real write, gone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from './archive-posting.mjs';
import { HttpError } from './lib/http.mjs';
import { parseArchive } from './lib/jd-archive-core.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const report = (company, role, url) => `# Scouting: ${company} — ${role}\n\n**Date:** 2026-10-01\n**Tier:** T1\n**URL:** ${url}\n\n## Eligibility\n`;

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jd-archive-'));
  for (const d of ['data', 'reports/tier-1', 'reports/tier-2', 'reports/tier-4', 'jds']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'reports/tier-1/Nimbus Robotics - Data Analyst.md'), report('Nimbus Robotics', 'Data Analyst', 'https://boards.greenhouse.io/nimbus/jobs/4012345'));
  writeFileSync(join(root, 'reports/tier-2/Tailspin Toys - Analyst.md'), report('Tailspin Toys', 'Analyst', 'https://boards.greenhouse.io/tailspin/jobs/99'));
  writeFileSync(join(root, 'reports/tier-1/Fabrikam Energy - Ops.md'), report('Fabrikam Energy', 'Ops', 'https://jobs.lever.co/fabrikam/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab'));
  writeFileSync(join(root, 'reports/tier-4/Skipped - Role.md'), report('Skipped', 'Role', 'https://x.example.com/1'));
  writeFileSync(join(root, 'data/scouting.md'), [
    '| # | Date | Company | Role | Match | Ease | Tier | Eligibility | Report | Deadline | Hint | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    '| 11 | 2026-10-01 | Nimbus Robotics | Data Analyst | 8.5 | 7.5 | T1 | green | [11](reports/tier-1/Nimbus Robotics - Data Analyst.md) | n/d | READY | |',
    '| 12 | 2026-10-01 | Tailspin Toys | Analyst | 7 | 7.5 | T2 | green | [12](reports/tier-2/Tailspin Toys - Analyst.md) | n/d | | |',
    '| 13 | 2026-10-01 | Fabrikam Energy | Ops | 8.5 | 7.5 | T1 | green | [13](reports/tier-1/Fabrikam Energy - Ops.md) | n/d | READY | |',
    '',
  ].join('\n'));
  return root;
}

const node = (script, args, root) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

const fakeHttp = (handler) => ({
  getJson: async (url) => handler(url),
  send: async () => { throw new HttpError('unexpected page fetch'); },
});

test('checker lists the T1–T3 reports without an archive and ignores T4', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'jds/011-nimbus-robotics-data-analyst.md'), '# x\n');
    const { code, out } = node('check-jd-archive.mjs', [], root);
    assert.equal(code, 0);
    assert.match(out, /1\/3 reports archived, 2 missing/);
    assert.match(out, /#12 Tailspin Toys/);
    assert.match(out, /#13 Fabrikam Energy/);
    assert.doesNotMatch(out, /Skipped/);
    assert.equal(node('check-jd-archive.mjs', ['--strict'], root).code, 1);
    const json = JSON.parse(node('check-jd-archive.mjs', ['--json'], root).out);
    assert.equal(json.counts.missing, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline warns about missing JD archives with the backfill command', () => {
  const root = makeRoot();
  try {
    const { out } = node('verify-pipeline.mjs', [], root);
    assert.match(out, /3 of 3 reports have no saved job description/);
    assert.match(out, /archive-posting\.mjs --missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backfill --dry-run reports the route per report and writes nothing', async () => {
  const root = makeRoot();
  try {
    const lines = [];
    const code = await run({ root, argv: ['--missing', '--dry-run'], httpClient: fakeHttp(() => { throw new Error('no network in a dry run'); }), out: (l) => lines.push(l) });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /would-archive .*#11 Nimbus Robotics.*via greenhouse → 011-nimbus-robotics-data-analyst\.md/);
    assert.match(text, /via lever → 013-fabrikam-energy-ops\.md/);
    assert.match(text, /3 reports: 3 would-archive/);
    assert.equal(existsSync(join(root, 'jds/011-nimbus-robotics-data-analyst.md')), false);
    assert.equal(existsSync(join(root, 'jds/.unrecoverable.tsv')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backfill writes the archive, logs a gone posting, and retries an unreachable one', async () => {
  const root = makeRoot();
  try {
    const httpClient = fakeHttp((url) => {
      if (url.includes('/nimbus/')) return { title: 'Data Analyst', content: '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Build dashboards.&lt;/p&gt;' };
      if (url.includes('/tailspin/')) throw new HttpError('HTTP 404', { status: 404 });
      throw new HttpError('HTTP 503', { status: 503, retryable: true });
    });
    const lines = [];
    assert.equal(await run({ root, argv: ['--missing'], httpClient, today: '2026-10-20', out: (l) => lines.push(l) }), 0);
    const text = lines.join('\n');
    assert.match(text, /archived\s+#11 Nimbus Robotics/);
    assert.match(text, /gone\s+#12 Tailspin Toys.*HTTP 404/);
    assert.match(text, /unreachable\s+#13 Fabrikam Energy/);

    const saved = parseArchive(readFileSync(join(root, 'jds/011-nimbus-robotics-data-analyst.md'), 'utf8'));
    assert.equal(saved.fetched, '2026-10-20');
    assert.equal(saved.url, 'https://boards.greenhouse.io/nimbus/jobs/4012345');
    assert.equal(saved.source, 'greenhouse-api');
    assert.equal(saved.body, '## About\n\nBuild dashboards.\n');
    assert.equal(existsSync(join(root, 'jds/012-tailspin-toys-analyst.md')), false);
    assert.equal(existsSync(join(root, 'jds/013-fabrikam-energy-ops.md')), false);

    // The gone one is logged and no longer "missing"; the unreachable one is still missing.
    assert.match(readFileSync(join(root, 'jds/.unrecoverable.tsv'), 'utf8'), /^2026-10-20\t012\thttps:\/\/boards\.greenhouse\.io\/tailspin\/jobs\/99\tHTTP 404$/m);
    const check = node('check-jd-archive.mjs', [], root).out;
    assert.match(check, /1\/3 reports archived, 1 posting gone \(unrecoverable\), 1 missing/);

    // Re-running never rewrites an archive nor retries the gone posting.
    const again = [];
    await run({ root, argv: ['--missing'], httpClient: fakeHttp(() => { throw new HttpError('HTTP 503', { status: 503, retryable: true }); }), out: (l) => again.push(l) });
    assert.match(again.join('\n'), /1 report: 1 unreachable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--report=N works for one report and rejects an unknown number', async () => {
  const root = makeRoot();
  try {
    const lines = [];
    assert.equal(await run({ root, argv: ['--report=12', '--dry-run'], httpClient: fakeHttp(() => ({})), out: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /1 report: 1 would-archive/);
    const bad = [];
    assert.equal(await run({ root, argv: ['--report=99'], httpClient: fakeHttp(() => ({})), out: (l) => bad.push(l) }), 2);
    assert.match(bad.join('\n'), /No T1–T3 report with number 99/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

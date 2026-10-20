// Unit tests for scripts/lib/doctor-checks.mjs — pure logic used by doctor.mjs.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTsvDataRows,
  countMarkdownTableRows,
  countPendingPipelineItems,
  parseMarkdownTableHeader,
  parseTsvHeader,
  validateScoreHistoryHeader,
  checkScoreHistoryRows,
  SCORE_HISTORY_REQUIRED_COLS,
  validateScanHistoryHeader,
  validateColCacheHeader,
  validateTaxCacheHeader,
  validateOutreachHeader,
  buildUserLayerChecks,
  buildArtifactChecks,
  buildCapabilityInventory,
  buildPipelineSummary,
  buildProfileChecks,
  buildPrivateRootChecks,
  findTrackedPersonal,
  BACKUP_WARN_DAYS,
} from './doctor-checks.mjs';
import { PROFILE_PATHS, relativeLinkTarget } from './profile-core.mjs';
import { LINKED_PATHS } from './data-root.mjs';

// ── countTsvDataRows ──────────────────────────────────────────────────────

test('countTsvDataRows returns 0 for null/empty', () => {
  assert.equal(countTsvDataRows(null), 0);
  assert.equal(countTsvDataRows(''), 0);
  assert.equal(countTsvDataRows('header\n'), 0);
});

test('countTsvDataRows counts non-empty non-header lines', () => {
  const tsv = 'col1\tcol2\nval1\tval2\nval3\tval4\n';
  assert.equal(countTsvDataRows(tsv), 2);
});

test('countTsvDataRows ignores trailing blank lines', () => {
  const tsv = 'a\tb\n1\t2\n\n\n';
  assert.equal(countTsvDataRows(tsv), 1);
});

// ── countMarkdownTableRows ────────────────────────────────────────────────

test('countMarkdownTableRows returns 0 for null/empty', () => {
  assert.equal(countMarkdownTableRows(null), 0);
  assert.equal(countMarkdownTableRows(''), 0);
});

test('countMarkdownTableRows skips header and separator', () => {
  const md = [
    '| # | Company | Role |',
    '|---|---------|------|',
    '| 1 | Acme    | Analyst |',
    '| 2 | Beta    | PM      |',
  ].join('\n');
  assert.equal(countMarkdownTableRows(md), 2);
});

test('countMarkdownTableRows handles table with no data rows', () => {
  const md = '| Col |\n|-----|\n';
  assert.equal(countMarkdownTableRows(md), 0);
});

test('countMarkdownTableRows ignores non-table lines', () => {
  const md = '# Heading\n\n| Col |\n|-----|\n| data |\n\nsome prose';
  assert.equal(countMarkdownTableRows(md), 1);
});

// ── countPendingPipelineItems ─────────────────────────────────────────────

test('countPendingPipelineItems returns 0 for null/empty', () => {
  assert.equal(countPendingPipelineItems(null), 0);
  assert.equal(countPendingPipelineItems(''), 0);
});

test('countPendingPipelineItems counts only unchecked (- [ ]) URL lines', () => {
  const content = [
    '# Pipeline — Pending Evaluations',
    '',
    '## Pending',
    '- [ ] https://jobs.example.com/1 | Acme | Analyst',
    '- [ ] https://boards.greenhouse.io/company/jobs/2 | Beta | PM',
    '',
  ].join('\n');
  assert.equal(countPendingPipelineItems(content), 2);
});

// Regression (audit finding 1): checked-off `- [x]` history lines are
// processed, not pending — they must NOT inflate the inbox count. The old
// counter matched every line containing a URL and over-reported by the size
// of the whole processed history.
test('countPendingPipelineItems excludes checked-off history lines', () => {
  const content = [
    '## Pending',
    '- [ ] https://jobs.example.com/live | Acme | Analyst',
    '- [x] https://jobs.example.com/done-1 | Beta | PM',
    '- [x] https://boards.greenhouse.io/company/jobs/done-2 | Gamma | Ops',
    'Some prose mentioning https://example.com/inline that is not a checkbox',
  ].join('\n');
  assert.equal(countPendingPipelineItems(content), 1);
});

test('countPendingPipelineItems returns 0 when every line is checked off', () => {
  const content = [
    '## Pending',
    '- [x] https://jobs.example.com/done-1 | Acme | Analyst',
    '- [x] https://jobs.example.com/done-2 | Beta | PM',
  ].join('\n');
  assert.equal(countPendingPipelineItems(content), 0);
});

// ── parseTsvHeader ────────────────────────────────────────────────────────

test('parseTsvHeader returns [] for null/empty', () => {
  assert.deepEqual(parseTsvHeader(null), []);
  assert.deepEqual(parseTsvHeader(''), []);
});

test('parseTsvHeader splits first non-empty line on tabs', () => {
  const tsv = 'date\tcompany\trole\nval1\tval2\tval3\n';
  assert.deepEqual(parseTsvHeader(tsv), ['date', 'company', 'role']);
});

test('parseTsvHeader trims column names', () => {
  const tsv = '  col1 \t col2 \n';
  assert.deepEqual(parseTsvHeader(tsv), ['col1', 'col2']);
});

// ── validateScoreHistoryHeader ────────────────────────────────────────────

test('validateScoreHistoryHeader passes when all required columns present', () => {
  const cols = ['date', 'company', 'role', 'archetype', 'want', 'ease', 'eligibility', 'verdict', 'tier', 'extra'];
  const { valid, missing } = validateScoreHistoryHeader(cols);
  assert.equal(valid, true);
  assert.deepEqual(missing, []);
});

test('SCORE_HISTORY_REQUIRED_COLS is the v2 set', () => {
  assert.deepEqual(SCORE_HISTORY_REQUIRED_COLS, [
    'date', 'company', 'role', 'archetype', 'want', 'ease', 'eligibility', 'verdict', 'tier',
  ]);
});

test('validateScoreHistoryHeader rejects a v1 header (overall / ease_of_entry / strategic_fit)', () => {
  const v1 = ['date', 'company', 'role', 'archetype', 'overall', 'skills_match', 'ease_of_entry', 'strategic_fit'];
  const { valid, missing } = validateScoreHistoryHeader(v1);
  assert.equal(valid, false);
  assert.deepEqual(missing, ['want', 'ease', 'eligibility', 'verdict', 'tier']);
});

test('validateScoreHistoryHeader fails on missing required columns', () => {
  const cols = ['date', 'company', 'role'];
  const { valid, missing } = validateScoreHistoryHeader(cols);
  assert.equal(valid, false);
  assert.ok(missing.includes('want'));
  assert.ok(missing.includes('archetype'));
});

test('validateScoreHistoryHeader is case-insensitive', () => {
  const cols = ['Date', 'Company', 'Role', 'Archetype', 'Want', 'Ease', 'Eligibility', 'Verdict', 'Tier'];
  const { valid } = validateScoreHistoryHeader(cols);
  assert.equal(valid, true);
});

// ── validateScanHistoryHeader ─────────────────────────────────────────────

test('validateScanHistoryHeader passes with the canonical scanner header', () => {
  // Exactly what scan.mjs / merge-scan-staging.mjs write (single-sourced
  // from merge-staging-core.HISTORY_HEADER — note `title`, not `role`).
  const cols = ['url', 'first_seen', 'portal', 'title', 'company', 'location', 'status', 'scan_dates'];
  const { valid, missing } = validateScanHistoryHeader(cols);
  assert.equal(valid, true);
  assert.deepEqual(missing, []);
});

test('validateScanHistoryHeader fails when url missing', () => {
  const cols = ['first_seen', 'portal', 'title', 'company', 'location', 'status', 'scan_dates'];
  const { valid, missing } = validateScanHistoryHeader(cols);
  assert.equal(valid, false);
  assert.ok(missing.includes('url'));
});

// ── validateColCacheHeader ────────────────────────────────────────────────

test('validateColCacheHeader passes with required cols', () => {
  const cols = ['city', 'baseline_eur', 'source', 'last_updated'];
  const { valid } = validateColCacheHeader(cols);
  assert.equal(valid, true);
});

test('validateColCacheHeader fails when baseline_eur missing', () => {
  const cols = ['city', 'source'];
  const { valid, missing } = validateColCacheHeader(cols);
  assert.equal(valid, false);
  assert.ok(missing.includes('baseline_eur'));
});

// ── validateTaxCacheHeader ────────────────────────────────────────────────

test('validateTaxCacheHeader passes with required cols', () => {
  const cols = ['country', 'gross_band_eur', 'effective_rate', 'source', 'last_updated'];
  const { valid } = validateTaxCacheHeader(cols);
  assert.equal(valid, true);
});

test('validateTaxCacheHeader fails when effective_rate missing', () => {
  const cols = ['country', 'gross_band_eur'];
  const { valid, missing } = validateTaxCacheHeader(cols);
  assert.equal(valid, false);
  assert.ok(missing.includes('effective_rate'));
});

// ── buildUserLayerChecks ──────────────────────────────────────────────────

test('buildUserLayerChecks: all present → all pass', () => {
  const files = {
    cv: 'some content',
    profileYml: 'name: Test',
    profileMd: '# profile',
    portalsYml: 'companies: []',
    articleDigest: 'digest',
  };
  const checks = buildUserLayerChecks(files);
  assert.ok(checks.every(c => c.pass), 'All checks should pass when all files present');
});

test('buildUserLayerChecks: missing cv → fail check with fix', () => {
  const files = {
    cv: null,
    profileYml: 'name: Test',
    profileMd: '# profile',
    portalsYml: 'companies: []',
    articleDigest: null,
  };
  const checks = buildUserLayerChecks(files);
  const cvCheck = checks.find(c => c.label.includes('cv.md'));
  assert.ok(cvCheck, 'cv check should exist');
  assert.equal(cvCheck.pass, false);
  assert.ok(cvCheck.fix, 'fix should be provided');
});

test('buildUserLayerChecks: missing _profile.md → fail check', () => {
  const files = {
    cv: 'x', profileYml: 'x', profileMd: null, portalsYml: 'x', articleDigest: null,
  };
  const checks = buildUserLayerChecks(files);
  const mdCheck = checks.find(c => c.label.includes('_profile.md'));
  assert.ok(mdCheck, '_profile.md check should exist');
  assert.equal(mdCheck.pass, false);
});

test('buildUserLayerChecks: article-digest optional — missing is still pass', () => {
  const files = {
    cv: 'x', profileYml: 'x', profileMd: 'x', portalsYml: 'x', articleDigest: null,
  };
  const checks = buildUserLayerChecks(files);
  const adCheck = checks.find(c => c.label.includes('article-digest'));
  assert.ok(adCheck, 'article-digest check should exist');
  assert.equal(adCheck.pass, true, 'article-digest missing should not be a failure');
});

// ── buildArtifactChecks ───────────────────────────────────────────────────

test('buildArtifactChecks: all null → all pass (not-yet-created)', () => {
  const files = {
    scanHistory: null, scoreHistory: null, scouting: null,
    applications: null, pipeline: null, outreach: null,
    colCache: null, taxCache: null,
  };
  const checks = buildArtifactChecks(files, { companiesCount: 0 });
  assert.ok(checks.every(c => c.pass), 'Missing data artifacts should not fail (not-yet-created)');
});

test('buildArtifactChecks: valid scan-history → pass with row count', () => {
  const content = 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates\n'
    + 'http://a\t2026-01-01\tgreenhouse\tAnalyst\tAcme\tCity, Country\tnew\t2026-01-01\n';
  const checks = buildArtifactChecks({ scanHistory: content, scoreHistory: null, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null }, {});
  const sc = checks.find(c => c.label.includes('scan-history'));
  assert.ok(sc.pass);
  assert.ok(sc.label.includes('1 posting'));
});

test('buildArtifactChecks: corrupt scan-history header → fail', () => {
  const content = 'garbage\theader\nval\tval\n';
  const checks = buildArtifactChecks({ scanHistory: content, scoreHistory: null, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null }, {});
  const sc = checks.find(c => c.label.includes('scan-history'));
  assert.equal(sc.pass, false);
});

test('buildArtifactChecks: companies count shown in label', () => {
  const files = { scanHistory: null, scoreHistory: null, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null };
  const checks = buildArtifactChecks(files, { companiesCount: 5 });
  const comp = checks.find(c => c.label.includes('companies'));
  assert.ok(comp, 'companies check should exist');
  assert.ok(comp.label.includes('5'), 'should show count');
});

test('buildArtifactChecks: valid score-history → pass with row count', () => {
  const header = 'date\tcompany\trole\tarchetype\twant\tease\teligibility\tverdict\ttier\n';
  const row    = '2026-01-01\tAcme\tAnalyst\tBiz Dev\t8.25\t5.6\tgreen\tstretch\tT2\n';
  const content = header + row + row;
  const files = { scanHistory: null, scoreHistory: content, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null };
  const checks = buildArtifactChecks(files, {});
  const sc = checks.find(c => c.label.includes('score-history'));
  assert.ok(sc.pass);
  assert.ok(sc.label.includes('2 evaluation'));
});

test('buildArtifactChecks: v1 score-history header fails with an archive hint', () => {
  const content = 'date\tcompany\trole\tarchetype\toverall\tskills_match\tease_of_entry\tstrategic_fit\n2026-01-01\tAcme\tA\tB\t7\t7\t7\t7\n';
  const files = { scanHistory: null, scoreHistory: content, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null };
  const sc = buildArtifactChecks(files, {}).find(c => c.label.includes('score-history'));
  assert.equal(sc.pass, false);
  assert.match(sc.fix, /scoring-v1/);
});

test('buildArtifactChecks: scouting.md with a v2 header passes, a v1 header fails', () => {
  const v2 = '| # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-06-01 | Acme | Analyst | 8 | 7 | T1 | green | — | n/d | READY |  |\n';
  const v1 = '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-06-01 | Acme | Analyst | 8/10 | T1 | 8/8 | — | n/d | READY |  |\n';
  const base = { scanHistory: null, scoreHistory: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null };
  const ok = buildArtifactChecks({ ...base, scouting: v2 }, {}).find(c => c.label.includes('scouting.md'));
  assert.equal(ok.pass, true);
  const bad = buildArtifactChecks({ ...base, scouting: v1 }, {}).find(c => c.label.includes('scouting.md'));
  assert.equal(bad.pass, false);
  assert.match(bad.fix, /12-column v2 header/);
});

// ── checkScoreHistoryRows (verify-pipeline) ─────────────────────────────────

const V2_COLS = 'date\tarchetype\tskills_match\texperience_bar\tcompetition\tease\tgrowth_mobility\toptionality_exit\tbrand_value\trole_content\tbest_cities\tsalary_adj_city\twork_life_balance\twant\tpriority\teligibility\teligibility_flags\tverdict\tbest_fit_roles\tmode\tcompany\trole\ttier\tsource\tlocation\temployment_type\tduration\tsalary_raw\turl';
const hrow = (o = {}) => {
  const base = {
    date: '2026-06-01', archetype: 'Analyst', skills_match: '8', experience_bar: '6', competition: '5', ease: '5.6',
    growth_mobility: '8', optionality_exit: '8', brand_value: '9', role_content: '7', best_cities: '8', salary_adj_city: '6',
    work_life_balance: '6', want: '8.25', priority: '6.8', eligibility: 'amber', eligibility_flags: 'start_date:amber:not stated',
    verdict: 'stretch', best_fit_roles: '', mode: 'scouting', company: 'Acme', role: 'Analyst', tier: 'T2', source: '', location: '',
    employment_type: '', duration: '', salary_raw: '', url: '',
  };
  const m = { ...base, ...o };
  return V2_COLS.split('\t').map(c => m[c]).join('\t');
};

test('checkScoreHistoryRows: a clean v2 file has no findings', () => {
  const r = checkScoreHistoryRows(`${V2_COLS}\n${hrow()}\n${hrow({ company: 'Blocked Co', eligibility: 'red', eligibility_flags: 'language:red:German C1', verdict: 'blocked', tier: 'T4', want: '', ease: '', priority: '', skills_match: '', experience_bar: '', competition: '', growth_mobility: '', optionality_exit: '', brand_value: '', role_content: '', best_cities: '', salary_adj_city: '', work_life_balance: '' })}\n`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.rows, 2);
});

test('checkScoreHistoryRows: v1 header → missing-column error', () => {
  const r = checkScoreHistoryRows('date\tcompany\trole\tarchetype\toverall\n2026-01-01\tA\tR\tX\t7\n');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /want, ease, eligibility, verdict, tier/);
});

test('checkScoreHistoryRows: checks by header name, not position (column order may change)', () => {
  const cols = ['tier', 'company', 'role', 'archetype', 'date', 'verdict', 'eligibility', 'ease', 'want'];
  const text = `${cols.join('\t')}\nT1\tAcme\tAnalyst\tX\t2026-06-01\tgo\tgreen\t7.5\t8.5\n`;
  const r = checkScoreHistoryRows(text);
  assert.deepEqual(r.errors, []);
});

test('checkScoreHistoryRows: flags bad eligibility, bad tier, missing/out-of-range scores', () => {
  const r = checkScoreHistoryRows(`${V2_COLS}\n${hrow({ eligibility: 'maybe' })}\n${hrow({ tier: 'full' })}\n${hrow({ want: '' })}\n${hrow({ ease: '11' })}\n`);
  assert.equal(r.errors.length, 4);
  assert.ok(r.errors.some(e => /eligibility "maybe"/.test(e)));
  assert.ok(r.errors.some(e => /tier "full"/.test(e)));
  assert.ok(r.errors.some(e => /want ""/.test(e)));
  assert.ok(r.errors.some(e => /ease "11"/.test(e)));
});

test('checkScoreHistoryRows: a blocked (red) row must have empty want/ease/priority — never 0', () => {
  const r = checkScoreHistoryRows(`${V2_COLS}\n${hrow({ eligibility: 'red', verdict: 'blocked', tier: 'T4', want: '0', ease: '', priority: '' })}\n`);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /blocked \(red\) row has want "0"/);
});

test('checkScoreHistoryRows: a short row is a warning', () => {
  const r = checkScoreHistoryRows(`${V2_COLS}\n2026-06-01\tAnalyst\n`);
  assert.ok(r.warnings.some(w => /columns, header has 29/.test(w)));
});

// ── parseMarkdownTableHeader + outreach header wiring (audit finding 9) ────

const OUTREACH_HEADER =
  '| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |';

test('parseMarkdownTableHeader skips heading/prose to the real table header', () => {
  const md = ['# Outreach Log', '', 'Some prose about the log.', '', OUTREACH_HEADER,
    '|---|------|---------|------|---------|-------|---------|-------|---------|-------|',
    '| 1 | 2026-01-01 | Acme | Analyst | Jane Doe | Recruiter | Email | 1 | Pending | — |',
  ].join('\n');
  assert.deepEqual(
    parseMarkdownTableHeader(md),
    ['#', 'Date', 'Company', 'Role', 'Contact', 'Title', 'Channel', 'Touch', 'Outcome', 'Notes'],
  );
});

test('parseMarkdownTableHeader returns [] when there is no table', () => {
  assert.deepEqual(parseMarkdownTableHeader('# Just a heading\n\nprose only'), []);
  assert.deepEqual(parseMarkdownTableHeader(null), []);
});

test('buildArtifactChecks: valid outreach header → pass', () => {
  const content = [
    '# Outreach Log', '', OUTREACH_HEADER,
    '|---|------|---------|------|---------|-------|---------|-------|---------|-------|',
    '| 1 | 2026-01-01 | Acme | Analyst | Jane Doe | Recruiter | Email | 1 | Pending | — |',
  ].join('\n');
  const files = { scanHistory: null, scoreHistory: null, scouting: null, applications: null, pipeline: null, outreach: content, colCache: null, taxCache: null };
  const oc = buildArtifactChecks(files, {}).find(c => c.label.includes('outreach.md'));
  assert.ok(oc.pass, 'valid outreach header should pass');
  assert.ok(oc.label.includes('1 outreach thread'));
});

// The old branch pushed pass:true for BOTH valid and invalid headers, so a
// malformed outreach.md (which would make outreach-cadence.mjs mis-read every
// thread) sailed through. A missing required column is now a failing check.
test('buildArtifactChecks: outreach header missing Channel/Touch → fail', () => {
  const content = [
    '# Outreach Log', '',
    '| # | Date | Company | Role | Contact | Title | Outcome | Notes |',
    '|---|------|---------|------|---------|-------|---------|-------|',
    '| 1 | 2026-01-01 | Acme | Analyst | Jane Doe | Recruiter | Pending | — |',
  ].join('\n');
  const files = { scanHistory: null, scoreHistory: null, scouting: null, applications: null, pipeline: null, outreach: content, colCache: null, taxCache: null };
  const oc = buildArtifactChecks(files, {}).find(c => c.label.includes('outreach.md'));
  assert.equal(oc.pass, false);
  assert.ok(/missing:.*channel/i.test(oc.label) && /touch/i.test(oc.label));
});

// ── buildCapabilityInventory ──────────────────────────────────────────────

test('buildCapabilityInventory: all scripts present → pass', () => {
  const checks = buildCapabilityInventory({
    scriptExists: () => true,
    modeCount: 22,
    jobspyPyExists: true,
    jobspyVenvReady: true,
    storyBankExists: true,
  });
  const toolCheck = checks.find(c => c.label.includes('CLI tools'));
  assert.ok(toolCheck.pass, 'tool check should pass when all present');
});

test('buildCapabilityInventory: missing scripts → fail with names', () => {
  const missing = new Set(['scan.mjs', 'generate-pdf.mjs']);
  const checks = buildCapabilityInventory({
    scriptExists: (s) => !missing.has(s),
    modeCount: 22,
    jobspyPyExists: true,
    jobspyVenvReady: true,
    storyBankExists: false,
  });
  const toolCheck = checks.find(c => c.label.includes('CLI tools'));
  assert.equal(toolCheck.pass, false);
  assert.ok(toolCheck.label.includes('scan.mjs'));
  assert.ok(toolCheck.label.includes('generate-pdf.mjs'));
});

test('buildCapabilityInventory: jobspy not installed → fail', () => {
  const checks = buildCapabilityInventory({
    scriptExists: () => true,
    modeCount: 22,
    jobspyPyExists: false,
    jobspyVenvReady: false,
    storyBankExists: false,
  });
  const jobspyCheck = checks.find(c => c.label.toLowerCase().includes('jobspy'));
  assert.ok(jobspyCheck, 'jobspy check should exist');
  assert.equal(jobspyCheck.pass, false);
});

test('buildCapabilityInventory: jobspy installed but venv missing → fail', () => {
  const checks = buildCapabilityInventory({
    scriptExists: () => true,
    modeCount: 22,
    jobspyPyExists: true,
    jobspyVenvReady: false,
    storyBankExists: false,
  });
  const jobspyCheck = checks.find(c => c.label.toLowerCase().includes('jobspy'));
  assert.equal(jobspyCheck.pass, false);
  assert.ok(jobspyCheck.fix && jobspyCheck.fix.includes('setup.sh'));
});

test('buildCapabilityInventory: story bank absent → pass (optional)', () => {
  const checks = buildCapabilityInventory({
    scriptExists: () => true,
    modeCount: 22,
    jobspyPyExists: true,
    jobspyVenvReady: true,
    storyBankExists: false,
  });
  const bankCheck = checks.find(c => c.label.includes('story-bank'));
  assert.ok(bankCheck, 'story bank check should exist');
  assert.equal(bankCheck.pass, true, 'missing story bank should not fail');
});

test('buildCapabilityInventory: mode count shown in label', () => {
  const checks = buildCapabilityInventory({
    scriptExists: () => true,
    modeCount: 17,
    jobspyPyExists: true,
    jobspyVenvReady: true,
    storyBankExists: false,
  });
  const modeCheck = checks.find(c => c.label.includes('mode'));
  assert.ok(modeCheck, 'mode check should exist');
  assert.ok(modeCheck.label.includes('17'));
});

// ── buildPipelineSummary ──────────────────────────────────────────────────

test('buildPipelineSummary returns a label and lines', () => {
  const result = buildPipelineSummary({ scanned: 120, scored: 45, scouted: 30, applied: 8, pending: 5 });
  assert.ok(result.label, 'should have a label');
  assert.ok(Array.isArray(result.lines), 'lines should be an array');
  assert.ok(result.lines.length > 0);
  assert.ok(result.lines.some(l => l.includes('120')), 'should show scanned count');
  assert.ok(result.lines.some(l => l.includes('8')),   'should show applied count');
});

test('buildPipelineSummary defaults to 0 for missing counts', () => {
  const result = buildPipelineSummary({});
  assert.ok(result.lines.every(l => /\d/.test(l)), 'all lines should have numbers');
});

// ── buildProfileChecks ────────────────────────────────────────────────────

/** A fully healthy migrated layout with one active profile. */
function healthyLayout(slug = 'career') {
  return {
    profilesDirExists: true,
    activeRaw: `${slug}\n`,
    profileDirs: [slug],
    links: PROFILE_PATHS.map(p => ({
      path: p,
      present: true,
      isSymlink: true,
      linkTarget: relativeLinkTarget(p, slug),
    })),
    profileStructures: [
      { slug, hasUser: true, hasData: true, hasReports: true, hasMeta: true },
    ],
    reportsChildren: ['.gitkeep', 'tier-1', 'tier-2', 'tier-3', 'tier-4', 'positioning', 'briefs'],
  };
}

test('buildProfileChecks: pre-migration layout → single informative OK line', () => {
  for (const layout of [undefined, null, { profilesDirExists: false }]) {
    const checks = buildProfileChecks(layout);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].pass, true);
    assert.match(checks[0].label, /single-profile layout/);
  }
});

test('buildProfileChecks: healthy migrated layout is all-green', () => {
  const checks = buildProfileChecks(healthyLayout());
  assert.ok(checks.length >= 5, 'covers active, links, shadows, structure, reports/');
  assert.ok(checks.every(c => c.pass), JSON.stringify(checks.filter(c => !c.pass)));
  assert.ok(checks.some(c => c.label.includes("profiles/active → 'career'")));
  assert.ok(checks.some(c => c.label.includes('19 canonical paths are symlinks')));
});

test('buildProfileChecks: missing profiles/active fails', () => {
  const layout = { ...healthyLayout(), activeRaw: null };
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /profiles\/active is missing/.test(c.label));
  assert.ok(fail, 'missing active pointer should fail');
});

test('buildProfileChecks: invalid active slug fails', () => {
  const layout = { ...healthyLayout(), activeRaw: 'Not A Slug\n' };
  const checks = buildProfileChecks(layout);
  assert.ok(checks.some(c => !c.pass && /invalid slug/.test(c.label)));
});

test('buildProfileChecks: active pointing at a missing profile dir fails', () => {
  const layout = { ...healthyLayout(), activeRaw: 'ghost\n' };
  const checks = buildProfileChecks(layout);
  assert.ok(checks.some(c => !c.pass && /missing profile 'ghost'/.test(c.label)));
});

test('buildProfileChecks: a canonical path missing entirely fails', () => {
  const layout = healthyLayout();
  layout.links = layout.links.map(l =>
    l.path === 'data/scouting.md' ? { ...l, present: false, isSymlink: false, linkTarget: null } : l
  );
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /missing entirely/.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /data\/scouting\.md/);
});

test('buildProfileChecks: a layout from before the status log (no status-log.tsv link) is flagged with the switch fix', () => {
  const layout = healthyLayout();
  layout.links = layout.links.map(l =>
    l.path === 'data/status-log.tsv' ? { ...l, present: false, isSymlink: false, linkTarget: null } : l
  );
  const fail = buildProfileChecks(layout).find(c => !c.pass && /missing entirely/.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /data\/status-log\.tsv/);
  assert.match(String(fail.fix), /profile -- switch career/);
});

test('buildProfileChecks: a symlink pointing at the wrong profile fails', () => {
  const layout = healthyLayout();
  layout.links = layout.links.map(l =>
    l.path === 'reports/tier-1'
      ? { ...l, linkTarget: relativeLinkTarget('reports/tier-1', 'other') }
      : l
  );
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /not resolving into profiles\/career\//.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /reports\/tier-1/);
});

test('buildProfileChecks: real-file shadow at a canonical path fails with a targeted fix', () => {
  const layout = healthyLayout();
  layout.links = layout.links.map(l =>
    l.path === 'data/scan-history.tsv' ? { ...l, isSymlink: false, linkTarget: null } : l
  );
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /real-file shadow/.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /data\/scan-history\.tsv/);
  assert.ok(fail.fix, 'shadow check should carry a fix hint');
});

test('buildProfileChecks: structurally incomplete profile dir fails naming the missing parts', () => {
  const layout = healthyLayout();
  layout.profileDirs = ['career', 'broken'];
  layout.profileStructures.push({
    slug: 'broken', hasUser: true, hasData: false, hasReports: true, hasMeta: false,
  });
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /profiles\/broken\//.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /data\//);
  assert.match(fail.label, /meta\.yml/);
});

test('buildProfileChecks: unexpected real children of reports/ fail; OS noise ignored', () => {
  const layout = healthyLayout();
  layout.reportsChildren = [...layout.reportsChildren, 'stray-report.md', '.DS_Store'];
  const checks = buildProfileChecks(layout);
  const fail = checks.find(c => !c.pass && /unexpected real child/.test(c.label));
  assert.ok(fail);
  assert.match(fail.label, /stray-report\.md/);
  assert.ok(!/DS_Store/.test(fail.label), '.DS_Store is OS noise, not a finding');
});

test('buildProfileChecks: link checks are blocked (not guessed) when active is unresolvable', () => {
  const layout = { ...healthyLayout(), activeRaw: null };
  const checks = buildProfileChecks(layout);
  assert.ok(checks.some(c => !c.pass && /blocked/.test(c.label)));
  assert.ok(!checks.some(c => c.label.includes('canonical paths are symlinks into')));
});

// ── Private root ──────────────────────────────────────────────────────────

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const okLinks = () => LINKED_PATHS.map((e) => ({ path: e.path, kind: e.kind, state: 'linked', ok: true, target: e.link }));

/** A healthy migrated checkout; override fields per test. */
function healthy(over = {}) {
  return {
    privateExists: true,
    links: okLinks(),
    legacyPaths: [],
    dataRoot: { root: '/work/starpath/private', kind: 'private', source: 'default' },
    git: { isRepo: true, branch: 'main', remote: 'git@example.test:dana/private-data.git', uncommitted: 0, lastCommitAt: NOW - DAY, unpushed: 0 },
    now: NOW,
    publicRepo: true,
    ignored: true,
    trackedPersonal: [],
    hooksPath: '.githooks',
    demoPresent: true,
    overrides: [],
    ...over,
  };
}

const failures = (checks) => checks.filter((c) => !c.pass);
const warnings = (checks) => checks.filter((c) => c.pass && c.warn);
const find = (checks, re) => checks.find((c) => re.test(c.label));

test('buildPrivateRootChecks: a healthy private root passes with no warnings', () => {
  const checks = buildPrivateRootChecks(healthy());
  assert.deepEqual(failures(checks), []);
  assert.deepEqual(warnings(checks), []);
  assert.ok(find(checks, /all 13 repo-root links point into private\//));
  assert.ok(find(checks, /own git repo \(branch main\)/));
  assert.ok(find(checks, /last backup 1 day ago/));
  assert.ok(find(checks, /gitignored by the public repo/));
  assert.ok(find(checks, /no personal paths tracked/));
  assert.ok(find(checks, /hooks installed/));
  assert.ok(find(checks, /demo dataset present/));
  assert.ok(find(checks, /no private overrides/));
});

test('buildPrivateRootChecks: missing / dangling links fail with the link fix', () => {
  const links = okLinks();
  links[5] = { ...links[5], state: 'absent', ok: false, target: null };
  links[8] = { ...links[8], state: 'dangling', ok: false, target: '../gone/logs' };
  links[1] = { ...links[1], state: 'linked', ok: false }; // link fine, private/data missing
  const checks = buildPrivateRootChecks(healthy({ links }));
  const f = failures(checks);
  assert.equal(f.length, 1);
  assert.match(f[0].label, /3 links missing or broken: data \(private\/data missing\), jds \(absent\), batch\/logs \(dangling\)/);
  assert.equal(f[0].fix, 'Run: npm run private -- link');
  assert.ok(!find(checks, /all 13 repo-root links/));
});

test('buildPrivateRootChecks: a real folder at a link path is a shadow (FAIL), a wrong link needs --force', () => {
  const links = okLinks();
  links[1] = { ...links[1], state: 'real', ok: false, target: null };
  links[10] = { ...links[10], state: 'real', ok: false, target: null };
  links[0] = { ...links[0], state: 'wrong', ok: false, target: '../elsewhere/user' };
  const checks = buildPrivateRootChecks(healthy({ links }));
  const shadow = find(checks, /shadow/);
  assert.equal(shadow.pass, false);
  assert.match(shadow.label, /data, batch\/batch-state\.tsv/);
  assert.match(shadow.fix[0], /npm run private -- init/);
  const wrong = find(checks, /pointing elsewhere/);
  assert.equal(wrong.pass, false);
  assert.match(wrong.label, /user → \.\.\/elsewhere\/user/);
  assert.match(wrong.fix, /link --force/);
});

test('buildPrivateRootChecks: no private/ — legacy folders warn "not migrated", nothing at all is a first-run hint', () => {
  const legacy = buildPrivateRootChecks(healthy({ privateExists: false, git: null, legacyPaths: ['user', 'data', 'profiles'] }));
  const nm = find(legacy, /not migrated/);
  assert.equal(nm.pass, true);
  assert.equal(nm.warn, true);
  assert.match(nm.label, /user, data, profiles/);
  assert.match(nm.fix, /npm run private -- init/);
  assert.ok(!find(legacy, /git repo/), 'no private-repo checks without private/');
  assert.deepEqual(failures(legacy), []);

  const fresh = buildPrivateRootChecks(healthy({ privateExists: false, git: null }));
  const fr = find(fresh, /first run/);
  assert.equal(fr.warn, true);
  assert.match(fr.fix, /npm run private -- init/);
});

test('buildPrivateRootChecks: private/ without git fails; no remote and stale backups warn', () => {
  const noGit = buildPrivateRootChecks(healthy({ git: { isRepo: false } }));
  assert.match(failures(noGit)[0].label, /not a git repo/);
  assert.ok(!find(noGit, /remote/));

  const noRemote = buildPrivateRootChecks(healthy({ git: { ...healthy().git, remote: null } }));
  const r = find(noRemote, /no remote/);
  assert.equal(r.warn, true);
  assert.match(r.fix, /git -C private remote add origin <url> && npm run backup/);

  const stale = buildPrivateRootChecks(healthy({ git: { ...healthy().git, lastCommitAt: NOW - (BACKUP_WARN_DAYS + 3) * DAY, uncommitted: 4, unpushed: 2 } }));
  const s = find(stale, /last backup/);
  assert.equal(s.warn, true);
  assert.equal(s.label, 'last backup 10 days ago (4 uncommitted changes · 2 commits not pushed)');
  assert.equal(s.fix, 'Run: npm run backup');

  const fresh = buildPrivateRootChecks(healthy({ git: { ...healthy().git, lastCommitAt: NOW - BACKUP_WARN_DAYS * DAY, uncommitted: 1 } }));
  const f = find(fresh, /last backup/);
  assert.ok(!f.warn, 'exactly 7 days is still fine');
  assert.equal(f.note, '1 uncommitted change');

  const none = buildPrivateRootChecks(healthy({ git: { ...healthy().git, lastCommitAt: null } }));
  assert.equal(find(none, /no commits yet/).warn, true);
});

test('buildPrivateRootChecks: public-repo safety — ignore rule and tracked personal paths FAIL, hooks warn', () => {
  const checks = buildPrivateRootChecks(healthy({
    ignored: false,
    trackedPersonal: ['data/scouting.md', 'private/user/cv.md'],
    hooksPath: null,
  }));
  const f = failures(checks).map((c) => c.label);
  assert.ok(f.some((l) => /NOT ignored/.test(l)));
  assert.ok(f.some((l) => /2 personal paths tracked by the public repo: data\/scouting\.md, private\/user\/cv\.md/.test(l)));
  const hooks = find(checks, /hooks not installed/);
  assert.equal(hooks.warn, true);
  assert.equal(hooks.fix, 'Run: npm run hooks');

  const notRepo = buildPrivateRootChecks(healthy({ publicRepo: false, ignored: null }));
  assert.ok(!find(notRepo, /gitignored|tracked|hooks/), 'skipped outside a git checkout');
});

test('buildPrivateRootChecks: demo is info only', () => {
  const c = find(buildPrivateRootChecks(healthy({ demoPresent: false })), /demo dataset/);
  assert.equal(c.pass, true);
  assert.ok(!c.warn);
  assert.match(c.label, /npm run demo:build/);
});

test('buildPrivateRootChecks: overrides listed, drift / orphans / invalid ones warn', () => {
  const overrides = [
    { rel: 'modes/scouting.append.md', target: 'modes/scouting.md', mode: 'append', valid: true, defaultExists: true, drift: true },
    { rel: 'templates/cv-template.html', target: 'templates/cv-template.html', mode: 'replace', valid: true, defaultExists: true, drift: false },
    { rel: 'modes/retired.md', target: 'modes/retired.md', mode: 'replace', valid: true, defaultExists: false, drift: false },
    { rel: 'scripts/scan.mjs', target: 'scripts/scan.mjs', mode: 'replace', valid: false, defaultExists: true, drift: false },
  ];
  const checks = buildPrivateRootChecks(healthy({ overrides }));
  assert.equal(find(checks, /overrides active/).label,
    '3 overrides active: modes/retired.md (replace), modes/scouting.md (append), templates/cv-template.html (replace)');
  const drift = find(checks, /default changed since your override/);
  assert.equal(drift.warn, true);
  assert.match(drift.label, /modes\/scouting\.md$/);
  assert.match(drift.fix[0], /git log -p -- modes\/scouting\.md/);
  assert.equal(find(checks, /no repo default/).warn, true);
  assert.equal(find(checks, /not overridable/).warn, true);
  assert.deepEqual(failures(checks), []);
  assert.ok(!find(buildPrivateRootChecks(healthy({ overrides: null })), /override/), 'no data root → no override lines');
});

test('buildPrivateRootChecks: a data root other than private/ is noted', () => {
  const c = find(buildPrivateRootChecks(healthy({ dataRoot: { root: '/work/starpath/demo', kind: 'demo', source: 'env' } })), /private\/ exists/);
  assert.match(c.note, /demo, from env/);
});

test('findTrackedPersonal: personal and private/ paths only', () => {
  assert.deepEqual(findTrackedPersonal([
    'scripts/doctor.mjs',
    'batch/README.md',
    'batch/batch-prompt.md',
    'batch/logs/run.log',
    'batch/batch-state.tsv',
    'data/.gitkeep',
    'user/cv.md',
    'reports/tier-1/Fabrikam - Analyst.md',
    'profiles/active',
    'private/README.md',
    'demo/user/profile.yml',
    'demo/data/scouting.md',
    'docs/REPO-GUIDE.md',
    '',
  ]), [
    'batch/logs/run.log',
    'batch/batch-state.tsv',
    'data/.gitkeep',
    'user/cv.md',
    'reports/tier-1/Fabrikam - Analyst.md',
    'profiles/active',
    'private/README.md',
  ]);
  assert.deepEqual(findTrackedPersonal(null), []);
});

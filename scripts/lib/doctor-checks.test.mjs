// Unit tests for scripts/lib/doctor-checks.mjs — pure logic used by doctor.mjs.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTsvDataRows,
  countMarkdownTableRows,
  countPipelineItems,
  parseTsvHeader,
  validateScoreHistoryHeader,
  validateScanHistoryHeader,
  validateColCacheHeader,
  validateTaxCacheHeader,
  validateOutreachHeader,
  buildUserLayerChecks,
  buildArtifactChecks,
  buildCapabilityInventory,
  buildPipelineSummary,
} from './doctor-checks.mjs';

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

// ── countPipelineItems ────────────────────────────────────────────────────

test('countPipelineItems returns 0 for null/empty', () => {
  assert.equal(countPipelineItems(null), 0);
  assert.equal(countPipelineItems(''), 0);
});

test('countPipelineItems counts lines with URLs', () => {
  const content = [
    '# Pipeline',
    'https://jobs.example.com/1',
    'Some text without a URL',
    'https://boards.greenhouse.io/company/jobs/2',
    '',
  ].join('\n');
  assert.equal(countPipelineItems(content), 2);
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
  const cols = ['date', 'company', 'role', 'archetype', 'overall', 'skills_match', 'ease_of_entry', 'strategic_fit', 'extra'];
  const { valid, missing } = validateScoreHistoryHeader(cols);
  assert.equal(valid, true);
  assert.deepEqual(missing, []);
});

test('validateScoreHistoryHeader fails on missing required columns', () => {
  const cols = ['date', 'company', 'role'];
  const { valid, missing } = validateScoreHistoryHeader(cols);
  assert.equal(valid, false);
  assert.ok(missing.includes('overall'));
  assert.ok(missing.includes('archetype'));
});

test('validateScoreHistoryHeader is case-insensitive', () => {
  const cols = ['Date', 'Company', 'Role', 'Archetype', 'Overall', 'Skills_Match', 'Ease_Of_Entry', 'Strategic_Fit'];
  const { valid } = validateScoreHistoryHeader(cols);
  assert.equal(valid, true);
});

// ── validateScanHistoryHeader ─────────────────────────────────────────────

test('validateScanHistoryHeader passes with all required cols', () => {
  const cols = ['url', 'company', 'role', 'first_seen', 'status'];
  const { valid, missing } = validateScanHistoryHeader(cols);
  assert.equal(valid, true);
  assert.deepEqual(missing, []);
});

test('validateScanHistoryHeader fails when url missing', () => {
  const cols = ['company', 'role', 'first_seen'];
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
  const content = 'url\tcompany\trole\tfirst_seen\nhttp://a\tAcme\tAnalyst\t2026-01-01\n';
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
  const header = 'date\tcompany\trole\tarchetype\toverall\tskills_match\tease_of_entry\tstrategic_fit\n';
  const row    = '2026-01-01\tAcme\tAnalyst\tBiz Dev\t7.5\t7\t7\t7\n';
  const content = header + row + row;
  const files = { scanHistory: null, scoreHistory: content, scouting: null, applications: null, pipeline: null, outreach: null, colCache: null, taxCache: null };
  const checks = buildArtifactChecks(files, {});
  const sc = checks.find(c => c.label.includes('score-history'));
  assert.ok(sc.pass);
  assert.ok(sc.label.includes('2 evaluation'));
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

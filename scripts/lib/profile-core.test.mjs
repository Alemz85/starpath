// Unit tests for scripts/lib/profile-core.mjs — pure logic behind
// scripts/profile.mjs. Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILE_CONFIG_FILES,
  PROFILE_DATA_FILES,
  PROFILE_FILES,
  PROFILE_REPORT_DIRS,
  PROFILE_PATHS,
  TRACKER_SCAFFOLDS,
  SCORE_HISTORY_HEADER,
  pathKind,
  validateSlug,
  parseActive,
  serializeActive,
  parseMeta,
  serializeMeta,
  profileRelPath,
  relativeLinkTarget,
  linkResolvesIntoProfile,
  planInit,
  planCreate,
  planSwitch,
  planEject,
  evaluateGuards,
  parseBatchStateRows,
  countPendingPipelineLines,
} from './profile-core.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── Canonical path sets ───────────────────────────────────────────────────

test('path sets match the spec: 12 files + 6 report dirs = 18 paths', () => {
  assert.equal(PROFILE_CONFIG_FILES.length, 3);
  assert.equal(PROFILE_DATA_FILES.length, 9);
  assert.equal(PROFILE_FILES.length, 12);
  assert.equal(PROFILE_REPORT_DIRS.length, 6);
  assert.equal(PROFILE_PATHS.length, 18);
  // No duplicates
  assert.equal(new Set(PROFILE_PATHS).size, 18);
});

test('pathKind: dirs for report subdirs, files otherwise', () => {
  assert.equal(pathKind('reports/tier-1'), 'dir');
  assert.equal(pathKind('reports/briefs'), 'dir');
  assert.equal(pathKind('data/scouting.md'), 'file');
  assert.equal(pathKind('user/profile.yml'), 'file');
});

test('every data file has a scaffold; config files have none', () => {
  for (const p of PROFILE_DATA_FILES) {
    assert.ok(p in TRACKER_SCAFFOLDS, `${p} needs a scaffold`);
    assert.equal(typeof TRACKER_SCAFFOLDS[p], 'string');
  }
  for (const p of PROFILE_CONFIG_FILES) {
    assert.ok(!(p in TRACKER_SCAFFOLDS), `${p} must NOT be scaffolded`);
  }
});

// ── Scaffold-header parity with the real writers ──────────────────────────
// The scaffolds must stay byte-identical to what the writers create, so a
// scaffolded profile is indistinguishable from an organically-created one.

test('score-history scaffold header matches modes/_shared.md and batch/batch-prompt.md', () => {
  for (const rel of ['modes/_shared.md', 'batch/batch-prompt.md']) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    assert.ok(
      text.includes(SCORE_HISTORY_HEADER),
      `${rel} no longer contains the exact score-history header — update SCORE_HISTORY_HEADER in profile-core.mjs`
    );
  }
});

test('scouting scaffold carries the canonical 11-column header', () => {
  assert.match(
    TRACKER_SCAFFOLDS['data/scouting.md'],
    /\| # \| Date \| Company \| Role \| Score \| Tier \| CF\/AF \| Report \| Deadline \| Promotion Hint \| Notes \|/
  );
});

test('applications scaffold carries the canonical 10-column header (Deadline present)', () => {
  // merge-tracker.mjs writes a Deadline cell between PDF and Report on every
  // row, so the scaffold header must include it — a 9-col header under 10-col
  // rows is the schema drift that mis-mapped Report/Notes downstream.
  assert.match(
    TRACKER_SCAFFOLDS['data/applications.md'],
    /\| # \| Date \| Company \| Role \| Score \| Status \| PDF \| Deadline \| Report \| Notes \|/
  );
});

test('pipeline scaffold has the ## Pending section merge-scan-staging expects', () => {
  assert.ok(TRACKER_SCAFFOLDS['data/pipeline.md'].includes('## Pending'));
});

test('report-summaries scaffold is empty (appenders write bare rows, no header)', () => {
  assert.equal(TRACKER_SCAFFOLDS['data/report-summaries.tsv'], '');
});

test('filter-audit-state scaffold parses as empty JSON object', () => {
  assert.deepEqual(JSON.parse(TRACKER_SCAFFOLDS['data/filter-audit-state.json']), {});
});

// ── validateSlug ──────────────────────────────────────────────────────────

test('validateSlug accepts spec-conformant slugs', () => {
  for (const s of ['career', 'cph-student', 'a', '0', 'x1-y2', 'a'.repeat(32)]) {
    assert.equal(validateSlug(s).valid, true, s);
  }
});

test('validateSlug rejects bad slugs with a reason', () => {
  const bad = ['', 'Career', 'has space', '-leading', 'über', 'a'.repeat(33), 'foo_bar', null, undefined, 42];
  for (const s of bad) {
    const r = validateSlug(s);
    assert.equal(r.valid, false, String(s));
    assert.ok(r.reason, String(s));
  }
});

test("validateSlug reserves 'active'", () => {
  const r = validateSlug('active');
  assert.equal(r.valid, false);
  assert.match(r.reason, /reserved/);
});

// ── parseActive / serializeActive ─────────────────────────────────────────

test('parseActive round-trips serializeActive', () => {
  assert.equal(parseActive(serializeActive('career')), 'career');
});

test('parseActive tolerates whitespace and blank lines', () => {
  assert.equal(parseActive('  career  \n'), 'career');
  assert.equal(parseActive('\n\ncph-student\n'), 'cph-student');
});

test('parseActive returns null for empty/invalid content', () => {
  assert.equal(parseActive(''), null);
  assert.equal(parseActive('\n\n'), null);
  assert.equal(parseActive('Not A Slug'), null);
  assert.equal(parseActive('active'), null); // reserved
  assert.equal(parseActive(null), null);
});

// ── meta.yml round-trip ───────────────────────────────────────────────────

test('meta round-trip preserves label and created', () => {
  const meta = { label: 'Copenhagen student', created: '2026-07-07' };
  assert.deepEqual(parseMeta(serializeMeta(meta)), meta);
});

test('meta round-trip escapes double quotes in the label', () => {
  const meta = { label: 'the "big" search', created: '2026-01-01' };
  assert.deepEqual(parseMeta(serializeMeta(meta)), meta);
});

test('parseMeta handles unquoted values and missing keys', () => {
  assert.deepEqual(parseMeta('label: plain\n'), { label: 'plain', created: null });
  assert.deepEqual(parseMeta(''), { label: null, created: null });
  assert.deepEqual(parseMeta(null), { label: null, created: null });
});

// ── Path math ─────────────────────────────────────────────────────────────

test('relativeLinkTarget climbs exactly out of the link dir', () => {
  assert.equal(
    relativeLinkTarget('data/scouting.md', 'career'),
    '../profiles/career/data/scouting.md'
  );
  assert.equal(
    relativeLinkTarget('reports/tier-1', 'cph-student'),
    '../profiles/cph-student/reports/tier-1'
  );
  assert.equal(
    relativeLinkTarget('user/profile.yml', 'career'),
    '../profiles/career/user/profile.yml'
  );
});

test('linkResolvesIntoProfile accepts the targets the CLI writes', () => {
  for (const p of PROFILE_PATHS) {
    assert.equal(
      linkResolvesIntoProfile(p, relativeLinkTarget(p, 'career'), 'career'),
      true,
      p
    );
  }
});

test('linkResolvesIntoProfile rejects wrong-profile / wrong-path / garbage targets', () => {
  assert.equal(
    linkResolvesIntoProfile('data/scouting.md', '../profiles/other/data/scouting.md', 'career'),
    false
  );
  assert.equal(
    linkResolvesIntoProfile('data/scouting.md', '../profiles/career/data/applications.md', 'career'),
    false
  );
  assert.equal(linkResolvesIntoProfile('data/scouting.md', '', 'career'), false);
  assert.equal(linkResolvesIntoProfile('data/scouting.md', null, 'career'), false);
  // Escapes the repo root
  assert.equal(
    linkResolvesIntoProfile('data/scouting.md', '../../elsewhere/profiles/career/data/scouting.md', 'career'),
    false
  );
});

test('linkResolvesIntoProfile accepts absolute targets by suffix', () => {
  assert.equal(
    linkResolvesIntoProfile(
      'data/scouting.md',
      '/somewhere/repo/profiles/career/data/scouting.md',
      'career'
    ),
    true
  );
  assert.equal(
    linkResolvesIntoProfile(
      'data/scouting.md',
      '/somewhere/repo/profiles/other/data/scouting.md',
      'career'
    ),
    false
  );
});

// ── Plans ─────────────────────────────────────────────────────────────────

test('planSwitch: 18 symlink ops then write-active LAST', () => {
  const ops = planSwitch('cph-student');
  assert.equal(ops.length, 19);
  const last = ops[ops.length - 1];
  assert.deepEqual(last, { op: 'write-active', slug: 'cph-student' });
  const links = ops.slice(0, -1);
  assert.ok(links.every((o) => o.op === 'symlink'));
  assert.deepEqual(links.map((o) => o.linkPath), PROFILE_PATHS);
  for (const o of links) {
    assert.equal(o.target, relativeLinkTarget(o.linkPath, 'cph-student'));
    assert.equal(o.kind, pathKind(o.linkPath));
  }
});

test('planInit: adopts every canonical path before any symlink, active LAST', () => {
  const ops = planInit('career', { label: 'Career search', date: '2026-07-07' });
  assert.equal(ops[ops.length - 1].op, 'write-active');
  const kinds = ops.map((o) => o.op);
  assert.ok(kinds.lastIndexOf('adopt') < kinds.indexOf('symlink'), 'moves happen before links');
  const adopts = ops.filter((o) => o.op === 'adopt');
  assert.equal(adopts.length, 18);
  // Data files carry their scaffold; config files and dirs don't.
  for (const a of adopts) {
    if (PROFILE_DATA_FILES.includes(a.canonical)) {
      assert.equal(a.scaffold, TRACKER_SCAFFOLDS[a.canonical], a.canonical);
    } else {
      assert.equal(a.scaffold, null, a.canonical);
    }
    assert.equal(a.to, profileRelPath('career', a.canonical));
  }
  const meta = ops.find((o) => o.op === 'write-meta');
  assert.match(meta.content, /label: "Career search"/);
  assert.match(meta.content, /created: 2026-07-07/);
});

test('planInit defaults the label to the slug', () => {
  const ops = planInit('career', { date: '2026-07-07' });
  const meta = ops.find((o) => o.op === 'write-meta');
  assert.match(meta.content, /label: "career"/);
});

test('planCreate scaffolds the 9 data files + 6 report dirs, never switches', () => {
  const ops = planCreate('second', { label: 'Second', date: '2026-07-07' });
  assert.ok(!ops.some((o) => o.op === 'write-active'), 'create must not touch the active pointer');
  assert.ok(!ops.some((o) => o.op === 'symlink'), 'create must not touch canonical symlinks');
  const scaffolds = ops.filter((o) => o.op === 'scaffold-if-missing');
  assert.deepEqual(scaffolds.map((o) => o.path), PROFILE_DATA_FILES.map((p) => profileRelPath('second', p)));
  const dirOps = ops.filter((o) => o.op === 'ensure-dir').map((o) => o.path);
  for (const d of PROFILE_REPORT_DIRS) {
    assert.ok(dirOps.includes(profileRelPath('second', d)), d);
  }
  assert.ok(!ops.some((o) => o.op === 'copy-if-exists'), 'no --from → no copies');
});

test('planCreate --from copies exactly the 3 config files', () => {
  const ops = planCreate('second', { from: 'career', date: '2026-07-07' });
  const copies = ops.filter((o) => o.op === 'copy-if-exists');
  assert.deepEqual(
    copies.map((o) => [o.from, o.to]),
    PROFILE_CONFIG_FILES.map((p) => [profileRelPath('career', p), profileRelPath('second', p)])
  );
});

test('planEject restores all 18 paths then removes the active pointer LAST', () => {
  const ops = planEject('career');
  assert.equal(ops.length, 19);
  assert.deepEqual(ops[ops.length - 1], { op: 'remove-active' });
  const restores = ops.slice(0, -1);
  assert.ok(restores.every((o) => o.op === 'restore'));
  assert.deepEqual(restores.map((o) => o.linkPath), PROFILE_PATHS);
  for (const o of restores) assert.equal(o.from, profileRelPath('career', o.linkPath));
});

// ── Guards ────────────────────────────────────────────────────────────────

test('evaluateGuards passes on a clean state', () => {
  assert.deepEqual(evaluateGuards({}), []);
  assert.deepEqual(evaluateGuards(), []);
});

test('evaluateGuards flags unmerged addition TSVs with counts', () => {
  const failures = evaluateGuards({
    trackerAdditionTsvs: ['001-a.tsv', '002-b.tsv'],
    scoutingAdditionTsvs: ['003-c.tsv'],
  });
  assert.deepEqual(failures, [
    'unmerged TSVs in batch/tracker-additions (2 files)',
    'unmerged TSVs in batch/scouting-additions (1 file)',
  ]);
});

test('evaluateGuards flags in-flight batch workers, ignores finished rows', () => {
  const rows = [
    { id: '1', status: 'completed' },
    { id: '2', status: 'processing' },
    { id: '3', status: 'failed' },
    { id: '4', status: 'processing' },
    { id: '5', status: 'skipped' },
  ];
  assert.deepEqual(evaluateGuards({ batchStateRows: rows }), [
    'in-flight batch workers in batch/batch-state.tsv (2 processing)',
  ]);
  assert.deepEqual(
    evaluateGuards({ batchStateRows: rows.filter((r) => r.status !== 'processing') }),
    []
  );
});

test('evaluateGuards flags each unmerged JobSpy staging file', () => {
  assert.deepEqual(
    evaluateGuards({ jobspyHistoryStagingPresent: true, jobspyPipelineStagingPresent: true }),
    [
      'unmerged JobSpy staging: data/scan-history.jobspy.tsv',
      'unmerged JobSpy staging: data/pipeline.jobspy.md',
    ]
  );
});

// ── parseBatchStateRows ───────────────────────────────────────────────────

test('parseBatchStateRows parses the batch-runner.sh state format', () => {
  const content =
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
    '1\thttps://x.test/a\tcompleted\t2026-07-07T10:00:00Z\t2026-07-07T10:05:00Z\t001\t7.5\t-\t0\n' +
    '2\thttps://x.test/b\tprocessing\t2026-07-07T10:06:00Z\t-\t002\t-\t-\t0\n';
  assert.deepEqual(parseBatchStateRows(content), [
    { id: '1', status: 'completed' },
    { id: '2', status: 'processing' },
  ]);
});

test('parseBatchStateRows tolerates empty/blank input and missing header', () => {
  assert.deepEqual(parseBatchStateRows(''), []);
  assert.deepEqual(parseBatchStateRows(null), []);
  assert.deepEqual(parseBatchStateRows('\n\n'), []);
  // No header → the runner's fixed layout (id=0, status=2)
  assert.deepEqual(parseBatchStateRows('7\thttps://x\tprocessing\t-\t-\t-\t-\t-\t0'), [
    { id: '7', status: 'processing' },
  ]);
});

// ── countPendingPipelineLines ─────────────────────────────────────────────

test('countPendingPipelineLines counts unchecked URL checkboxes only', () => {
  const md = [
    '# Pipeline — Pending Evaluations',
    '',
    '## Pending',
    '',
    '- [ ] https://x.test/a | ACME | Analyst',
    '- [ ] https://x.test/b | Beta | Associate',
    '- [x] https://x.test/c | Gamma | Done',
    '- [ ] not a url line',
    '',
    '## Processed',
    '- [x] https://x.test/d | Delta | Old',
  ].join('\n');
  assert.equal(countPendingPipelineLines(md), 2);
  assert.equal(countPendingPipelineLines(''), 0);
  assert.equal(countPendingPipelineLines(null), 0);
});

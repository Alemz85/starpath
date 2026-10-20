import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, archiveFileName, numOfFileName, normalizeUrl, parseReport, trackerNumbers,
  formatArchive, parseArchive, buildArchiveIndex, findArchive, auditReports,
  parseUnrecoverable, formatUnrecoverableLine, unrecoverableKey, tierOfReportPath,
} from './jd-archive-core.mjs';

const REPORT = (company, role, url, extra = '') => `# Scouting: ${company} — ${role}

**Date:** 2026-10-01
**Tier:** T1
**URL:** ${url}
${extra}
## Eligibility
`;

test('slugify folds accents, drops punctuation and caps on a word edge', () => {
  assert.equal(slugify('Nimbus Robotics & Co.'), 'nimbus-robotics-and-co');
  assert.equal(slugify('Chargé d’affaires (Lyon)'), 'charge-d-affaires-lyon');
  assert.ok(slugify('a'.repeat(30) + ' ' + 'b'.repeat(60)).length <= 60);
  assert.equal(slugify(''), '');
});

test('archiveFileName pads the number and falls back to the slugs alone', () => {
  assert.equal(archiveFileName({ num: 7, company: 'Nimbus Robotics', role: 'Data Analyst' }), '007-nimbus-robotics-data-analyst.md');
  assert.equal(archiveFileName({ num: 1234, company: 'A', role: 'B' }), '1234-a-b.md');
  assert.equal(archiveFileName({ num: null, company: 'A', role: 'B' }), 'a-b.md');
  assert.equal(numOfFileName('007-x.md'), 7);
  assert.equal(numOfFileName('x-007.md'), null);
});

test('normalizeUrl ignores tracking params, hash, case of host and trailing slash', () => {
  const a = normalizeUrl('https://Jobs.Example.com/roles/42/?utm_source=x&gh_src=y#apply');
  assert.equal(a, 'jobs.example.com/roles/42');
  assert.equal(normalizeUrl('https://jobs.example.com/roles/42'), a);
  assert.notEqual(normalizeUrl('https://jobs.example.com/roles/43'), a);
  assert.equal(normalizeUrl('—'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
});

test('parseReport reads the title, URL and date; falls back to the file name', () => {
  const r = parseReport(REPORT('Nimbus Robotics', 'Data Analyst', 'https://jobs.example.com/1'), 'reports/tier-1/x.md');
  assert.deepEqual(r, { company: 'Nimbus Robotics', role: 'Data Analyst', url: 'https://jobs.example.com/1', date: '2026-10-01' });
  const g = parseReport('# Gap & Growth: Contoso — Analyst\n**URL:** —\n', 'reports/tier-3/x.md');
  assert.equal(g.company, 'Contoso');
  assert.equal(g.url, '');
  const f = parseReport('no title here', 'reports/tier-2/Fabrikam Energy - Ops Analyst.md');
  assert.equal(f.company, 'Fabrikam Energy');
  assert.equal(f.role, 'Ops Analyst');
});

test('trackerNumbers maps decoded report paths to row numbers, # prefix allowed', () => {
  const map = trackerNumbers([
    '| 12 | 2026-10-01 | A | B | 8 | 7 | T1 | green | [12](reports/tier-1/Nimbus Robotics - Data Analyst.md) | n/d |',
    '| 5 | 2026-10-01 | A | B | W8 E7 | Evaluated | ❌ | n/d | [#5](reports/tier-2/Tailspin%20Toys%20-%20Analyst.md) | |',
    '| 6 | x | [6](—) |',
  ]);
  assert.equal(map.get('reports/tier-1/Nimbus Robotics - Data Analyst.md'), 12);
  assert.equal(map.get('reports/tier-2/Tailspin Toys - Analyst.md'), 5);
  assert.equal(map.size, 2);
});

test('formatArchive / parseArchive round-trip, body kept verbatim', () => {
  const body = '## About the role\n\nYou will build *things*.\n\n- one\n- two\n\n---\n\nA rule inside the posting.';
  const text = formatArchive({ company: 'Nimbus Robotics', role: 'Data Analyst', url: 'https://jobs.example.com/1', fetched: '2026-10-20', source: 'worker', body });
  const p = parseArchive(text);
  assert.equal(p.structured, true);
  assert.equal(p.company, 'Nimbus Robotics');
  assert.equal(p.url, 'https://jobs.example.com/1');
  assert.equal(p.fetched, '2026-10-20');
  assert.equal(p.source, 'worker');
  assert.equal(p.body, body + '\n');
});

test('parseArchive keeps a legacy hand-saved file whole and reads its URL', () => {
  const legacy = '# Join Fabrikam\n\nCompany: Fabrikam\nURL: https://careers.example.com/jobs/9\nStatus: CLOSED\n\n> saved verbatim\n\nText.\n';
  const p = parseArchive(legacy);
  assert.equal(p.structured, false);
  assert.equal(p.url, 'https://careers.example.com/jobs/9');
  assert.equal(p.body, legacy);
});

test('findArchive: number (padded or not), then URL, then slug', () => {
  const files = [
    { name: '012-nimbus-robotics-data-analyst.md', head: formatArchive({ url: 'https://a.example.com/1', fetched: '2026-10-01', body: 'x' }) },
    { name: 'fabrikam-old-name.md', head: 'URL: https://careers.example.com/jobs/9\n' },
    { name: 'contoso-ops-analyst.md', head: '# nothing\n' },
  ];
  const idx = buildArchiveIndex(files);
  assert.deepEqual(findArchive({ num: 12 }, idx), { name: '012-nimbus-robotics-data-analyst.md', how: 'number' });
  assert.deepEqual(findArchive({ num: '012' }, idx), { name: '012-nimbus-robotics-data-analyst.md', how: 'number' });
  assert.deepEqual(findArchive({ num: 99, url: 'https://careers.example.com/jobs/9/?utm_source=z' }, idx), { name: 'fabrikam-old-name.md', how: 'url' });
  assert.deepEqual(findArchive({ num: 99, company: 'Contoso', role: 'Ops Analyst' }, idx), { name: 'contoso-ops-analyst.md', how: 'slug' });
  assert.equal(findArchive({ num: 99, company: 'Other', role: 'Role', url: 'https://x.example.com/' }, idx), null);
});

test('auditReports covers T1–T3 only and separates archived, missing and unrecoverable', () => {
  const reports = [
    { path: 'reports/tier-1/Nimbus Robotics - Data Analyst.md', text: REPORT('Nimbus Robotics', 'Data Analyst', 'https://jobs.example.com/1') },
    { path: 'reports/tier-2/Tailspin Toys - Analyst.md', text: REPORT('Tailspin Toys', 'Analyst', 'https://jobs.example.com/2') },
    { path: 'reports/tier-3/Contoso - Ops.md', text: REPORT('Contoso', 'Ops', 'https://jobs.example.com/3') },
    { path: 'reports/tier-4/Skipped - Role.md', text: REPORT('Skipped', 'Role', 'https://jobs.example.com/4') },
    { path: 'reports/tier-1/.history/Nimbus Robotics - Data Analyst.2026-09-01.md', text: REPORT('Nimbus Robotics', 'Data Analyst', 'https://jobs.example.com/1') },
    { path: 'reports/positioning/2026.md', text: '# positioning' },
  ];
  const trackers = [
    '| 1 | d | Nimbus Robotics | Data Analyst | [1](reports/tier-1/Nimbus Robotics - Data Analyst.md) |',
    '| 2 | d | Tailspin Toys | Analyst | [2](reports/tier-2/Tailspin Toys - Analyst.md) |',
    '| 3 | d | Contoso | Ops | [3](reports/tier-3/Contoso - Ops.md) |',
  ];
  const archive = [{ name: '001-nimbus-robotics-data-analyst.md', head: '' }];
  const unrecoverable = parseUnrecoverable(formatUnrecoverableLine({ date: '2026-10-20', key: '003', url: 'https://jobs.example.com/3', reason: 'HTTP 404' }));
  const { rows, counts } = auditReports({ reports, trackers, archive, unrecoverable });
  assert.deepEqual(counts, { total: 3, archived: 1, missing: 1, unrecoverable: 1 });
  assert.deepEqual(rows.map((r) => [r.num, r.status]), [[1, 'archived'], [2, 'missing'], [3, 'unrecoverable']]);
  assert.equal(rows[1].expected, '002-tailspin-toys-analyst.md');
  assert.equal(rows[2].reason, 'HTTP 404');
});

test('a report without a tracker row is audited by URL/slug and keyed by its path', () => {
  const path = 'reports/tier-2/Fabrikam Energy - Analyst.md';
  const text = REPORT('Fabrikam Energy', 'Analyst', 'https://jobs.example.com/7');
  const miss = auditReports({ reports: [{ path, text }], trackers: [], archive: [] });
  assert.equal(miss.rows[0].num, null);
  assert.equal(miss.rows[0].expected, 'fabrikam-energy-analyst.md');
  assert.equal(unrecoverableKey({ num: null, path }), path);
  const hit = auditReports({ reports: [{ path, text }], trackers: [], archive: [{ name: 'fabrikam-energy-analyst.md', head: '' }] });
  assert.equal(hit.rows[0].status, 'archived');
});

test('tierOfReportPath', () => {
  assert.equal(tierOfReportPath('reports/tier-3/x.md'), 3);
  assert.equal(tierOfReportPath('reports/positioning/x.md'), null);
});

test('unrecoverable log: latest line per key wins; tabs and newlines in fields are flattened', () => {
  const text = [
    formatUnrecoverableLine({ date: '2026-10-01', key: '004', url: 'https://x.example.com/', reason: 'HTTP 404' }),
    formatUnrecoverableLine({ date: '2026-10-02', key: '004', url: 'https://x.example.com/', reason: 'the page\tsays\nclosed' }),
  ].join('\n');
  const map = parseUnrecoverable(text);
  assert.equal(map.get('004').date, '2026-10-02');
  assert.equal(map.get('004').reason, 'the page says closed');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownLinks, normalizeReportPath, reportLinkTarget } from './report-link.mjs';

test('plain link', () => {
  assert.equal(reportLinkTarget('[12](reports/tier-1/Nimbus Robotics - Data Analyst.md)'), 'reports/tier-1/Nimbus Robotics - Data Analyst.md');
});

test('percent-encoded link is decoded', () => {
  assert.equal(
    reportLinkTarget('[12](reports/tier-2/Nimbus%20Robotics%20-%20Data%20Analyst%20%28Lyon%29.md)'),
    'reports/tier-2/Nimbus Robotics - Data Analyst (Lyon).md',
  );
});

test('literal parentheses in the target', () => {
  assert.equal(
    reportLinkTarget('[12](reports/tier-2/Nimbus Robotics - Data Analyst (Lyon, autumn start).md)'),
    'reports/tier-2/Nimbus Robotics - Data Analyst (Lyon, autumn start).md',
  );
});

test('angle-bracket target and backslashes', () => {
  assert.equal(reportLinkTarget('[3](<./reports\\tier-1\\A - B (C).md>)'), 'reports/tier-1/A - B (C).md');
});

test('no .md link gives null', () => {
  assert.equal(reportLinkTarget('—'), null);
  assert.equal(reportLinkTarget(''), null);
  assert.equal(reportLinkTarget(undefined), null);
  assert.equal(reportLinkTarget('[x](https://example.com/page)'), null);
  assert.equal(reportLinkTarget('[x](reports/broken (open.md'), null);
});

test('a malformed percent sequence stays as written', () => {
  assert.equal(normalizeReportPath('reports/100%.md'), 'reports/100%.md');
});

test('markdownLinks finds several links with labels', () => {
  const links = markdownLinks('see [#1](reports/a (x).md) and [#2](reports/b.md).');
  assert.deepEqual(links, [
    { label: '#1', target: 'reports/a (x).md' },
    { label: '#2', target: 'reports/b.md' },
  ]);
});

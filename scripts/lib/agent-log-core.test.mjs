// Unit tests for scripts/lib/agent-log-core.mjs
//
// Plain node:test + node:assert, zero external deps.
// Run: node --test scripts/lib/agent-log-core.test.mjs
//       (or `npm test` which runs `node --test "scripts/**/*.test.mjs"`)
//
// Coverage:
//   escapeField/unescapeField — round trip for tabs, newlines, backslashes
//   parseRows                 — empty/missing content, header-only, malformed
//                                rows, unescaping on read
//   serializeRow/serializeAll — round trip through parseRows
//   nextId                    — empty → 1, else max+1
//   buildEntry                — default severity fallback
//   filterRows                — unresolved, category, combined
//   sortNewestFirst           — id-desc
//   limitRows                 — positive/zero/negative/non-numeric
//   computeCounts             — grouping + most-repeated-first ordering
//   resolveRow                — known id, unknown id, note handling
//   renderList/renderCounts   — empty placeholder + table formatting/escaping

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  SEVERITIES,
  DEFAULT_SEVERITY,
  HEADER,
  escapeField,
  unescapeField,
  parseRows,
  serializeRow,
  serializeAll,
  nextId,
  buildEntry,
  filterRows,
  sortNewestFirst,
  limitRows,
  computeCounts,
  resolveRow,
  renderList,
  renderCounts,
} from './agent-log-core.mjs';

/* ───── escaping ─────────────────────────────────────────────────────────*/

test('escapeField/unescapeField: round-trips tabs, newlines, backslashes', () => {
  const cases = [
    'plain text',
    'has\ttab',
    'has\nnewline',
    'has\r\nCRLF',
    'back\\slash',
    'mix\t\\n literal\nreal',
    '',
  ];
  for (const original of cases) {
    const escaped = escapeField(original);
    assert.ok(!escaped.includes('\t'), `escaped form has no raw tab: ${JSON.stringify(escaped)}`);
    assert.ok(!escaped.includes('\n'), `escaped form has no raw newline: ${JSON.stringify(escaped)}`);
    const roundTripped = unescapeField(escaped);
    const normalizedOriginal = original.replace(/\r\n/g, '\n');
    assert.equal(roundTripped, normalizedOriginal);
  }
});

test('escapeField: nullish → empty string', () => {
  assert.equal(escapeField(null), '');
  assert.equal(escapeField(undefined), '');
});

test('unescapeField: nullish → empty string', () => {
  assert.equal(unescapeField(null), '');
  assert.equal(unescapeField(undefined), '');
});

/* ───── parse / serialize ────────────────────────────────────────────────*/

test('parseRows: missing/empty content → []', () => {
  assert.deepEqual(parseRows(''), []);
  assert.deepEqual(parseRows(undefined), []);
  assert.deepEqual(parseRows(null), []);
});

test('parseRows: header-only content → []', () => {
  assert.deepEqual(parseRows(HEADER + '\n'), []);
});

test('parseRows: skips malformed rows (too few columns, non-numeric id)', () => {
  const content = [
    HEADER,
    'not-a-number\t2026-08-18T00:00:00.000Z\tschema\tsubj\tmed\tmsg\topen\t\t',
    '1\t2026-08-18T00:00:00.000Z\tschema\tsubj', // too few columns
    '2\t2026-08-18T00:00:00.000Z\tschema\tsubj\tmed\tmsg\topen\t\t',
  ].join('\n');
  const rows = parseRows(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 2);
});

test('parseRows: unescapes subject/message/resolution_note on read', () => {
  const row = {
    id: 1,
    timestamp: '2026-08-18T00:00:00.000Z',
    category: 'data',
    subject: 'file with\ttab and\nnewline',
    severity: 'high',
    message: 'message with\ttab',
    status: 'resolved',
    resolvedAt: '2026-08-18T01:00:00.000Z',
    resolutionNote: 'note with\nnewline',
  };
  const content = HEADER + '\n' + serializeRow(row) + '\n';
  const [parsed] = parseRows(content);
  assert.equal(parsed.subject, row.subject);
  assert.equal(parsed.message, row.message);
  assert.equal(parsed.resolutionNote, row.resolutionNote);
  assert.equal(parsed.status, 'resolved');
  assert.equal(parsed.resolvedAt, row.resolvedAt);
});

test('serializeRow/serializeAll: round-trips through parseRows', () => {
  const rows = [
    buildEntry({ id: 1, timestamp: 't1', category: 'schema', subject: 'a\tb', severity: 'low', message: 'm1\nline2' }),
    buildEntry({ id: 2, timestamp: 't2', category: 'url', subject: 'c', severity: 'high', message: 'm2' }),
  ];
  const content = serializeAll(rows);
  assert.ok(content.startsWith(HEADER + '\n'));
  const parsed = parseRows(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].subject, 'a\tb');
  assert.equal(parsed[0].message, 'm1\nline2');
  assert.equal(parsed[1].category, 'url');
});

/* ───── nextId / buildEntry ──────────────────────────────────────────────*/

test('nextId: empty rows → 1', () => {
  assert.equal(nextId([]), 1);
});

test('nextId: max id + 1, regardless of array order', () => {
  assert.equal(nextId([{ id: 3 }, { id: 1 }, { id: 7 }, { id: 2 }]), 8);
});

test('buildEntry: fills status=open and blank resolution fields', () => {
  const e = buildEntry({ id: 1, timestamp: 't', category: 'schema', subject: 's', severity: 'high', message: 'm' });
  assert.equal(e.status, 'open');
  assert.equal(e.resolvedAt, '');
  assert.equal(e.resolutionNote, '');
});

test('buildEntry: falls back to DEFAULT_SEVERITY when severity is falsy', () => {
  const e = buildEntry({ id: 1, timestamp: 't', category: 'schema', subject: 's', severity: '', message: 'm' });
  assert.equal(e.severity, DEFAULT_SEVERITY);
  assert.equal(DEFAULT_SEVERITY, 'med');
});

test('CATEGORIES/SEVERITIES export the documented enums', () => {
  assert.deepEqual(CATEGORIES, ['schema', 'data', 'url', 'rubric', 'other']);
  assert.deepEqual(SEVERITIES, ['low', 'med', 'high']);
});

/* ───── filter / sort / limit ────────────────────────────────────────────*/

const SAMPLE_ROWS = [
  { id: 1, category: 'schema', subject: 'foo', status: 'open' },
  { id: 2, category: 'data', subject: 'bar', status: 'resolved' },
  { id: 3, category: 'schema', subject: 'foo', status: 'open' },
  { id: 4, category: 'url', subject: 'baz', status: 'open' },
];

test('filterRows: unresolved-only', () => {
  const out = filterRows(SAMPLE_ROWS, { unresolved: true });
  assert.deepEqual(out.map((r) => r.id), [1, 3, 4]);
});

test('filterRows: category filter', () => {
  const out = filterRows(SAMPLE_ROWS, { category: 'schema' });
  assert.deepEqual(out.map((r) => r.id), [1, 3]);
});

test('filterRows: combined unresolved + category', () => {
  const out = filterRows(SAMPLE_ROWS, { unresolved: true, category: 'schema' });
  assert.deepEqual(out.map((r) => r.id), [1, 3]);
});

test('filterRows: no filters returns everything', () => {
  assert.equal(filterRows(SAMPLE_ROWS, {}).length, 4);
});

test('sortNewestFirst: id descending, does not mutate input', () => {
  const input = [{ id: 1 }, { id: 3 }, { id: 2 }];
  const out = sortNewestFirst(input);
  assert.deepEqual(out.map((r) => r.id), [3, 2, 1]);
  assert.deepEqual(input.map((r) => r.id), [1, 3, 2]); // unchanged
});

test('limitRows: positive n caps the array', () => {
  assert.equal(limitRows([1, 2, 3, 4], 2).length, 2);
});

test('limitRows: zero/negative/non-numeric returns all rows', () => {
  assert.equal(limitRows([1, 2, 3], 0).length, 3);
  assert.equal(limitRows([1, 2, 3], -1).length, 3);
  assert.equal(limitRows([1, 2, 3], null).length, 3);
  assert.equal(limitRows([1, 2, 3], 'nope').length, 3);
});

/* ───── computeCounts ────────────────────────────────────────────────────*/

test('computeCounts: groups by (category, subject), counts total/open', () => {
  const rows = [
    { category: 'schema', subject: 'x', status: 'open' },
    { category: 'schema', subject: 'x', status: 'resolved' },
    { category: 'schema', subject: 'x', status: 'open' },
    { category: 'data', subject: 'y', status: 'open' },
  ];
  const counts = computeCounts(rows);
  assert.equal(counts.length, 2);
  const x = counts.find((c) => c.subject === 'x');
  assert.equal(x.total, 3);
  assert.equal(x.open, 2);
});

test('computeCounts: most-repeated first, ties broken alphabetically', () => {
  const rows = [
    { category: 'url', subject: 'z', status: 'open' },
    { category: 'data', subject: 'a', status: 'open' },
    { category: 'data', subject: 'a', status: 'open' },
    { category: 'data', subject: 'b', status: 'open' },
    { category: 'data', subject: 'b', status: 'open' },
  ];
  const counts = computeCounts(rows);
  // 'a' and 'b' both total 2, 'z' totals 1 → a, b, z (alpha tiebreak, then total desc)
  assert.deepEqual(counts.map((c) => c.subject), ['a', 'b', 'z']);
});

test('computeCounts: empty input → []', () => {
  assert.deepEqual(computeCounts([]), []);
});

/* ───── resolveRow ───────────────────────────────────────────────────────*/

test('resolveRow: resolves a known id, sets resolvedAt and note', () => {
  const rows = [
    buildEntry({ id: 1, timestamp: 't1', category: 'schema', subject: 's', severity: 'med', message: 'm' }),
    buildEntry({ id: 2, timestamp: 't2', category: 'data', subject: 's2', severity: 'med', message: 'm2' }),
  ];
  const { rows: next, found } = resolveRow(rows, 1, { note: 'fixed it', timestamp: 'RESOLVED_AT' });
  assert.equal(found, true);
  assert.equal(next[0].status, 'resolved');
  assert.equal(next[0].resolvedAt, 'RESOLVED_AT');
  assert.equal(next[0].resolutionNote, 'fixed it');
  assert.equal(next[1].status, 'open'); // untouched
});

test('resolveRow: unknown id → found:false, rows unchanged', () => {
  const rows = [buildEntry({ id: 1, timestamp: 't1', category: 'schema', subject: 's', severity: 'med', message: 'm' })];
  const { rows: next, found } = resolveRow(rows, 999, { timestamp: 'X' });
  assert.equal(found, false);
  assert.deepEqual(next, rows);
});

test('resolveRow: id passed as a numeric string works (CLI positional args are strings)', () => {
  const rows = [buildEntry({ id: 5, timestamp: 't', category: 'schema', subject: 's', severity: 'med', message: 'm' })];
  const { found } = resolveRow(rows, '5', { timestamp: 'X' });
  assert.equal(found, true);
});

test('resolveRow: omitted note keeps the prior resolutionNote', () => {
  const rows = [{ ...buildEntry({ id: 1, timestamp: 't', category: 'schema', subject: 's', severity: 'med', message: 'm' }), resolutionNote: 'prior note' }];
  const { rows: next } = resolveRow(rows, 1, { timestamp: 'X' });
  assert.equal(next[0].resolutionNote, 'prior note');
});

/* ───── rendering ─────────────────────────────────────────────────────────*/

test('renderList: empty → placeholder string', () => {
  assert.equal(renderList([]), '_no agent-log entries_');
});

test('renderList: renders a markdown table and escapes pipes/newlines in cells', () => {
  const rows = [
    { id: 1, timestamp: 't1', category: 'schema', subject: 'a|b', severity: 'high', message: 'line1\nline2', status: 'open' },
  ];
  const out = renderList(rows);
  assert.match(out, /\| id \| timestamp \| category \| subject \| severity \| message \| status \|/);
  assert.match(out, /a\\\|b/);
  assert.ok(!out.includes('line1\nline2'));
});

test('renderCounts: empty → placeholder string', () => {
  assert.equal(renderCounts([]), '_no agent-log entries_');
});

test('renderCounts: renders a markdown table', () => {
  const out = renderCounts([{ category: 'schema', subject: 'x', total: 3, open: 2 }]);
  assert.match(out, /\| category \| subject \| total \| open \|/);
  assert.match(out, /\| schema \| x \| 3 \| 2 \|/);
});

// Unit tests for scripts/lib/session-handoff-core.mjs
//
// Plain node:test + node:assert, zero external deps.
// Run: node --test scripts/lib/session-handoff-core.test.mjs
//       (or `npm test` which runs `node --test "scripts/**/*.test.mjs"`)
//
// Coverage:
//   validateSlug     — valid kebab-case, invalid shapes, missing
//   parseEntries     — empty/missing content, single/multiple entries,
//                      guard against body lines that merely start with "## "
//   nextId           — empty → 1, else max+1
//   renderEntry/appendEntry — round trip through parseEntries, first-write
//                             vs. append-to-existing separator handling
//   firstBodyLine    — first non-blank line, blank body
//   renderCompactList — empty placeholder + compact one-liners

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_READ_LIMIT,
  validateSlug,
  parseEntries,
  nextId,
  renderEntry,
  appendEntry,
  firstBodyLine,
  renderCompactList,
} from './session-handoff-core.mjs';

/* ───── validateSlug ─────────────────────────────────────────────────────*/

test('validateSlug: accepts lowercase kebab-case', () => {
  assert.equal(validateSlug('foo-bar-42').valid, true);
  assert.equal(validateSlug('foo').valid, true);
});

test('validateSlug: rejects missing/empty/non-string', () => {
  assert.equal(validateSlug(null).valid, false);
  assert.equal(validateSlug(undefined).valid, false);
  assert.equal(validateSlug('').valid, false);
});

test('validateSlug: rejects uppercase, spaces, underscores, leading/trailing hyphen', () => {
  for (const bad of ['Foo-Bar', 'foo bar', 'foo_bar', '-foo', 'foo-', 'foo--bar']) {
    assert.equal(validateSlug(bad).valid, false, `expected "${bad}" to be invalid`);
  }
});

test('validateSlug: rejection reason names the bad slug', () => {
  const r = validateSlug('Bad Slug');
  assert.match(r.reason, /kebab-case/);
});

/* ───── parseEntries ─────────────────────────────────────────────────────*/

test('parseEntries: missing/empty content → []', () => {
  assert.deepEqual(parseEntries(''), []);
  assert.deepEqual(parseEntries(undefined), []);
  assert.deepEqual(parseEntries(null), []);
});

test('parseEntries: single entry, heading + body', () => {
  const content = '## 1 · 2026-08-18T10:00:00.000Z · fix-scan-bug\n\nRan into a schema drift.\nLeft it for next session.\n';
  const entries = parseEntries(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 1);
  assert.equal(entries[0].timestamp, '2026-08-18T10:00:00.000Z');
  assert.equal(entries[0].slug, 'fix-scan-bug');
  assert.equal(entries[0].body, 'Ran into a schema drift.\nLeft it for next session.');
});

test('parseEntries: multiple entries in file order', () => {
  const content = [
    '## 1 · 2026-08-18T10:00:00.000Z · first-thread',
    '',
    'body one',
    '',
    '## 2 · 2026-08-18T11:00:00.000Z · second-thread',
    '',
    'body two',
    '',
  ].join('\n');
  const entries = parseEntries(content);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.id), [1, 2]);
  assert.equal(entries[0].body, 'body one');
  assert.equal(entries[1].body, 'body two');
});

test('parseEntries: guards against body lines that merely start with "## " but are not real headings', () => {
  const content = [
    '## 1 · 2026-08-18T10:00:00.000Z · real-thread',
    '',
    'Some notes.',
    '## Not a real entry heading',
    '## 2 · not-a-timestamp · also-fake',
    'More notes after the fake headings.',
  ].join('\n');
  const entries = parseEntries(content);
  assert.equal(entries.length, 1, 'fake "## " lines must not split into new entries');
  assert.match(entries[0].body, /Not a real entry heading/);
  assert.match(entries[0].body, /also-fake/);
  assert.match(entries[0].body, /More notes after the fake headings\./);
});

test('parseEntries: trims leading/trailing blank lines from the body but keeps internal blanks', () => {
  const content = '## 1 · 2026-08-18T10:00:00.000Z · slug\n\n\nline1\n\nline2\n\n\n';
  const entries = parseEntries(content);
  assert.equal(entries[0].body, 'line1\n\nline2');
});

/* ───── nextId ────────────────────────────────────────────────────────────*/

test('nextId: empty entries → 1', () => {
  assert.equal(nextId([]), 1);
});

test('nextId: max id + 1', () => {
  assert.equal(nextId([{ id: 2 }, { id: 5 }, { id: 1 }]), 6);
});

/* ───── renderEntry / appendEntry round trip ──────────────────────────────*/

test('renderEntry: produces a heading parseable back into the same entry', () => {
  const entry = { id: 3, timestamp: '2026-08-18T12:00:00.000Z', slug: 'my-thread', body: 'line1\nline2' };
  const rendered = renderEntry(entry);
  const [parsed] = parseEntries(rendered + '\n');
  assert.deepEqual(parsed, entry);
});

test('appendEntry: first write on empty content', () => {
  const entry = { id: 1, timestamp: '2026-08-18T10:00:00.000Z', slug: 'first', body: 'hello' };
  const content = appendEntry('', entry);
  const entries = parseEntries(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'first');
});

test('appendEntry: appends to existing content, both entries parse back correctly', () => {
  const first = { id: 1, timestamp: '2026-08-18T10:00:00.000Z', slug: 'first', body: 'hello' };
  const second = { id: 2, timestamp: '2026-08-18T11:00:00.000Z', slug: 'second', body: 'world\nmore text' };
  let content = appendEntry('', first);
  content = appendEntry(content, second);
  const entries = parseEntries(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].body, 'hello');
  assert.equal(entries[1].body, 'world\nmore text');
});

test('appendEntry: is idempotent-safe regardless of trailing whitespace on existing content', () => {
  const first = { id: 1, timestamp: '2026-08-18T10:00:00.000Z', slug: 'first', body: 'hello' };
  const second = { id: 2, timestamp: '2026-08-18T11:00:00.000Z', slug: 'second', body: 'world' };
  const withTrailingNewlines = appendEntry('', first) + '\n\n\n';
  const content = appendEntry(withTrailingNewlines, second);
  const entries = parseEntries(content);
  assert.equal(entries.length, 2);
});

/* ───── firstBodyLine ────────────────────────────────────────────────────*/

test('firstBodyLine: returns the first non-blank line, trimmed', () => {
  assert.equal(firstBodyLine('\n\n  first real line  \nsecond'), 'first real line');
});

test('firstBodyLine: blank/empty body → ""', () => {
  assert.equal(firstBodyLine(''), '');
  assert.equal(firstBodyLine('\n\n\n'), '');
  assert.equal(firstBodyLine(null), '');
});

/* ───── renderCompactList ────────────────────────────────────────────────*/

test('renderCompactList: empty → placeholder string', () => {
  assert.equal(renderCompactList([]), '_no session handoffs recorded yet_');
});

test('renderCompactList: one line per entry with id, timestamp, slug, first body line', () => {
  const entries = [
    { id: 1, timestamp: '2026-08-18T10:00:00.000Z', slug: 'foo', body: 'first line\nsecond line' },
  ];
  const out = renderCompactList(entries);
  assert.equal(out, '1 · 2026-08-18T10:00:00.000Z · foo — first line');
});

test('renderCompactList: empty body renders the (empty) marker', () => {
  const entries = [{ id: 1, timestamp: 't', slug: 'foo', body: '' }];
  const out = renderCompactList(entries);
  assert.match(out, /\(empty\)$/);
});

/* ───── DEFAULT_READ_LIMIT sanity ────────────────────────────────────────*/

test('DEFAULT_READ_LIMIT is a small positive integer', () => {
  assert.ok(Number.isInteger(DEFAULT_READ_LIMIT));
  assert.ok(DEFAULT_READ_LIMIT > 0);
});

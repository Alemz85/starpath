// Unit tests for scripts/lib/career-bank.mjs.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveCareerBank,
  CAREER_BANK_PATH,
  LEGACY_CAREER_BANK_PATH,
  CAREER_BANK_RENAME_FIX,
} from './career-bank.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'career-bank-'));
  mkdirSync(join(root, 'user'));
  for (const rel of files) writeFileSync(join(root, rel), '# bank\n');
  return root;
}

test('new name wins when both files exist', () => {
  const root = fixture([CAREER_BANK_PATH, LEGACY_CAREER_BANK_PATH]);
  try {
    const r = resolveCareerBank(root);
    assert.equal(r.rel, 'user/career-bank.md');
    assert.equal(r.path, join(root, 'user/career-bank.md'));
    assert.equal(r.legacy, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new name alone resolves, not legacy', () => {
  const root = fixture([CAREER_BANK_PATH]);
  try {
    const r = resolveCareerBank(root);
    assert.equal(r.rel, CAREER_BANK_PATH);
    assert.equal(r.legacy, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('old name is used when only it exists', () => {
  const root = fixture([LEGACY_CAREER_BANK_PATH]);
  try {
    const r = resolveCareerBank(root);
    assert.equal(r.rel, 'user/article-digest.md');
    assert.equal(r.path, join(root, 'user/article-digest.md'));
    assert.equal(r.legacy, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('neither file → nulls, same as a missing file today', () => {
  const root = fixture([]);
  try {
    assert.deepEqual(resolveCareerBank(root), { rel: null, path: null, legacy: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exists is injectable', () => {
  const seen = [];
  const r = resolveCareerBank('/r', { exists: (p) => { seen.push(p); return p.endsWith('article-digest.md'); } });
  assert.equal(r.legacy, true);
  assert.deepEqual(seen, [join('/r', CAREER_BANK_PATH), join('/r', LEGACY_CAREER_BANK_PATH)]);
});

test('rename fix is the one-line mv', () => {
  assert.equal(CAREER_BANK_RENAME_FIX, 'mv user/article-digest.md user/career-bank.md');
});

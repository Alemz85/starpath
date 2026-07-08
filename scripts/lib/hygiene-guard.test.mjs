/**
 * hygiene-guard.test.mjs — Unit tests for the personal-data hygiene guard
 *
 * Tests the pure functions: extractPersonalData (with mock paths), buildPatterns,
 * and the scanner logic with synthetic files — no filesystem scanning of the real
 * codebase (the CLI integration test in test-all.mjs covers that).
 *
 * Run: node --test scripts/lib/hygiene-guard.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildPatterns, runHygieneGuard } from './hygiene-guard.mjs';

// ── Synthetic personal data for testing ─────────────────────────────────────

const MOCK_PD = {
  fullName: 'Jane Testuser',
  firstName: 'Jane',
  lastName: 'Testuser',
  email: 'jane@example.test',
  phone: '+1 555 123 4567',
  phoneDigits: '15551234567',
  nationality: 'Canada',
  schools: ['Testford Business School', 'Generic University'],
  employers: ['Acme Corp', 'Beta Consulting'],
  projectNames: ['Testford Capstone'],
  graduationDates: ['June 2025', 'Jun 2025', 'September 2026', 'Sep 2026'],
};

// ── buildPatterns ─────────────────────────────────────────────────────────────

describe('buildPatterns', () => {
  it('generates a pattern for full name', () => {
    const pats = buildPatterns(MOCK_PD);
    const p = pats.find(x => x.id === 'full_name');
    assert.ok(p, 'full_name pattern exists');
    assert.ok(p.regex.test('Jane Testuser applied'), 'matches full name');
    assert.ok(!p.regex.test('Jane Smith applied'), 'does not match first name alone');
  });

  it('generates a pattern for email', () => {
    const pats = buildPatterns(MOCK_PD);
    const p = pats.find(x => x.id === 'email');
    assert.ok(p, 'email pattern exists');
    assert.ok(p.regex.test('contact jane@example.test for info'), 'matches email');
    assert.ok(!p.regex.test('contact you@other.example for info'), 'does not match other email');
  });

  it('generates phone_full pattern', () => {
    const pats = buildPatterns(MOCK_PD);
    const p = pats.find(x => x.id === 'phone_full');
    assert.ok(p, 'phone_full pattern exists');
    assert.ok(p.regex.test('+1 555 123 4567'), 'matches full phone');
  });

  it('generates phone_partial pattern matching last 9 digits in various formats', () => {
    const pats = buildPatterns(MOCK_PD);
    const p = pats.find(x => x.id === 'phone_partial');
    assert.ok(p, 'phone_partial pattern exists');
    // "5551234567" — last 9 digits of "15551234567" is "551234567"
    assert.ok(p.regex.test('555 123 4567'), 'matches spaced phone format');
    assert.ok(p.regex.test('555-123-4567'), 'matches dashed phone format');
    assert.ok(!p.regex.test('555 987 6543'), 'does not match different number');
  });

  it('generates school proximity patterns only flagging user-addressed prose', () => {
    const pats = buildPatterns(MOCK_PD);
    const schoolPat = pats.find(x => x.id && x.id.startsWith('school_prose_testford'));
    assert.ok(schoolPat, 'school pattern exists');

    // Should match: "you finish the Testford Business School degree in Oct 2026"
    const flaggedLine = 'you finish the Testford Business School MSc';
    assert.ok(schoolPat.regex.test(flaggedLine), 'flags school near "you"');

    // Should NOT match: school in a reference table / list context
    const tableLine = '| **Testford Business School** | Spain | Italy | Yes |';
    assert.ok(!schoolPat.regex.test(tableLine), 'does not flag school in table row (no "you/your")');
  });

  it('generates grad_date patterns for both full and abbreviated month forms', () => {
    const pats = buildPatterns(MOCK_PD);
    // Should have patterns for both "June 2025" and "Jun 2025"
    const juneFull = pats.find(x => x.id === 'grad_date_june_2025');
    const juneAbbr = pats.find(x => x.id === 'grad_date_jun_2025');
    assert.ok(juneFull, 'full month grad_date pattern exists');
    assert.ok(juneAbbr, 'abbreviated month grad_date pattern exists');
  });

  it('graduation date pattern flags user-addressed prose with school', () => {
    const pats = buildPatterns(MOCK_PD);
    const p = pats.find(x => x.id === 'grad_date_sep_2026');
    assert.ok(p, 'Sep 2026 pattern exists');
    const flaggedLine = 'you finish the Testford Business School MSc in Sep 2026';
    assert.ok(p.regex.test(flaggedLine), 'flags date near school in second-person prose');
  });

  it('graduation date pattern does NOT flag code comments with month+year', () => {
    const pats = buildPatterns(MOCK_PD);
    // This simulates the entityId.ts false positive we fixed
    const commentLine = '// year suffixes: "(2025-2026)", "Spring 2026", "Start September 2026", "2026"';
    const p = pats.find(x => x.id === 'grad_date_sep_2026');
    // The comment has "September 2026" but not near "you finish" / school names
    assert.ok(!p || !p.regex.test(commentLine), 'does not flag month/year in plain code comment');
  });
});

// ── runHygieneGuard (integration with synthetic tmpdir) ────────────────────

/**
 * Create a minimal fake repo in a temp directory and run the guard against it.
 */
async function makeFakeRepo(files) {
  const root = join(tmpdir(), `hygiene-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });

  // Write user/profile.yml with test data
  mkdirSync(join(root, 'user'), { recursive: true });
  writeFileSync(join(root, 'user', 'profile.yml'), `
candidate:
  full_name: "Jane Testuser"
  email: "jane@example.test"
  phone: "+1 555 123 4567"
  nationality: "Canada"
`.trim());

  // Write user/cv.md with minimal content
  writeFileSync(join(root, 'user', 'cv.md'), `
# Jane Testuser
**Contact:** +1 555 123 4567 | jane@example.test

## Education
### MSc Business
**Testford Business School** — City, Country
September 2024 – June 2025

## Experience
### Analyst
**Acme Corp** — City | Jan 2024 – Jun 2024

## Projects
### Data Analysis
**Testford Capstone** via Testford

`.trim());

  // Write the extra files the caller wants
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  return root;
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

describe('runHygieneGuard — synthetic repo', () => {
  it('passes when system files have no personal data', async () => {
    const root = await makeFakeRepo({
      'modes/_shared.md': '## Scoring\nThe agent reads user/cv.md at evaluation time.\n',
      'scripts/score.mjs': '// Generic scoring logic\nexport function score() { return 7; }\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      assert.equal(result.violations.length, 0, 'no violations for clean system files');
    } finally {
      cleanup(root);
    }
  });

  it('catches full name in mode file', async () => {
    const root = await makeFakeRepo({
      'modes/example.md': '## Example\nFor a candidate like Jane Testuser, the score would be 8.\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id === 'full_name');
      assert.ok(v, 'full_name violation found in modes file');
      assert.equal(v.file, 'modes/example.md');
    } finally {
      cleanup(root);
    }
  });

  it('catches email in template file', async () => {
    const root = await makeFakeRepo({
      'templates/cv.html': '<p>Contact: jane@example.test</p>\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id === 'email');
      assert.ok(v, 'email violation found in template');
    } finally {
      cleanup(root);
    }
  });

  it('catches phone number as placeholder in frontend', async () => {
    const root = await makeFakeRepo({
      'frontend/src/PhoneField.tsx': 'const field = <input placeholder="555 123 4567" />\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id === 'phone_partial');
      assert.ok(v, 'phone_partial violation found in frontend tsx');
    } finally {
      cleanup(root);
    }
  });

  it('catches graduation date with school in prose', async () => {
    const root = await makeFakeRepo({
      'modes/interview-prep.md': [
        '## Interview Prep',
        'Remember that you finish the Testford Business School MSc in Jun 2025.',
        'This means your availability window opens in July 2025.',
      ].join('\n'),
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id === 'grad_date_jun_2025');
      assert.ok(v, 'graduation date violation found in mode file prose');
    } finally {
      cleanup(root);
    }
  });

  it('does NOT flag school name in a reference table with many schools', async () => {
    const root = await makeFakeRepo({
      'modes/_shared.md': [
        '| School | Primary market | Secondary | CEMS? |',
        '| **Testford Business School** | UK | Europe | Yes |',
        '| **Other University** | Germany | EU | No |',
      ].join('\n'),
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id && v.pattern.id.startsWith('school_prose_'));
      assert.ok(!v, 'no school violation for legitimate reference table');
    } finally {
      cleanup(root);
    }
  });

  it('does NOT flag generic "your" usage without candidate school/date context', async () => {
    const root = await makeFakeRepo({
      'modes/scouting.md': [
        '## Report Voice',
        'Address the candidate as "you" and "your".',
        'Example: "your CV covers Python and SQL".',
        'Example: "your target salary is €40K".',
      ].join('\n'),
    });
    try {
      const result = await runHygieneGuard({ root });
      assert.equal(result.violations.length, 0, 'no false positive for generic second-person voice');
    } finally {
      cleanup(root);
    }
  });

  it('respects the hygiene-guard:allow inline marker', async () => {
    const root = await makeFakeRepo({
      'scripts/test-fixtures.mjs': [
        '// This is an explicitly approved reference:',
        '// Jane Testuser is used as test identity in fixture data // hygiene-guard:allow',
      ].join('\n'),
    });
    try {
      const result = await runHygieneGuard({ root });
      assert.equal(result.violations.length, 0, 'allow marker suppresses violation');
    } finally {
      cleanup(root);
    }
  });

  // Regression (audit finding 3): the scanner only walked modes/scripts/
  // templates/frontend-src, so root-level docs (CLAUDE.md et al.) and batch/
  // were a blind spot — yet the Data Contract names them system layer.
  it('catches personal data in a root-level CLAUDE.md (as a warning)', async () => {
    const root = await makeFakeRepo({
      'CLAUDE.md': '## Example\nFor a candidate like Jane Testuser, the score would be 8.\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      // CLAUDE.md gets its severity downgraded to warn (cautionary examples),
      // so the hit lands in warnings — but it must NOT be silently dropped.
      const w = result.warnings.find(w => w.pattern.id === 'full_name' && w.file === 'CLAUDE.md');
      assert.ok(w, 'full_name warning found in root CLAUDE.md');
      const v = result.violations.find(v => v.file === 'CLAUDE.md');
      assert.ok(!v, 'CLAUDE.md hit is a warning, not a hard violation');
    } finally {
      cleanup(root);
    }
  });

  it('catches personal data in batch/batch-prompt.md', async () => {
    const root = await makeFakeRepo({
      'batch/batch-prompt.md': '## Worker prompt\nContact the candidate at jane@example.test.\n',
    });
    try {
      const result = await runHygieneGuard({ root });
      const v = result.violations.find(v => v.pattern.id === 'email' && v.file === 'batch/batch-prompt.md');
      assert.ok(v, 'email violation found in batch/batch-prompt.md');
    } finally {
      cleanup(root);
    }
  });

  it('gracefully handles missing user data (returns zero patterns)', async () => {
    const root = join(tmpdir(), `hygiene-empty-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'modes'), { recursive: true });
    writeFileSync(join(root, 'modes', 'test.md'), 'Some content here.\n');
    try {
      const result = await runHygieneGuard({ root });
      // No user data means no patterns, so no violations possible
      assert.equal(result.personalData.fullName, null, 'no personal data extracted');
      assert.equal(result.patterns.length, 0, 'zero patterns with no user data');
      assert.equal(result.violations.length, 0, 'no violations');
    } finally {
      cleanup(root);
    }
  });
});

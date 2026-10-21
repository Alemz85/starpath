/**
 * leak-patterns.test.mjs — generic leak patterns (positives + negatives).
 *
 * Positive fixtures are fictional and carry the allow marker so the repo's
 * own leak scan skips these lines. Run: node --test scripts/lib/leak-patterns.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanGenericLine, maskTerm, isPlaceholderEmail, isPlaceholderPhone, GENERIC_PATTERNS } from './leak-patterns.mjs';

const cats = (line) => scanGenericLine(line).map((h) => `${h.category}:${h.severity}`);

describe('email', () => {
  it('flags real-looking addresses', () => {
    assert.deepEqual(cats('mail robin.quarry@gmail.com today'), ['email:block']); // hygiene-guard:allow
    assert.deepEqual(cats('<j.doe+jobs@uni-lakeside.edu>'), ['email:block']); // hygiene-guard:allow
    assert.deepEqual(cats('a@b.co.uk and x.y@corp.example.org'), []);
  });
  it('ignores placeholders, noreply and non-addresses', () => {
    for (const line of [
      'jane@example.com', 'you@example.org', 'x@example.net', 'jane@example.test', 'me@acme.test', 'a@b.com',
      'you@email.com', 'jane@acme.com', 'bob@initech.com', 'root@localhost', 'dev@box.local',
      'Co-Authored-By: Claude <noreply@anthropic.com>', 'no-reply@service.io',
      '112028253+someone@users.noreply.github.com', 'git@github.com:owner/repo.git',
      'logo@2x.png', 'react@18.3.1', 'npx shadcn@latest add', '@scope/pkg',
    ]) assert.deepEqual(cats(line), [], line);
  });
  it('isPlaceholderEmail', () => {
    assert.equal(isPlaceholderEmail('robin@mailbox.example'), true);
    assert.equal(isPlaceholderEmail('robin@realmail.org'), false); // hygiene-guard:allow
  });
});

describe('phone', () => {
  it('flags international numbers with ≥ 8 digits after the country code', () => {
    assert.deepEqual(cats('call +34 619 72 40 83'), ['phone:block']); // hygiene-guard:allow
    assert.deepEqual(cats('tel:+4915123456781'), ['phone:block']); // hygiene-guard:allow
    assert.deepEqual(cats('+1 (415) 867-2309'), ['phone:block']); // hygiene-guard:allow
  });
  it('ignores fictional ranges, short numbers and score deltas', () => {
    for (const line of ['+1 555 123 4567', '+11 5550 123456', '+44 7700 900123', '+1-555-0123',
      'Match +0.25 / Ease +1.5', '+33 1234', '@@ -1,3 +12,8 @@', '+00 000 000 000', '+1 234 567 890']) {
      assert.deepEqual(cats(line), [], line);
    }
    assert.equal(isPlaceholderPhone('+1 555 987 6543'), true);
  });
});

describe('home paths', () => {
  it('flags /Users/<real name>/ and /home/<real name>/', () => {
    assert.deepEqual(cats('see /Users/rquarry/Projects/x'), ['home-path:block']); // hygiene-guard:allow
    assert.deepEqual(cats('"/home/robin/.config"'), ['home-path:block']); // hygiene-guard:allow
  });
  it('masks only the user name', () => {
    assert.deepEqual(scanGenericLine('/Users/rquarry/x').map((h) => h.masked), ['/Users/r·····y/']); // hygiene-guard:allow
  });
  it('ignores placeholders', () => {
    for (const line of ['/Users/<name>/', '/Users/you/Projects', '/home/runner/work/repo', '/Users/$USER/',
      '/Users/Shared/', '/home/user/app', '/Users/*/Library', '/Users/.../x', 'C:\\Users\\name']) {
      assert.deepEqual(cats(line), [], line);
    }
  });
});

describe('secrets', () => {
  const key = (prefix, len, ch = 'a1B2') => prefix + ch.repeat(Math.ceil(len / ch.length)).slice(0, len);
  it('flags API-key and private-key shapes', () => {
    for (const s of [
      key('sk-ant-api03-', 40), key('sk-proj-', 40), key('sk-', 48), key('ghp_', 36), key('gho_', 36),
      key('github_pat_', 60), 'AKIA' + 'QWERTYUIOPASDFGH', key('xoxb-', 30),
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', '-----BEGIN ' + 'PRIVATE KEY-----',
    ]) assert.deepEqual(cats(`token = "${s}"`), ['secret:block'], s.slice(0, 12));
  });
  it('ignores placeholders and look-alikes', () => {
    for (const line of [
      'ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx', 'sk-ant-...', 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      'task-abcdefghijabcdefghijabcdef', 'risk-adjusted-score-calibration-v2', 'AKIA-like', '-----BEGIN PUBLIC KEY-----',
      'const re = /sk-ant-[A-Za-z0-9_-]{20,}/',
    ]) assert.deepEqual(cats(line), [], line);
  });
});

describe('salary (warning only)', () => {
  it('flags salary-looking figures as warnings', () => {
    assert.deepEqual(cats('target €67K base'), ['salary:warn']);
    assert.deepEqual(cats('€ 52.5k'), ['salary:warn']);
    assert.deepEqual(cats('offer 67,000 EUR'), ['salary:warn']);
    assert.deepEqual(cats('67000€'), ['salary:warn']);
  });
  it('ignores other numbers', () => {
    for (const line of ['€1,200/mo', '2026-10-20', '100K rows', 'EUR 1.000.000', '€5K']) assert.deepEqual(cats(line), [], line);
  });
  it('every pattern is global and has a severity', () => {
    for (const p of GENERIC_PATTERNS) {
      assert.ok(p.regex.global, p.id);
      assert.ok(['block', 'warn'].includes(p.severity), p.id);
    }
  });
});

describe('allow marker and masking', () => {
  it('skips lines with hygiene-guard:allow', () => {
    assert.deepEqual(cats('robin.quarry@gmail.com // hygiene-guard:allow'), []); // hygiene-guard:allow
  });
  it('masks every hit', () => {
    const hits = scanGenericLine('robin.quarry@gmail.com +34 619 72 40 83'); // hygiene-guard:allow
    assert.deepEqual(hits.map((h) => h.masked), ['r·····m', '+·····3']);
    assert.equal(maskTerm('  ab  '), 'a·····b');
  });
});

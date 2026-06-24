/**
 * liveness-core.test.mjs — characterization suite for classifyLiveness().
 *
 * classifyLiveness is the gatekeeper that decides whether a scraped posting
 * is surfaced (`active`), dropped (`expired`), or flagged for manual review
 * (`uncertain`). It is a fixed *precedence* of seven checks; the order is the
 * contract, so these tests pin both the result and which signal won.
 *
 * Precedence (first match wins):
 *   1. HTTP 404 / 410                  → expired
 *   2. finalUrl has ?error=true        → expired
 *   3. body matches a hard-expired pat → expired
 *   4. a visible apply control exists  → active
 *   5. body looks like a search/listing→ expired
 *   6. body under MIN_CONTENT_CHARS    → expired (nav/footer only)
 *   7. otherwise                       → uncertain
 *
 * Run: node --test scripts/liveness-core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness } from './liveness-core.mjs';

// A body long enough to clear the MIN_CONTENT_CHARS (300) floor, so tests that
// target a *later* branch aren't short-circuited by the "insufficient content"
// check. Deliberately benign — no expired/listing/apply phrases.
const LONG_BODY =
  'About the team. '.repeat(40) +
  'We build delightful products for millions of users across many regions.';

test('classifyLiveness fixture stays above the content floor', () => {
  assert.ok(LONG_BODY.length >= 300, 'LONG_BODY must exceed MIN_CONTENT_CHARS');
});

// ── 1. HTTP status short-circuit ──────────────────────────────────────────
test('HTTP 404 → expired', () => {
  const { result, reason } = classifyLiveness({ status: 404, bodyText: LONG_BODY });
  assert.equal(result, 'expired');
  assert.equal(reason, 'HTTP 404');
});

test('HTTP 410 → expired', () => {
  const { result, reason } = classifyLiveness({ status: 410, bodyText: LONG_BODY });
  assert.equal(result, 'expired');
  assert.equal(reason, 'HTTP 410');
});

test('only 404/410 short-circuit — 403 and 500 fall through to body checks', () => {
  // A 403 (login wall) or 5xx with a healthy applyable body is NOT auto-expired.
  for (const status of [403, 500, 503]) {
    const { result } = classifyLiveness({ status, bodyText: LONG_BODY, applyControls: ['Apply now'] });
    assert.equal(result, 'active', `status ${status} should fall through, not auto-expire`);
  }
});

test('HTTP status wins over a hard-expired body phrase (checked first)', () => {
  const { result, reason } = classifyLiveness({
    status: 404,
    bodyText: 'this job is no longer available',
  });
  assert.equal(result, 'expired');
  assert.equal(reason, 'HTTP 404', 'status is reported, not the body pattern');
});

// ── 2. Expired-URL redirect ───────────────────────────────────────────────
test('redirect to ?error=true → expired', () => {
  const { result, reason } = classifyLiveness({
    finalUrl: 'https://boards.example.com/job/123?error=true',
    bodyText: LONG_BODY,
  });
  assert.equal(result, 'expired');
  assert.match(reason, /^redirect to /);
});

test('error param mid-query (&error=true) is detected', () => {
  const { result } = classifyLiveness({
    finalUrl: 'https://x.com/job?ref=feed&error=true',
    bodyText: LONG_BODY,
  });
  assert.equal(result, 'expired');
});

test('a benign final URL does not trip the redirect check', () => {
  const { result } = classifyLiveness({
    finalUrl: 'https://x.com/job?error_code=0&utm=feed',
    bodyText: LONG_BODY,
    applyControls: ['Apply'],
  });
  // error_code= is not error= ; should reach the apply-control → active branch.
  assert.equal(result, 'active');
});

// ── 3. Hard-expired body patterns (incl. i18n) ────────────────────────────
const HARD_EXPIRED_BODIES = [
  ['no longer available', 'This job is no longer available.'],
  ['no longer open', 'This job is currently no longer open for new candidates.'],
  ['position filled', 'This position has been filled. Thank you for your interest.'],
  ['this job has expired', 'This job has expired and is closed to applicants.'],
  ['job posting expired', 'This job posting has expired.'],
  ['not accepting', 'We are no longer accepting applications for this role.'],
  ['role no longer', 'This role is no longer accepting candidates.'],
  ['job no longer (no "is")', 'This job no longer accepts external applicants.'],
  ['listing closed', 'This job listing is closed.'],
  ['job not found', 'Job not found — it may have been removed.'],
  ['page does not exist (straight quote)', "The page you are looking for doesn't exist."],
  ['page does not exist (curly quote)', 'The page you are looking for doesn’t exist.'],
  ['DE — besetzt (nicht mehr)', 'Diese Stelle ist nicht mehr besetzt.'],
  ['DE — besetzt (bereits)', 'Diese Stelle bereits besetzt.'],
  ['FR — offre expirée', 'Cette offre expirée a été retirée.'],
  ['FR — offre n’est plus disponible', "Cette offre n'est plus disponible."],
  ['case-insensitive', 'THIS JOB HAS EXPIRED'],
];

for (const [label, body] of HARD_EXPIRED_BODIES) {
  test(`hard-expired body → expired: ${label}`, () => {
    const { result, reason } = classifyLiveness({ status: 200, bodyText: body });
    assert.equal(result, 'expired');
    assert.match(reason, /^pattern matched: /);
  });
}

test('"doesnt" with no separator does NOT match the page-not-found pattern', () => {
  // The pattern is /doesn.t/ — it needs exactly one char between "doesn" and "t".
  const { result } = classifyLiveness({
    status: 200,
    bodyText: 'The page you are looking for doesnt exist ' + LONG_BODY,
  });
  assert.notEqual(result, 'expired', 'no apostrophe → pattern should not fire');
});

test('hard-expired body wins over a visible apply control (precedence #3 > #4)', () => {
  // A dead page can still render a generic/stale "Apply" button; the explicit
  // expired phrase is authoritative and must win.
  const { result } = classifyLiveness({
    status: 200,
    bodyText: 'This position has been filled.',
    applyControls: ['Apply now'],
  });
  assert.equal(result, 'expired');
});

// ── 4. Apply controls → active (incl. i18n labels) ────────────────────────
const APPLY_LABELS = [
  ['EN — Apply', 'Apply'],
  ['EN — Apply now', 'Apply now'],
  ['EN — Easy Apply', 'Easy Apply'],
  ['EN — Submit application', 'Submit application'],
  ['EN — Start application', 'Start application'],
  ['ES — Solicitar', 'Solicitar ahora'],
  ['DE — bewerben', 'Jetzt bewerben'],
  ['DE — Ich bewerbe mich', 'Ich bewerbe mich'],
  ['FR — Postuler', 'Postuler'],
];

for (const [label, control] of APPLY_LABELS) {
  test(`visible apply control → active: ${label}`, () => {
    const { result, reason } = classifyLiveness({
      status: 200,
      bodyText: LONG_BODY,
      applyControls: [control],
    });
    assert.equal(result, 'active');
    assert.equal(reason, 'visible apply control detected');
  });
}

test('apply control is found among unrelated controls', () => {
  const { result } = classifyLiveness({
    status: 200,
    bodyText: LONG_BODY,
    applyControls: ['Save job', 'Share', 'Apply now', 'Print'],
  });
  assert.equal(result, 'active');
});

test('non-apply controls alone do not make a page active', () => {
  const { result } = classifyLiveness({
    status: 200,
    bodyText: LONG_BODY,
    applyControls: ['Save job', 'Share', 'Sign in'],
  });
  assert.equal(result, 'uncertain');
});

test('word-boundary: "Reapply" / "Applying" do not match \\bapply\\b', () => {
  const { result } = classifyLiveness({
    status: 200,
    bodyText: LONG_BODY,
    applyControls: ['Reapply later', 'Applying soon'],
  });
  assert.equal(result, 'uncertain', 'embedded "apply" should not count as an apply control');
});

// ── precedence #4 > #5: a search page that still renders Apply buttons ─────
test('apply control wins over a listing-page phrase (precedence #4 > #5)', () => {
  // CHARACTERIZATION: a search-results page ("25 jobs found") that also shows
  // per-row "Apply" buttons is currently classified active, because the apply
  // check runs before the listing-page check. Documented, not asserted-as-ideal.
  const { result } = classifyLiveness({
    status: 200,
    bodyText: '25 jobs found. ' + LONG_BODY,
    applyControls: ['Apply'],
  });
  assert.equal(result, 'active');
});

// ── 5. Listing / search pages (no apply control) ──────────────────────────
test('"N jobs found" with no apply control → expired', () => {
  for (const n of ['1 job found', '25 jobs found', '1,204 jobs found']) {
    const { result } = classifyLiveness({ status: 200, bodyText: n + '. ' + LONG_BODY });
    assert.equal(result, 'expired', `"${n}" should read as a listing page`);
  }
});

test('"search for jobs page is loaded" → expired', () => {
  const { result } = classifyLiveness({
    status: 200,
    bodyText: 'Search for jobs page is loaded. ' + LONG_BODY,
  });
  assert.equal(result, 'expired');
});

// ── 6. Minimum content floor ──────────────────────────────────────────────
test('body shorter than the content floor → expired', () => {
  const { result, reason } = classifyLiveness({ status: 200, bodyText: 'Loading…' });
  assert.equal(result, 'expired');
  assert.match(reason, /insufficient content/);
});

test('content floor boundary: 299 chars → expired, 300 → uncertain', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: 'x'.repeat(299) }).result, 'expired');
  assert.equal(classifyLiveness({ status: 200, bodyText: 'x'.repeat(300) }).result, 'uncertain');
});

test('whitespace-only body is treated as empty (trim before length check)', () => {
  const { result } = classifyLiveness({ status: 200, bodyText: ' '.repeat(1000) });
  assert.equal(result, 'expired');
});

// ── 7. Uncertain fall-through ─────────────────────────────────────────────
test('healthy body, no apply control, no expired/listing signal → uncertain', () => {
  const { result, reason } = classifyLiveness({ status: 200, bodyText: LONG_BODY });
  assert.equal(result, 'uncertain');
  assert.match(reason, /no visible apply control/);
});

// ── Defaults / robustness ─────────────────────────────────────────────────
test('no arguments defaults to expired (conservative empty-body floor)', () => {
  const { result } = classifyLiveness();
  assert.equal(result, 'expired');
});

test('empty object input defaults to expired', () => {
  const { result } = classifyLiveness({});
  assert.equal(result, 'expired');
});

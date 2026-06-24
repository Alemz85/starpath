// Unit tests for classifyLiveness — scripts/liveness-core.mjs decides whether a
// fetched job page is active / expired / uncertain. It gates scan dedup and the
// liveness verification step; a regression here silently revives dead listings
// or kills live ones. test-all.mjs § 3 pins two end-to-end fixtures; this suite
// nails the full decision precedence, the multilingual patterns, and the
// content-length floor.
//
// Plain ESM, zero deps: picked up by `node --test "scripts/**/*.test.mjs"`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLiveness } from './liveness-core.mjs'

// A body long enough to clear the 300-char nav/footer floor without tripping
// any expired/listing-page pattern.
const RICH_BODY = (
  'Senior Operations Analyst — join our team to own delivery across evaluation, ' +
  'deployment and reliability. You will partner with customers, build dashboards, ' +
  'analyse performance data, and drive operational excellence across the region. ' +
  'We offer a collaborative culture, structured onboarding, and real ownership.'
)

test('classifyLiveness: HTTP 404/410 are expired regardless of body', () => {
  assert.deepEqual(classifyLiveness({ status: 404, bodyText: RICH_BODY, applyControls: ['Apply'] }),
    { result: 'expired', reason: 'HTTP 404' })
  assert.equal(classifyLiveness({ status: 410 }).result, 'expired')
})

test('classifyLiveness: an error-redirect URL is expired (ahead of the apply check)', () => {
  const r = classifyLiveness({ status: 200, finalUrl: 'https://x.com/job?error=true', bodyText: RICH_BODY, applyControls: ['Apply'] })
  assert.equal(r.result, 'expired')
})

test('classifyLiveness: a hard-expired body wins over a stray Apply button', () => {
  // The canonical case: a closed page that still renders a generic nav "Apply".
  const r = classifyLiveness({ status: 200, bodyText: 'This role is no longer accepting applications.', applyControls: ['Apply'] })
  assert.equal(r.result, 'expired')
})

test('classifyLiveness: hard-expired patterns are multilingual', () => {
  for (const body of [
    'The position has been filled.',
    'Diese Stelle ist bereits besetzt.',
    "Cette offre n'est plus disponible.",
    'The page you are looking for doesn’t exist.',
  ]) {
    assert.equal(classifyLiveness({ status: 200, bodyText: body }).result, 'expired', body)
  }
})

test('classifyLiveness: a visible apply control means active (multilingual)', () => {
  for (const control of ['Apply for this Job', 'Bewerben', 'Solicitar', 'Postuler', 'Easy Apply']) {
    assert.equal(classifyLiveness({ status: 200, bodyText: RICH_BODY, applyControls: [control] }).result, 'active', control)
  }
})

test('classifyLiveness: a "N jobs found" search page is expired — unless it has an apply control', () => {
  // No apply control → it's a search-results landing, not the listing → expired.
  assert.equal(classifyLiveness({ status: 200, bodyText: '663 jobs found\n' + RICH_BODY }).result, 'expired')
  // With an apply control, the apply check (earlier) wins → active.
  assert.equal(classifyLiveness({ status: 200, bodyText: '663 jobs found\n' + RICH_BODY, applyControls: ['Apply for this Job'] }).result, 'active')
})

test('classifyLiveness: thin nav/footer-only content (< 300 chars) is expired', () => {
  const r = classifyLiveness({ status: 200, bodyText: 'Careers · About · Contact' })
  assert.equal(r.result, 'expired')
  assert.match(r.reason, /insufficient content/)
})

test('classifyLiveness: real content but no apply control is uncertain (not a false kill)', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: RICH_BODY }).result, 'uncertain')
})

test('classifyLiveness: tolerates being called with no arguments', () => {
  // status 0, empty body (< 300) → expired on the content floor, no throw.
  assert.equal(classifyLiveness().result, 'expired')
})

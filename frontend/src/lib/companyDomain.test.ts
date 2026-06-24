import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessDomain, OVERRIDES } from '@/lib/companyDomain'

test('exact overrides resolve case- and whitespace-insensitively', () => {
  assert.equal(guessDomain('Google'), 'google.com')
  assert.equal(guessDomain('  GOOGLE  '), 'google.com')
  assert.equal(guessDomain('Amazon Web Services'), 'aws.amazon.com')
  assert.equal(guessDomain('McKinsey & Company'), 'mckinsey.com')
  assert.equal(guessDomain('Booking.com'), 'booking.com')
})

test('word-boundary prefix matches a "Brand <descriptor>" name', () => {
  assert.equal(guessDomain('Google Cloud'), 'google.com')
  assert.equal(guessDomain('Klarna Bank'), 'klarna.com')
  assert.equal(guessDomain('SAP SE'), 'sap.com')
  assert.equal(guessDomain('IBM Watson'), 'ibm.com')
  assert.equal(guessDomain('X Corp'), 'x.com')
})

test('a bare letter-prefix does NOT hijack an unrelated name (the bug fix)', () => {
  // These all merely *start with* a short override key; before the
  // word-boundary guard they wrongly resolved to the override's domain.
  assert.equal(guessDomain('Xero'), 'xero.com')        // was x.com
  assert.equal(guessDomain('Amdocs'), 'amdocs.com')    // was amd.com
  assert.equal(guessDomain('Sapient'), 'sapient.com')  // was sap.com
  assert.equal(guessDomain('Eyeo'), 'eyeo.com')        // was ey.com
  assert.equal(guessDomain('Bainbridge'), 'bainbridge.com') // was bain.com
})

test('cleaned fallback strips legal/suffix noise then dot-coms the rest', () => {
  assert.equal(guessDomain('Acme Inc'), 'acme.com')
  assert.equal(guessDomain('Foobar GmbH'), 'foobar.com')
  assert.equal(guessDomain('Some Startup Ltd.'), 'somestartup.com')
  // multi-word unknown names concatenate (no spaces survive the clean)
  assert.equal(guessDomain('Widget Works'), 'widgetworks.com')
})

test('a name that is entirely stripped falls back to unknown.com', () => {
  assert.equal(guessDomain('Group Ltd'), 'unknown.com')
  assert.equal(guessDomain('!!!'), 'unknown.com')
})

test('every override value is a bare domain (no scheme, no path)', () => {
  for (const domain of Object.values(OVERRIDES)) {
    assert.ok(!/^https?:\/\//.test(domain), `${domain} should not carry a scheme`)
    assert.ok(!domain.includes('/'), `${domain} should not carry a path`)
    assert.ok(domain.includes('.'), `${domain} should look like a domain`)
  }
})

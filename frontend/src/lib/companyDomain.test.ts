import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainFromCareersUrl, guessDomain, OVERRIDES, resolveLogoDomain, userDomains } from '@/lib/companyDomain'

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

test('accents fold before the cleaned fallback', () => {
  assert.equal(guessDomain('Crème Studio'), 'cremestudio.com')   // was crmestudio.com
  assert.equal(guessDomain('Café Nimbus'), 'cafenimbus.com')
})

test('a name that already is a domain is used as is', () => {
  assert.equal(guessDomain('Contoso.io'), 'contoso.io')  // was contosoio.com
  assert.equal(guessDomain('Fabrikam.co.uk'), 'fabrikam.co.uk')
})

test('a careers URL gives the company domain unless it is on a job board', () => {
  assert.equal(domainFromCareersUrl('https://jobs.nimbus-robotics.app/en/vacancies/1'), 'nimbus-robotics.app')
  assert.equal(domainFromCareersUrl('https://www.contoso-group.eu/en/careers.html'), 'contoso-group.eu')
  assert.equal(domainFromCareersUrl('https://careers.fabrikam.com'), 'fabrikam.com')
  assert.equal(domainFromCareersUrl('https://job-boards.greenhouse.io/contoso'), null)
  assert.equal(domainFromCareersUrl('https://jobs.ashbyhq.com/contoso'), null)
  assert.equal(domainFromCareersUrl('https://contoso.wd3.myworkdayjobs.com/Careers'), null)
  assert.equal(domainFromCareersUrl('not a url'), null)
})

test('user domains: explicit beats overrides, overrides beat careers hosts, careers hosts beat guessing', () => {
  const user = userDomains({
    company_domains: { 'Tailspin Toys': 'tailspin.io', 'Bad Entry': 'not a domain' },
    tracked_companies: [
      { name: 'Contoso Group', careers_url: 'https://www.contoso-group.eu/careers' },
      { name: 'Fabrikam', careers_url: 'https://jobs.ashbyhq.com/fabrikam', domain: 'https://fabrikam.dev/' },
      { name: 'Netflix', careers_url: 'https://explore.jobs.netflix.net' },
      { name: 'Woodgrove', careers_url: 'https://job-boards.greenhouse.io/woodgrove' },
    ],
  })
  assert.equal(resolveLogoDomain('Tailspin Toys', user), 'tailspin.io')
  assert.equal(resolveLogoDomain('  tailspin toys ', user), 'tailspin.io')
  assert.equal(resolveLogoDomain('Bad Entry', user), 'badentry.com')
  assert.equal(resolveLogoDomain('Contoso Group', user), 'contoso-group.eu')
  assert.equal(resolveLogoDomain('Fabrikam', user), 'fabrikam.dev')
  assert.equal(resolveLogoDomain('Netflix', user), 'netflix.com')
  assert.equal(resolveLogoDomain('Woodgrove', user), 'woodgrove.com')
  assert.equal(resolveLogoDomain('Figma'), 'figma.com')
  assert.deepEqual(userDomains(null), { explicit: {}, careers: {} })
  assert.equal(resolveLogoDomain('Netflix', userDomains({ company_domains: { netflix: 'netflix.dev' } })), 'netflix.dev')
})

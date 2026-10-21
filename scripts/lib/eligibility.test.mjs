// Unit tests for the scoring v2 eligibility gate (scripts/lib/eligibility.mjs,
// spec docs/scoring-v2.md §1). Every red / amber / green branch of every
// check, the permanent-role and flexible-start rules, the "unknown is not
// green" cases, the empty-profile behaviour, and the roll-up.
//
// All candidates and dates are fictional.
//
// Plain ESM, zero deps: `node --test scripts/lib/eligibility.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateEligibility,
  eligibilityFlags,
  checkStartDate,
  checkDuration,
  durationRangeFor,
  checkGraduation,
  checkLanguage,
  checkWorkAuth,
  checkOther,
  levelRank,
  LEVEL_LADDER,
  EU27,
  EEA_NON_EU,
  EU_EEA_COUNTRIES,
  CHECK_ORDER,
  redIsScored,
} from './eligibility.mjs'

const TODAY = '2026-10-20'

const PROFILE = {
  available_from: '2026-11-01',
  blocked_windows: [{ from: '2027-01-01', to: '2027-05-31', reason: 'study term' }],
  graduations: [{ degree: 'MSc', date: '2026-10' }],
  languages: [
    { language: 'English', level: 'C2' },
    { language: 'Spanish', level: 'B2' },
    { language: 'Italian', level: 'B1' },
    { language: 'Portuguese', level: 'native' },
  ],
  work_authorisation: ['EU'],
  duration_months: { min: 3, max: 12 },
  permanent_start_ok_before_block: false,
}

const start = (f, p = PROFILE) => checkStartDate(f, p, { today: TODAY })

// ─── reference data ───────────────────────────────────────────────────────────

test('level ladder matches the spec', () => {
  assert.deepEqual({ ...LEVEL_LADDER }, {
    A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
    basic: 2, conversational: 3, professional: 4, business: 4, fluent: 5, native: 7,
  })
  assert.equal(levelRank('c1'), 5)
  assert.equal(levelRank('Fluent'), 5)
  assert.equal(levelRank(' native '), 7)
  assert.equal(levelRank('elvish'), null)
  assert.equal(levelRank(null), null)
})

test('EU expansion is EU-27 + EEA (IS, LI, NO), and excludes CH / GB', () => {
  assert.equal(EU27.length, 27)
  assert.deepEqual([...EEA_NON_EU], ['IS', 'LI', 'NO'])
  assert.equal(EU_EEA_COUNTRIES.size, 30)
  for (const c of ['DE', 'FR', 'PT', 'IS', 'LI', 'NO', 'GR']) assert.ok(EU_EEA_COUNTRIES.has(c), c)
  for (const c of ['CH', 'GB', 'US']) assert.ok(!EU_EEA_COUNTRIES.has(c), c)
})

// ─── start_date ───────────────────────────────────────────────────────────────

test('start_date green: known start, no overlap, after availability', () => {
  const r = start({ employment: 'internship', start: { earliest: '2027-06-15' }, duration_months: 6 })
  assert.equal(r.status, 'green')
  assert.equal(r.question, undefined)
})

test('start_date red: internship period overlaps a blocked window and start is not flexible', () => {
  const r = start({ employment: 'internship', start: { earliest: '2026-11-15', flexible: false }, duration_months: 3 })
  assert.equal(r.status, 'red')
  assert.match(r.reason, /overlaps blocked window 2027-01-01–2027-05-31 \(study term\)/)
})

test('start_date amber: overlap exists but start is flexible — question asks to move past the block', () => {
  const r = start({ employment: 'internship', start: { earliest: '2026-11-15', flexible: true }, duration_months: 3 })
  assert.equal(r.status, 'amber')
  assert.match(r.question, /after 2027-05-31/)
})

test('start_date: blocked window `to` is inclusive', () => {
  assert.equal(start({ employment: 'fixed_term', start: { earliest: '2027-05-31' }, duration_months: 6 }).status, 'red')
  assert.equal(start({ employment: 'fixed_term', start: { earliest: '2027-06-01' }, duration_months: 6 }).status, 'green')
  // a period ending the day before the block starts is clear
  assert.equal(start({ employment: 'internship', start: { earliest: '2026-11-01' }, duration_months: 2 }).status, 'green')
})

test('start_date red: latest start is before the candidate is available', () => {
  const r = start({ employment: 'internship', start: { earliest: '2026-09-01', latest: '2026-10-15' }, duration_months: 2 })
  assert.equal(r.status, 'red')
  assert.match(r.reason, /Latest start 2026-10-15/)
})

test('start_date amber: earliest start before availability but latest allows it', () => {
  const r = start({ employment: 'internship', start: { earliest: '2026-10-01', latest: '2026-11-15' }, duration_months: 2 })
  assert.equal(r.status, 'amber')
  assert.match(r.question, /2026-11-01/)
})

test('start_date amber: earliest before availability, latest not stated (unknown is not red either)', () => {
  const r = start({ employment: 'internship', start: { earliest: '2026-10-01' }, duration_months: 2 })
  assert.equal(r.status, 'amber')
})

test('start_date: availability shift still checks the shifted period against blocks', () => {
  // can only start 2026-11-01; 3 months then runs into January → red
  const r = start({ employment: 'internship', start: { earliest: '2026-10-01', latest: '2026-11-30' }, duration_months: 3 })
  assert.equal(r.status, 'red')
})

test('start_date amber: start not stated for internship / fixed-term / graduate programme', () => {
  for (const employment of ['internship', 'fixed_term', 'graduate_programme']) {
    const r = start({ employment, start: { earliest: null }, duration_months: 6 })
    assert.equal(r.status, 'amber', employment)
    assert.match(r.question, /start date/)
  }
  // no `start` object at all, unknown employment type → also amber
  assert.equal(start({}).status, 'amber')
})

test('start_date permanent: open-ended period runs through a later block (red) unless start is after it', () => {
  assert.equal(start({ employment: 'permanent', start: { earliest: '2026-12-01' } }).status, 'red')
  assert.equal(start({ employment: 'permanent', start: { earliest: '2027-06-15' } }).status, 'green')
  assert.equal(start({ employment: 'permanent', start: { earliest: '2026-12-01', flexible: true } }).status, 'amber')
})

test('start_date permanent with permanent_start_ok_before_block: only the start date matters', () => {
  const p = { ...PROFILE, permanent_start_ok_before_block: true }
  assert.equal(start({ employment: 'permanent', start: { earliest: '2026-12-01' } }, p).status, 'green')
  assert.equal(start({ employment: 'permanent', start: { earliest: '2027-02-01' } }, p).status, 'red')
})

test('start_date permanent, no stated start: amber only if a blocked window lies in the next 9 months', () => {
  const r = start({ employment: 'permanent', start: { earliest: null } })
  assert.equal(r.status, 'amber')
  assert.match(r.question, /study term/)
  const far = { ...PROFILE, blocked_windows: [{ from: '2028-01-01', to: '2028-03-31' }] }
  assert.equal(start({ employment: 'permanent' }, far).status, 'green')
  // 2026-10-20 + 9 months = 2027-07-20; a block starting 2027-07-19 is inside, 2027-07-21 is not
  const edgeIn = { ...PROFILE, blocked_windows: [{ from: '2027-07-19', to: '2027-08-31' }] }
  const edgeOut = { ...PROFILE, blocked_windows: [{ from: '2027-07-21', to: '2027-08-31' }] }
  assert.equal(start({ employment: 'permanent' }, edgeIn).status, 'amber')
  assert.equal(start({ employment: 'permanent' }, edgeOut).status, 'green')
  // no `today`: falls back to available_from as the reference date
  assert.equal(checkStartDate({ employment: 'permanent' }, PROFILE).status, 'amber')
  assert.equal(checkStartDate({ employment: 'permanent' }, far).status, 'green')
})

test('start_date: empty profile or no date constraints → green "not checked"', () => {
  assert.equal(start({ employment: 'internship' }, {}).status, 'green')
  assert.match(start({ employment: 'internship' }, {}).reason, /Not checked/)
  // only available_from, no blocks
  const p = { available_from: '2026-11-01' }
  assert.equal(start({ employment: 'internship', start: { earliest: '2027-03-01' }, duration_months: 6 }, p).status, 'green')
})

// ─── duration ─────────────────────────────────────────────────────────────────

test('duration: inside / outside range, internship unknown, not applicable', () => {
  assert.equal(checkDuration({ employment: 'internship', duration_months: 6 }, PROFILE).status, 'green')
  assert.equal(checkDuration({ employment: 'internship', duration_months: 3 }, PROFILE).status, 'green')   // min inclusive
  assert.equal(checkDuration({ employment: 'fixed_term', duration_months: 12 }, PROFILE).status, 'green')  // max inclusive
  const short = checkDuration({ employment: 'internship', duration_months: 2 }, PROFILE)
  assert.equal(short.status, 'amber')
  assert.match(short.question, /2-month/)
  assert.equal(checkDuration({ employment: 'fixed_term', duration_months: 18 }, PROFILE).status, 'amber')
  const unknown = checkDuration({ employment: 'internship', duration_months: null }, PROFILE)
  assert.equal(unknown.status, 'amber')
  assert.match(unknown.question, /How long/)
  assert.equal(checkDuration({ employment: 'fixed_term', duration_months: null }, PROFILE).status, 'green')
  assert.equal(checkDuration({ employment: 'permanent', duration_months: 36 }, PROFILE).status, 'green')
  assert.equal(checkDuration({ employment: 'internship', duration_months: 24 }, {}).status, 'green')     // no range
})

test('duration: a range per employment type, falling back to default for the rest', () => {
  const p = { duration_months: {
    default: { min: 3, max: 12 },
    graduate_programme: { min: 12, max: 24 },
  } }
  const grad = checkDuration({ employment: 'graduate_programme', duration_months: 18 }, p)
  assert.equal(grad.status, 'green')
  assert.match(grad.reason, /for a graduate programme \(12–24 months\)/)
  const long = checkDuration({ employment: 'graduate_programme', duration_months: 30 }, p)
  assert.equal(long.status, 'amber')
  assert.match(long.reason, /graduate programme/)
  assert.match(long.question, /You can do 12–24 months/)
  // Types without their own range use the default.
  assert.equal(checkDuration({ employment: 'internship', duration_months: 18 }, p).status, 'amber')
  assert.equal(checkDuration({ employment: 'fixed_term', duration_months: 6 }, p).status, 'green')
  assert.equal(checkDuration({ employment: 'working_student', duration_months: 18 }, p).status, 'amber')
  assert.equal(checkDuration({ employment: null, duration_months: 18 }, p).status, 'amber')
  assert.equal(checkDuration({ employment: 'permanent', duration_months: 36 }, p).status, 'green')
})

test('duration: top-level min/max is the fallback beside per-type ranges', () => {
  const p = { duration_months: { min: 2, max: 12, graduate_programme: { max: 24 } } }
  assert.equal(checkDuration({ employment: 'graduate_programme', duration_months: 24 }, p).status, 'green')
  assert.equal(checkDuration({ employment: 'graduate_programme', duration_months: 1 }, p).status, 'green') // no min for this type
  assert.equal(checkDuration({ employment: 'internship', duration_months: 18 }, p).status, 'amber')
  const r = checkDuration({ employment: 'internship', duration_months: 6 }, p)
  assert.equal(r.reason, '6 months is inside your accepted range (2–12 months)')
})

test('duration: per-type ranges only, no fallback → other types are not checked', () => {
  const p = { duration_months: { internship: { min: 3, max: 6 } } }
  assert.equal(checkDuration({ employment: 'internship', duration_months: 9 }, p).status, 'amber')
  const ft = checkDuration({ employment: 'fixed_term', duration_months: 36 }, p)
  assert.equal(ft.status, 'green')
  assert.match(ft.reason, /Not checked/)
})

test('durationRangeFor names the range it used', () => {
  const p = { duration_months: { default: { min: 3, max: 12 }, internship: { min: 2, max: 6 } } }
  assert.deepEqual(durationRangeFor(p, 'internship'), { min: 2, max: 6, type: 'internship' })
  assert.deepEqual(durationRangeFor(p, 'graduate_programme'), { min: 3, max: 12, type: 'default' })
  assert.deepEqual(durationRangeFor({ duration_months: { min: 3, max: 12 } }, 'internship'), { min: 3, max: 12, type: 'default' })
  assert.deepEqual(durationRangeFor({}, 'internship'), { min: null, max: null, type: null })
})

test('evaluateEligibility: an 18-month graduate programme is amber on one range, green with its own', () => {
  const facts = { ...GREEN_FACTS, employment: 'graduate_programme', duration_months: 18 }
  const single = evaluateEligibility(facts, { ...PROFILE, duration_months: { min: 3, max: 12 } }, { today: TODAY })
  assert.equal(single.checks.find(c => c.check === 'duration').status, 'amber')
  const perType = evaluateEligibility(facts, {
    ...PROFILE,
    duration_months: { min: 3, max: 12, graduate_programme: { min: 12, max: 24 } },
  }, { today: TODAY })
  assert.equal(perType.checks.find(c => c.check === 'duration').status, 'green')
  assert.equal(perType.amber_count, single.amber_count - 1)
})

// ─── graduation ───────────────────────────────────────────────────────────────

test('graduation: no requirement, inside, hard outside (red), soft outside (amber)', () => {
  assert.equal(checkGraduation({}, PROFILE).status, 'green')
  assert.equal(checkGraduation({ graduation: { from: null, to: null } }, PROFILE).status, 'green')
  assert.equal(checkGraduation({ graduation: { from: '2025-06', to: '2027-12' } }, PROFILE).status, 'green')
  assert.equal(checkGraduation({ graduation: { from: '2026-10', to: '2026-10' } }, PROFILE).status, 'green') // inclusive
  const hard = checkGraduation({ graduation: { from: '2027-01', to: '2028-12', soft: false } }, PROFILE)
  assert.equal(hard.status, 'red')
  const soft = checkGraduation({ graduation: { from: '2027-01', to: '2028-12', soft: true } }, PROFILE)
  assert.equal(soft.status, 'amber')
  assert.match(soft.question, /hard requirement/)
})

test('graduation: open-ended windows, day-precision dates, multiple degrees, empty profile', () => {
  assert.equal(checkGraduation({ graduation: { to: '2026-06' } }, PROFILE).status, 'red')
  assert.equal(checkGraduation({ graduation: { from: '2026-01-15' } }, PROFILE).status, 'green')
  const two = { graduations: [{ date: '2024-07' }, { date: '2027-07' }] }
  assert.equal(checkGraduation({ graduation: { from: '2027-01', to: '2027-12' } }, two).status, 'green')
  assert.equal(checkGraduation({ graduation: { from: '2027-01', to: '2027-12' } }, {}).status, 'green')
})

// ─── language ─────────────────────────────────────────────────────────────────

const lang = (language, level, required = true) => ({ languages: [{ language, level, required }] })

test('language green: met, exceeded, native, nice-to-have, no level stated', () => {
  assert.equal(checkLanguage({}, PROFILE).status, 'green')
  assert.equal(checkLanguage(lang('English', 'C1'), PROFILE).status, 'green')
  assert.equal(checkLanguage(lang('english', 'c2'), PROFILE).status, 'green')          // case-insensitive
  assert.equal(checkLanguage(lang('Spanish', 'professional'), PROFILE).status, 'green')
  assert.equal(checkLanguage(lang('Spanish', 'conversational'), PROFILE).status, 'green')
  assert.equal(checkLanguage(lang('Portuguese', 'native'), PROFILE).status, 'green')   // native meets native
  assert.equal(checkLanguage(lang('German', 'C1', false), PROFILE).status, 'green')    // nice-to-have never blocks
  assert.equal(checkLanguage(lang('Spanish', null), PROFILE).status, 'green')          // having it is enough
})

test('language red: missing, or ≥ 2 steps below', () => {
  const missing = checkLanguage(lang('German', 'B2'), PROFILE)
  assert.equal(missing.status, 'red')
  assert.match(missing.reason, /not in your profile/)
  assert.equal(checkLanguage(lang('German', null), PROFILE).status, 'red')
  assert.equal(checkLanguage(lang('Spanish', 'C2'), PROFILE).status, 'red')     // B2 vs C2 = 2 steps
  assert.equal(checkLanguage(lang('Italian', 'C1'), PROFILE).status, 'red')     // B1 vs C1 = 2 steps
})

test('language red (amended rule): ANY shortfall when the requirement is C1 or higher', () => {
  assert.equal(checkLanguage(lang('Spanish', 'fluent'), PROFILE).status, 'red')  // B2 vs C1: 1 step, still red
  assert.equal(checkLanguage(lang('Spanish', 'C1'), PROFILE).status, 'red')
  assert.equal(checkLanguage(lang('English', 'native'), PROFILE).status, 'red')  // C2 vs native: 1 step, still red
})

test('language amber: exactly 1 step below a requirement of B2 or lower', () => {
  const r = checkLanguage(lang('Italian', 'B2'), PROFILE)                        // B1 vs B2
  assert.equal(r.status, 'amber')
  assert.match(r.question, /Italian at B1 \(vs\. B2 required\)/)
  assert.equal(checkLanguage(lang('Italian', 'business'), PROFILE).status, 'amber')
  const a2 = { languages: [{ language: 'Italian', level: 'A2' }] }
  assert.equal(checkLanguage(lang('Italian', 'B1'), a2).status, 'amber')          // A2 vs B1
  assert.equal(checkLanguage(lang('Italian', 'B2'), a2).status, 'red')            // A2 vs B2 = 2 steps
})

test('language: unparseable candidate level → amber; worst requirement wins; empty profile not checked', () => {
  const odd = { languages: [{ language: 'Dutch', level: 'decent' }] }
  assert.equal(checkLanguage(lang('Dutch', 'B2'), odd).status, 'amber')
  const multi = { languages: [
    { language: 'Italian', level: 'B2', required: true },   // amber
    { language: 'German', level: 'B1', required: true },    // red
  ] }
  const r = checkLanguage(multi, PROFILE)
  assert.equal(r.status, 'red')
  assert.match(r.reason, /German/)
  assert.match(r.reason, /Italian/)
  assert.equal(checkLanguage(lang('German', 'C1'), {}).status, 'green')
})

// ─── work_auth ────────────────────────────────────────────────────────────────

const wa = (country, work_auth = {}) => ({ country, work_auth })

test('work_auth green: EU-27, EEA, REMOTE-EU for an EU candidate', () => {
  for (const c of ['DE', 'pt', 'NO', 'IS', 'LI', 'EL']) assert.equal(checkWorkAuth(wa(c), PROFILE).status, 'green', c)
  assert.equal(checkWorkAuth(wa('REMOTE-EU'), PROFILE).status, 'green')
})

test('work_auth amber: CH for an EU candidate, whatever the sponsorship facts', () => {
  const r = checkWorkAuth(wa('CH', { sponsorship: 'not_offered', requires_existing_right: true }), PROFILE)
  assert.equal(r.status, 'amber')
  assert.match(r.question, /Swiss work permit/)
})

test('work_auth amber: not covered and sponsorship offered or unknown', () => {
  const offered = checkWorkAuth(wa('GB', { sponsorship: 'offered' }), PROFILE)
  assert.equal(offered.status, 'amber')
  assert.match(offered.question, /confirm visa sponsorship for GB/)
  const unknown = checkWorkAuth(wa('GB', { sponsorship: 'unknown' }), PROFILE)
  assert.equal(unknown.status, 'amber')
  assert.match(unknown.question, /Do you sponsor/)
  assert.equal(checkWorkAuth(wa('US'), PROFILE).status, 'amber')   // no work_auth facts = unknown
})

test('work_auth red: not covered AND existing right required / no sponsorship / below salary floor', () => {
  assert.equal(checkWorkAuth(wa('GB', { requires_existing_right: true, sponsorship: 'offered' }), PROFILE).status, 'red')
  assert.equal(checkWorkAuth(wa('GB', { sponsorship: 'not_offered' }), PROFILE).status, 'red')
  const floor = checkWorkAuth(wa('GB', { sponsorship: 'offered', below_sponsorship_salary_floor: true }), PROFILE)
  assert.equal(floor.status, 'red')
  assert.match(floor.reason, /salary floor/)
  // the same facts are harmless where the candidate is covered
  assert.equal(checkWorkAuth(wa('DE', { requires_existing_right: true, sponsorship: 'not_offered' }), PROFILE).status, 'green')
})

test('work_auth: ISO-code authorisations, UK alias, REMOTE-EU without EU auth, unknown country, empty profile', () => {
  const gbOnly = { work_authorisation: ['GB'] }
  assert.equal(checkWorkAuth(wa('UK'), gbOnly).status, 'green')
  assert.equal(checkWorkAuth(wa('REMOTE-EU', { sponsorship: 'not_offered' }), gbOnly).status, 'red')
  assert.equal(checkWorkAuth(wa('CH'), gbOnly).status, 'amber')       // plain "not covered, sponsorship unknown"
  assert.equal(checkWorkAuth(wa(null), PROFILE).status, 'amber')      // unknown is not green
  assert.equal(checkWorkAuth(wa('US', { sponsorship: 'not_offered' }), {}).status, 'green')
})

// ─── other (amended: agent-judged items) ──────────────────────────────────────

test('other: absent / empty → green', () => {
  assert.equal(checkOther({}).status, 'green')
  assert.equal(checkOther({ other: [] }).status, 'green')
  assert.equal(checkOther({ other: [{ status: 'green', reason: 'fine' }] }).status, 'green')
})

test('other: any amber entry → amber with its question; any red entry → red', () => {
  const amber = checkOther({ other: [{ status: 'amber', reason: 'STEM degree preferred', question: 'Does a business degree with a quant minor qualify?', text: 'STEM degree preferred' }] })
  assert.equal(amber.status, 'amber')
  assert.equal(amber.question, 'Does a business degree with a quant minor qualify?')
  assert.equal(amber.entries.length, 1)
  const red = checkOther({ other: [
    { status: 'amber', reason: 'enrolment', question: 'Is a graduate eligible?' },
    { status: 'red', reason: 'security clearance required' },
  ] })
  assert.equal(red.status, 'red')
  assert.match(red.reason, /clearance/)
})

test('other: amber without a question gets a fallback; unknown status counts as amber', () => {
  const r = checkOther({ other: [{ status: 'amber', reason: 'driving licence' }, { status: 'maybe', reason: 'on-call rota' }] })
  assert.equal(r.status, 'amber')
  assert.ok(r.entries.every(e => typeof e.question === 'string' && e.question.length > 0))
})

// ─── evaluateEligibility roll-up ──────────────────────────────────────────────

const GREEN_FACTS = {
  employment: 'internship',
  start: { earliest: '2027-06-15', latest: null, flexible: false, text: 'Start: June 2027' },
  duration_months: 6,
  graduation: { from: '2025-06', to: '2027-12', soft: false },
  languages: [{ language: 'English', level: 'C1', required: true }, { language: 'German', level: 'B2', required: false }],
  country: 'NL',
  work_auth: { requires_existing_right: false, sponsorship: 'unknown', below_sponsorship_salary_floor: false },
}

test('evaluateEligibility: a fully green listing', () => {
  const r = evaluateEligibility(GREEN_FACTS, PROFILE, { today: TODAY })
  assert.equal(r.status, 'green')
  assert.equal(r.amber_count, 0)
  assert.equal(r.blocking_reason, null)
  assert.deepEqual(r.checks.map(c => c.check), [...CHECK_ORDER])
  assert.ok(r.checks.every(c => c.status === 'green' && c.question === undefined))
  assert.equal(eligibilityFlags(r), '')
})

test('evaluateEligibility: a multi-amber listing — every amber has a question', () => {
  const facts = {
    ...GREEN_FACTS,
    start: { earliest: null },          // amber: internship start not stated
    duration_months: null,              // amber: internship length not stated
    country: 'GB',                      // amber: sponsorship unknown
    other: [{ status: 'amber', reason: 'STEM degree preferred', question: 'Is a non-STEM MSc accepted?' },
            { status: 'amber', reason: 'final-year students only', question: 'Are recent graduates eligible?' }],
  }
  const r = evaluateEligibility(facts, PROFILE, { today: TODAY })
  assert.equal(r.status, 'amber')
  assert.equal(r.amber_count, 5)        // 3 structured checks + 2 `other` entries
  const ambers = r.checks.filter(c => c.status === 'amber')
  assert.deepEqual(ambers.map(c => c.check), ['start_date', 'duration', 'work_auth', 'other'])
  assert.ok(ambers.every(c => typeof c.question === 'string' && c.question.length > 0))
  assert.equal(r.blocking_reason, null)
  const flags = eligibilityFlags(r).split(';')
  assert.equal(flags.length, 4)
  assert.ok(flags[0].startsWith('start_date:amber:'))
})

test('evaluateEligibility: worst status wins; red carries a blocking reason', () => {
  const r = evaluateEligibility({ ...GREEN_FACTS, languages: [{ language: 'German', level: 'C1', required: true }], duration_months: 2 }, PROFILE, { today: TODAY })
  assert.equal(r.status, 'red')
  assert.equal(r.amber_count, 1)        // the duration amber still counts
  assert.match(r.blocking_reason, /^language: German C1 required/)
  assert.equal(evaluateEligibility({ ...GREEN_FACTS, other: [{ status: 'red', reason: 'clearance' }] }, PROFILE, { today: TODAY }).status, 'red')
})

test('evaluateEligibility: empty profile gates nothing; null inputs are safe', () => {
  const r = evaluateEligibility({ employment: 'internship', country: 'US', languages: [{ language: 'Japanese', level: 'C1' }] }, {}, { today: TODAY })
  assert.equal(r.status, 'green')
  assert.equal(r.amber_count, 0)
  assert.equal(evaluateEligibility(null, null).status, 'green')
  // a real profile and no facts: unknown is not green
  const blind = evaluateEligibility({}, PROFILE, { today: TODAY })
  assert.equal(blind.status, 'amber')
  assert.deepEqual(blind.checks.filter(c => c.status === 'amber').map(c => c.check), ['start_date', 'work_auth'])
})

// ─── score_through_red ───────────────────────────────────────────────────────

const THROUGH = {
  ...PROFILE,
  score_through_red: { checks: ['start_date', 'work_auth'], languages: ['Spanish'], except_employment: ['working_student'] },
}

test('score_through_red: absent → a red listing is never scored', () => {
  const r = evaluateEligibility({ employment: 'internship', country: 'ES', languages: [{ language: 'German', level: 'C1', required: true }] }, PROFILE, { today: TODAY })
  assert.equal(r.status, 'red')
  assert.equal(r.scored, false)
  assert.equal(evaluateEligibility({ employment: 'internship', country: 'ES', duration_months: 6, start: { earliest: '2027-06-01' } }, PROFILE, { today: TODAY }).scored, true, 'non-red is always scored')
})

test('score_through_red: language reds only for the listed languages', () => {
  const lang = (language, level) => ({ employment: 'permanent', country: 'ES', languages: [{ language, level, required: true }] })
  const spanish = evaluateEligibility(lang('Spanish', 'C1'), THROUGH, { today: TODAY })
  assert.equal(spanish.status, 'red')
  assert.deepEqual(spanish.checks.find(c => c.check === 'language').red_languages, ['Spanish'])
  assert.equal(spanish.scored, true)
  assert.equal(evaluateEligibility(lang('German', 'C1'), THROUGH, { today: TODAY }).scored, false)
  const both = { employment: 'permanent', country: 'ES', languages: [{ language: 'Spanish', level: 'C1', required: true }, { language: 'German', level: 'B2', required: true }] }
  assert.equal(evaluateEligibility(both, THROUGH, { today: TODAY }).scored, false, 'every red language must be allowed')
})

test('score_through_red: every red check must be allowed; excepted employment types never score', () => {
  const lateStart = { employment: 'internship', country: 'ES', duration_months: 6, start: { earliest: '2027-02-01', flexible: false } }
  const r = evaluateEligibility(lateStart, THROUGH, { today: TODAY })
  assert.equal(r.status, 'red')
  assert.equal(r.scored, true)
  assert.equal(evaluateEligibility({ ...lateStart, employment: 'working_student' }, THROUGH, { today: TODAY }).scored, false)
  const plusGrad = { ...lateStart, graduation: { from: '2025-01', to: '2025-12', soft: false } }
  assert.equal(evaluateEligibility(plusGrad, THROUGH, { today: TODAY }).scored, false, 'graduation is not in checks')
  assert.equal(redIsScored([{ check: 'language', status: 'red' }], {}, THROUGH), false, 'a language red without names is not scored')
})

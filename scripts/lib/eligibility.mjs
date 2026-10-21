// eligibility.mjs — the scoring v2 eligibility gate (docs/scoring-v2.md §1).
//
// Eligibility is a gate, not a score. Before anyone argues about how well a
// role matches or how easy it is to get, ask: can this candidate take it
// at all? Most hand-caught misses in v1 were here: an internship that
// overlaps a study term, a "fluent German" requirement, a country that won't
// sponsor. v1 caught them through scattered exceptions (language-wall force
// Skip, geo/visa discards, a UK salary-floor gate, a visa-friction sub-table).
// v2 runs six explicit checks and returns green / amber / red:
//
//   red   → the listing is Blocked (no Match / Ease / Priority)
//   amber → scored normally, Ease −0.5 per amber (max −1.0), and every
//           amber carries the one question to ask the recruiter
//   green → no effect
//
// Pure: no I/O, no clock. The caller passes `today` (needed only for the
// "permanent role, no stated start" rule). JD facts come from the agent;
// `null` / missing = the JD doesn't say, and **unknown is not green** for
// the facts a check depends on.
//
// Profile fields that are absent mean "no constraint": a check whose
// profile data is missing is green with a "not checked" reason. So an
// empty profile (no `eligibility:` block in user/profile.yml) gates
// nothing: every listing is green.

/* ───── Reference data ──────────────────────────────────────────── */

// CEFR steps. A candidate's `native` (7) meets any requirement.
export const LEVEL_LADDER = Object.freeze({
  A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
  basic: 2,
  conversational: 3,
  professional: 4,
  business: 4,
  fluent: 5,
  native: 7,
})

// Required level at or above which ANY shortfall is red (amendment to §1.2:
// "fluent" / C1+ means the work happens in that language).
export const STRICT_LANGUAGE_LEVEL = LEVEL_LADDER.C1

export const EU27 = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])
export const EEA_NON_EU = Object.freeze(['IS', 'LI', 'NO'])
// What a profile's "EU" work authorisation expands to.
export const EU_EEA_COUNTRIES = Object.freeze(new Set([...EU27, ...EEA_NON_EU]))

export const CHECK_ORDER = Object.freeze(['start_date', 'duration', 'graduation', 'language', 'work_auth', 'other'])

// Permanent role, no stated start: amber only if a blocked window lies
// within this many months of today.
export const PERMANENT_LOOKAHEAD_MONTHS = 9

const RANK = { green: 0, amber: 1, red: 2 }
const COUNTRY_ALIASES = { UK: 'GB', EL: 'GR' }

/* ───── Helpers ─────────────────────────────────────────────────── */

/** Map a level string ("C1", "fluent", "b2") to its ladder step, or null. */
export function levelRank(level) {
  if (level == null) return null
  const s = String(level).trim()
  if (!s) return null
  const upper = s.toUpperCase()
  if (/^[ABC][12]$/.test(upper)) return LEVEL_LADDER[upper]
  const lower = s.toLowerCase()
  return Object.hasOwn(LEVEL_LADDER, lower) ? LEVEL_LADDER[lower] : null
}

const DAY = 86400000

// "YYYY-MM-DD" or "YYYY-MM" (first of month) → UTC ms; anything else → null.
function parseDate(s) {
  if (s == null) return null
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(s).trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1)
  return Number.isFinite(t) ? t : null
}

function addMonths(ms, months) {
  const whole = Math.trunc(months)
  const d = new Date(ms)
  d.setUTCMonth(d.getUTCMonth() + whole)
  return d.getTime() + Math.round((months - whole) * 30.44) * DAY
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

// Half-open overlap: [a1, a2) ∩ [b1, b2) ≠ ∅
const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2

const ym = (s) => {
  if (s == null) return null
  const m = /^(\d{4})-(\d{2})/.exec(String(s).trim())
  return m ? `${m[1]}-${m[2]}` : null
}

const normCountry = (c) => {
  if (c == null) return null
  const u = String(c).trim().toUpperCase()
  return COUNTRY_ALIASES[u] ?? u
}

function result(check, status, reason, question) {
  const out = { check, status, reason }
  if (status === 'amber') out.question = question ?? `Can you clarify: ${reason}?`
  return out
}

const EMPLOYMENT_NOUN = {
  internship: 'internship',
  graduate_programme: 'graduate programme',
  fixed_term: 'fixed-term role',
  permanent: 'permanent role',
  working_student: 'working-student role',
}

/* ───── Checks ──────────────────────────────────────────────────── */

/**
 * start_date — does the role's period fit around the candidate's
 * availability and blocked windows?
 */
export function checkStartDate(facts, profile, { today } = {}) {
  const avail = parseDate(profile?.available_from)
  const blocks = (profile?.blocked_windows ?? [])
    .map(b => ({ from: parseDate(b?.from), to: parseDate(b?.to), reason: b?.reason ?? null }))
    .filter(b => b.from != null && b.to != null)
    .map(b => ({ ...b, end: b.to + DAY })) // `to` is the last blocked day (inclusive)
  if (avail == null && blocks.length === 0) {
    return result('start_date', 'green', 'Not checked: no availability constraints in profile')
  }

  const start = facts?.start ?? {}
  const earliest = parseDate(start.earliest)
  const latest = parseDate(start.latest)
  const flexible = start.flexible === true
  const employment = facts?.employment ?? null
  const permanent = employment === 'permanent'
  const noun = EMPLOYMENT_NOUN[employment] ?? 'role'
  const blockLabel = (b) => `${iso(b.from)}–${iso(b.to)}${b.reason ? ` (${b.reason})` : ''}`

  // Window closes before the candidate is free — nothing to negotiate.
  if (latest != null && avail != null && latest < avail) {
    return result('start_date', 'red',
      `Latest start ${iso(latest)} is before you are available (${iso(avail)})`)
  }

  // No stated start.
  if (earliest == null) {
    if (!permanent) {
      return result('start_date', 'amber',
        `Start date not stated for this ${noun}`,
        `What is the start date for this ${noun}, and is it flexible?`)
    }
    const ref = parseDate(today) ?? avail
    if (ref == null) {
      // No reference date: any blocked window could be in range.
      return blocks.length > 0
        ? result('start_date', 'amber', 'Start date not stated and you have blocked windows',
            `When would this role start? You are unavailable ${blocks.map(blockLabel).join('; ')}.`)
        : result('start_date', 'green', 'Start date not stated; no blocked windows')
    }
    const horizon = addMonths(ref, PERMANENT_LOOKAHEAD_MONTHS)
    const soon = blocks.filter(b => overlaps(ref, horizon, b.from, b.end))
    if (soon.length > 0) {
      return result('start_date', 'amber',
        `Start date not stated; blocked window ${soon.map(blockLabel).join('; ')} within ${PERMANENT_LOOKAHEAD_MONTHS} months`,
        `When would this role start? You are unavailable ${soon.map(blockLabel).join('; ')}.`)
    }
    return result('start_date', 'green', `Start date not stated; no blocked window in the next ${PERMANENT_LOOKAHEAD_MONTHS} months`)
  }

  const ambers = []
  const questions = []
  let effStart = earliest
  if (avail != null && earliest < avail) {
    // latest ≥ avail (red case returned above), or latest unknown.
    effStart = avail
    if (latest != null) {
      ambers.push(`Earliest start ${iso(earliest)} is before you are available (${iso(avail)}); latest start ${iso(latest)} allows it`)
    } else {
      ambers.push(`Start ${iso(earliest)} is before you are available (${iso(avail)})`)
    }
    questions.push(`Could the start move to ${iso(avail)}?`)
  }

  // Role period: the full run for internships / fixed-term / graduate
  // programmes (just the start when the length is unknown — the duration
  // check flags that); for permanent roles, open-ended unless the candidate
  // is fine starting before a block.
  const duration = Number.isFinite(facts?.duration_months) ? facts.duration_months : null
  let periodEnd
  if (permanent) {
    periodEnd = profile?.permanent_start_ok_before_block === true ? effStart + DAY : Infinity
  } else {
    periodEnd = duration != null ? addMonths(effStart, duration) : effStart + DAY
  }
  const hits = blocks.filter(b => overlaps(effStart, periodEnd, b.from, b.end))
  if (hits.length > 0) {
    const period = periodEnd === Infinity
      ? `from ${iso(effStart)} (open-ended)`
      : periodEnd - effStart <= DAY ? `starting ${iso(effStart)}` : `${iso(effStart)}–${iso(periodEnd - DAY)}`
    const msg = `Role period ${period} overlaps blocked window ${hits.map(blockLabel).join('; ')}`
    if (!flexible) return result('start_date', 'red', msg)
    ambers.push(`${msg}, but the start is flexible`)
    const lastEnd = Math.max(...hits.map(b => b.to))
    questions.push(`Could the start move to after ${iso(lastEnd)}?`)
  }

  if (ambers.length > 0) {
    return result('start_date', 'amber', ambers.join('; '), questions.join(' '))
  }
  return result('start_date', 'green', `Starts ${iso(effStart)}, clear of blocked windows`)
}

// Employment types that can carry their own length range (a permanent role
// has no length).
export const DURATION_TYPES = Object.freeze(['internship', 'graduate_programme', 'fixed_term', 'working_student'])

const bounds = (r) => ({
  min: Number.isFinite(r?.min) ? r.min : null,
  max: Number.isFinite(r?.max) ? r.max : null,
})
const isRange = (r) => r != null && typeof r === 'object' && !Array.isArray(r)

/**
 * The accepted length range for one employment type. `duration_months` is
 * either one range for every type (`{ min, max }`, the original form) or a
 * range per type, with `default` (else a top-level min / max) for the types
 * it doesn't list:
 *
 *   duration_months:
 *     default:            { min: 3, max: 12 }
 *     graduate_programme: { min: 12, max: 24 }
 *
 * The type is the JD's `employment` fact, the same field the other checks
 * read. Returns { min, max, type }: `type` is the key whose range applies
 * (`default` for the fallback, null when the profile sets no range).
 */
export function durationRangeFor(profile, employment) {
  const dm = profile?.duration_months
  if (!isRange(dm)) return { min: null, max: null, type: null }
  if (DURATION_TYPES.includes(employment) && isRange(dm[employment])) {
    return { ...bounds(dm[employment]), type: employment }
  }
  return { ...bounds(isRange(dm.default) ? dm.default : dm), type: 'default' }
}

/** duration — fixed-term / internship / programme length vs. the acceptable range for its type. */
export function checkDuration(facts, profile) {
  const employment = facts?.employment ?? null
  const { min, max, type } = durationRangeFor(profile, employment)
  if (min == null && max == null) {
    return result('duration', 'green', 'Not checked: no duration range in profile')
  }
  if (employment === 'permanent') return result('duration', 'green', 'Not applicable (permanent role)')
  const d = Number.isFinite(facts?.duration_months) ? facts.duration_months : null
  const rangeLabel = `${min ?? '…'}–${max ?? '…'} months`
  const forType = type !== 'default' ? ` for a ${EMPLOYMENT_NOUN[type]}` : ''
  if (d == null) {
    if (employment === 'internship') {
      return result('duration', 'amber', 'Internship length not stated',
        `How long is the internship? You can do ${rangeLabel}.`)
    }
    return result('duration', 'green', 'Length not stated (not required for this employment type)')
  }
  if ((min != null && d < min) || (max != null && d > max)) {
    return result('duration', 'amber', `${d} months is outside your accepted range${forType} (${rangeLabel})`,
      `Is the ${d}-month length negotiable? You can do ${rangeLabel}.`)
  }
  return result('duration', 'green', `${d} months is inside your accepted range${forType} (${rangeLabel})`)
}

/** graduation — "must have graduated / be graduating between from..to". */
export function checkGraduation(facts, profile) {
  const from = ym(facts?.graduation?.from)
  const to = ym(facts?.graduation?.to)
  if (!from && !to) return result('graduation', 'green', 'No graduation window')
  const dates = (profile?.graduations ?? []).map(g => ym(g?.date)).filter(Boolean)
  if (dates.length === 0) return result('graduation', 'green', 'Not checked: no graduation dates in profile')
  const window = `${from ?? '…'} to ${to ?? '…'}`
  const inside = dates.some(d => (!from || d >= from) && (!to || d <= to))
  if (inside) return result('graduation', 'green', `Your graduation date falls inside ${window}`)
  const msg = `Graduation window ${window}; your graduation date(s) ${dates.join(', ')} fall outside it`
  if (facts.graduation.soft === true) {
    return result('graduation', 'amber', `${msg} (soft requirement)`,
      `Is the ${window} graduation window a hard requirement? You graduate ${dates.join(', ')}.`)
  }
  return result('graduation', 'red', msg)
}

/**
 * language — required languages vs. the candidate's levels.
 *   red:   missing; or ≥2 steps below; or below at all when the requirement
 *          is C1 or higher (fluent / C2 / native)
 *   amber: 1 step below a requirement of B2 or lower; or the candidate's own
 *          level for that language isn't on the ladder
 *   `required: false` languages never block; a required language with no
 *   stated level is met by having it at all.
 */
export function checkLanguage(facts, profile) {
  const required = (facts?.languages ?? []).filter(l => l && l.language && l.required !== false)
  if (required.length === 0) return result('language', 'green', 'No required languages')
  const mine = profile?.languages ?? []
  if (mine.length === 0) return result('language', 'green', 'Not checked: no languages in profile')
  const find = (name) => mine.find(m => String(m?.language ?? '').trim().toLowerCase() === String(name).trim().toLowerCase())

  const reds = [], ambers = [], questions = [], redLanguages = []
  for (const req of required) {
    const have = find(req.language)
    const reqLabel = req.level ? `${req.language} ${req.level}` : req.language
    if (!have) { reds.push(`${reqLabel} required; not in your profile`); redLanguages.push(req.language); continue }
    const r = levelRank(req.level)
    if (r == null) continue // no level stated: having the language is enough
    const c = levelRank(have.level)
    if (c == null) {
      ambers.push(`${reqLabel} required; your ${req.language} level is not on the CEFR ladder`)
      questions.push(`Is ${req.language} at ${have.level ?? 'your level'} enough for this role?`)
      continue
    }
    const gap = r - c
    if (gap <= 0) continue
    const msg = `${reqLabel} required; you have ${have.level} (${gap} step${gap > 1 ? 's' : ''} below)`
    if (gap >= 2 || r >= STRICT_LANGUAGE_LEVEL) { reds.push(msg); redLanguages.push(req.language) }
    else {
      ambers.push(msg)
      questions.push(`Is ${req.language} at ${have.level} (vs. ${req.level} required) acceptable for this role?`)
    }
  }
  if (reds.length > 0) return { ...result('language', 'red', [...reds, ...ambers].join('; ')), red_languages: redLanguages }
  if (ambers.length > 0) return result('language', 'amber', ambers.join('; '), questions.join(' '))
  return result('language', 'green', 'All required languages met')
}

/** work_auth — right to work in the role's country. */
export function checkWorkAuth(facts, profile) {
  const raw = profile?.work_authorisation
  const auth = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(normCountry).filter(Boolean)
  if (auth.length === 0) return result('work_auth', 'green', 'Not checked: no work authorisation in profile')
  const hasEU = auth.includes('EU')
  const covered = new Set(auth.filter(a => a !== 'EU'))
  if (hasEU) for (const c of EU_EEA_COUNTRIES) covered.add(c)

  const country = normCountry(facts?.country)
  if (!country) {
    return result('work_auth', 'amber', 'Work location country not stated',
      'Which country is this role based in, and do you sponsor work visas there?')
  }
  if (country === 'REMOTE-EU') {
    if (hasEU) return result('work_auth', 'green', 'Remote within the EU; you have EU work authorisation')
  } else if (covered.has(country)) {
    return result('work_auth', 'green', `You are authorised to work in ${country}`)
  }

  // Switzerland for an EU/EEA national: free movement applies but a permit
  // is still needed. Always amber, whatever the sponsorship facts say.
  if (country === 'CH' && hasEU) {
    return result('work_auth', 'amber', 'Switzerland: EU nationals need a Swiss work permit',
      'Will you arrange the Swiss work permit (L/B) for an EU national?')
  }

  const wa = facts?.work_auth ?? {}
  const where = country === 'REMOTE-EU' ? 'the EU' : country
  const reds = []
  if (wa.requires_existing_right === true) reds.push(`requires an existing right to work in ${where}`)
  if (wa.sponsorship === 'not_offered') reds.push('sponsorship not offered')
  if (wa.below_sponsorship_salary_floor === true) reds.push('comp is below the sponsored-visa salary floor')
  if (reds.length > 0) {
    return result('work_auth', 'red', `Not authorised to work in ${where}: ${reds.join('; ')}`)
  }
  if (wa.sponsorship === 'offered') {
    return result('work_auth', 'amber', `Not authorised to work in ${where}; sponsorship offered`,
      `Can you confirm visa sponsorship for ${where} is available for this role?`)
  }
  return result('work_auth', 'amber', `Not authorised to work in ${where}; sponsorship unknown`,
    `Do you sponsor work visas for ${where}?`)
}

/**
 * other — agent-judged items the five structured checks don't model (degree
 * field, enrolment status, clearances…). Each entry is
 * { status: "amber"|"red", reason, question, text }. Any red → red; any
 * amber → amber. Entries with an unrecognised status count as amber
 * (unknown is not green); `green` entries are ignored.
 * Returns the check plus `entries` (the non-green items, each with its own
 * question); each amber entry counts once toward amber_count.
 */
export function checkOther(facts) {
  const items = (facts?.other ?? []).filter(i => i && i.status !== 'green')
  if (items.length === 0) return { ...result('other', 'green', 'No other requirements flagged'), entries: [] }
  const entries = items.map(i => {
    const status = i.status === 'red' ? 'red' : 'amber'
    const reason = i.reason ?? i.text ?? 'unspecified requirement'
    const e = { status, reason }
    if (i.text) e.text = i.text
    if (status === 'amber') e.question = i.question ?? `Can you clarify: ${reason}?`
    return e
  })
  const reds = entries.filter(e => e.status === 'red')
  const ambers = entries.filter(e => e.status === 'amber')
  const out = reds.length > 0
    ? result('other', 'red', entries.map(e => e.reason).join('; '))
    : result('other', 'amber', ambers.map(e => e.reason).join('; '), ambers.map(e => e.question).join(' '))
  return { ...out, entries }
}

/* ───── Entry point ─────────────────────────────────────────────── */

/**
 * Run every check and roll up.
 *
 *   facts    eligibility_facts from the JD (spec §1.1); null/{} allowed
 *   profile  the `eligibility:` block of user/profile.yml; null/{} = no gate
 *   opts     { today: "YYYY-MM-DD" } — reference date for the permanent-role
 *            look-ahead (falls back to profile.available_from)
 *
 * Returns { status, amber_count, checks, blocking_reason }
 *   status          worst status across checks
 *   amber_count     amber checks among the five structured ones, plus one
 *                   per amber entry in `other`
 *   checks          six results in CHECK_ORDER: { check, status, reason, question? }
 *   blocking_reason the first red check's reason (null unless red)
 */
export function evaluateEligibility(facts, profile, opts = {}) {
  const f = facts ?? {}
  const p = profile ?? {}
  const other = checkOther(f)
  const checks = [
    checkStartDate(f, p, opts),
    checkDuration(f, p),
    checkGraduation(f, p),
    checkLanguage(f, p),
    checkWorkAuth(f, p),
    other,
  ]
  let status = 'green'
  for (const c of checks) if (RANK[c.status] > RANK[status]) status = c.status
  const amber_count =
    checks.filter(c => c.check !== 'other' && c.status === 'amber').length +
    other.entries.filter(e => e.status === 'amber').length
  // With a score_through_red rule, mark each red check scorable or not, so
  // the reason shown for an unscored listing is the wall that kept it
  // unscored (a French requirement), not one the rule lets through (a start
  // date) that merely comes first in CHECK_ORDER.
  const hasRule = p.score_through_red && typeof p.score_through_red === 'object'
  if (hasRule) {
    for (const c of checks) if (c.status === 'red') c.scorable = redIsScored([c], f, p)
  }
  const scored = status !== 'red' || redIsScored(checks, f, p)
  const red = (!scored && checks.find(c => c.status === 'red' && c.scorable === false))
    || checks.find(c => c.status === 'red')
  return {
    status,
    amber_count,
    checks,
    blocking_reason: red ? `${red.check}: ${red.reason}` : null,
    scored,
  }
}

/**
 * Whether a red listing still gets Match / Ease (profile
 * `eligibility.score_through_red`). Red stays red: the verdict is Blocked and
 * the flag shows; the scores only fill in the market picture for a wall the
 * candidate could plausibly clear later (a start date that may move, a
 * language they are learning). Every red check must be allowed:
 *
 *   score_through_red:
 *     checks: [start_date, duration, graduation, work_auth, other]
 *     languages: [<language>]          # a language red is scored only for these
 *     except_employment: [working_student]   # never scored, whatever the red
 *
 * No block (the default) → no red listing is scored.
 */
export function redIsScored(checks, facts, profile) {
  const cfg = profile?.score_through_red
  if (!cfg || typeof cfg !== 'object') return false
  const lower = (xs) => new Set((Array.isArray(xs) ? xs : []).map(x => String(x).trim().toLowerCase()))
  const allowedChecks = lower(cfg.checks)
  const allowedLanguages = lower(cfg.languages)
  if (lower(cfg.except_employment).has(String(facts?.employment ?? '').toLowerCase())) return false
  const reds = (checks ?? []).filter(c => c.status === 'red')
  if (reds.length === 0) return false
  return reds.every(c => c.check === 'language'
    ? (c.red_languages ?? []).length > 0 && c.red_languages.every(l => allowedLanguages.has(String(l).toLowerCase()))
    : allowedChecks.has(c.check))
}

/**
 * The `eligibility_flags` cell for score-history.tsv (spec §8.1):
 * `check:status:reason` for every non-green check, `;`-joined. Semicolons
 * and tabs inside reasons are replaced so the cell stays splittable.
 */
export function eligibilityFlags(eligibility) {
  // Reds that kept the listing unscored lead (the app shows the first red as
  // the reason); otherwise CHECK_ORDER.
  const lead = (c) => (c.status === 'red' && c.scorable === false ? 0 : 1)
  return (eligibility?.checks ?? [])
    .filter(c => c.status !== 'green')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => lead(a.c) - lead(b.c) || a.i - b.i)
    .map(({ c }) => c)
    .map(c => `${c.check}:${c.status}:${String(c.reason).replace(/[;\t\n]+/g, ',')}`)
    .join(';')
}

/**
 * outcome-stats.mjs — what happened to the applications the user sent, and
 * what may (and may not) be concluded from it.
 *
 * CONTRACT: docs/scoring-statistical-design.md § 3.7. Gates and classification
 * constants come from scoring-stats.mjs (OUTCOME_GATES / OUTCOME_RULES); never
 * restate them here.
 *
 * Inputs, all already parsed (the CLI scripts/outcomes.mjs reads the files):
 *   applications  tracker rows { num, date, company, role, status, notes, report }
 *   ledger        status-log rows { num, date, company, role, from, to, stage, source, note }
 *   scores        score-history rows (targeting-core parseScoreHistory)
 *   materials     the user's materials index rows, header-named
 *                 { company, role, app_num, sent, tailored, materials, notes } (optional)
 *   sizes         Map applicationKey → company-size bucket (optional)
 *
 * Joined on applicationKey (application-key.mjs). Every application that
 * reached the market becomes one record with its outcome, dates (exact or
 * approximate), timing and the context an agent needs to interpret it (the
 * "why" table). Slices carry describeSample(); below a gate the raw counts
 * stay (facts) and every rate / timing / gap conclusion is withheld.
 *
 * Pure: no I/O, `today` is injected. Unit-tested in outcome-stats.test.mjs.
 */

import { applicationKey, groupByApplication, indexByApplication, lookupApplication } from './application-key.mjs'
import { EASE_HIGH, EASE_MID } from './score-bands.mjs'
import { OUTCOME_GATES, OUTCOME_RULES, describeSample } from './scoring-stats.mjs'

/* ───── Vocabulary ───────────────────────────────────────────────── */

export const OUTCOMES = Object.freeze(['progressed', 'rejected', 'no-response', 'pending', 'withdrawn'])
export const EASE_BANDS = Object.freeze(['low', 'mid', 'high'])
export const SLICE_DIMS = Object.freeze(['easeBand', 'archetype', 'city', 'companySize'])

/** How far an application got, by status. Rejected / Discarded say nothing about reach. */
const REACH = Object.freeze({ Applied: 1, Responded: 2, Interview: 3, Offer: 4 })
const REACH_NAMES = ['', 'Applied', 'Responded', 'Interview', 'Offer']
const SENT_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected'])

/** The verdict grid's Ease column (score-bands EASE_MID / EASE_HIGH); 'unscored' without an Ease. */
export function easeBand(ease) {
  const e = Number(ease)
  if (ease === null || ease === undefined || ease === '' || !Number.isFinite(e)) return 'unscored'
  if (e >= EASE_HIGH) return 'high'
  if (e >= EASE_MID) return 'mid'
  return 'low'
}

/* ───── Dates ────────────────────────────────────────────────────── */

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isIso = (d) => ISO.test(String(d ?? ''))

/** Whole days from a to b (YYYY-MM-DD), or null. */
export function daysBetween(a, b) {
  if (!isIso(a) || !isIso(b)) return null
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/**
 * Is a ledger row's date exact? Backfilled rows carry the tracker row's date,
 * so they are approximate — unless the user corrected them since (planAmend
 * adds "corrected <date>" to the note).
 */
export function ledgerDateExact(entry) {
  if (!entry || !isIso(entry.date)) return false
  if (/\bcorrected \d{4}-\d{2}-\d{2}/.test(String(entry.note ?? ''))) return true
  return entry.source !== 'backfill'
}

/** 'fast' | 'normal' | 'late' for an exact days-to-rejection, else null. */
export function rejectionTiming(days, rules = OUTCOME_RULES) {
  if (days === null || days === undefined || !Number.isFinite(days)) return null
  if (days <= rules.fastRejectionDays) return 'fast'
  if (days > rules.lateRejectionDays) return 'late'
  return 'normal'
}

/* ───── One application ──────────────────────────────────────────── */

function chronological(entries) {
  return entries
    .map((e, i) => ({ e, i: e._i ?? i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map((x) => x.e)
}

function cityOf(location) {
  const first = String(location ?? '').split(/[,;/|]/)[0].trim()
  return first || 'unknown'
}

function latestScore(prev, next) {
  return String(next.date ?? '') >= String(prev.date ?? '') ? next : prev
}

/**
 * Build one record, or null when the application never reached the market
 * (only Evaluated / SKIP, or Discarded / Rejected straight from Evaluated).
 */
export function buildRecord(app, { history = [], score = null, material = null, size = null, today, rules = OUTCOME_RULES } = {}) {
  const hist = chronological(history)
  const statuses = new Set([app.status, ...hist.map((e) => e.to), ...hist.map((e) => e.from)].filter(Boolean))
  const rejection = [...hist].reverse().find((e) => e.to === 'Rejected') ?? null
  const rejectedFromEvaluated = rejection?.from === 'Evaluated'
  const sent = [...statuses].some((s) => SENT_STATUSES.has(s) && s !== 'Rejected') ||
    (statuses.has('Rejected') && !rejectedFromEvaluated)
  if (!sent) return null

  let reach = 0
  for (const s of statuses) reach = Math.max(reach, REACH[s] ?? 0)
  if (reach === 0) reach = 1 // rejected after applying: reached Applied

  // Sent date: the materials index, else the logged move to Applied, else the
  // tracker row. An application that predates the status log (no history, or
  // a backfilled origin row) was reconstructed, so a materials date for it is
  // approximate too; an exact logged move then wins over it.
  const appliedMove = hist.find((e) => e.to === 'Applied')
  const predatesLog = !hist.length || hist.some((e) => e.from === '' && e.source === 'backfill')
  const materialSent = material && isIso(material.sent) ? material.sent : null
  let sentDate = null, sentExact = false, sentSource = null
  if (materialSent && !predatesLog) {
    sentDate = materialSent; sentExact = true; sentSource = 'materials'
  } else if (appliedMove && isIso(appliedMove.date) && ledgerDateExact(appliedMove)) {
    sentDate = appliedMove.date; sentExact = true; sentSource = 'ledger'
  } else if (materialSent) {
    sentDate = materialSent; sentExact = false; sentSource = 'materials'
  } else if (appliedMove && isIso(appliedMove.date)) {
    sentDate = appliedMove.date; sentExact = false; sentSource = 'ledger'
  } else if (isIso(app.date)) {
    sentDate = app.date; sentExact = false; sentSource = 'tracker'
  }

  let rejected = null
  if (rejection && !rejectedFromEvaluated) {
    const exact = sentExact && ledgerDateExact(rejection)
    const days = daysBetween(sentDate, rejection.date)
    rejected = {
      date: rejection.date,
      exact,
      days,
      timing: exact ? rejectionTiming(days, rules) : null,
      stage: rejection.stage || rejection.from || 'unknown',
      explicitStage: Boolean(rejection.stage),
    }
  }

  // Rejected in the tracker but never logged (a row older than the log):
  // a rejection with no date, so it counts but is never timed.
  if (!rejected && app.status === 'Rejected' && !rejection) {
    rejected = { date: null, exact: false, days: null, timing: null, stage: 'unknown', explicitStage: false }
  }

  const reply = hist.find((e) => ['Responded', 'Interview', 'Offer', 'Rejected'].includes(e.to) && e.from !== '' && !(e.to === 'Rejected' && e.from === 'Evaluated'))
  const firstReply = reply
    ? { date: reply.date, exact: sentExact && ledgerDateExact(reply), days: daysBetween(sentDate, reply.date), to: reply.to }
    : null

  const daysSinceSent = daysBetween(sentDate, today)
  let outcome
  if (reach >= REACH.Responded) outcome = 'progressed'
  else if (rejected) outcome = 'rejected'
  else if (app.status === 'Discarded') outcome = 'withdrawn'
  else if (daysSinceSent !== null && daysSinceSent >= rules.noResponseDays) outcome = 'no-response'
  else outcome = 'pending'

  const ease = Number.isFinite(score?.ease) ? score.ease : null
  const band = easeBand(ease)
  const notes = [
    app.notes,
    ...hist.filter((e) => e.stage || (e.note && e.source !== 'backfill')).map((e) => [e.to, e.stage, e.note].filter(Boolean).join(': ')),
    material?.notes,
  ].map((s) => String(s ?? '').trim()).filter(Boolean)

  return {
    key: applicationKey(app.company, app.role),
    num: app.num,
    company: app.company,
    role: app.role,
    status: app.status,
    archetype: score?.archetype || 'unknown',
    city: cityOf(score?.location),
    companySize: size || 'unknown',
    match: Number.isFinite(score?.match) ? score.match : null,
    ease,
    easeBand: band,
    verdict: score?.verdict || null,
    sentDate,
    sentExact,
    sentSource,
    daysSinceSent,
    reach: REACH_NAMES[reach],
    outcome,
    rejected,
    firstReply,
    materials: String(material?.materials ?? '').trim(),
    tailored: isIso(material?.tailored) ? material.tailored : null,
    notes,
    agreement: agreementOf(band, outcome, rejected),
  }
}

/**
 * Does this one outcome agree with its Ease band? A label for the why-table,
 * never a conclusion: one application is an anecdote.
 */
export function agreementOf(band, outcome, rejected) {
  if (band === 'unscored' || outcome === 'pending' || outcome === 'withdrawn') return ''
  if (band === 'high' && outcome === 'progressed') return 'agrees'
  if (band === 'low' && outcome !== 'progressed') return 'agrees'
  if (band === 'high' && rejected?.timing === 'fast') return 'surprise: high Ease, fast rejection'
  if (band === 'high') return 'surprise: high Ease, did not progress'
  if (band === 'low' && outcome === 'progressed') return 'surprise: low Ease, progressed'
  return ''
}

/* ───── Slices ───────────────────────────────────────────────────── */

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function rate(k, sample) {
  return { k, n: sample.n, value: sample.sufficient && sample.n > 0 ? k / sample.n : null }
}

/**
 * Counts (always) and gated claims (only when their sample clears the gate)
 * over a set of records.
 */
export function sliceStats(records, gates = OUTCOME_GATES) {
  const by = (o) => records.filter((r) => r.outcome === o).length
  const progressed = by('progressed')
  const rejected = by('rejected')
  const noResponse = by('no-response')
  const resolved = progressed + rejected + noResponse
  const interview = records.filter((r) => r.reach === 'Interview' || r.reach === 'Offer').length
  const offer = records.filter((r) => r.reach === 'Offer').length
  const sample = describeSample(resolved, gates.minResolved)

  const timedRecs = records.filter((r) => r.outcome === 'rejected' && r.rejected?.exact && Number.isFinite(r.rejected.days))
  const timedSample = describeSample(timedRecs.length, gates.minTimedRejections)
  const tally = (t) => timedRecs.filter((r) => r.rejected.timing === t).length
  const fast = tally('fast')

  return {
    counts: {
      applications: records.length,
      pending: by('pending'),
      withdrawn: by('withdrawn'),
      resolved, progressed, rejected, noResponse, interview, offer,
    },
    sample,
    rates: {
      reply: rate(progressed + rejected, sample),
      progress: rate(progressed, sample),
      interview: rate(interview, sample),
    },
    timing: {
      sample: timedSample,
      fast,
      normal: tally('normal'),
      late: tally('late'),
      untimed: records.filter((r) => r.outcome === 'rejected').length - timedRecs.length,
      fastShare: timedSample.sufficient ? fast / timedSample.n : null,
      medianDays: timedSample.sufficient ? median(timedRecs.map((r) => r.rejected.days)) : null,
    },
  }
}

/** Slices by one dimension: [{ value, ...sliceStats }], largest first. */
export function sliceBy(records, dim, gates = OUTCOME_GATES) {
  const groups = new Map()
  for (const r of records) {
    const v = r[dim] ?? 'unknown'
    if (!groups.has(v)) groups.set(v, [])
    groups.get(v).push(r)
  }
  return [...groups.entries()]
    .map(([value, recs]) => ({ value, ...sliceStats(recs, gates) }))
    .sort((a, b) => b.counts.applications - a.counts.applications || String(a.value).localeCompare(String(b.value)))
}

/* ───── The Ease check (docs § 3.7 "What counts as a gap") ──────── */

function bandCounts(records, band) {
  const recs = records.filter((r) => r.easeBand === band && ['progressed', 'rejected', 'no-response'].includes(r.outcome))
  return { n: recs.length, progressed: recs.filter((r) => r.outcome === 'progressed').length }
}

/** Resolved, scored records split at the median sent date into [earlier, later]. */
export function chronologicalHalves(records) {
  const resolved = records
    .filter((r) => r.easeBand !== 'unscored' && ['progressed', 'rejected', 'no-response'].includes(r.outcome))
    .sort((a, b) => String(a.sentDate ?? '').localeCompare(String(b.sentDate ?? '')) || a.num - b.num)
  const mid = Math.floor(resolved.length / 2)
  return [resolved.slice(0, mid), resolved.slice(mid)]
}

const share = (c) => (c.n ? c.progressed / c.n : 0)

/**
 * Compare a lower and a higher Ease band. Status:
 *   insufficient    a band is under minResolved (shortfall stated)
 *   agrees          the higher band progresses at least as often
 *   within-resolution  inverted, but one application per band would undo it
 *   not-persistent  inverted overall, not in both halves (or a half is too thin)
 *   gap             all conditions hold — the only status that may suggest a change
 */
export function compareBands(records, lower, higher, gates = OUTCOME_GATES) {
  const lo = bandCounts(records, lower)
  const hi = bandCounts(records, higher)
  const base = { kind: 'inversion', lower, higher, lowerCounts: lo, higherCounts: hi }
  const short = [[lower, lo], [higher, hi]].filter(([, c]) => c.n < gates.minResolved)
  if (short.length) {
    return { ...base, status: 'insufficient', shortfall: short.map(([b, c]) => ({ band: b, n: c.n, gate: gates.minResolved })) }
  }
  if (share(hi) >= share(lo)) return { ...base, status: 'agrees' }
  const robust = (hi.progressed + 1) / hi.n < (lo.progressed - 1) / lo.n
  if (!robust) return { ...base, status: 'within-resolution' }
  const halves = chronologicalHalves(records).map((half) => ({ lo: bandCounts(half, lower), hi: bandCounts(half, higher) }))
  const thin = halves.some((h) => h.lo.n < gates.minPerHalfBand || h.hi.n < gates.minPerHalfBand)
  const holds = halves.every((h) => share(h.hi) < share(h.lo))
  if (thin || !holds) return { ...base, status: 'not-persistent', halves, thinHalf: thin }
  return { ...base, status: 'gap', halves }
}

/** The high band claims to be the easiest; zero progressions there is § 3.4's zero-conversion rule. */
export function highNeverProgresses(records, gates = OUTCOME_GATES) {
  const hi = bandCounts(records, 'high')
  const base = { kind: 'high-no-progress', band: 'high', counts: hi }
  if (hi.n < gates.minResolved) return { ...base, status: 'insufficient', shortfall: [{ band: 'high', n: hi.n, gate: gates.minResolved }] }
  if (hi.progressed > 0) return { ...base, status: 'agrees' }
  const halves = chronologicalHalves(records).map((half) => bandCounts(half, 'high'))
  if (halves.some((h) => h.n < gates.minPerHalfBand)) return { ...base, status: 'not-persistent', halves, thinHalf: true }
  return { ...base, status: 'gap', halves }
}

export function easeCheck(records, gates = OUTCOME_GATES) {
  const comparisons = [
    compareBands(records, 'low', 'mid', gates),
    compareBands(records, 'mid', 'high', gates),
    compareBands(records, 'low', 'high', gates),
    highNeverProgresses(records, gates),
  ]
  return { comparisons, gaps: comparisons.filter((c) => c.status === 'gap') }
}

/**
 * A confirmed gap as a suggestion. The id is stable across runs (kind and
 * bands, never counts) so a later inbox or the user can track it.
 */
export function gapSuggestion(gap) {
  if (gap.kind === 'high-no-progress') {
    return {
      id: 'outcomes:ease:high-no-progress',
      source: 'outcomes',
      kind: 'suggestion',
      title: 'High-Ease applications are not getting past screening',
      body: `None of ${gap.counts.n} resolved applications scored Ease ≥ ${EASE_HIGH} progressed, in both halves of the search. Ease may be over-crediting something employers screen on. Review the Ease dimensions of these applications (Skills Match, Experience bar, Competition) and consider \`scoring.ease_weights\` in user/profile.yml.`,
      target: 'user/profile.yml',
      evidence: gap,
    }
  }
  const pct = (c) => `${c.progressed} of ${c.n}`
  return {
    id: `outcomes:ease:inversion:${gap.lower}-${gap.higher}`,
    source: 'outcomes',
    kind: 'suggestion',
    title: `${cap(gap.higher)}-Ease applications progress less often than ${gap.lower}-Ease ones`,
    body: `${cap(gap.higher)} Ease progressed ${pct(gap.higherCounts)}; ${gap.lower} Ease ${pct(gap.lowerCounts)}, in both halves of the search. Ease is ranking these the wrong way round. Compare the applications in the why-table, and consider \`scoring.ease_weights\` in user/profile.yml or the archetype framing in user/_profile.md.`,
    target: 'user/profile.yml',
    evidence: gap,
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/* ───── Everything ───────────────────────────────────────────────── */

/**
 * The whole analysis. `today` is YYYY-MM-DD; `rules` may override
 * noResponseDays (user/profile.yml `outcomes.no_response_days`).
 */
export function analyzeApplicationOutcomes({ applications = [], ledger = [], scores = [], materials = [], sizes = new Map(), today, rules = {}, gates = OUTCOME_GATES } = {}) {
  const r = { ...OUTCOME_RULES, ...Object.fromEntries(Object.entries(rules).filter(([, v]) => Number.isFinite(v) && v > 0)) }
  const history = groupByApplication(ledger)
  const scoreIndex = indexByApplication(scores.filter((s) => s && s.company && s.role), { pick: latestScore })
  const materialIndex = indexByApplication(materials)
  const materialByNum = new Map(materials.filter((m) => m.app_num !== undefined && m.app_num !== '').map((m) => [Number(m.app_num), m]))

  const records = []
  for (const app of applications) {
    const key = applicationKey(app.company, app.role)
    if (!key) continue
    const byNum = materialByNum.get(Number(app.num))
    const material = byNum && applicationKey(byNum.company, byNum.role) === key ? byNum : lookupApplication(materialIndex, app.company, app.role) ?? null
    // A reused number never borrows another listing's history (same guard as status-ledger entryMatches).
    const hist = (history.get(key) ?? []).filter((e) => !e.num || !app.num || Number(e.num) === Number(app.num))
    const rec = buildRecord(app, {
      history: hist,
      score: lookupApplication(scoreIndex, app.company, app.role) ?? null,
      material,
      size: sizes.get(key) ?? null,
      today,
      rules: r,
    })
    if (rec) records.push(rec)
  }
  records.sort((a, b) => String(a.sentDate ?? '').localeCompare(String(b.sentDate ?? '')) || a.num - b.num)

  const check = easeCheck(records, gates)
  return {
    today,
    rules: r,
    gates: { ...gates },
    overall: sliceStats(records, gates),
    slices: Object.fromEntries(SLICE_DIMS.map((d) => [d, sliceBy(records, d, gates)])),
    easeCheck: check,
    suggestions: check.gaps.map(gapSuggestion),
    records,
  }
}

/**
 * Rejection patterns for the patterns mode: where rejections happen (stage),
 * how fast (timing, gated), and per slice. Read from the status log via the
 * records, never from status text.
 */
export function rejectionPatterns(result) {
  const rejectedRecs = result.records.filter((r) => r.rejected)
  const byStage = new Map()
  for (const r of rejectedRecs) {
    const k = r.rejected.stage
    byStage.set(k, (byStage.get(k) ?? 0) + 1)
  }
  return {
    rejections: rejectedRecs.length,
    afterProgress: rejectedRecs.filter((r) => r.outcome === 'progressed').length,
    byStage: [...byStage.entries()].map(([stage, n]) => ({ stage, n })).sort((a, b) => b.n - a.n || a.stage.localeCompare(b.stage)),
    timing: result.overall.timing,
    slices: Object.fromEntries(Object.entries(result.slices).map(([dim, list]) => [
      dim,
      list.filter((s) => s.counts.rejected > 0).map((s) => ({ value: s.value, rejected: s.counts.rejected, resolved: s.counts.resolved, sample: s.sample, timing: s.timing })),
    ])),
    gates: result.gates,
  }
}

/* ───── Rendering (docs § 4: always n, counts below the gate) ──── */

/** "2 of 9" below `moderate`, "2 of 9 (22%)" from `moderate` up, "withheld" note when insufficient. */
export function formatRate(rateObj, sample) {
  const base = `${rateObj.k} of ${rateObj.n}`
  if (!sample.sufficient) return base
  if (sample.confidence === 'low') return `${base} (${sample.confidence})`
  return `${base} (${Math.round(rateObj.value * 100)}%, ${sample.confidence})`
}

function withheld(sample, what = 'resolved') {
  return `withheld (${sample.n} ${what}, ${sample.gate} needed)`
}

function sliceLine(label, s) {
  const c = s.counts
  const head = `${label}: ${c.applications} sent · ${c.progressed} progressed · ${c.rejected} rejected · ${c.noResponse} no response · ${c.pending} pending${c.withdrawn ? ` · ${c.withdrawn} withdrawn` : ''}`
  if (!s.sample.sufficient) return `${head} — rates ${withheld(s.sample)}`
  return `${head} — reply ${formatRate(s.rates.reply, s.sample)}, progress ${formatRate(s.rates.progress, s.sample)}, interview ${formatRate(s.rates.interview, s.sample)}`
}

function timingLine(t) {
  const counts = `${t.fast} fast (≤${OUTCOME_RULES.fastRejectionDays}d) · ${t.normal} normal · ${t.late} late (>${OUTCOME_RULES.lateRejectionDays}d)${t.untimed ? ` · ${t.untimed} with approximate dates` : ''}`
  if (!t.sample.sufficient) return `Rejection timing: ${counts} — timing conclusions ${withheld(t.sample, 'exactly dated rejections')}`
  return `Rejection timing: ${counts} — median ${t.medianDays} days, fast ${t.fast} of ${t.sample.n} (${t.sample.confidence})`
}

function comparisonLine(c) {
  const name = c.kind === 'high-no-progress' ? 'high Ease never progresses' : `${c.higher} vs ${c.lower} Ease`
  if (c.status === 'insufficient') return `- ${name}: withheld (${c.shortfall.map((s) => `${s.band} band ${s.n} resolved`).join(', ')}; ${c.shortfall[0].gate} needed per band)`
  const counts = c.kind === 'high-no-progress'
    ? `${c.counts.progressed} of ${c.counts.n}`
    : `${c.higher} ${c.higherCounts.progressed} of ${c.higherCounts.n}, ${c.lower} ${c.lowerCounts.progressed} of ${c.lowerCounts.n}`
  return `- ${name}: ${c.status} (${counts})`
}

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

function daysCell(x) {
  if (!x || x.days === null || x.days === undefined) return ''
  return `${x.exact ? '' : '~'}${x.days}d`
}

/** The per-application "why" table, markdown. */
export function formatWhyTable(records) {
  const head = '| # | Company | Role | Sent | Ease | Archetype | Outcome | Reached | Rejection stage | Reply / rejection | Materials | Notes | vs score |'
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  const rows = records.map((r) => {
    const reply = r.rejected ? `${daysCell(r.rejected)}${r.rejected.timing ? ` ${r.rejected.timing}` : ''}` : daysCell(r.firstReply)
    return `| ${r.num} | ${cell(r.company)} | ${cell(r.role)} | ${r.sentDate ? `${r.sentExact ? '' : '~'}${r.sentDate}` : ''} | ${r.ease !== null ? `${r.ease} (${r.easeBand})` : 'unscored'} | ${cell(r.archetype)} | ${r.outcome} | ${r.reach} | ${cell(r.rejected?.stage ?? '')} | ${reply} | ${cell(r.materials)} | ${cell(r.notes.join('; ')).slice(0, 160)} | ${r.agreement} |`
  })
  return [head, sep, ...rows].join('\n')
}

/**
 * The chat's compact block: counts and gated rates, the Ease check, then the
 * why-table. States plainly what is withheld and why.
 */
export function formatOutcomesBlock(result) {
  const o = result.overall
  const lines = [
    `## Application outcomes (as of ${result.today})`,
    '',
    `Rules: no reply after ${result.rules.noResponseDays} days = no response; rates need ${result.gates.minResolved} resolved applications per slice, timing needs ${result.gates.minTimedRejections} exactly dated rejections. "~" = approximate date (backfilled), left out of timing.`,
    '',
    sliceLine('Overall', o),
    timingLine(o.timing),
  ]
  for (const dim of ['easeBand', 'archetype']) {
    const slices = result.slices[dim]
    if (!slices.length) continue
    lines.push('', `By ${dim === 'easeBand' ? 'Ease band' : dim}:`)
    for (const s of slices) lines.push(`- ${sliceLine(s.value, s)}`)
  }
  lines.push('', 'Ease vs outcomes (agreement is not a correction; only a persistent gap is):')
  for (const c of result.easeCheck.comparisons) lines.push(comparisonLine(c))
  if (result.suggestions.length) {
    lines.push('', 'Suggestions (confirmed gaps, for the user to decide):')
    for (const s of result.suggestions) lines.push(`- [${s.id}] ${s.title}. ${s.body}`)
  } else {
    lines.push('', 'No conclusion about the scoring is supported yet.')
  }
  lines.push('', `### Why table (${result.records.length} applications)`, '', result.records.length ? formatWhyTable(result.records) : '_No application has reached the market yet._')
  return lines.join('\n')
}

// apply-kit-core.mjs — pure readiness logic for the `apply-kit` mode.
//
// Applying *well* to one listing means several artifacts need to exist for that
// `company + role`, each produced by a different existing mode:
//
//   • a scouting report          (reports/tier-N/{Company} - {Role}.md)  ← scouting
//   • a tailored, ATS-checked CV (output/cv-…{company}…-{date}.pdf)       ← pdf
//   • drafted application answers (interview-prep/{Company} - {Role}.md)  ← apply / interview-prep
//   • cached company research     (data/companies/{slug}.md)             ← deep
//   • an outreach / referral plan (rows in data/outreach.md)             ← contacto
//
// Nothing assembles these into a single "is this application ready to send, and
// what's exactly missing?" view. That is this module's job. It is the readiness
// equivalent of daily-brief-core: a pure composition layer that the thin CLI
// (scripts/apply-kit.mjs) feeds *already-resolved* file facts — it never touches
// the filesystem, the clock, or any global, so it is exhaustively unit-testable.
//
// IMPORTANT — this generates nothing and submits nothing. It only reports what
// exists and names the exact next action (delegating to the right mode) for each
// gap. The Ethical-Use rule in CLAUDE.md (never auto-submit) is upheld by design:
// the only "actions" here are *suggested commands the user runs*, never sends.
//
// ── THE READINESS MODEL ──────────────────────────────────────────────────────
// Each artifact is one CHECK with a status:
//
//   ready    — present and (where freshness applies) fresh/valid → nothing to do.
//   stale    — present but degraded (e.g. company research older than its window,
//              or an invalid artifact) → usable but worth refreshing.
//   missing  — absent → the gap that blocks a strong application.
//   n/a      — not applicable to this listing (e.g. outreach is optional).
//
// Checks carry a `weight` (how much it matters for "ready to send") and a
// `blocking` flag (a missing blocking artifact means the kit is NOT ready). The
// overall verdict and the single highest-leverage next action fall out of those.

/* ───── Check catalog ─────────────────────────────────────────────────────────
 *
 * Order = the sequence a reader should close gaps in. A report comes first
 * (no point tailoring a CV for a role you haven't decided to pursue); the CV and
 * answers are the core of the application; research sharpens both; outreach is
 * the optional multiplier that lifts response rates.
 *
 * `mode` is the existing mode that fills the gap. `fillHint` is an illustrative,
 * read-only-to-the-user next step, kept generic so no user data leaks into the
 * system layer.
 */
export const CHECK_IDS = ['report', 'cv', 'answers', 'research', 'outreach']

export const CHECK_META = {
  report: {
    id: 'report',
    label: 'Scouting report',
    // The decision artifact. Without it you haven't evaluated fit — applying is premature.
    weight: 3,
    blocking: true,
    optional: false,
    mode: 'scouting',
    fillHint: 'Evaluate the listing — run scouting on the JD/URL.',
  },
  cv: {
    id: 'cv',
    label: 'Tailored CV (ATS-checked)',
    // The single most important application artifact. A generic CV tanks response rate.
    weight: 3,
    blocking: true,
    optional: false,
    mode: 'pdf',
    fillHint: 'Tailor + ATS-check the CV for this role — run pdf mode.',
  },
  answers: {
    id: 'answers',
    label: 'Drafted application answers',
    // Application-form answers / cover-letter content, grounded in the story bank.
    weight: 2,
    blocking: false,
    optional: false,
    mode: 'apply',
    fillHint: 'Draft the application-form answers — run apply mode.',
  },
  research: {
    id: 'research',
    label: 'Company research',
    // Sharpens the CV, the answers, and any outreach. Freshness-gated.
    weight: 1,
    blocking: false,
    optional: false,
    mode: 'deep',
    fillHint: 'Cache deep company research — run deep mode.',
  },
  outreach: {
    id: 'outreach',
    label: 'Outreach / referral plan',
    // The optional multiplier: a referral dramatically raises response rates.
    weight: 1,
    blocking: false,
    optional: true,
    mode: 'contacto',
    fillHint: 'Find a referral and draft outreach — run contacto mode.',
  },
}

/* ───── Status model ─────────────────────────────────────────────────────────*/

export const STATUS = {
  ready: { id: 'ready', mark: '✓', rank: 0 },
  stale: { id: 'stale', mark: '○', rank: 1 },
  missing: { id: 'missing', mark: '✗', rank: 2 },
  na: { id: 'n/a', mark: '–', rank: 3 },
}

/* ───── Per-artifact evaluators ───────────────────────────────────────────────
 *
 * Each takes the resolved *facts* for one artifact (booleans + small metadata
 * the CLI gathered from disk) and returns a uniform check object:
 *
 *   { id, label, mode, status, blocking, optional, weight,
 *     detail,        — one-line human explanation of the status
 *     next,          — { mode, hint } when there's something to do, else null
 *     meta }         — passthrough (path, ageDays, …) for the renderer
 *
 * Facts are deliberately minimal so the pure layer never has to know how the
 * CLI found a file (glob vs slug vs table scan lives in the CLI).
 */

function baseCheck(metaKey, status, detail, meta) {
  const m = CHECK_META[metaKey]
  const isGap = status === 'missing' || status === 'stale'
  return {
    id: m.id,
    label: m.label,
    mode: m.mode,
    status,
    blocking: m.blocking,
    optional: m.optional,
    weight: m.weight,
    detail,
    next: isGap ? { mode: m.mode, hint: m.fillHint } : null,
    meta: meta || {},
  }
}

/**
 * Scouting report check.
 * @param {object} f  { exists:boolean, path?:string, tier?:number }
 */
export function reportCheck(f = {}) {
  if (f.exists) {
    const where = f.path ? ` (${f.path})` : ''
    const tier = Number.isFinite(f.tier) ? ` · tier ${f.tier}` : ''
    return baseCheck('report', 'ready', `Report on disk${tier}${where}.`,
      { path: f.path || null, tier: Number.isFinite(f.tier) ? f.tier : null })
  }
  return baseCheck('report', 'missing', 'No scouting report — listing not yet evaluated.', {})
}

/**
 * Tailored-CV check. CVs land in output/ (gitignored), one per company+date.
 * @param {object} f  { exists:boolean, path?:string, atsChecked?:boolean, atsCoverage?:number }
 */
export function cvCheck(f = {}) {
  if (!f.exists) {
    return baseCheck('cv', 'missing', 'No tailored CV generated for this role.', {})
  }
  const where = f.path ? ` (${f.path})` : ''
  // A CV that exists but whose ATS coverage is known-weak is "stale": usable but
  // worth a re-tailor. We only downgrade when we have an explicit low signal —
  // absence of an ATS number is not held against an existing CV.
  if (f.atsChecked === false) {
    return baseCheck('cv', 'stale', `CV present but not ATS-checked${where}.`,
      { path: f.path || null, atsChecked: false })
  }
  if (Number.isFinite(f.atsCoverage) && f.atsCoverage < 0.6) {
    return baseCheck('cv', 'stale',
      `CV present but ATS coverage low (${Math.round(f.atsCoverage * 100)}%)${where}.`,
      { path: f.path || null, atsCoverage: f.atsCoverage })
  }
  return baseCheck('cv', 'ready', `Tailored CV on disk${where}.`,
    { path: f.path || null, atsCoverage: Number.isFinite(f.atsCoverage) ? f.atsCoverage : null })
}

/**
 * Drafted-application-answers check. We treat the per-listing prep file
 * (interview-prep/{Company} - {Role}.md, written by apply/interview-prep) as the
 * home of drafted answers + STAR mapping.
 * @param {object} f  { exists:boolean, path?:string }
 */
export function answersCheck(f = {}) {
  if (f.exists) {
    const where = f.path ? ` (${f.path})` : ''
    return baseCheck('answers', 'ready', `Application prep / answers drafted${where}.`,
      { path: f.path || null })
  }
  return baseCheck('answers', 'missing', 'No drafted application answers yet.', {})
}

/**
 * Company-research check. Freshness comes from company-research-core (the CLI
 * runs it and passes the verdict here so we don't re-implement the date math).
 * @param {object} f
 *   { exists:boolean, path?:string, state?:'fresh'|'stale'|'missing-date'|'invalid-date',
 *     ageDays?:number, valid?:boolean }
 */
export function researchCheck(f = {}) {
  if (!f.exists) {
    return baseCheck('research', 'missing', 'No cached company research.', {})
  }
  const where = f.path ? ` (${f.path})` : ''
  const age = Number.isFinite(f.ageDays) ? `${f.ageDays}d old` : 'age unknown'
  // Invalid schema or non-fresh → present-but-degraded (stale): still readable,
  // worth refreshing before reuse. Only a fresh + valid artifact is "ready".
  if (f.valid === false) {
    return baseCheck('research', 'stale', `Research present but schema invalid${where}.`,
      { path: f.path || null, state: f.state || null, ageDays: f.ageDays ?? null, valid: false })
  }
  if (f.state && f.state !== 'fresh') {
    return baseCheck('research', 'stale', `Research present but ${age} — refresh before reuse${where}.`,
      { path: f.path || null, state: f.state, ageDays: f.ageDays ?? null, valid: f.valid !== false })
  }
  return baseCheck('research', 'ready', `Fresh company research cached${where}.`,
    { path: f.path || null, state: f.state || 'fresh', ageDays: f.ageDays ?? null, valid: true })
}

/**
 * Outreach-plan check. Optional: a missing outreach plan is a gap worth flagging
 * (referrals lift response rates) but never blocks "ready to send".
 * @param {object} f  { touches?:number, contacts?:number, lastTouch?:string }
 */
export function outreachCheck(f = {}) {
  const touches = Number.isFinite(f.touches) ? f.touches : 0
  const contacts = Number.isFinite(f.contacts) ? f.contacts : 0
  if (touches > 0 || contacts > 0) {
    const who = contacts === 1 ? '1 contact' : `${contacts} contacts`
    const last = f.lastTouch ? ` · last touch ${f.lastTouch}` : ''
    return baseCheck('outreach', 'ready', `Outreach logged — ${who}, ${touches} touch(es)${last}.`,
      { contacts, touches, lastTouch: f.lastTouch || null })
  }
  // Optional → render as "missing" (a real gap to nudge), but it stays
  // non-blocking via CHECK_META, so it never holds back the ready verdict.
  return baseCheck('outreach', 'missing', 'No outreach yet — a referral would lift response odds.', {})
}

/* ───── Story-bank supporting signal ──────────────────────────────────────────
 *
 * The story bank is a CROSS-listing asset, not a per-listing artifact, so it is
 * NOT a gating check. We surface it as a supporting note: drafting strong answers
 * (the `answers` check) leans on it, so an empty/incomplete bank is worth knowing
 * about when answers are still missing.
 *
 * @param {object} f  { exists:boolean, storyCount?:number, ok?:boolean, gaps?:number }
 * @returns {object|null} a note object, or null if there's nothing useful to say.
 */
export function storyBankNote(f = {}) {
  if (!f || !f.exists) {
    return { level: 'info', text: 'No story bank yet — apply/interview-prep will start one when you draft answers.' }
  }
  const count = Number.isFinite(f.storyCount) ? f.storyCount : 0
  if (f.ok === false) {
    return { level: 'warn', text: `Story bank has ${count} stor${count === 1 ? 'y' : 'ies'} but failed its health check — run check-story-bank.mjs.` }
  }
  const gaps = Number.isFinite(f.gaps) ? f.gaps : 0
  const gapPart = gaps > 0 ? ` · ${gaps} competency gap(s)` : ''
  return { level: 'ok', text: `Story bank: ${count} stor${count === 1 ? 'y' : 'ies'}${gapPart} to draw answers from.` }
}

/* ───── Assembly ─────────────────────────────────────────────────────────────
 *
 * Compose the per-artifact facts into a single readiness object for one listing.
 * Pure: facts in, verdict out.
 *
 * @param {object} listing  { company, role, slug? }
 * @param {object} facts
 *   { report, cv, answers, research, outreach, storyBank }  — each the fact shape
 *   accepted by the matching *Check above (storyBank → storyBankNote).
 * @returns {object} kit:
 *   { company, role, slug, checks: [...], note, summary, verdict, readyToSend,
 *     completeness, topAction }
 */
export function assembleKit(listing = {}, facts = {}) {
  const company = (listing.company || '').trim()
  const role = (listing.role || '').trim()
  const slug = (listing.slug || '').trim() || null

  const checks = [
    reportCheck(facts.report),
    cvCheck(facts.cv),
    answersCheck(facts.answers),
    researchCheck(facts.research),
    outreachCheck(facts.outreach),
  ]

  const note = storyBankNote(facts.storyBank || {})

  // ── Summary counts. ──
  const summary = { ready: 0, stale: 0, missing: 0 }
  for (const c of checks) {
    if (c.status === 'ready') summary.ready++
    else if (c.status === 'stale') summary.stale++
    else if (c.status === 'missing') summary.missing++
  }

  // ── Ready-to-send: no BLOCKING artifact may be missing. (A blocking artifact
  //    that is merely stale doesn't block — it's present and usable.) ──
  const blockingGaps = checks.filter((c) => c.blocking && c.status === 'missing')
  const readyToSend = blockingGaps.length === 0

  // ── Weighted completeness 0..1: a ready check earns full weight, a stale check
  //    earns half (present but degraded), a missing check earns none. Optional
  //    checks count toward the denominator too, so an outreach-less kit reads as
  //    "not 100% — there's still a lever to pull", which is honest. ──
  let earned = 0
  let total = 0
  for (const c of checks) {
    total += c.weight
    if (c.status === 'ready') earned += c.weight
    else if (c.status === 'stale') earned += c.weight * 0.5
  }
  const completeness = total > 0 ? Math.round((earned / total) * 100) / 100 : 0

  // ── Verdict label. ──
  let verdict
  if (!readyToSend) verdict = 'blocked'
  else if (summary.missing === 0 && summary.stale === 0) verdict = 'ready'
  else verdict = 'sendable-with-gaps' // blocking artifacts present; optional/secondary gaps remain

  // ── The single highest-leverage next action. ──
  const topAction = pickTopAction(checks)

  return {
    company,
    role,
    slug,
    checks,
    note,
    summary,
    verdict,
    readyToSend,
    completeness,
    topAction,
  }
}

/**
 * Choose the most important gap to close next.
 * Priority: blocking-missing > missing > stale, then higher weight, then the
 * fixed CHECK_IDS order (report → cv → answers → research → outreach).
 * Returns null when there are no gaps (fully ready).
 */
export function pickTopAction(checks) {
  const order = (id) => CHECK_IDS.indexOf(id)
  const tier = (c) => {
    if (c.status === 'missing') return c.blocking ? 0 : 1
    if (c.status === 'stale') return 2
    return 9 // ready / n/a — never an action
  }
  const gaps = checks.filter((c) => c.next)
  if (gaps.length === 0) return null
  gaps.sort((a, b) =>
    tier(a) - tier(b) ||
    b.weight - a.weight ||
    order(a.id) - order(b.id))
  const c = gaps[0]
  return {
    id: c.id,
    label: c.label,
    mode: c.mode,
    status: c.status,
    hint: c.next.hint,
  }
}

/* ───── Markdown renderer ──────────────────────────────────────────────────────
 *
 * Render one kit into a portable, scannable readiness checklist. Pure: kit → str.
 */
export function renderKit(kit) {
  const L = []
  const title = kit.role ? `${kit.company} — ${kit.role}` : (kit.company || 'Listing')
  L.push(`# Application-kit readiness — ${title}`)
  L.push('')

  // ── Headline: verdict + completeness + the one thing to do next. ──
  const pct = Math.round((kit.completeness || 0) * 100)
  L.push(`**Readiness:** ${verdictLabel(kit.verdict)} · ${pct}% complete · ${readyPhrase(kit.readyToSend)}`)
  L.push('')
  if (kit.topAction) {
    const ta = kit.topAction
    L.push(`**Do this next:** ${ta.hint} _(${ta.mode} mode → ${ta.label})_`)
    L.push('')
  } else {
    L.push('**Do this next:** Nothing — every artifact is in place. Review, then submit yourself.')
    L.push('')
  }

  // ── The checklist. ──
  L.push('## Checklist')
  L.push('')
  for (const c of kit.checks) {
    const mark = STATUS[statusKey(c.status)].mark
    const opt = c.optional ? ' _(optional)_' : ''
    L.push(`- ${mark} **${c.label}**${opt} — ${c.detail}`)
    if (c.next) {
      L.push(`    → ${c.next.hint} \`(${c.next.mode} mode)\``)
    }
  }
  L.push('')

  // ── Supporting note (story bank). ──
  if (kit.note && kit.note.text) {
    L.push(`_${kit.note.text}_`)
    L.push('')
  }

  // Footer: provenance + the hard ethical guarantee.
  L.push('---')
  L.push('_Read-only readiness check — generates and submits nothing. ' +
    'Close the gaps via the named modes, review, then submit yourself. `scripts/apply-kit.mjs`._')
  L.push('')
  return L.join('\n')
}

function statusKey(status) {
  if (status === 'n/a') return 'na'
  return STATUS[status] ? status : 'missing'
}

function verdictLabel(v) {
  switch (v) {
    case 'ready': return 'READY'
    case 'sendable-with-gaps': return 'Sendable (gaps remain)'
    case 'blocked': return 'BLOCKED (missing essentials)'
    default: return v || 'unknown'
  }
}

function readyPhrase(ready) {
  return ready ? 'core artifacts present' : 'core artifacts missing'
}

/* ───── Convenience: render straight from listing + facts ─────────────────────*/
export function buildKitMarkdown(listing, facts) {
  return renderKit(assembleKit(listing, facts))
}

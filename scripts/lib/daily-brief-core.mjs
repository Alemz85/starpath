// daily-brief-core.mjs — pure assembly logic for the daily/weekly job-search brief.
//
// Several read-only analysis cores already exist, each answering one slice of
// "where does my search stand":
//
//   • whats-new-core.mjs      — fresh, high-fit postings since the last scan.
//   • followup-cadence.mjs    — applications whose follow-up is due/overdue.
//   • outreach-core.mjs       — outreach threads where a nudge is due now.
//   • warm-outreach-core.mjs  — untouched warm referral paths into pipeline
//                               companies (warm-direct / warm-intro first touches
//                               vetted by the outreach-plan decision ladder).
//   • positioning-core.mjs  — the one standing targeting insight across the corpus.
//   • deadlines-core.mjs    — closing-date urgency bucketing (import-only, never modified).
//   • analyze-patterns.mjs  — one learned targeting lesson from outcomes (a "stop
//                             wasting effort on X" heads-up, import-only).
//
// Nothing bundles them into a single "what should I do now?" artifact the user
// can read, cron, or email. That is this module's job. It does NOT re-implement
// any of that math — the CLI wrapper (scripts/daily-brief.mjs) runs each core's
// own pure functions over the canonical files and hands the *already-computed*
// outputs here. This module only:
//
//   1. normalizes each core's output into a uniform list of "action" items,
//   2. ranks them into sections by urgency / leverage,
//   3. picks the single "do this first" action by genuine cross-section
//      time-criticality (globalPriority) — NOT by section position, so a deadline
//      closing today outranks a mildly-overdue follow-up,
//   4. renders one dated markdown brief (with pipeline health, deadlines, and a
//      learned-lesson heads-up).
//
// Everything here is a pure function of its inputs — no filesystem, no clock,
// no globals, no mutation. That keeps it exhaustively unit-testable, and keeps
// the imported cores untouched (this is a composition layer, not a fork).

/* ───── Section model ───────────────────────────────────────────────────────
 *
 * The brief is organized into ordered sections, each a bucket of action items.
 * Order = the sequence a reader should work top-to-bottom: time-sensitive
 * obligations first (a due follow-up / nudge decays if missed), then fresh
 * opportunities to act on, then the one standing strategic note.
 *
 *   followups  — applications with an overdue/urgent follow-up. Most decay-
 *                sensitive: a stale thread cools fast. Top of the brief.
 *   deadlines  — listings/applications with a closing date ≤ 30 days out.
 *                (urgent ≤ 7d first, then near 8–30d). Pure from deadlines-core
 *                classified output — import-only.
 *   outreach   — outreach threads where a nudge is due now.
 *   warmpaths  — untouched warm referral paths into pipeline companies (a
 *                warm-direct / warm-intro first touch recommended by the
 *                outreach-plan decision ladder). The highest-ROI opportunity
 *                move — but still an opportunity, so it renders after the
 *                open-thread obligations above.
 *   newhits    — fresh, high-fit postings worth evaluating/applying to.
 *   headsup    — one learned targeting lesson from rejection/outcome patterns
 *                ("stop wasting effort on X"). A note, not a to-do.
 *   insight    — one standing positioning insight (not an item to "do today",
 *                but the lens to keep in mind while doing the above).
 */
export const SECTION_ORDER = ['followups', 'deadlines', 'outreach', 'warmpaths', 'newhits', 'triage', 'headsup', 'insight']

export const SECTION_META = {
  followups: { title: 'Follow-ups due', kind: 'action' },
  deadlines: { title: 'Deadlines closing soon', kind: 'action' },
  outreach: { title: 'Outreach nudges due', kind: 'action' },
  warmpaths: { title: 'Warm outreach paths', kind: 'action' },
  newhits: { title: 'Fresh high-fit postings', kind: 'action' },
  triage: { title: 'Deep-eval next (inbox triage)', kind: 'action' },
  headsup: { title: 'Heads-up from your outcomes', kind: 'insight' },
  insight: { title: 'Standing positioning note', kind: 'insight' },
}

/* ───── Date helpers (string YYYY-MM-DD, lexicographic = chronological) ──────*/
function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/* ───── Normalizers: each core's output → uniform action items ───────────────
 *
 * A uniform item is:
 *   { key, label, sub, urgency, sortKey, meta }
 * where
 *   key      — stable identity (for dedup / linking), `company|role`-ish.
 *   label    — the headline line (e.g. "Acme — Strategy Analyst").
 *   sub      — the one-line "why it's here / what to do".
 *   urgency  — numeric, lower = more urgent (drives intra-section sort).
 *   sortKey  — tiebreak (e.g. days overdue, score), higher = earlier.
 *   meta     — passthrough for the renderer (score, date, url, …).
 */

/**
 * Follow-up items from followup-cadence analysis output.
 * We surface only the genuinely-actionable ones: `overdue` and `urgent`.
 * `waiting` (on-track) and `cold` (maxed out) are noise for a "do now" brief.
 *
 * @param {object} followupResult  shape: { entries: [...] } or { error }
 */
export function followupItems(followupResult) {
  if (!followupResult || followupResult.error || !Array.isArray(followupResult.entries)) {
    return []
  }
  const URGENCY_RANK = { urgent: 0, overdue: 1 }
  const items = []
  for (const e of followupResult.entries) {
    if (e.urgency !== 'overdue' && e.urgency !== 'urgent') continue
    const days = Number.isFinite(e.daysSinceApplication) ? e.daysSinceApplication : 0
    const role = e.role || ''
    const contact = Array.isArray(e.contacts) && e.contacts[0] ? e.contacts[0].email : null
    const what = e.urgency === 'urgent'
      ? `Respond now — ${e.status}, ${days}d since applied`
      : `Follow up — ${e.status}, ${days}d since applied, ${e.followupCount || 0} sent`
    items.push({
      key: `${(e.company || '').toLowerCase()}|${role.toLowerCase()}`,
      label: role ? `${e.company} — ${role}` : e.company,
      sub: contact ? `${what} · ${contact}` : what,
      urgency: URGENCY_RANK[e.urgency] ?? 2,
      sortKey: days, // more days overdue → surface earlier within same urgency
      meta: {
        status: e.status,
        score: e.score,
        daysSince: days,
        followupCount: e.followupCount || 0,
        nextFollowupDate: e.nextFollowupDate || null,
        reportPath: e.reportPath || null,
      },
    })
  }
  return items.sort((a, b) => a.urgency - b.urgency || b.sortKey - a.sortKey)
}

/**
 * Outreach items from outreach-core.classifyAll output.
 * Only `nudge` (a follow-up is due now) belongs in a "do now" brief.
 *
 * @param {object} outreachResult  shape: { entries: [...] } (classifyAll output)
 */
export function outreachItems(outreachResult) {
  if (!outreachResult || !Array.isArray(outreachResult.entries)) return []
  const items = []
  for (const e of outreachResult.entries) {
    if (e.action !== 'nudge') continue
    const days = Number.isFinite(e.daysSince) ? e.daysSince : 0
    const who = e.contact || 'contact'
    items.push({
      key: `${(e.company || '').toLowerCase()}|${who.toLowerCase()}`,
      label: e.role ? `${e.company} — ${e.role}` : (e.company || who),
      sub: `${e.reason || 'Nudge due'} · ${who}${e.channel ? ` (${e.channel})` : ''}`,
      urgency: 0,
      sortKey: days, // longer since last touch → more overdue → earlier
      meta: {
        contact: who,
        title: e.title || null,
        channel: e.channel || null,
        daysSince: days,
        lastTouch: e.lastTouch || null,
        touches: e.touches ?? null,
      },
    })
  }
  return items.sort((a, b) => b.sortKey - a.sortKey)
}

/**
 * Warm-path items from warm-outreach-core.warmOutreachOpportunities output.
 * Each opportunity is an untouched warm first touch (warm-direct / warm-intro)
 * into a pipeline company, pre-filtered by the outreach-plan decision ladder:
 * due nudges live in the `outreach` section, live threads block the company
 * entirely, and exhausted (cold) contacts are never targets. So every item here
 * is safe to act on as-is. Input arrives ranked highest-value first (role score,
 * then warmth) — we keep that order and just cap for scannability.
 *
 * @param {Array|null} opportunities  warmOutreachOpportunities() output
 * @param {object} opts               { maxWarmPaths = 3 }
 */
export function warmPathItems(opportunities, { maxWarmPaths = 3 } = {}) {
  if (!Array.isArray(opportunities)) return []
  return opportunities.slice(0, maxWarmPaths).map((o) => {
    const t = o.target || {}
    const who = t.name || 'contact'
    const title = t.title ? ` (${t.title})` : ''
    const action = o.play === 'warm-intro'
      ? `Ask ${t.via || 'your mutual contact'} for an intro to ${who}${title} — 2nd-degree bridge`
      : `Message ${who}${title} directly — untouched 1st-degree tie`
    const roleScore = o.topRole && Number.isFinite(o.topRole.score) ? o.topRole.score : null
    const scoreSuffix = roleScore && roleScore > 0 ? ` · ${roleScore.toFixed(1)}/10 role` : ''
    return {
      key: `warmpath|${(o.company || '').toLowerCase()}|${who.toLowerCase()}`,
      label: o.topRole && o.topRole.role ? `${o.company} — ${o.topRole.role}` : o.company,
      sub: `${action}${scoreSuffix}`,
      urgency: 0,
      sortKey: roleScore ?? 0,
      meta: {
        kind: o.play, // 'warm-direct' | 'warm-intro'
        company: o.company,
        contact: who,
        via: t.via || null,
        warmth: t.warmth ?? null,
        leverage: t.leverage || null,
        roleScore,
        cautions: o.cautions || [],
      },
    }
  })
}

/**
 * Fresh-hit items from whats-new-core.buildDigest output.
 * We surface the `prioritize` bucket (new AND high-fit) plus the `needs-eval`
 * bucket (new, unscored — go evaluate), capped so the brief stays scannable.
 *
 * @param {object} digest  buildDigest output: { items, prioritize, needsEval, ... }
 * @param {object} opts    { maxPrioritize, maxNeedsEval }
 */
export function newHitItems(digest, { maxPrioritize = 8, maxNeedsEval = 5 } = {}) {
  if (!digest || !Array.isArray(digest.items)) return []
  const items = []

  const prioritize = (digest.prioritize || []).slice(0, maxPrioritize)
  for (const it of prioritize) {
    items.push({
      key: `${(it.company || '').toLowerCase()}|${(it.title || '').toLowerCase()}`,
      label: it.title ? `${it.company} — ${it.title}` : it.company,
      sub: scoreSub(it) + (it.location ? ` · ${it.location}` : '') + ageSuffix(it),
      urgency: 0,
      sortKey: Number.isFinite(it.overall) ? it.overall : 0,
      meta: {
        kind: 'prioritize',
        overall: it.overall ?? null,
        band: it.band || null,
        location: it.location || '',
        url: it.url || null,
        ageDays: it.ageDays ?? null,
        archetype: it.archetype || null,
      },
    })
  }

  const needsEval = (digest.needsEval || []).slice(0, maxNeedsEval)
  for (const it of needsEval) {
    items.push({
      key: `${(it.company || '').toLowerCase()}|${(it.title || '').toLowerCase()}`,
      label: it.title ? `${it.company} — ${it.title}` : it.company,
      sub: `Unscored — run scouting${it.location ? ` · ${it.location}` : ''}${ageSuffix(it)}`,
      urgency: 1, // after the already-scored prioritize hits
      sortKey: 0,
      meta: {
        kind: 'needs-eval',
        location: it.location || '',
        url: it.url || null,
        ageDays: it.ageDays ?? null,
      },
    })
  }

  return items.sort((a, b) => a.urgency - b.urgency || b.sortKey - a.sortKey)
}

function scoreSub(it) {
  if (!Number.isFinite(it.overall)) return 'Scored'
  const star = it.band === 'strong' ? '★★' : it.band === 'solid' ? '★' : ''
  return `${it.overall.toFixed(1)}/10${star ? ` ${star}` : ''}`
}

function ageSuffix(it) {
  return Number.isFinite(it.ageDays) && it.ageDays > 0 ? ` · ${it.ageDays}d old` : ''
}

/**
 * The single standing positioning insight from positioning-core output.
 * Not an "item to do today" — a one-paragraph lens. We pull the systemic
 * binding constraint + its cheapest cross-archetype lever, falling back to the
 * landscape's strongest archetype if no systemic constraint binds.
 *
 * Returns a single-element array (or empty) so it slots into the section model.
 *
 * @param {object} intel  positioningIntel output, or { error }
 */
export function insightItems(intel) {
  if (!intel || intel.error) return []
  const sys = intel.systemicConstraint

  if (sys && sys.dominant) {
    const d = sys.dominant
    const names = d.archetypes || []
    const where = names.length > 2
      ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
      : names.join(', ')
    let sub = `"${d.label}" is the binding constraint across ${d.count} archetype(s)` +
      (where ? ` (${where})` : '') + '.'
    if (sys.lever) {
      sub += ` The highest-leverage move: lift ${sys.lever.label}` +
        ` (re-bands ${sys.lever.count} archetype(s), avg +${sys.lever.avgLift}).`
    }
    return [{
      key: `insight|${d.dimension}`,
      label: `Targeting: ${d.label} is your systemic blocker`,
      sub,
      urgency: 0,
      sortKey: 0,
      meta: { kind: 'systemic-constraint', dimension: d.dimension, archetypes: names },
    }]
  }

  // Fallback: no single dimension binds → point at the strongest archetype.
  // positioning-core sorts `fingerprints` strongest-first (by avgOverall).
  const top = (Array.isArray(intel.fingerprints) && intel.fingerprints[0]) || null
  if (top && top.archetype) {
    return [{
      key: `insight|${top.archetype}`,
      label: `Targeting: lean into ${top.archetype}`,
      sub: `Your strongest-scoring archetype` +
        (Number.isFinite(top.avgOverall) ? ` (avg ${round1(top.avgOverall)}/10)` : '') +
        ` — concentrate sourcing there.`,
      urgency: 0,
      sortKey: 0,
      meta: { kind: 'top-archetype', archetype: top.archetype },
    }]
  }
  return []
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/* ───── Deadline items (from deadlines-core.classifyDeadlines output) ────────
 *
 * We surface only the `urgent` bucket (≤ 7 days) and `near` bucket (8–30 days)
 * so the brief stays actionable, not a full calendar dump. The full deadlines
 * view (`/career-ops deadlines`) is the right place for the complete picture.
 *
 * Expected input shape: classifyDeadlines() return value:
 *   { asOf, buckets: { urgent: [...], near: [...], ... }, counts: {...} }
 *
 * Each bucket entry has: { source, num, company, role, status/tier, deadline,
 *   parsed, daysLeft }
 *
 * @param {object|null} classifiedDeadlines   deadlines-core.classifyDeadlines output
 * @param {object}      opts                  { maxUrgent, maxNear }
 */
export function deadlineItems(classifiedDeadlines, { maxUrgent = 5, maxNear = 5 } = {}) {
  if (!classifiedDeadlines || !classifiedDeadlines.buckets) return []
  const items = []

  const urgentEntries = (classifiedDeadlines.buckets.urgent || []).slice(0, maxUrgent)
  for (const e of urgentEntries) {
    const dayLabel = e.daysLeft === 0 ? 'closes today' : `${e.daysLeft}d left`
    const tierOrStatus = e.source === 'scouting' ? e.tier : (e.status || '')
    const sub = `${dayLabel}${tierOrStatus ? ` · ${tierOrStatus}` : ''} — decide now`
    items.push({
      key: `deadline|${(e.company || '').toLowerCase()}|${(e.role || '').toLowerCase()}`,
      label: e.role ? `${e.company} — ${e.role}` : e.company,
      sub,
      urgency: 0, // urgent entries sort before near
      sortKey: 7 - (e.daysLeft ?? 7), // fewer days left → higher sortKey → surfaces first
      meta: {
        kind: 'deadline-urgent',
        source: e.source,
        daysLeft: e.daysLeft,
        deadline: e.deadline,
        tierOrStatus,
        num: e.num || null,
      },
    })
  }

  const nearEntries = (classifiedDeadlines.buckets.near || []).slice(0, maxNear)
  for (const e of nearEntries) {
    const tierOrStatus = e.source === 'scouting' ? e.tier : (e.status || '')
    const sub = `${e.daysLeft}d left (${e.deadline})${tierOrStatus ? ` · ${tierOrStatus}` : ''}`
    items.push({
      key: `deadline|${(e.company || '').toLowerCase()}|${(e.role || '').toLowerCase()}`,
      label: e.role ? `${e.company} — ${e.role}` : e.company,
      sub,
      urgency: 1, // near entries sort after urgent
      sortKey: 30 - (e.daysLeft ?? 30), // fewer days left → earlier
      meta: {
        kind: 'deadline-near',
        source: e.source,
        daysLeft: e.daysLeft,
        deadline: e.deadline,
        tierOrStatus,
        num: e.num || null,
      },
    })
  }

  return items.sort((a, b) => a.urgency - b.urgency || b.sortKey - a.sortKey)
}

/* ───── Deep-eval next: the inbox triage top slice ───────────────────────────
 *
 * scripts/lib/triage-core.mjs ranks the pipeline.md Pending inbox with
 * deterministic zero-token signals (scan relevance, freshness, dream/affinity
 * company, title level, dedup hits). The brief folds in the top of that
 * ranking so "what should I evaluate next?" is answered on the same page as
 * follow-ups and deadlines — the top of the funnel was previously invisible
 * here (only an inboxCount in the health line).
 *
 * Only positively-scored deep-eval entries appear: a negative triage score
 * means the signals argue AGAINST spending an evaluation on it, and the brief
 * should never recommend that.
 *
 * Expected input: triage-core triagePending() output (ranked entries with
 * { url, company, title, triageScore, triageReasons, bucket }), or null.
 *
 * @param {Array|null} rankedTriage
 * @param {object} opts  { maxTriage = 5 }
 */
export function triageItems(rankedTriage, { maxTriage = 5 } = {}) {
  if (!Array.isArray(rankedTriage)) return []
  return rankedTriage
    .filter((e) => e && e.bucket === 'deep-eval' && e.triageScore > 0)
    .slice(0, maxTriage)
    .map((e) => ({
      key: `triage|${e.url}`,
      label: e.company && e.title ? `${e.company} — ${e.title}` : (e.company || e.title || e.url),
      sub: `triage ${e.triageScore.toFixed(1)} — ${(e.triageReasons || []).join('; ')}`,
      urgency: 0,
      sortKey: e.triageScore,
      meta: { kind: 'triage', url: e.url, score: e.triageScore },
    }))
}

/* ───── Pipeline health summary ──────────────────────────────────────────────
 *
 * A compact one-liner showing funnel health: how many applications are actively
 * in-flight, how many evaluations are pending a decision, and how many URLs are
 * waiting in the pipeline inbox.
 *
 * Expected input shape (pipelineHealth input from CLI):
 *   {
 *     active:    N,   // Applied + Responded + Interview + Offer
 *     evaluated: N,   // Evaluated (waiting for decision)
 *     inboxCount: N,  // rows in data/pipeline.md
 *   }
 *
 * Returns an object { active, evaluated, inboxCount, hasData } or null when all
 * counts are zero/null (suppressed in the render).
 *
 * @param {object|null} pipelineHealth
 */
export function buildPipelineHealthSummary(pipelineHealth) {
  if (!pipelineHealth) return null
  const active = Number.isFinite(pipelineHealth.active) ? pipelineHealth.active : 0
  const evaluated = Number.isFinite(pipelineHealth.evaluated) ? pipelineHealth.evaluated : 0
  const inboxCount = Number.isFinite(pipelineHealth.inboxCount) ? pipelineHealth.inboxCount : 0
  if (active === 0 && evaluated === 0 && inboxCount === 0) return null
  return { active, evaluated, inboxCount, hasData: true }
}

/* ───── Heads-up: one rejection/targeting recommendation ─────────────────────
 *
 * analyze-patterns.mjs already mines outcomes + reports for systematic waste
 * (geo-restriction blockers, stack mismatches, a score floor under which nothing
 * converts, the best/worst archetype). Those recommendations never reached the
 * "what should I do today" surface — so the brief was blind to the single most
 * useful piece of learned intelligence: "stop wasting effort on X".
 *
 * This folds the highest-impact recommendation in as a standing "heads-up" note
 * (prose, not a to-do) so the reader keeps the lesson in mind while working the
 * action list. We surface ONE — the first `high`-impact rec, else the first rec —
 * to keep the brief scannable. It is a note, never the top action.
 *
 * Expected input: analyze-patterns.mjs analyze() output, shape:
 *   { recommendations: [{ action, reasoning, impact }], metadata: {...} }  OR  { error }
 *
 * Returns a single-element array (or empty) so it slots into the section model.
 *
 * @param {object|null} patterns  analyze-patterns analyze() output, or { error }
 */
export function patternHeadsUp(patterns) {
  if (!patterns || patterns.error || !Array.isArray(patterns.recommendations)) {
    return []
  }
  const recs = patterns.recommendations
  if (recs.length === 0) return []

  // Prefer the first high-impact rec; fall back to the first rec of any impact.
  const pick = recs.find((r) => r && r.impact === 'high') || recs[0]
  if (!pick || !pick.action) return []

  const impact = typeof pick.impact === 'string' ? pick.impact : 'medium'
  return [{
    key: `headsup|${impact}`,
    label: 'Targeting lesson from your outcomes',
    sub: `${pick.action}.` + (pick.reasoning ? ` ${pick.reasoning}` : ''),
    urgency: 0,
    sortKey: 0,
    meta: { kind: 'pattern-recommendation', impact, action: pick.action },
  }]
}

/* ───── Cross-section global priority ────────────────────────────────────────
 *
 * The "Do this first" pick used to be section-order-based: the first item of the
 * first non-empty ACTION section in SECTION_ORDER. That made `followups` *always*
 * outrank `deadlines` — so a deadline closing TODAY lost to a mildly-overdue
 * follow-up. The whole brief is built around that one pick, so the ordering has
 * to reflect genuine, cross-section time-criticality, not section position.
 *
 * `globalPriority` maps any normalized action item to a single comparable score
 * (LOWER = more urgent). The tiers, most-urgent first:
 *
 *   0xx  Deadlines — irreversible if missed. Scaled by days left, so a deadline
 *        closing today (0d) beats one closing in 6 days, and both beat any
 *        follow-up. A passed/near-zero deadline is the most critical thing there
 *        is. Tier band 0–99.
 *   1xx  Urgent follow-ups — a recruiter is actively waiting on YOUR reply
 *        (status responded/interview). Relationship decays fast but is
 *        recoverable. Tier band 100–199, sooner-overdue first.
 *   2xx  Overdue follow-ups — your application has gone quiet past cadence.
 *        Tier band 200–299, more-days-overdue first.
 *   3xx  Outreach nudges — a warm thread to keep alive. Tier band 300–399.
 *   4xx  Warm outreach paths — an untouched warm referral path into a pipeline
 *        company (warm-direct / warm-intro). The highest-ROI *opportunity* —
 *        a referral beats any cold move — but nothing decays if it waits a day,
 *        so every open-thread obligation above still wins. Tier band 400–499,
 *        higher target-role score first.
 *   5xx  Fresh high-fit postings — opportunity, not obligation; never decays as
 *        fast as an open thread. Prioritized hits (scored) before needs-eval.
 *        Tier band 500–599, higher score first.
 *   6xx  Inbox triage — the deterministic "deep-eval next" ranking. Purely
 *        prospective (nothing is waiting on the user), so it only becomes the
 *        top action when nothing above exists. Tier band 600–699, higher
 *        triage score first.
 *
 * This is intentionally a coarse, explainable ladder (deadlines > obligations >
 * opportunities), with a continuous within-tier term so ties break sensibly.
 *
 * @param {string} sectionId  one of the ACTION section ids
 * @param {object} item       a normalized action item (from the *Items fns)
 * @returns {number} priority — lower = surface first
 */
export function globalPriority(sectionId, item) {
  const meta = item && item.meta ? item.meta : {}

  if (sectionId === 'deadlines') {
    // daysLeft can be negative (missed) → clamp to 0 so "missed/today" is the
    // most urgent. Cap the spread at 60 so far-out deadlines still rank below
    // every same-day obligation but above opportunities.
    const dl = Number.isFinite(meta.daysLeft) ? Math.max(0, meta.daysLeft) : 30
    return Math.min(dl, 60) // 0..60 → band 0–60
  }

  if (sectionId === 'followups') {
    const days = Number.isFinite(meta.daysSince) ? meta.daysSince : 0
    // urgency 0 = urgent (recruiter waiting), 1 = overdue (app went quiet).
    if (item.urgency === 0) {
      // Urgent: band 100–199. Sooner-since-applied is MORE urgent for a
      // responded/interview thread (a same-day reply matters most), so smaller
      // `days` → smaller priority. Clamp the spread.
      return 100 + Math.min(Math.max(days, 0), 99)
    }
    // Overdue: band 200–299. More days overdue → MORE urgent → smaller priority.
    return 200 + Math.max(0, 99 - Math.min(days, 99))
  }

  if (sectionId === 'outreach') {
    const days = Number.isFinite(meta.daysSince) ? meta.daysSince : 0
    // Longer since last touch → more overdue → smaller priority. Band 300–399.
    return 300 + Math.max(0, 99 - Math.min(days, 99))
  }

  if (sectionId === 'warmpaths') {
    // Band 400–499 — higher target-role score → earlier (a referral matters
    // most where the fit is best). Scores are 0–10; ×10 spreads the band.
    const score = Number.isFinite(meta.roleScore) ? meta.roleScore : 0
    return 400 + Math.max(0, 99 - Math.min(Math.round(score * 10), 99))
  }

  if (sectionId === 'newhits') {
    // Prioritized (scored) hits before needs-eval; higher score → earlier.
    // Band 500–549 for scored, 550–599 for needs-eval.
    const base = meta.kind === 'needs-eval' ? 550 : 500
    const score = Number.isFinite(meta.overall) ? meta.overall : 0
    return base + Math.max(0, 49 - Math.min(Math.round(score * 5), 49))
  }

  if (sectionId === 'triage') {
    // Band 600–699 — higher triage score → earlier. Scores are small floats
    // (typically 0–10); ×10 spreads them across the band.
    const score = Number.isFinite(meta.score) ? meta.score : 0
    return 600 + Math.max(0, 99 - Math.min(Math.round(score * 10), 99))
  }

  return 999 // unknown section → lowest priority
}

/**
 * Pick the single highest-value next action across ALL action sections, ranked
 * by `globalPriority` (not by section order). Returns the same shape the old
 * section-order pick returned: { section, sectionTitle, item } or null.
 *
 * @param {Array} sections  the assembled section list
 * @returns {object|null}
 */
export function pickTopAction(sections) {
  let best = null
  let bestPriority = Infinity
  for (const s of sections) {
    if (s.kind !== 'action') continue
    for (const item of s.items) {
      const p = globalPriority(s.id, item)
      if (p < bestPriority) {
        bestPriority = p
        best = { section: s.id, sectionTitle: s.title, item, priority: p }
      }
    }
  }
  return best
}

/* ───── Assembly ─────────────────────────────────────────────────────────────
 *
 * Compose the normalized items into a single brief object. The caller passes
 * already-computed core outputs (the CLI runs the cores' own pure functions);
 * this stays a pure transform.
 *
 * @param {object} inputs
 *   - digest               whats-new buildDigest output (or null)
 *   - followupResult       followup-cadence analysis output (or null)
 *   - outreachResult       outreach classifyAll output (or null)
 *   - warmOutreach         warm-outreach-core warmOutreachOpportunities() output (or null)
 *   - positioningIntel     positioning-core positioningIntel output (or null)
 *   - classifiedDeadlines  deadlines-core.classifyDeadlines output (or null)
 *   - triage               triage-core triagePending() ranked entries (or null)
 *   - pipelineHealth       { active, evaluated, inboxCount } counts (or null)
 * @param {object} opts
 *   - asOf      YYYY-MM-DD "today" for the brief header (required for a dated brief)
 *   - period    'daily' | 'weekly' (label only; affects the header wording)
 *   - maxPrioritize / maxNeedsEval  caps passed to newHitItems
 *   - maxUrgent / maxNear          caps passed to deadlineItems
 *   - maxWarmPaths                 cap passed to warmPathItems
 *
 * @returns {object} brief:
 *   { asOf, period, sections: [{ id, title, kind, items }], counts, totalActions,
 *     topAction, pipelineHealth }
 */
export function assembleBrief(inputs = {}, opts = {}) {
  const asOf = isValidDate(opts.asOf) ? opts.asOf.trim() : null
  const period = opts.period === 'weekly' ? 'weekly' : 'daily'

  const byId = {
    followups: followupItems(inputs.followupResult),
    deadlines: deadlineItems(inputs.classifiedDeadlines, opts),
    outreach: outreachItems(inputs.outreachResult),
    warmpaths: warmPathItems(inputs.warmOutreach, opts),
    newhits: newHitItems(inputs.digest, opts),
    triage: triageItems(inputs.triage, opts),
    headsup: patternHeadsUp(inputs.patterns),
    insight: insightItems(inputs.positioningIntel),
  }

  const sections = SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_META[id].title,
    kind: SECTION_META[id].kind,
    items: byId[id],
  }))

  const counts = {}
  let totalActions = 0
  for (const s of sections) {
    counts[s.id] = s.items.length
    if (s.kind === 'action') totalActions += s.items.length
  }

  // The single highest-value next action, ranked across ALL action sections by
  // genuine time-criticality (globalPriority), not section order — so a deadline
  // closing today outranks a mildly-overdue follow-up. Insight/heads-up are
  // notes, never the top action.
  const topAction = pickTopAction(sections)

  const pipelineHealth = buildPipelineHealthSummary(inputs.pipelineHealth || null)

  return { asOf, period, sections, counts, totalActions, topAction, pipelineHealth }
}

/* ───── Markdown renderer ────────────────────────────────────────────────────
 *
 * Render the assembled brief into one portable markdown document the user can
 * read, cron to a file, or pipe into an email. Pure: brief object → string.
 */
export function renderBrief(brief) {
  const L = []
  const dateLabel = brief.asOf || 'undated'
  const periodWord = brief.period === 'weekly' ? 'Weekly' : 'Daily'

  L.push(`# ${periodWord} job-search brief — ${dateLabel}`)
  L.push('')

  // ── Pipeline health summary (one-liner above the action block). ──
  if (brief.pipelineHealth && brief.pipelineHealth.hasData) {
    const ph = brief.pipelineHealth
    const parts = []
    if (ph.active > 0) parts.push(`${ph.active} active app${ph.active !== 1 ? 's' : ''} in flight`)
    if (ph.evaluated > 0) parts.push(`${ph.evaluated} evaluated — pending decision`)
    if (ph.inboxCount > 0) parts.push(`${ph.inboxCount} URL${ph.inboxCount !== 1 ? 's' : ''} in pipeline inbox`)
    L.push(`> **Pipeline:** ${parts.join(' · ')}`)
    L.push('')
  }

  // ── Headline: the one thing to do, + a scoreboard. ──
  if (brief.totalActions === 0) {
    L.push('_Nothing time-sensitive right now._ No due follow-ups, deadline pressure, outreach nudges, warm paths to open, or fresh high-fit postings.')
    L.push('')
  } else {
    if (brief.topAction) {
      const ta = brief.topAction
      const topLine = renderTopActionLine(ta)
      L.push(`**Do this first:** ${topLine} _(${ta.sectionTitle})_`)
      L.push('')
    }
    const board = SECTION_ORDER
      .filter((id) => SECTION_META[id].kind === 'action' && brief.counts[id] > 0)
      .map((id) => `${brief.counts[id]} ${SECTION_META[id].title.toLowerCase()}`)
      .join(' · ')
    L.push(`_${brief.totalActions} action(s):_ ${board}`)
    L.push('')
  }

  // ── Sections. ──
  for (const s of brief.sections) {
    if (s.items.length === 0) continue
    L.push(`## ${s.title}`)
    L.push('')
    if (s.kind === 'insight') {
      // Insight renders as prose, not a checklist.
      for (const it of s.items) {
        L.push(`**${it.label}.** ${it.sub}`)
        L.push('')
      }
      continue
    }
    for (const it of s.items) {
      const line = renderActionLine(s.id, it)
      L.push(`- ${line}`)
    }
    L.push('')
  }

  // Footer: provenance so a cron'd/emailed copy is self-describing.
  L.push('---')
  L.push(`_Generated ${dateLabel} · read-only over canonical job-search data · \`scripts/daily-brief.mjs\`._`)
  L.push('')

  return L.join('\n')
}

/**
 * Render the top-action one-liner with enriched context where available.
 * For deadline-urgent items → surfaces days-left inline.
 * For new-hit items → links to the URL.
 * For follow-up items → kept compact (label + sub).
 */
function renderTopActionLine(topAction) {
  const it = topAction.item
  const section = topAction.section

  if (section === 'deadlines' && it.meta && it.meta.daysLeft !== undefined) {
    const daysLabel = it.meta.daysLeft === 0 ? 'closes TODAY' : `${it.meta.daysLeft}d left`
    return `**${it.label}** — ${daysLabel} · ${it.meta.tierOrStatus || ''} — decide/apply now`
  }

  if ((section === 'newhits' || section === 'triage') && it.meta && it.meta.url) {
    return `**[${it.label}](${it.meta.url})** — ${it.sub}`
  }

  return `**${it.label}** — ${it.sub}`
}

function renderActionLine(sectionId, it) {
  let head = `**${it.label}**`
  // Link fresh postings + triage picks to their URL when present.
  if ((sectionId === 'newhits' || sectionId === 'triage') && it.meta && it.meta.url) {
    head = `**[${it.label}](${it.meta.url})**`
  }
  return `${head} — ${it.sub}`
}

/* ───── Convenience: render straight from raw core outputs ───────────────────*/
export function buildBriefMarkdown(inputs, opts) {
  return renderBrief(assembleBrief(inputs, opts))
}

export { isValidDate as _isValidDate, daysBetween as _daysBetween }

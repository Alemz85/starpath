// patterns-core.mjs — pure outcome-pattern math over data/applications.md.
//
// analyze-patterns.mjs has two jobs that answer two different questions:
//
//   --scouting  → "where is the LANDSCAPE offering me strong matches, and which
//                  dimension drags my scores down?"  (targeting-core.mjs; rich
//                  from day one, before any application has been sent.)
//
//   default     → "now that I've actually APPLIED to things and heard back,
//                  what's costing me applications?"  (this module.) This signal
//                  only exists once outcomes accumulate in applications.md.
//
// The targeting path was extracted into targeting-core.mjs and unit-tested long
// ago; the outcome path lived entirely inline in the CLI and was never tested.
// This module extracts that math so it can be exhaustively covered, and — while
// doing it — adds the single most decision-useful thing the inline version was
// missing: a **stage-conversion funnel**. The old funnel was just raw counts per
// status; it could tell you "8 applied, 1 offer" but not *where* the pipeline
// leaks. A job-seeker's most actionable question is "am I failing to get
// responses, failing to convert responses into interviews, or failing to close
// interviews into offers?" — three very different problems with three very
// different fixes. computeFunnel answers exactly that, and diagnoseFunnel names
// the weakest stage.
//
// Everything here is a pure function of its inputs — no filesystem, no clock, no
// globals, no mutation. The thin file/CLI wrapper stays in analyze-patterns.mjs.

import { parseAppRow } from './tracker-core.mjs'

/* ───── Status normalization (mirrors verify-pipeline.mjs) ──────────────────
 *
 * applications.md statuses drift across languages and casings. We fold them to
 * a canonical lowercase token so every downstream aggregate is stable. Scouting
 * observations live in data/scouting.md and are NOT parsed here.
 */
export const STATUS_ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
}

export function normalizeStatus(raw) {
  if (!raw) return ''
  const clean = String(raw).replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim()
  return STATUS_ALIASES[clean] || clean
}

/* ───── Outcome classification ──────────────────────────────────────────────
 *
 * Coarse outcome buckets for score-by-outcome comparison. Note these are
 * distinct from the FUNNEL stages below: a row in "applied" is a `positive`
 * outcome (the user got past self-filtering) even though it hasn't progressed.
 */
export function classifyOutcome(status) {
  const s = normalizeStatus(status)
  if (['interview', 'offer', 'responded', 'applied'].includes(s)) return 'positive'
  if (['rejected', 'discarded'].includes(s)) return 'negative'
  if (['skip'].includes(s)) return 'self_filtered'
  return 'pending' // evaluated
}

/* ───── applications.md parsing ─────────────────────────────────────────────
 *
 * The canonical column order carries an OPTIONAL Deadline cell between PDF and
 * Report:
 *   | # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
 * Real writers (merge-tracker) emit that 10-column form; the legacy 9-column
 * form (no Deadline) is still valid on disk. Hand-indexing `report = parts[8]`
 * is therefore wrong for current data — it reads the Deadline as the report and
 * shifts Notes onto the report cell. We delegate to parseAppRow (tracker-core),
 * exactly like deadlines-core / followup-cadence-core, so the report/notes
 * indices are resolved by the shared, deadline-aware logic.
 */
export function parseTracker(content) {
  if (!content) return []
  const entries = []
  for (const line of content.split('\n')) {
    const row = parseAppRow(line)
    if (!row) continue
    entries.push({
      num: row.num, date: row.date, company: row.company, role: row.role,
      score: row.score, status: row.status, pdf: row.pdf, report: row.report,
      notes: row.notes,
    })
  }
  return entries
}

/* ───── Remote-policy bucketing ─────────────────────────────────────────────*/
export function classifyRemote(raw) {
  if (!raw) return 'unknown'
  const lower = raw.toLowerCase()
  if (/\b(us[- ]?only|canada[- ]?only|residents only|usa only|us residents|canada residents)\b/.test(lower)) return 'geo-restricted'
  if (/\bargentina\s+remote\s+only\b/.test(lower)) return 'geo-restricted'
  if (/\b(hybrid|on-?site|office|columbus|cape town|relocat)\b/.test(lower)) return 'hybrid/onsite'
  if (/\b(global|anywhere|worldwide|no restrict|70\+|work from anywhere)\b/.test(lower)) return 'global remote'
  if (/\b(remote|latam|americas|brazil|fully remote)\b/.test(lower)) return 'regional remote'
  return 'unknown'
}

/* ───── Company-size bucketing ──────────────────────────────────────────────*/
export function classifyCompanySize(teamSize) {
  if (!teamSize) return 'unknown'
  const lower = teamSize.toLowerCase()
  const nums = lower.match(/[\d,]+/g)
  if (nums) {
    const max = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''), 10)))
    if (max <= 50) return 'startup'
    if (max <= 500) return 'scaleup'
    return 'enterprise'
  }
  if (/\b(small|elite|tiny|founding)\b/.test(lower)) return 'startup'
  if (/\b(large|enterprise|global)\b/.test(lower)) return 'enterprise'
  return 'unknown'
}

/* ───── Hard-blocker classification from a gap ──────────────────────────────*/
export function extractBlockerType(gap) {
  const desc = (gap.description || '').toLowerCase()
  const sev = (gap.severity || '').toLowerCase()
  if (sev.includes('nice') || sev.includes('soft')) return null // skip soft gaps
  if (/\b(residency|us[- ]only|canada|location|visa|geo|country|region)\b/.test(desc)) return 'geo-restriction'
  if (/\b(javascript|typescript|python|ruby|java|go|rust|node|react|angular|vue|django|flask|rails)\b/.test(desc)) return 'stack-mismatch'
  if (/\b(senior|staff|lead|principal|director|manager|head)\b/.test(desc)) return 'seniority-mismatch'
  if (/\b(hybrid|on-?site|office|relocat)\b/.test(desc)) return 'onsite-requirement'
  return 'other'
}

/* ───── Small numeric helpers ───────────────────────────────────────────────*/
const round2 = (n) => Math.round(n * 100) / 100
function scoreStats(arr) {
  if (arr.length === 0) return { avg: 0, min: 0, max: 0, count: 0 }
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length
  return { avg: round2(avg), min: Math.min(...arr), max: Math.max(...arr), count: arr.length }
}

/* ───── Stage-conversion funnel ─────────────────────────────────────────────
 *
 * THE new decision-useful insight. The pipeline is a sequence of gates:
 *
 *   applied → responded → interview → offer
 *
 * A status only ever reflects the FURTHEST stage a listing reached (an entry at
 * "interview" already cleared "applied" and "responded"; an "offer" cleared all
 * three; a "rejected"/"discarded" sat at whatever stage it died). So the count
 * that *ever reached* a stage is the sum of every listing now at or beyond it.
 * That cumulative count is what makes a conversion ratio meaningful.
 *
 * Reached-counts (cumulative, furthest-stage semantics):
 *   reachedApplied   = everything that left "evaluated" and wasn't self-filtered
 *   reachedResponded = responded + interview + offer
 *   reachedInterview = interview + offer
 *   reachedOffer     = offer
 *
 * `rejected`/`discarded` are terminal but we don't know which stage they died
 * at from the status alone, so they count toward `reachedApplied` (they were
 * applied to) but not toward later stages. That makes the response/interview/
 * offer rates *conservative* — they measure "of everything I sent, how much
 * progressed", which is exactly the funnel-leak question.
 *
 * Each stage rate is the conditional conversion from the prior stage, so a low
 * rate localizes the leak:
 *   responseRate  = reachedResponded / reachedApplied
 *   interviewRate = reachedInterview / reachedResponded
 *   offerRate     = reachedOffer     / reachedInterview
 */
export function computeFunnel(enriched) {
  const counts = { evaluated: 0, applied: 0, responded: 0, interview: 0, offer: 0, rejected: 0, discarded: 0, skip: 0 }
  for (const e of enriched) {
    const s = e.normalizedStatus
    if (counts[s] !== undefined) counts[s]++
  }

  // Everything that left "evaluated" and wasn't self-filtered counts as "sent".
  const reachedApplied = counts.applied + counts.responded + counts.interview + counts.offer + counts.rejected + counts.discarded
  const reachedResponded = counts.responded + counts.interview + counts.offer
  const reachedInterview = counts.interview + counts.offer
  const reachedOffer = counts.offer

  const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null)

  const stages = [
    { stage: 'applied', label: 'Applied', reached: reachedApplied, fromPrev: null, rate: null },
    { stage: 'responded', label: 'Got a response', reached: reachedResponded, fromPrev: 'applied', rate: ratio(reachedResponded, reachedApplied) },
    { stage: 'interview', label: 'Reached interview', reached: reachedInterview, fromPrev: 'responded', rate: ratio(reachedInterview, reachedResponded) },
    { stage: 'offer', label: 'Got an offer', reached: reachedOffer, fromPrev: 'interview', rate: ratio(reachedOffer, reachedInterview) },
  ]

  return {
    counts,
    reached: { applied: reachedApplied, responded: reachedResponded, interview: reachedInterview, offer: reachedOffer },
    stages,
    responseRate: ratio(reachedResponded, reachedApplied),
    interviewRate: ratio(reachedInterview, reachedResponded),
    offerRate: ratio(reachedOffer, reachedInterview),
  }
}

/* ───── Funnel diagnosis ─────────────────────────────────────────────────────
 *
 * Names the weakest conversion gate — the stage where the most applications are
 * lost — and turns it into a concrete "this is the bottleneck, here's the lever"
 * message. We only diagnose a gate once enough applications have reached its
 * *input* stage that the rate isn't pure noise (minBase), so we don't declare a
 * "0% interview rate" off a single response.
 *
 * The fix hints are funnel-stage-specific, not company- or user-specific:
 *   response gate  → the CV/application isn't getting reads — targeting, CV
 *                    relevance, or referrals are the lever.
 *   interview gate → responses aren't converting — screening prep / fit framing.
 *   offer gate     → interviews aren't closing — interview performance / negotiation.
 */
export function diagnoseFunnel(funnel, { minBase = 3 } = {}) {
  const gates = [
    {
      stage: 'response', rate: funnel.responseRate, base: funnel.reached.applied,
      label: 'getting a response',
      lever: 'The application rarely gets read — the lever is upstream of the interview: sharper targeting (apply to fewer, better-fit roles), a more ATS-aligned CV, or a referral to skip the cold pile.',
    },
    {
      stage: 'interview', rate: funnel.interviewRate, base: funnel.reached.responded,
      label: 'converting a response into an interview',
      lever: 'Responses are coming in but stalling at the screen — the lever is screening prep: a tighter recruiter-call narrative and crisp answers to the standard competency screen.',
    },
    {
      stage: 'offer', rate: funnel.offerRate, base: funnel.reached.interview,
      label: 'closing an interview into an offer',
      lever: 'Interviews are happening but not converting — the lever is interview performance and close: STAR-story depth, role-specific cases, and negotiation.',
    },
  ]

  // Only gates with enough input volume to be meaningful, and a defined rate.
  const meaningful = gates.filter(g => g.base >= minBase && g.rate !== null)
  if (meaningful.length === 0) {
    return { hasDiagnosis: false, reason: 'Not enough applications have moved through the funnel yet to localize where you are losing them.' }
  }

  // The weakest gate (lowest conversion) is the bottleneck. Tie-break toward the
  // EARLIER gate, since fixing an upstream leak unlocks more total volume.
  const ordered = ['response', 'interview', 'offer']
  meaningful.sort((a, b) => a.rate - b.rate || ordered.indexOf(a.stage) - ordered.indexOf(b.stage))
  const weakest = meaningful[0]

  return {
    hasDiagnosis: true,
    bottleneck: weakest.stage,
    rate: weakest.rate,
    base: weakest.base,
    headline: `Your biggest leak is ${weakest.label} (${weakest.rate}% across ${weakest.base}).`,
    lever: weakest.lever,
    impact: weakest.rate <= 20 ? 'high' : 'medium',
  }
}

/* ───── Enrichment: tracker entry × report data → analysis record ───────────
 *
 * Takes parsed tracker entries and a `loadReport(pathRelToRoot) → reportData`
 * resolver (injected so this stays pure — the CLI supplies a fs-backed one).
 * reportData shape: { archetype, seniority, remote, teamSize, comp, domain,
 * scores, gaps } — exactly what parseReport in the CLI produces; any field may
 * be null/absent.
 */
export function enrichEntries(entries, loadReport) {
  return entries.map(e => {
    const reportMatch = e.report.match(/\]\(([^)]+)\)/)
    const reportData = reportMatch && typeof loadReport === 'function'
      ? loadReport(reportMatch[1])
      : null
    const outcome = classifyOutcome(e.status)
    const score = parseFloat(e.score) || 0
    const remoteSource = reportData?.remote || e.notes || ''
    const teamSource = reportData?.teamSize || ''
    return {
      ...e,
      normalizedStatus: normalizeStatus(e.status),
      outcome,
      score,
      report: reportData,
      remoteBucket: classifyRemote(remoteSource),
      companySize: classifyCompanySize(teamSource),
    }
  })
}

/* ───── Top-level outcome analysis (consumed by the CLI) ────────────────────
 *
 * `enriched` is the output of enrichEntries. minThreshold gates the whole
 * analysis on having enough post-"Evaluated" rows to be worth reading.
 */
export function analyzeOutcomes(enriched, { minThreshold = 5 } = {}) {
  if (!enriched || enriched.length === 0) {
    return { error: 'No applications found in tracker.' }
  }

  const beyondEvaluated = enriched.filter(e => e.normalizedStatus !== 'evaluated')
  if (beyondEvaluated.length < minThreshold) {
    return {
      error: `Not enough data: ${beyondEvaluated.length}/${minThreshold} applications beyond "Evaluated". Keep applying and come back later.`,
      current: beyondEvaluated.length,
      threshold: minThreshold,
    }
  }

  // --- Raw status funnel (kept for backward-compat) + stage-conversion funnel ---
  const funnel = {}
  for (const e of enriched) {
    funnel[e.normalizedStatus] = (funnel[e.normalizedStatus] || 0) + 1
  }
  const conversionFunnel = computeFunnel(enriched)
  const funnelDiagnosis = diagnoseFunnel(conversionFunnel)

  // --- Score by outcome ---
  const scoresByOutcome = { positive: [], negative: [], self_filtered: [], pending: [] }
  for (const e of enriched) {
    if (e.score > 0) scoresByOutcome[e.outcome].push(e.score)
  }
  const scoreComparison = {
    positive: scoreStats(scoresByOutcome.positive),
    negative: scoreStats(scoresByOutcome.negative),
    self_filtered: scoreStats(scoresByOutcome.self_filtered),
    pending: scoreStats(scoresByOutcome.pending),
  }

  // --- Archetype breakdown ---
  const archetypeMap = new Map()
  for (const e of enriched) {
    const arch = e.report?.archetype || 'Unknown'
    if (!archetypeMap.has(arch)) archetypeMap.set(arch, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 })
    const entry = archetypeMap.get(arch)
    entry.total++
    entry[e.outcome]++
  }
  const archetypeBreakdown = [...archetypeMap.entries()].map(([archetype, data]) => ({
    archetype, ...data,
    conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total)

  // --- Blocker analysis ---
  const blockerCounts = new Map()
  for (const e of enriched) {
    if (!e.report?.gaps) continue
    for (const gap of e.report.gaps) {
      const type = extractBlockerType(gap)
      if (!type) continue
      blockerCounts.set(type, (blockerCounts.get(type) || 0) + 1)
    }
  }
  const blockerAnalysis = [...blockerCounts.entries()]
    .map(([blocker, frequency]) => ({
      blocker, frequency,
      percentage: Math.round((frequency / enriched.length) * 100),
    }))
    .sort((a, b) => b.frequency - a.frequency)

  // --- Remote policy breakdown ---
  const remoteMap = new Map()
  for (const e of enriched) {
    if (!remoteMap.has(e.remoteBucket)) remoteMap.set(e.remoteBucket, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 })
    const entry = remoteMap.get(e.remoteBucket)
    entry.total++
    entry[e.outcome]++
  }
  const remotePolicy = [...remoteMap.entries()].map(([policy, data]) => ({
    policy, ...data,
    conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total)

  // --- Company size breakdown ---
  const sizeMap = new Map()
  for (const e of enriched) {
    if (!sizeMap.has(e.companySize)) sizeMap.set(e.companySize, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 })
    const entry = sizeMap.get(e.companySize)
    entry.total++
    entry[e.outcome]++
  }
  const companySizeBreakdown = [...sizeMap.entries()].map(([size, data]) => ({
    size, ...data,
    conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total)

  // --- Score threshold ---
  const positiveScores = scoresByOutcome.positive.filter(s => s > 0)
  const minPositiveScore = positiveScores.length > 0 ? Math.min(...positiveScores) : 0
  const scoreThreshold = {
    recommended: minPositiveScore > 0 ? Math.floor(minPositiveScore * 10) / 10 : 3.5,
    reasoning: positiveScores.length > 0
      ? `Lowest score among positive outcomes is ${minPositiveScore}. No applications below this score led to progress.`
      : 'Not enough positive outcome data to determine threshold.',
    positiveRange: positiveScores.length > 0
      ? `${Math.min(...positiveScores)} - ${Math.max(...positiveScores)}`
      : 'N/A',
  }

  // --- Tech stack gaps (from negative + self_filtered outcomes) ---
  const stackGapCounts = new Map()
  for (const e of enriched) {
    if (e.outcome !== 'negative' && e.outcome !== 'self_filtered') continue
    if (!e.report?.gaps) continue
    for (const gap of e.report.gaps) {
      const techs = (gap.description || '').match(/\b(JavaScript|TypeScript|Python|Ruby|Java|Go|Rust|Node\.?js|React|Angular|Vue\.?js|Django|Flask|Rails|PHP|Laravel|Symfony|Kotlin|Swift|C\+\+|C#|\.NET|MongoDB|MySQL|PostgreSQL|Redis|GraphQL|REST|AWS|GCP|Azure|Docker|Kubernetes|Terraform|Supabase|Inngest|React Native)\b/gi)
      if (techs) {
        for (const tech of techs) {
          const normalized = tech.charAt(0).toUpperCase() + tech.slice(1)
          stackGapCounts.set(normalized, (stackGapCounts.get(normalized) || 0) + 1)
        }
      }
    }
  }
  const techStackGaps = [...stackGapCounts.entries()]
    .map(([skill, frequency]) => ({ skill, frequency }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 15)

  // --- Recommendations ---
  const recommendations = buildOutcomeRecommendations({
    funnelDiagnosis, conversionFunnel, blockerAnalysis, techStackGaps,
    minPositiveScore, scoreThreshold, archetypeBreakdown, remotePolicy, enriched,
  })

  const dates = enriched.map(e => e.date).filter(Boolean).sort()

  return {
    metadata: {
      total: enriched.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      byOutcome: {
        positive: enriched.filter(e => e.outcome === 'positive').length,
        negative: enriched.filter(e => e.outcome === 'negative').length,
        self_filtered: enriched.filter(e => e.outcome === 'self_filtered').length,
        pending: enriched.filter(e => e.outcome === 'pending').length,
      },
    },
    funnel,
    conversionFunnel,
    funnelDiagnosis,
    scoreComparison,
    archetypeBreakdown,
    blockerAnalysis,
    remotePolicy,
    companySizeBreakdown,
    scoreThreshold,
    techStackGaps,
    recommendations,
  }
}

/* ───── Recommendation assembly ─────────────────────────────────────────────
 *
 * The funnel diagnosis leads (it's the highest-leverage "where am I losing
 * applications" signal); the existing blocker/threshold/archetype/remote
 * heuristics follow.
 */
export function buildOutcomeRecommendations({
  funnelDiagnosis, blockerAnalysis, techStackGaps, minPositiveScore,
  scoreThreshold, archetypeBreakdown, remotePolicy, enriched,
}) {
  const recommendations = []

  // 0. Funnel bottleneck — the highest-leverage move, so it leads.
  if (funnelDiagnosis?.hasDiagnosis) {
    recommendations.push({
      action: funnelDiagnosis.headline,
      reasoning: funnelDiagnosis.lever,
      impact: funnelDiagnosis.impact,
    })
  }

  // 1. Geo-restriction.
  const geoBlocker = blockerAnalysis.find(b => b.blocker === 'geo-restriction')
  if (geoBlocker && geoBlocker.percentage >= 20) {
    recommendations.push({
      action: `Tighten location filters in user/portals.yml -- ${geoBlocker.percentage}% of applications hit a geo-restriction blocker`,
      reasoning: `${geoBlocker.frequency} of ${enriched.length} offers are location-restricted. These are wasted evaluation effort.`,
      impact: 'high',
    })
  }

  // 2. Stack mismatch.
  const stackBlocker = blockerAnalysis.find(b => b.blocker === 'stack-mismatch')
  if (stackBlocker && stackBlocker.percentage >= 15) {
    const topGaps = techStackGaps.slice(0, 3).map(g => g.skill).join(', ')
    recommendations.push({
      action: `Filter out roles requiring ${topGaps} as primary stack -- ${stackBlocker.percentage}% hit stack mismatch`,
      reasoning: `Core stack gaps (${topGaps}) are the most common technical blockers in negative outcomes.`,
      impact: 'high',
    })
  }

  // 3. Score threshold.
  if (minPositiveScore > 3.0) {
    recommendations.push({
      action: `Set minimum score threshold at ${scoreThreshold.recommended}/5 before generating PDFs`,
      reasoning: `No positive outcomes below ${minPositiveScore}/5. Scores below this are wasted effort.`,
      impact: 'medium',
    })
  }

  // 4. Best archetype.
  const bestArchetype = archetypeBreakdown.filter(a => a.total >= 2).sort((a, b) => b.conversionRate - a.conversionRate)[0]
  if (bestArchetype && bestArchetype.conversionRate > 0) {
    recommendations.push({
      action: `Double down on "${bestArchetype.archetype}" roles (${bestArchetype.conversionRate}% conversion rate)`,
      reasoning: `${bestArchetype.positive} of ${bestArchetype.total} applications in this archetype led to positive outcomes.`,
      impact: 'medium',
    })
  }

  // 5. Worst remote policy.
  const worstRemote = remotePolicy.filter(r => r.total >= 2 && r.conversionRate === 0)[0]
  if (worstRemote) {
    recommendations.push({
      action: `Avoid "${worstRemote.policy}" roles (0% conversion across ${worstRemote.total} applications)`,
      reasoning: `None of the ${worstRemote.total} applications with "${worstRemote.policy}" policy led to progress.`,
      impact: 'medium',
    })
  }

  return recommendations
}

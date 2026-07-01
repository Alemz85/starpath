// Pure logic for the Pipeline view's Inbox — the triage queue of pending job
// URLs (data/pipeline.md) that haven't been evaluated yet. The Pipeline view
// pairs this inbox with the application-status Kanban (whose bucketing lives in
// lib/applyingBoard.groupByStatus); this module owns only the inbox half:
// classifying each pending URL, deciding which still need a human decision, and
// rolling the queue up into the counts + ordering the view renders.
//
// Everything here is string-in / data-in, value-out — no React, no IPC — so the
// triage rules are unit-testable in isolation. The view binds the classified
// items to its evaluate / dismiss affordances; this module never performs the
// side effect.

import { inboxEvalPrompt } from '@/lib/evalSpawn'
import { guessCompanyFromUrl, isValidHttpUrl } from '@/lib/listingUrl'
import { livenessKey } from '@/lib/scanHistory'
import type { PipelineUrl, ApplicationEntry, ScoutingEntry } from '@/types'

// ─── Inbox item classification ────────────────────────────────────────────────

// Why an inbox URL is the way it is. Drives the chip + ordering on each row.
//   'new'         → a fresh URL with no match anywhere; the prime triage target.
//   'known'       → the company already appears in applications/scouting, so this
//                   is likely a second posting from a name we've already judged —
//                   useful context, lower triage priority.
//   'evaluated'   → this exact (company, role) already has a scored entry —
//                   almost certainly a repost/dupe; lowest live priority.
//   'invalid'     → not a parseable http(s) URL (a malformed pipeline.md line);
//                   surfaced so the user can clean it up rather than silently drop.
export type InboxReason = 'new' | 'known' | 'evaluated' | 'invalid'

export interface InboxItem {
  /** The raw URL exactly as it sits in pipeline.md (the dedup + dismiss key). */
  url: string
  /** Best-effort company name pulled from the URL host/path, or null when the
   *  host is opaque (e.g. a bare ATS id with no company segment). Display hint
   *  only — the real name comes from the JD scrape at evaluation time. */
  companyHint: string | null
  /** Role title from the scanner-written pipeline line, when present. */
  title?: string
  /** Short, human-readable host label for grouping/scanning (e.g.
   *  "greenhouse.io", "lever.co"), or '' when the URL doesn't parse. */
  source: string
  /** Marked stale by the cache sync (the posting is old / likely closed). */
  isStale: boolean
  /** When the URL was added to the inbox, if known. */
  addedDate?: string
  reason: InboxReason
  /** Deterministic triage score — orders the queue best-first. Mirrors the
   *  renderer-available half of scripts/lib/triage-core.mjs's signal set. */
  triageScore: number
  /** Named contributions behind triageScore, for the row tooltip. */
  scoreReasons: string[]
}

// A barely-readable host → "is this a name we already know?" check. We match on
// the parsed company (or the URL hint as fallback) because a pending URL almost
// never shares an exact string with an applications.md row (different ATS host,
// redirect, etc.), but the company name is the stable join the rest of the app
// keys on (livenessKey).
function buildKnownCompanySet(
  applications: ApplicationEntry[],
  scouting: ScoutingEntry[],
): Set<string> {
  const set = new Set<string>()
  for (const a of applications) set.add(normalizeCompany(a.company))
  for (const s of scouting) set.add(normalizeCompany(s.company))
  return set
}

// Exact (company, role) keys of everything already scored — a pending URL that
// hits this set is almost certainly a repost of an entry we've judged. Same
// fold as livenessKey so the verdict agrees with the Database's join.
function buildEvaluatedKeySet(
  applications: ApplicationEntry[],
  scouting: ScoutingEntry[],
): Set<string> {
  const set = new Set<string>()
  for (const a of applications) set.add(livenessKey(a.company, a.role))
  for (const s of scouting) set.add(livenessKey(s.company, s.role))
  return set
}

// Case/space-fold a company name into a comparison key. Mirrors the spirit of
// livenessKey's company half (which folds the same way) so the inbox's "known"
// verdict agrees with how the Database keys the same company.
function normalizeCompany(company: string): string {
  return livenessKey(company, '').replace(/\|$/, '')
}

// Strip the host down to a scannable label: drop a leading `www.` and the
// long ATS subdomain noise so the user reads "greenhouse.io" not
// "boards.greenhouse.io". Returns '' for an unparseable URL.
export function inboxSource(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    // Collapse known multi-label ATS hosts to their registrable label.
    const parts = host.split('.')
    if (parts.length > 2) {
      const tail = parts.slice(-2).join('.')
      // Keep the registrable domain for the common ATS/job hosts; for an
      // arbitrary corporate careers subdomain the registrable domain is still
      // the most scannable grouping key.
      return tail
    }
    return host
  } catch {
    return ''
  }
}

// ─── Triage scoring ───────────────────────────────────────────────────────────

// Renderer-side mirror of the signal weights in scripts/lib/triage-core.mjs
// (the CLI adds scan-history freshness + profile.yml company boosts, which the
// renderer doesn't have; the shared signals use the same magnitudes so the two
// rankings agree in shape). Senior titles are a safety net behind the scan
// filter; 'evaluated' is the exact-dupe demotion.
const TRIAGE_WEIGHTS = {
  entryTitle: 1,
  seniorTitle: -4,
  knownCompany: -1,
  alreadyEvaluated: -5,
  stale: -2,
}

const SENIOR_TITLE_RE = /\b(senior|sr\.?|lead|principal|staff|director|head of|vp|vice president)\b/i
const ENTRY_TITLE_RE = /\b(intern(ship)?|graduate|grad|junior|trainee|werkstudent|working student|early careers?|rotational|associate program(me)?)\b/i

// Classify + score one pending URL against what we already know. Pure.
export function classifyInboxItem(
  pending: PipelineUrl,
  knownCompanies: Set<string>,
  evaluatedKeys: Set<string>,
): InboxItem {
  const url = pending.url
  if (!isValidHttpUrl(url)) {
    return {
      url,
      companyHint: null,
      source: '',
      isStale: pending.isStale,
      addedDate: pending.addedDate,
      reason: 'invalid',
      triageScore: 0,
      scoreReasons: ['malformed pipeline.md line'],
    }
  }

  // Prefer the scanner-parsed company; the URL hint is the manual-add fallback.
  const companyHint = pending.company || guessCompanyFromUrl(url)
  const title = pending.title

  const reasons: string[] = []
  let score = 0
  if (pending.relevance != null) {
    score += pending.relevance
    reasons.push(`scan relevance ${pending.relevance.toFixed(1)}`)
  } else {
    reasons.push('no scan relevance (manual add)')
  }

  let reason: InboxReason = 'new'
  if (companyHint != null && title && evaluatedKeys.has(livenessKey(companyHint, title))) {
    reason = 'evaluated'
    score += TRIAGE_WEIGHTS.alreadyEvaluated
    reasons.push(`already scored (${TRIAGE_WEIGHTS.alreadyEvaluated})`)
  } else if (companyHint != null && knownCompanies.has(normalizeCompany(companyHint))) {
    reason = 'known'
    score += TRIAGE_WEIGHTS.knownCompany
    reasons.push(`company already in trackers (${TRIAGE_WEIGHTS.knownCompany})`)
  }

  if (title && SENIOR_TITLE_RE.test(title)) {
    score += TRIAGE_WEIGHTS.seniorTitle
    reasons.push(`senior-title signal (${TRIAGE_WEIGHTS.seniorTitle})`)
  } else if (title && ENTRY_TITLE_RE.test(title)) {
    score += TRIAGE_WEIGHTS.entryTitle
    reasons.push(`entry-level title (+${TRIAGE_WEIGHTS.entryTitle})`)
  }

  if (pending.isStale) {
    score += TRIAGE_WEIGHTS.stale
    reasons.push(`stale (${TRIAGE_WEIGHTS.stale})`)
  }

  return {
    url,
    companyHint,
    title,
    source: inboxSource(url),
    isStale: pending.isStale,
    addedDate: pending.addedDate,
    reason,
    triageScore: Number(score.toFixed(2)),
    scoreReasons: reasons,
  }
}

// ─── Queue assembly + ordering ────────────────────────────────────────────────

// Build the ordered inbox queue from the raw pending URLs + the known corpus.
// Best triage score first (the real work floats to the top); invalid lines
// always sink to the bottom (cleanup, not triage). Ties keep pipeline.md
// insertion order so the queue doesn't churn between renders.
export function buildInbox(
  pending: PipelineUrl[],
  applications: ApplicationEntry[],
  scouting: ScoutingEntry[],
): InboxItem[] {
  const known = buildKnownCompanySet(applications, scouting)
  const evaluated = buildEvaluatedKeySet(applications, scouting)
  const items = pending.map(p => classifyInboxItem(p, known, evaluated))
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const aInvalid = a.item.reason === 'invalid' ? 1 : 0
      const bInvalid = b.item.reason === 'invalid' ? 1 : 0
      if (aInvalid !== bInvalid) return aInvalid - bInvalid
      const d = b.item.triageScore - a.item.triageScore
      return d !== 0 ? d : a.i - b.i
    })
    .map(({ item }) => item)
}

// ─── Inbox rollup ─────────────────────────────────────────────────────────────

export interface InboxStats {
  /** Every pending URL, valid or not. */
  total: number
  /** Fresh URLs with no known-company match — the count that should drive the
   *  inbox badge ("3 to triage"); these are the ones genuinely awaiting a call. */
  fresh: number
  /** URLs whose company we've already evaluated elsewhere. */
  known: number
  /** Stale (likely-closed) URLs, regardless of reason. */
  stale: number
  /** Malformed lines that need cleanup. */
  invalid: number
}

// Roll the classified queue into the header counts. `fresh` deliberately
// excludes stale items: a stale URL is unlikely to still be live, so it
// shouldn't inflate the "you have N things to triage" signal. 'evaluated'
// items fold into `known` — both are "we've seen this name before" context.
export function inboxStats(items: InboxItem[]): InboxStats {
  let fresh = 0, known = 0, stale = 0, invalid = 0
  for (const it of items) {
    if (it.isStale) stale++
    if (it.reason === 'invalid') { invalid++; continue }
    if (it.reason === 'known' || it.reason === 'evaluated') { known++; continue }
    // reason === 'new'
    if (!it.isStale) fresh++
  }
  return { total: items.length, fresh, known, stale, invalid }
}

// Group the queue by source host for an optional "by portal" read. Insertion
// order of first-seen sources is preserved (Map keeps it), and items within a
// source keep their queue order.
export function groupInboxBySource(items: InboxItem[]): { source: string; items: InboxItem[] }[] {
  const map = new Map<string, InboxItem[]>()
  for (const it of items) {
    const key = it.source || '(unknown)'
    const bucket = map.get(key)
    if (bucket) bucket.push(it)
    else map.set(key, [it])
  }
  return [...map.entries()].map(([source, items]) => ({ source, items }))
}

// ─── Triage command ───────────────────────────────────────────────────────────

// The task prompt that evaluates a single inbox URL through the scouting
// pipeline. Scoped to one URL so the inbox can triage items one at a time
// without re-running the whole queue. Since token-cost lever 3 it no longer
// routes through the `/career-ops` skill: the rubric comes from the compact
// eval bundle (see lib/evalSpawn.ts — spawn with `claudeEvalArgs`, not
// `claudeArgs`). The view feeds this to the spawn store; this module owns
// the string, not the spawn.
export function evaluateInboxCommand(url: string): string {
  return inboxEvalPrompt(url)
}

// A deterministic spawn id for an inbox URL's evaluation, so re-triggering the
// same URL targets the same in-flight spawn (and the view can show its status
// on the row). Slugged from the URL so it's filesystem/id-safe.
export function inboxSpawnId(url: string): string {
  const slug = url.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `inbox-eval-${slug || 'url'}`
}

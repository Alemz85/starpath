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

import { guessCompanyFromUrl, isValidHttpUrl } from '@/lib/listingUrl'
import { livenessKey } from '@/lib/scanHistory'
import type { PipelineUrl, ApplicationEntry, ScoutingEntry } from '@/types'

// ─── Inbox item classification ────────────────────────────────────────────────

// Why an inbox URL is the way it is. Drives the chip + ordering on each row.
//   'new'         → a fresh URL with no match anywhere; the prime triage target.
//   'known'       → the company already appears in applications/scouting, so this
//                   is likely a second posting from a name we've already judged —
//                   useful context, lower triage priority.
//   'invalid'     → not a parseable http(s) URL (a malformed pipeline.md line);
//                   surfaced so the user can clean it up rather than silently drop.
export type InboxReason = 'new' | 'known' | 'invalid'

export interface InboxItem {
  /** The raw URL exactly as it sits in pipeline.md (the dedup + dismiss key). */
  url: string
  /** Best-effort company name pulled from the URL host/path, or null when the
   *  host is opaque (e.g. a bare ATS id with no company segment). Display hint
   *  only — the real name comes from the JD scrape at evaluation time. */
  companyHint: string | null
  /** Short, human-readable host label for grouping/scanning (e.g.
   *  "greenhouse.io", "lever.co"), or '' when the URL doesn't parse. */
  source: string
  /** Marked stale by the cache sync (the posting is old / likely closed). */
  isStale: boolean
  /** When the URL was added to the inbox, if known. */
  addedDate?: string
  reason: InboxReason
}

// A barely-readable host → "is this a name we already know?" check. We match on
// the company hint because a pending URL almost never shares an exact string
// with an applications.md row (different ATS host, redirect, etc.), but the
// company name is the stable join the rest of the app keys on (livenessKey).
function buildKnownCompanySet(
  applications: ApplicationEntry[],
  scouting: ScoutingEntry[],
): Set<string> {
  const set = new Set<string>()
  for (const a of applications) set.add(normalizeCompany(a.company))
  for (const s of scouting) set.add(normalizeCompany(s.company))
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

// Classify one pending URL against what we already know. Pure.
export function classifyInboxItem(
  pending: PipelineUrl,
  knownCompanies: Set<string>,
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
    }
  }
  const companyHint = guessCompanyFromUrl(url)
  const known = companyHint != null && knownCompanies.has(normalizeCompany(companyHint))
  return {
    url,
    companyHint,
    source: inboxSource(url),
    isStale: pending.isStale,
    addedDate: pending.addedDate,
    reason: known ? 'known' : 'new',
  }
}

// ─── Queue assembly + ordering ────────────────────────────────────────────────

// Triage priority: fresh, unknown URLs first (the real work), then known-company
// URLs (context, lower priority), then stale ones (likely closed), then invalid
// lines (cleanup). Within a bucket, keep insertion order stable so the queue
// doesn't churn between renders.
const REASON_RANK: Record<InboxReason, number> = { new: 0, known: 1, invalid: 3 }

// A stale item sinks below live ones of the same reason — it's least likely to
// be worth evaluating. Encoded as a half-step so it never crosses a reason
// boundary (a fresh 'new' still beats a stale 'new', but a stale 'new' still
// beats any 'known').
function itemRank(item: InboxItem): number {
  return REASON_RANK[item.reason] + (item.isStale ? 0.5 : 0)
}

// Build the ordered inbox queue from the raw pending URLs + the known corpus.
// Stable sort (Array.prototype.sort is stable in modern V8) preserves the
// pipeline.md order inside each priority bucket.
export function buildInbox(
  pending: PipelineUrl[],
  applications: ApplicationEntry[],
  scouting: ScoutingEntry[],
): InboxItem[] {
  const known = buildKnownCompanySet(applications, scouting)
  const items = pending.map(p => classifyInboxItem(p, known))
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const r = itemRank(a.item) - itemRank(b.item)
      return r !== 0 ? r : a.i - b.i
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
// shouldn't inflate the "you have N things to triage" signal.
export function inboxStats(items: InboxItem[]): InboxStats {
  let fresh = 0, known = 0, stale = 0, invalid = 0
  for (const it of items) {
    if (it.isStale) stale++
    if (it.reason === 'invalid') { invalid++; continue }
    if (it.reason === 'known') { known++; continue }
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

// The slash command that evaluates a single inbox URL through the scouting
// pipeline. Mirrors the FILTER path the Scouting view's "Generate Reports"
// runs (modes/pipeline.md), but scoped to one pasted URL so the inbox can
// triage items one at a time without re-running the whole queue. The view
// feeds this to the spawn store; this module owns the string, not the spawn.
export function evaluateInboxCommand(url: string): string {
  return (
    `/career-ops pipeline — FILTER + DIMENSIONAL SCORE mode for this single URL: ${url}. ` +
    'Fetch the JD via Playwright/WebFetch, apply user/portals.yml title filters and the ' +
    'modes/pipeline.md relevance gate. If it survives, run the full dimensional scoring per ' +
    'modes/scouting.md, classify the tier, write the row to data/scouting.md + ' +
    'data/score-history.tsv, and mark the URL [x] in data/pipeline.md. If it fails the gate, ' +
    'move it to the Filtered Out section with a reason. Do NOT write a prose report file.'
  )
}

// A deterministic spawn id for an inbox URL's evaluation, so re-triggering the
// same URL targets the same in-flight spawn (and the view can show its status
// on the row). Slugged from the URL so it's filesystem/id-safe.
export function inboxSpawnId(url: string): string {
  const slug = url.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `inbox-eval-${slug || 'url'}`
}

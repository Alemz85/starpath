// whats-new-core.mjs — pure "what's new & worth my time since last scan" math.
//
// After a scan run the canonical files grow, but the user gets no quick read on
// what is *actually new* versus noise, and which of the new postings are worth
// spending evaluation effort on. The signal already exists in the data:
//
//   - data/scan-history.tsv  — every posting the scanners ever surfaced, with a
//     `first_seen` date, a `status` (added / skipped_*), and a pipe-joined list
//     of `scan_dates` (every run that re-saw the URL → liveness signal).
//   - data/score-history.tsv — every scouting evaluation, keyed by `url`, with
//     the v2 dimensions, Match, Ease, Priority, the eligibility gate result and
//     the verdict (docs/scoring-v2.md §8.1).
//
// This module joins those two read-only sources and emits a ranked digest:
// genuinely-new postings since a cutoff, bucketed by their verdict (go /
// stretch+solid / thin+growth / skip / blocked), with the new-but-unscored
// ones flagged as "needs eval". Within a bucket, Priority (√(Match·Ease)) is
// the sort key; it is never shown as a score.
//
// All functions are pure (no I/O, no globals, no mutation). The thin file/CLI
// wrapper lives in scripts/whats-new.mjs. Parsing is reused from
// targeting-core.mjs and the verdict rules from score-bands.mjs, so the score
// semantics stay single-sourced.

import { parseEligibilityFlags } from './targeting-core.mjs'
import { assignVerdict, computePriority, VERDICT_ORDER, VERDICT_LABELS } from './score-bands.mjs'

/* ───── scan-history.tsv parsing ────────────────────────────────────────────
 *
 * Tab-separated with a header row:
 *   url  first_seen  portal  title  company  location  status  scan_dates
 * `scan_dates` is a pipe-joined list of YYYY-MM-DD run dates. We parse
 * defensively: short/blank lines are skipped, and a missing header still works
 * via the canonical column order.
 */
const SCAN_HEADER_FALLBACK = [
  'url', 'first_seen', 'portal', 'title', 'company', 'location', 'status',
  'scan_dates',
]

export function parseScanHistory(tsvText) {
  if (!tsvText) return []
  const lines = tsvText.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return []

  const first = lines[0].split('\t')
  const hasHeader = first[0] === 'url' && first.includes('first_seen')
  const header = hasHeader ? first : SCAN_HEADER_FALLBACK
  const dataLines = hasHeader ? lines.slice(1) : lines

  const rows = []
  for (const line of dataLines) {
    const cells = line.split('\t')
    if (cells.length < 2) continue // need at least url + first_seen
    const row = {}
    header.forEach((key, i) => {
      row[key] = cells[i] !== undefined ? cells[i].trim() : ''
    })
    row.scan_dates_list = row.scan_dates
      ? row.scan_dates.split('|').map((d) => d.trim()).filter(Boolean)
      : []
    rows.push(row)
  }
  return rows
}

/* ───── URL normalization for the scan↔score join ───────────────────────────
 *
 * The two logs reference the same posting by URL, but a posting can re-appear
 * with a trailing slash, a different scheme, or extra tracking query params.
 * We normalize to a stable join key: lowercase host, no scheme, no trailing
 * slash, query string dropped (the path / gh_jid identifies the posting).
 * gh_jid / jid live in the query for some boards, so those are preserved.
 * Falls back to the raw lowercased string when the URL doesn't parse.
 */
export function normalizeUrl(raw) {
  if (!raw) return ''
  let s = String(raw).trim()
  if (!s) return ''
  // Some score-history rows carry an empty / placeholder url.
  if (s === 'n/d' || s === 'n/a') return ''
  try {
    const u = new URL(s)
    const host = u.host.toLowerCase()
    const path = u.pathname.replace(/\/+$/, '') // strip trailing slash(es)
    const idParam =
      u.searchParams.get('gh_jid') ||
      u.searchParams.get('jid') ||
      ''
    const key = `${host}${path}`
    return idParam ? `${key}?id=${idParam}` : key
  } catch {
    return s.toLowerCase().replace(/\/+$/, '')
  }
}

/* ───── Date helpers ────────────────────────────────────────────────────────
 * Dates are YYYY-MM-DD strings; lexicographic compare is chronological.
 */
function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
}

function daysBetween(a, b) {
  // whole days from a → b (b - a), via UTC midnight to dodge DST.
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const ta = Date.UTC(ay, am - 1, ad)
  const tb = Date.UTC(by, bm - 1, bd)
  return Math.round((tb - ta) / 86_400_000)
}

/**
 * The set of distinct run dates the scanner ever recorded, newest first.
 * Derived from every row's first_seen + scan_dates list (union). Used to infer
 * "the last run" and "the run before it" when the caller doesn't pass a cutoff.
 */
export function runDates(scanRows) {
  const set = new Set()
  for (const r of scanRows) {
    if (isValidDate(r.first_seen)) set.add(r.first_seen)
    for (const d of r.scan_dates_list || []) if (isValidDate(d)) set.add(d)
  }
  return [...set].sort().reverse()
}

/**
 * Decide the cutoff date that separates "new" from "already seen".
 *
 * The cutoff is INCLUSIVE: a posting is "new" when first_seen >= cutoff.
 *
 *  - explicit `since` wins (validated).
 *  - else if `days` given, cutoff = latestRun - days.
 *  - else default: the latest run date itself, i.e. "new since the previous
 *    scan" = everything first seen on the most recent run (inclusive). Postings
 *    first seen on any earlier run are, by definition, not new this run.
 *
 * Returns { cutoff, latestRun, basis } where basis explains the choice.
 */
export function resolveCutoff(scanRows, { since = null, days = null } = {}) {
  const dates = runDates(scanRows)
  const latestRun = dates[0] || null

  if (since && isValidDate(since)) {
    return { cutoff: since, latestRun, basis: 'since' }
  }
  if (Number.isFinite(days) && days >= 0 && latestRun) {
    const [y, m, d] = latestRun.split('-').map(Number)
    const t = Date.UTC(y, m - 1, d) - days * 86_400_000
    const dt = new Date(t)
    const cutoff = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
    return { cutoff, latestRun, basis: 'days' }
  }
  // default: postings first seen on the most recent run.
  return {
    cutoff: latestRun,
    latestRun,
    basis: dates.length > 1 ? 'latest-run' : 'single-run',
  }
}

/* ───── Score join ──────────────────────────────────────────────────────────
 *
 * Index score-history rows by normalized URL, keeping the *most recent*
 * evaluation per URL (re-evals overwrite). Returns Map<normUrl, scoreRow>.
 */
export function indexScoresByUrl(scoreRows) {
  const byUrl = new Map()
  for (const r of scoreRows) {
    const key = normalizeUrl(r.url)
    if (!key) continue
    const prev = byUrl.get(key)
    if (!prev) {
      byUrl.set(key, r)
    } else if (isValidDate(r.date) && (!isValidDate(prev.date) || r.date >= prev.date)) {
      byUrl.set(key, r)
    }
  }
  return byUrl
}

/* ───── Bucketing by verdict ────────────────────────────────────────────────
 *
 * Each new posting lands in one bucket, read off its scoring v2 verdict
 * (docs/scoring-v2.md §4) — never off a cut-off on a number. Order = how
 * loudly to surface:
 *
 *   go          verdict go: apply now.
 *   apply       verdict stretch or solid: apply (stretch: with prep).
 *   consider    verdict thin or growth: only if the pipeline is thin / close
 *               the gap first — worth a look, not a priority.
 *   needs-eval  added to the pipeline but never scored (or the score row has
 *               no usable verdict): unknown, go evaluate it.
 *   skip        verdict skip: recommend against applying.
 *   blocked     eligibility red: not eligible. Rendered "blocked: <reason>".
 *   noise       surfaced but filtered/skipped by the scanner (not `added`).
 *
 * Within a bucket, items rank by Priority (√(Match·Ease), a sort key only).
 */
const BUCKET_ORDER = ['go', 'apply', 'consider', 'needs-eval', 'skip', 'blocked', 'noise']

const VERDICT_BUCKET = {
  go: 'go',
  stretch: 'apply',
  solid: 'apply',
  thin: 'consider',
  growth: 'consider',
  skip: 'skip',
  blocked: 'blocked',
}

/**
 * The verdict of a score-history row: the stored/derived `verdict`
 * (targeting-core.parseScoreHistory fills it), else re-derived through the
 * engine from finite Match/Ease. Blocked rows (eligibility red) are 'blocked'.
 * Returns '' when nothing is derivable.
 */
export function verdictOf(scoreRow) {
  if (!scoreRow) return ''
  if (scoreRow.blocked === true || String(scoreRow.eligibility ?? '').toLowerCase() === 'red') return 'blocked'
  const v = String(scoreRow.verdict ?? '').trim().toLowerCase()
  if (VERDICT_ORDER.includes(v)) return v
  const match = Number(scoreRow.match)
  const ease = Number(scoreRow.ease)
  if (Number.isFinite(match) && Number.isFinite(ease)) {
    return assignVerdict({ match, ease, eligibility: scoreRow.eligibility || 'green' }).verdict
  }
  return ''
}

/**
 * Why a blocked row is blocked, from its eligibility flags: the first red
 * flag's reason (else its check name), else 'eligibility red'. Accepts parsed
 * `eligibilityFlags` or the raw `eligibility_flags` cell.
 */
export function blockedReasonOf(scoreRow) {
  if (!scoreRow) return ''
  const flags = Array.isArray(scoreRow.eligibilityFlags)
    ? scoreRow.eligibilityFlags
    : parseEligibilityFlags(scoreRow.eligibility_flags)
  const red = flags.find((f) => f.status === 'red')
  if (red) return red.reason || red.check || 'eligibility red'
  return 'eligibility red'
}

/** Bucket key for a scan row × its (latest) score-history row. */
export function bucketOf(scanRow, scoreRow) {
  if (scanRow.status !== 'added') return 'noise'
  if (!scoreRow) return 'needs-eval'
  return VERDICT_BUCKET[verdictOf(scoreRow)] || 'needs-eval'
}

/** @deprecated v1 name; returns the bucket key (see bucketOf). */
export const priorityOf = bucketOf

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null)

/* ───── Core digest builder ─────────────────────────────────────────────────
 *
 * Returns a structured digest object:
 *   { cutoff, latestRun, basis, asOf, totalNew, counts, items,
 *     prioritize, needsEval, blocked }
 * where `items` is every new posting (first_seen >= cutoff) enriched with its
 * verdict + bucket, sorted most-actionable first. `prioritize` = the go and
 * apply buckets (verdict go / stretch / solid), in rank order.
 *
 * Item shape:
 *   { url, company, title, location, portal, status, firstSeen, ageDays,
 *     timesSeen, match, ease, priority, verdict, verdictLabel, eligibility,
 *     blockedReason, archetype, bucket }
 *   match / ease / priority — numbers, null when unscored or blocked
 *   verdict                — verdict key, null when unscored
 *   verdictLabel           — VERDICT_LABELS[verdict]; "blocked: <reason>" for blocked
 *   blockedReason          — the red eligibility reason, null unless blocked
 *
 * Options:
 *   since / days        — passed to resolveCutoff.
 *   includeNoise        — keep scanner-skipped rows (default false).
 *   asOf                — "today" for freshness math (default = latestRun).
 */
export function buildDigest(scanRows, scoreRows, opts = {}) {
  const { includeNoise = false } = opts
  const { cutoff, latestRun, basis } = resolveCutoff(scanRows, opts)
  const asOf = (opts.asOf && isValidDate(opts.asOf)) ? opts.asOf : latestRun
  const scoresByUrl = indexScoresByUrl(scoreRows)

  const items = []
  for (const r of scanRows) {
    if (!isValidDate(r.first_seen)) continue
    if (cutoff && r.first_seen < cutoff) continue // not new

    const scoreRow = scoresByUrl.get(normalizeUrl(r.url)) || null
    const bucket = bucketOf(r, scoreRow)
    if (bucket === 'noise' && !includeNoise) continue

    const verdict = scoreRow ? (verdictOf(scoreRow) || null) : null
    const blocked = verdict === 'blocked'
    const match = !blocked && scoreRow ? finiteOrNull(Number(scoreRow.match)) : null
    const ease = !blocked && scoreRow ? finiteOrNull(Number(scoreRow.ease)) : null
    const stored = scoreRow ? finiteOrNull(Number(scoreRow.priority)) : null
    const priority = blocked ? null : (stored ?? computePriority(match, ease))
    const blockedReason = blocked ? blockedReasonOf(scoreRow) : null
    items.push({
      url: r.url,
      company: r.company || '',
      title: r.title || '',
      location: r.location || '',
      portal: r.portal || '',
      status: r.status || '',
      firstSeen: r.first_seen,
      ageDays: asOf && isValidDate(asOf) ? daysBetween(r.first_seen, asOf) : null,
      timesSeen: (r.scan_dates_list || []).length || 1,
      match,
      ease,
      priority,
      verdict,
      verdictLabel: blocked ? `blocked: ${blockedReason}` : (verdict ? VERDICT_LABELS[verdict] : null),
      eligibility: scoreRow ? (scoreRow.eligibility || null) : null,
      blockedReason,
      archetype: scoreRow ? scoreRow.archetype : null,
      bucket,
    })
  }

  // Sort: bucket, then Priority desc (unscored last), then freshest, then
  // company/title for stable ordering.
  const rank = (b) => {
    const i = BUCKET_ORDER.indexOf(b)
    return i === -1 ? BUCKET_ORDER.length : i
  }
  items.sort((a, b) => {
    if (rank(a.bucket) !== rank(b.bucket)) return rank(a.bucket) - rank(b.bucket)
    const ap = a.priority == null ? -Infinity : a.priority
    const bp = b.priority == null ? -Infinity : b.priority
    if (ap !== bp) return bp - ap
    if (a.firstSeen !== b.firstSeen) return a.firstSeen < b.firstSeen ? 1 : -1
    if (a.company !== b.company) return a.company < b.company ? -1 : 1
    return a.title < b.title ? -1 : 1
  })

  const counts = {}
  for (const b of BUCKET_ORDER) counts[b] = 0
  for (const it of items) counts[it.bucket] = (counts[it.bucket] || 0) + 1

  return {
    cutoff,
    latestRun,
    basis,
    asOf,
    totalNew: items.length,
    counts,
    items,
    prioritize: items.filter((i) => i.bucket === 'go' || i.bucket === 'apply'),
    needsEval: items.filter((i) => i.bucket === 'needs-eval'),
    blocked: items.filter((i) => i.bucket === 'blocked'),
  }
}

/** Star marker for a verdict: go ★★, stretch / solid ★, anything else (incl. blocked) none. */
export function verdictStars(verdict) {
  if (verdict === 'go') return '★★'
  if (verdict === 'stretch' || verdict === 'solid') return '★'
  return ''
}

export const BUCKET_LABELS = {
  go: 'Go — apply now',
  apply: 'Apply (stretch / solid)',
  consider: 'Worth a look (thin / growth)',
  'needs-eval': 'Needs eval',
  skip: 'Skip',
  blocked: 'Blocked',
  noise: 'Filtered',
}

/** @deprecated v1 names, kept as aliases of BUCKET_LABELS / BUCKET_ORDER. */
export const PRIORITY_LABELS = BUCKET_LABELS

export { BUCKET_ORDER, BUCKET_ORDER as PRIORITY_ORDER }

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
//     the full dimensional fingerprint + an `overall` score + `archetype`.
//
// This module joins those two read-only sources and emits a ranked digest:
// genuinely-new postings since a cutoff, surfaced by the fit signal already on
// hand (the scouting `overall` where one exists), with the new-AND-high-fit
// ones flagged to prioritize and the new-but-unscored ones flagged as
// "needs eval".
//
// All functions are pure (no I/O, no globals, no mutation). The thin file/CLI
// wrapper lives in scripts/whats-new.mjs. Parsing/banding is reused from
// targeting-core.mjs so the score semantics stay single-sourced.

import { overallBand } from './targeting-core.mjs'

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

/* ───── Priority bucketing ──────────────────────────────────────────────────
 *
 * Each new posting lands in one priority bucket. Order = how loudly to surface:
 *   prioritize  — scored strong/solid (overall ≥ 7.0): a real, worth-it match.
 *   review      — scored pass (6.0–6.99): borderline / growth target.
 *   needs-eval  — added to pipeline but never scored: unknown, go evaluate it.
 *   low         — scored weak (< 6.0): likely not worth applying.
 *   noise       — surfaced but filtered/skipped by the scanner (not `added`).
 */
const PRIORITY_ORDER = ['prioritize', 'review', 'needs-eval', 'low', 'noise']

export function priorityOf(scanRow, scoreRow) {
  const added = scanRow.status === 'added'
  if (!added) return 'noise'
  if (!scoreRow) return 'needs-eval'
  const band = overallBand(scoreRow.overall)
  if (band === 'strong' || band === 'solid') return 'prioritize'
  if (band === 'pass') return 'review'
  if (band === 'weak') return 'low'
  return 'needs-eval' // scored row with unparseable overall → treat as unknown
}

/* ───── Core digest builder ─────────────────────────────────────────────────
 *
 * Returns a structured digest object:
 *   { cutoff, latestRun, basis, asOf, totalNew, counts, items,
 *     prioritize, needsEval }
 * where `items` is every new posting (first_seen >= cutoff) enriched with its
 * fit signal + priority, sorted most-actionable first.
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
    const priority = priorityOf(r, scoreRow)
    if (priority === 'noise' && !includeNoise) continue

    const overall = scoreRow && Number.isFinite(scoreRow.overall) ? scoreRow.overall : null
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
      overall,
      band: overall != null ? overallBand(overall) : null,
      archetype: scoreRow ? scoreRow.archetype : null,
      priority,
    })
  }

  // Sort: priority bucket, then (within scored) overall desc, then freshest,
  // then company/title for stable ordering.
  const rank = (p) => {
    const i = PRIORITY_ORDER.indexOf(p)
    return i === -1 ? PRIORITY_ORDER.length : i
  }
  items.sort((a, b) => {
    if (rank(a.priority) !== rank(b.priority)) return rank(a.priority) - rank(b.priority)
    const ao = a.overall == null ? -Infinity : a.overall
    const bo = b.overall == null ? -Infinity : b.overall
    if (ao !== bo) return bo - ao
    if (a.firstSeen !== b.firstSeen) return a.firstSeen < b.firstSeen ? 1 : -1
    if (a.company !== b.company) return a.company < b.company ? -1 : 1
    return a.title < b.title ? -1 : 1
  })

  const counts = {}
  for (const p of PRIORITY_ORDER) counts[p] = 0
  for (const it of items) counts[it.priority] = (counts[it.priority] || 0) + 1

  return {
    cutoff,
    latestRun,
    basis,
    asOf,
    totalNew: items.length,
    counts,
    items,
    prioritize: items.filter((i) => i.priority === 'prioritize'),
    needsEval: items.filter((i) => i.priority === 'needs-eval'),
  }
}

export const PRIORITY_LABELS = {
  prioritize: 'Prioritize',
  review: 'Worth a look',
  'needs-eval': 'Needs eval',
  low: 'Low fit',
  noise: 'Filtered',
}

export { PRIORITY_ORDER }

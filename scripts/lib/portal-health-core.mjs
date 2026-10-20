/**
 * portal-health-core.mjs — pure logic for the portal health log.
 *
 * Every scanner run records one row per company in `data/portal-health.tsv`
 * (scan.mjs for the API companies, the Full scan agent for the WebSearch
 * ones). `reviewPortalHealth` turns that history into suggestions the user
 * decides on, never into edits of `user/portals.yml`:
 *
 *   fix      the company's endpoint has failed several runs in a row
 *            (wrong careers_url / api, a board that moved, a host that blocks
 *            the scanner) — check the URL or pause it;
 *   pause    the board answers but has had no matching role across enough
 *            runs and enough calendar time — pause or drop it, it costs a
 *            fetch (API) or a search + verifications (WebSearch) per scan;
 *   promote  a company that is NOT tracked keeps turning up with roles the
 *            user wants (found by the board-wide WebSearch queries or the
 *            aggregators more than once, or scored go/stretch/solid) — add it
 *            to tracked_companies; a tracked-but-disabled company with such a
 *            score is suggested for re-enabling.
 *
 * Thresholds are exported, not inlined, so the docs and the tests say the
 * same thing. Dates are ISO day strings. No I/O here (see portal-health-io.mjs).
 */

import { normalizeCompany } from './dedup-index.mjs'

export const HEALTH_COLUMNS = Object.freeze(['date', 'company', 'source', 'outcome', 'jobs', 'kept', 'note'])
export const HEALTH_HEADER = HEALTH_COLUMNS.join('\t')
export const OUTCOMES = Object.freeze(['ok', 'error', 'unreachable'])

export const THRESHOLDS = Object.freeze({
  /** `fix`: this many most-recent runs all failed. */
  fixMinConsecutiveFailures: 3,
  /** `pause`: at least this many runs spanning at least this many days, all with kept = 0. */
  pauseMinRuns: 4,
  pauseMinSpanDays: 45,
  /** `promote`: an untracked company found (status `added`) by a non-API source this many times… */
  promoteMinFinds: 2,
  /** …or scored with one of these verdicts at least once. */
  promoteVerdicts: Object.freeze(['go', 'stretch', 'solid']),
  /** The review lists at most this many suggestions per kind. */
  maxPerKind: 5,
})

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim()
const isoDay = (v) => {
  const s = String(v || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(s)
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : s // 2026-13-99 is not a day
}
const key = (name) => normalizeCompany(clean(name))

/** Normalize one record; throws on a missing company, an unknown outcome or a bad date. */
export function buildHealthRow({ date, company, source, outcome, jobs, kept, note }) {
  const d = isoDay(date)
  if (!d) throw new Error(`date must be YYYY-MM-DD, got "${date}"`)
  const c = clean(company)
  if (!c) throw new Error('company is required')
  const o = clean(outcome).toLowerCase()
  if (!OUTCOMES.includes(o)) throw new Error(`outcome must be one of ${OUTCOMES.join('|')}, got "${outcome}"`)
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 }
  return { date: d, company: c, source: clean(source) || 'unknown', outcome: o, jobs: num(jobs), kept: num(kept), note: clean(note) }
}

export function serializeHealthRow(row) {
  return HEALTH_COLUMNS.map((c) => (c === 'jobs' || c === 'kept' ? String(row[c] ?? 0) : clean(row[c]))).join('\t')
}

/** Parse the TSV (with or without its header). Malformed lines are dropped. */
export function parseHealthRows(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || line.startsWith(HEALTH_COLUMNS[0] + '\t')) continue
    const cells = line.split('\t')
    const raw = Object.fromEntries(HEALTH_COLUMNS.map((c, i) => [c, cells[i] ?? '']))
    try { out.push(buildHealthRow(raw)) } catch { /* skip a bad line */ }
  }
  return out
}

/**
 * One row per (company, date): the last written wins, so a re-run on the same
 * day replaces the earlier result instead of counting as a second run.
 */
export function collapseRuns(rows) {
  const byCompany = new Map()
  for (const r of rows) {
    const k = key(r.company)
    if (!byCompany.has(k)) byCompany.set(k, { company: r.company, runs: new Map() })
    byCompany.get(k).runs.set(r.date, r)
  }
  return new Map([...byCompany].map(([k, v]) => [k, {
    company: v.company,
    runs: [...v.runs.values()].sort((a, b) => a.date.localeCompare(b.date)),
  }]))
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

/**
 * @param {object} input
 * @param {Array} input.rows           parsed portal-health rows
 * @param {Array<{name:string, enabled?:boolean}>} input.tracked   portals.yml tracked_companies
 * @param {Array<{company:string, source:string, status:string}>} [input.scanHistory]
 * @param {Array<{company:string, verdict:string}>} [input.scores]  score-history rows
 * @param {object} [input.thresholds]
 * @returns {{fix: Array, pause: Array, promote: Array}}  each item {company, reason, evidence}
 */
export function reviewPortalHealth({ rows = [], tracked = [], scanHistory = [], scores = [], thresholds = THRESHOLDS }) {
  const t = { ...THRESHOLDS, ...thresholds }
  const trackedByKey = new Map(tracked.filter((c) => c && c.name).map((c) => [key(c.name), c]))
  const review = { fix: [], pause: [], promote: [] }

  for (const [k, { company, runs }] of collapseRuns(rows)) {
    const trackedEntry = trackedByKey.get(k)
    if (!trackedEntry || trackedEntry.enabled === false) continue // only live tracked companies cost a scan
    const last = runs[runs.length - 1]
    const tail = runs.slice(-t.fixMinConsecutiveFailures)
    if (tail.length >= t.fixMinConsecutiveFailures && tail.every((r) => r.outcome !== 'ok')) {
      review.fix.push({
        company,
        reason: `${tail.length} failed scans in a row (last: ${last.outcome}${last.note ? ` — ${last.note}` : ''}); check its careers_url / api or pause it`,
        evidence: { runs: tail.length, since: tail[0].date, last: last.date, outcome: last.outcome, note: last.note },
      })
      continue
    }
    const okRuns = runs.filter((r) => r.outcome === 'ok')
    const span = okRuns.length ? daysBetween(okRuns[0].date, okRuns[okRuns.length - 1].date) : 0
    const kept = okRuns.reduce((n, r) => n + r.kept, 0)
    const jobs = okRuns.reduce((n, r) => n + r.jobs, 0)
    if (okRuns.length >= t.pauseMinRuns && span >= t.pauseMinSpanDays && kept === 0) {
      review.pause.push({
        company,
        reason: `no matching role in ${okRuns.length} scans over ${span} days (${jobs} postings seen); pause or drop it`,
        evidence: { runs: okRuns.length, spanDays: span, jobs, since: okRuns[0].date, last: okRuns[okRuns.length - 1].date },
      })
    }
  }

  // promote: untracked companies the discovery sources keep finding, or any
  // untracked / disabled company that scored well.
  const finds = new Map()
  for (const h of scanHistory) {
    if (!h || !h.company || h.status !== 'added') continue
    if (/-api$/.test(String(h.source || ''))) continue // tracked API boards find their own roles
    const k = key(h.company)
    if (!finds.has(k)) finds.set(k, { company: h.company, count: 0, sources: new Set() })
    const f = finds.get(k)
    f.count++
    f.sources.add(String(h.source || 'unknown'))
  }
  const good = new Map()
  for (const s of scores) {
    if (!s || !s.company || !t.promoteVerdicts.includes(String(s.verdict || '').toLowerCase())) continue
    const k = key(s.company)
    if (!good.has(k)) good.set(k, { company: s.company, verdicts: [] })
    good.get(k).verdicts.push(String(s.verdict).toLowerCase())
  }
  const candidates = new Set([...finds.keys(), ...good.keys()])
  for (const k of candidates) {
    const entry = trackedByKey.get(k)
    if (entry && entry.enabled !== false) continue
    const f = finds.get(k)
    const g = good.get(k)
    const foundEnough = f && f.count >= t.promoteMinFinds
    if (!foundEnough && !g) continue
    const company = (g || f).company
    const parts = []
    if (foundEnough) parts.push(`found ${f.count}× by ${[...f.sources].join(', ')}`)
    if (g) parts.push(`scored ${g.verdicts.join(', ')}`)
    review.promote.push({
      company,
      reason: `${parts.join('; ')}: ${entry ? 're-enable it in' : 'add it to'} tracked_companies`,
      evidence: { finds: f ? f.count : 0, sources: f ? [...f.sources] : [], verdicts: g ? g.verdicts : [], tracked: Boolean(entry) },
    })
  }

  const rank = (list, by) => list.sort((a, b) => by(b) - by(a)).slice(0, t.maxPerKind)
  review.fix = rank(review.fix, (x) => x.evidence.runs)
  review.pause = rank(review.pause, (x) => x.evidence.runs)
  review.promote = rank(review.promote, (x) => x.evidence.verdicts.length * 10 + x.evidence.finds)
  return review
}

export function reviewIsEmpty(review) {
  return !review || (review.fix.length === 0 && review.pause.length === 0 && review.promote.length === 0)
}

const KIND_TITLE = { fix: 'Endpoint failing', pause: 'No fit for a while', promote: 'Worth tracking' }

/** Plain-text block for scan output / the CLI. Empty string when nothing to say. */
export function renderReview(review) {
  if (reviewIsEmpty(review)) return ''
  const lines = ['Portal health — suggestions (edit user/portals.yml; nothing is changed for you):']
  for (const kind of ['fix', 'pause', 'promote']) {
    for (const s of review[kind]) lines.push(`  ${KIND_TITLE[kind]} · ${s.company}: ${s.reason}`)
  }
  return lines.join('\n')
}

/** Daily-brief items (one per suggestion) for the Heads-up section. */
export function portalHeadsUp(review, limit = 3) {
  if (reviewIsEmpty(review)) return []
  const items = []
  for (const kind of ['fix', 'pause', 'promote']) {
    for (const s of review[kind]) {
      items.push({
        key: `portal|${kind}|${key(s.company)}`,
        label: `${KIND_TITLE[kind]}: ${s.company}`,
        sub: `${s.reason[0].toUpperCase()}${s.reason.slice(1)}.`,
        urgency: 0,
        sortKey: 0,
        meta: { kind: 'portal-health', action: kind, company: s.company, evidence: s.evidence },
      })
    }
  }
  return items.slice(0, limit)
}

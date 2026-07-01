// triage-core.mjs — zero-token pre-eval triage over the pipeline inbox.
//
// TODO.md's token-cost project, lever 1 (the biggest): the scan + filter +
// relevance ranking are free, but every *deep evaluation* is a full Claude
// spawn. This module ranks the Pending URLs in data/pipeline.md with purely
// deterministic signals so the user (or batch-runner) deep-evaluates only
// the top slice instead of the whole inbox.
//
// Signals (each contributes to a transparent additive score + reasons[]):
//   - the scanner's own relevance score, parsed from the pipeline line tail
//   - posting age from scan-history.tsv first_seen (fresh beats stale)
//   - dream-company / brand-affinity match from user/profile.yml (data
//     passed in by the caller — nothing user-specific lives here)
//   - entry-level vs senior title signals (safety net behind the scan filter)
//   - already-evaluated (company, role) hits against data/dedup-index.tsv
//
// Everything here is pure — the CLI (scripts/triage-pipeline.mjs) does I/O.

import { canonicalizeUrl } from './merge-staging-core.mjs'
import { normalizeCompany, normalizeRole } from './dedup-index.mjs'

/* ───── Parsing ──────────────────────────────────────────────────── */

const PENDING_LINE_RE = /^- \[ \] (https?:\/\/\S+)((?:\s*\|[^|\n]*)*)$/

/**
 * Parse the "## Pending" section of data/pipeline.md into structured entries.
 * Handles both plain lines (`- [ ] url | Company | Title`) and scanner lines
 * with a relevance tail (`... | Title | relevance 4.2 — fresh, city match`).
 * Lines in other sections (Filtered Out / Processed) are ignored.
 *
 * @param {string} text full pipeline.md content
 * @returns {Array<{url, company, title, relevanceScore, relevanceReasons, raw}>}
 */
export function parsePendingEntries(text) {
  const entries = []
  const pendingIdx = text.indexOf('## Pending')
  if (pendingIdx === -1) return entries
  const afterPending = text.slice(pendingIdx)
  const nextSection = afterPending.indexOf('\n## ', '## Pending'.length)
  const section = nextSection === -1 ? afterPending : afterPending.slice(0, nextSection)

  for (const line of section.split('\n')) {
    const m = line.trim().match(PENDING_LINE_RE)
    if (!m) continue
    const url = m[1]
    const fields = (m[2] || '')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean)

    let relevanceScore = null
    let relevanceReasons = ''
    // The relevance note is always the LAST field when present.
    const last = fields[fields.length - 1] || ''
    const rel = last.match(/^relevance ([0-9.]+)(?:\s*—\s*(.*))?$/)
    if (rel) {
      relevanceScore = Number(rel[1])
      relevanceReasons = rel[2] || ''
      fields.pop()
    }

    entries.push({
      url,
      company: fields[0] || '',
      title: fields[1] || '',
      relevanceScore,
      relevanceReasons,
      raw: line.trim(),
    })
  }
  return entries
}

/**
 * Index scan-history.tsv by canonical URL → { firstSeen, status }.
 * Tolerates short rows (pre-metadata era) — only columns 0/1/6 are read.
 */
export function buildScanIndex(tsvText) {
  const index = new Map()
  const lines = (tsvText || '').split('\n')
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 2 || !cols[0].startsWith('http')) continue
    index.set(canonicalizeUrl(cols[0]), {
      firstSeen: cols[1] || null,
      status: cols[6] || null,
    })
  }
  return index
}

/**
 * Build a Set of normalized "company\trole" keys from data/dedup-index.tsv
 * content — the same normalization the merge scripts maintain.
 */
export function buildDedupKeySet(tsvText) {
  const keys = new Set()
  const lines = (tsvText || '').split('\n')
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 2) continue
    keys.add(`${cols[0]}\t${cols[1]}`)
  }
  return keys
}

/* ───── Scoring ──────────────────────────────────────────────────── */

// Title signals. The scan filter should already exclude senior titles; this
// is a demotion safety net for lines that entered the inbox by other routes.
const SENIOR_TITLE_RE = /\b(senior|sr\.?|lead|principal|staff|director|head of|vp|vice president)\b/i
const ENTRY_TITLE_RE = /\b(intern(ship)?|graduate|grad|junior|trainee|werkstudent|working student|early careers?|rotational|associate program(me)?)\b/i

export const DEFAULT_WEIGHTS = {
  freshWithin7d: 2,
  freshWithin21d: 1,
  staleBeyond90d: -2,
  dreamTop: 3,
  dreamLower: 2,
  affinity: 1.5,
  entryTitle: 1,
  seniorTitle: -4,
  alreadyEvaluated: -5,
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.floor((to - from) / 86_400_000)
}

/**
 * Score one pending entry. Returns { score, reasons } — every contribution
 * is named so the plan is auditable the same way scan relevance is.
 *
 * @param entry   parsed pending entry
 * @param opts    {
 *   scanIndex:        Map from buildScanIndex (optional),
 *   dedupKeys:        Set from buildDedupKeySet (optional),
 *   dreamCompanies:   [{ name, priority }] from user/profile.yml (optional),
 *   affinityCompanies:[string] from profile.yml calibration (optional),
 *   today:            'YYYY-MM-DD',
 *   weights:          overrides for DEFAULT_WEIGHTS (optional),
 * }
 */
export function scorePendingEntry(entry, opts = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) }
  const reasons = []
  let score = 0

  if (entry.relevanceScore != null) {
    score += entry.relevanceScore
    reasons.push(`scan relevance ${entry.relevanceScore.toFixed(1)}`)
  } else {
    reasons.push('no scan relevance (manual add)')
  }

  const hit = opts.scanIndex?.get(canonicalizeUrl(entry.url))
  if (hit?.firstSeen && opts.today) {
    const age = daysBetween(hit.firstSeen, opts.today)
    if (age != null) {
      if (age <= 7) { score += w.freshWithin7d; reasons.push(`fresh (${age}d, +${w.freshWithin7d})`) }
      else if (age <= 21) { score += w.freshWithin21d; reasons.push(`recent (${age}d, +${w.freshWithin21d})`) }
      else if (age > 90) { score += w.staleBeyond90d; reasons.push(`stale (${age}d, ${w.staleBeyond90d})`) }
    }
  }

  const companyLc = entry.company.trim().toLowerCase()
  if (companyLc) {
    const dream = (opts.dreamCompanies || []).find(d => (d?.name || '').trim().toLowerCase() === companyLc)
    if (dream) {
      const bonus = dream.priority === 'top' ? w.dreamTop : w.dreamLower
      score += bonus
      reasons.push(`dream company (${dream.priority || 'listed'}, +${bonus})`)
    } else if ((opts.affinityCompanies || []).some(c => (c || '').trim().toLowerCase() === companyLc)) {
      score += w.affinity
      reasons.push(`brand-affinity company (+${w.affinity})`)
    }
  }

  if (SENIOR_TITLE_RE.test(entry.title)) {
    score += w.seniorTitle
    reasons.push(`senior-title signal (${w.seniorTitle})`)
  } else if (ENTRY_TITLE_RE.test(entry.title)) {
    score += w.entryTitle
    reasons.push(`entry-level title (+${w.entryTitle})`)
  }

  if (opts.dedupKeys && entry.company && entry.title) {
    const key = `${normalizeCompany(entry.company)}\t${normalizeRole(entry.title)}`
    if (opts.dedupKeys.has(key)) {
      score += w.alreadyEvaluated
      reasons.push(`already evaluated — likely dupe (${w.alreadyEvaluated})`)
    }
  }

  return { score: Number(score.toFixed(2)), reasons }
}

/**
 * Rank all pending entries and split them into deep-eval / hold buckets.
 * Deterministic: ties break by company then title so repeated runs agree.
 *
 * @returns {Array<entry & { triageScore, triageReasons, bucket }>}
 */
export function triagePending(entries, opts = {}) {
  const topN = opts.topN ?? 15
  const scored = entries.map(e => {
    const { score, reasons } = scorePendingEntry(e, opts)
    return { ...e, triageScore: score, triageReasons: reasons }
  })
  scored.sort((a, b) =>
    b.triageScore - a.triageScore ||
    a.company.localeCompare(b.company) ||
    a.title.localeCompare(b.title))
  return scored.map((e, i) => ({ ...e, bucket: i < topN ? 'deep-eval' : 'hold' }))
}

/* ───── Rendering / emission ─────────────────────────────────────── */

/** Render the triage plan as a compact markdown report. */
export function renderTriagePlan(ranked, { topN = 15 } = {}) {
  const lines = []
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  const hold = ranked.filter(e => e.bucket === 'hold')
  lines.push(`# Pipeline triage — ${ranked.length} pending, top ${Math.min(topN, ranked.length)} recommended for deep eval`)
  lines.push('')
  if (ranked.length === 0) {
    lines.push('Pending inbox is empty — nothing to triage.')
    return lines.join('\n')
  }
  lines.push('## Deep-eval now')
  lines.push('')
  lines.push('| # | Score | Company | Title | Why |')
  lines.push('|---|-------|---------|-------|-----|')
  deep.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${e.triageScore.toFixed(1)} | ${e.company || '—'} | ${e.title || '—'} | ${e.triageReasons.join('; ')} |`)
  })
  if (hold.length > 0) {
    lines.push('')
    lines.push(`## Hold (${hold.length}) — re-runs surface these as the top slice clears`)
    lines.push('')
    hold.forEach(e => {
      lines.push(`- ${e.triageScore.toFixed(1)} — ${e.company || '—'} | ${e.title || '—'} (${e.triageReasons.join('; ')})`)
    })
  }
  return lines.join('\n')
}

export const BATCH_INPUT_HEADER = 'id\turl\tsource\tnotes'

/**
 * Merge the deep-eval bucket into batch-input.tsv content. Existing rows are
 * preserved; new rows get sequential ids continuing from the current max;
 * URLs already present (canonicalized) are skipped so re-runs are idempotent.
 *
 * @returns {{ content, added, skipped }}
 */
export function emitBatchInput(deepEntries, existingContent = '') {
  const lines = (existingContent || '').split('\n').filter(l => l.trim())
  const hasHeader = lines[0] === BATCH_INPUT_HEADER || (lines[0] || '').startsWith('id\t')
  const rows = hasHeader ? lines.slice(1) : lines

  let maxId = 0
  const seenUrls = new Set()
  for (const row of rows) {
    const cols = row.split('\t')
    const id = Number(cols[0])
    if (Number.isFinite(id) && id > maxId) maxId = id
    if (cols[1]) seenUrls.add(canonicalizeUrl(cols[1]))
  }

  let added = 0
  let skipped = 0
  const out = [BATCH_INPUT_HEADER, ...rows]
  for (const e of deepEntries) {
    if (seenUrls.has(canonicalizeUrl(e.url))) { skipped++; continue }
    maxId += 1
    // Tabs inside titles would shift columns — normalize to spaces.
    const note = `triage ${e.triageScore.toFixed(1)}: ${e.company} — ${e.title}`.replace(/\t/g, ' ')
    out.push(`${maxId}\t${e.url}\ttriage\t${note}`)
    seenUrls.add(canonicalizeUrl(e.url))
    added++
  }
  return { content: out.join('\n') + '\n', added, skipped }
}

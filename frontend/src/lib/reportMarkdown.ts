// Evaluation-report markdown parsers — pure string→data functions that turn a
// `reports/tier-*/{Company} - {Role}.md` file into the structured pieces the
// ReportSlideOver renders (header metadata + the dimensional-scoring table).
//
// Extracted from components/reports/ReportSlideOver.tsx so the parsing is
// testable in isolation: these walk the report line-by-line, and a subtle
// regression (a mis-stripped `/10`, a row routed to the wrong fit group)
// renders a garbled report with no error. The React-coupled bits
// (`flattenChildrenText`, `sectionIcon`, the rendering components) stay in the
// component — only the string parsing lives here.

import type { Eligibility, EligibilityFlag, Verdict } from '@/types'
import { normalizeEligibility, normalizeTier, normalizeVerdict, ELIGIBILITY_CHECK_LABELS } from './scoreBands'

export interface DimensionRow {
  label: string
  score: string
  reasoning: string
}

/** The v2 `## Dimensional scoring` table, split by its row tags
 *  (docs/scoring-v2.md §8.5): `(want)` motivators, `(hygiene)` factors, the
 *  `Want (rollup)` row, `(ease)` dimensions, the `Ease (rollup)` row, and
 *  `(context)` rows. */
export interface ParsedDimensions {
  want: { rollup: string; reasoning: string; motivators: DimensionRow[]; hygiene: DimensionRow[] }
  ease: { rollup: string; reasoning: string; rows: DimensionRow[] }
  context: { rows: DimensionRow[] }
}

// Header metadata: keep contextual fields (Date / Mode / Location /
// Archetype / Verification) and drop the duplicated ones — URL has its own
// pill, Want / Ease / Eligibility / Verdict / Tier are parsed by
// parseReportHeader and rendered in the hero. Verification is kept because
// batch-mode reports need a visible "unconfirmed" caveat — see ReportMeta.
const META_KEEP = new Set(['date', 'mode', 'location', 'archetype', 'verification'])

export function extractMetadata(text: string): {
  meta: Array<{ key: string; value: string }>
  rest: string
} {
  const lines = text.split('\n')
  const kept: Array<{ key: string; value: string }> = []
  const out: string[] = []
  // Match "**Key:** value" anywhere in the line (the metadata block has one
  // pair per line in current reports, but we forgive trailing whitespace).
  const metaRe = /^\s*\*\*([^*:]+?):\*\*\s*(.+?)\s*$/
  for (const line of lines) {
    const m = metaRe.exec(line)
    if (m) {
      const key = m[1].trim()
      const value = m[2].trim()
      if (META_KEEP.has(key.toLowerCase())) {
        kept.push({ key, value })
      }
      // Either way, the line is consumed — we don't want to re-render the
      // dropped fields as a stray paragraph.
      continue
    }
    out.push(line)
  }
  // Collapse the run of blank lines the removed metadata block leaves behind.
  const rest = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { meta: kept, rest }
}

// ─── v2 report header (spec §8.5) ────────────────────────────────────────────
//
//   **Want:** 8.25/10 · **Ease:** 5.6/10
//   **Eligibility:** amber — start date not stated
//   **Verdict:** Stretch — apply with prep
//   **Tier:** T2

export interface ReportHeader {
  want: number | null
  ease: number | null
  eligibility: Eligibility | null
  /** Text after the status (`— start date not stated`), dash stripped. */
  eligibilityReason: string
  verdict: Verdict | null
  /** The verdict line's action text (`apply with prep`), dash stripped. */
  verdictAction: string
  tier: string | null
}

const VERDICT_BY_LABEL: Record<string, Verdict> = {
  'go': 'go', 'stretch': 'stretch', 'growth target': 'growth', 'growth': 'growth',
  'solid': 'solid', 'if pipeline thin': 'thin', 'thin': 'thin', 'only if your pipeline is thin': 'thin',
  'skip': 'skip', 'blocked': 'blocked',
}

function headerValue(md: string, key: string): string | null {
  const re = new RegExp(`\\*\\*${key}:\\*\\*\\s*([^\\n]*)`, 'i')
  const m = re.exec(md)
  return m ? m[1].trim() : null
}

function leadingNumber(v: string | null): number | null {
  if (!v) return null
  const m = v.replace(/\*\*/g, '').match(/^\s*(\d+(?:\.\d+)?)/)
  if (!m) return null
  const n = parseFloat(m[1])
  return Number.isFinite(n) ? n : null
}

function splitDash(v: string): [string, string] {
  const m = v.match(/^(.*?)\s+[—–-]\s+(.*)$/)
  return m ? [m[1].trim(), m[2].trim()] : [v.trim(), '']
}

export function parseReportHeader(md: string): ReportHeader {
  const want = leadingNumber(headerValue(md, 'Want'))
  const ease = leadingNumber(headerValue(md, 'Ease'))
  const eligRaw = headerValue(md, 'Eligibility') ?? ''
  const [eligHead, eligReason] = splitDash(eligRaw)
  const eligibility = normalizeEligibility(eligHead)
  const verdictRaw = headerValue(md, 'Verdict') ?? ''
  const [verdictHead, verdictAction] = splitDash(verdictRaw.replace(/\*\*/g, ''))
  const verdict = normalizeVerdict(verdictHead)
    ?? VERDICT_BY_LABEL[verdictHead.toLowerCase().replace(/[:.]$/, '')]
    ?? null
  const tier = normalizeTier(headerValue(md, 'Tier'))
  return {
    want: eligibility === 'red' ? null : want,
    ease: eligibility === 'red' ? null : ease,
    eligibility,
    eligibilityReason: eligibility ? eligReason : '',
    verdict: eligibility === 'red' ? 'blocked' : verdict,
    verdictAction,
    tier,
  }
}

// ─── `## Eligibility` section (spec §8.5) ────────────────────────────────────
//
//   ## Eligibility
//   | Check | Status | Reason |
//   | Start date | amber | start date not stated |
//   ...
//   **Ask the recruiter**
//   - When does the internship start?

export interface ParsedEligibility {
  checks: EligibilityFlag[]
  questions: string[]
}

const CHECK_BY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(ELIGIBILITY_CHECK_LABELS).map(([k, label]) => [label.toLowerCase(), k]),
)

/** A Check cell → its check key (`Start date` / `start_date` → start_date).
 *  An unknown label is kept as written so the renderer's fallback can show
 *  it — never dropped. */
function checkKey(cell: string): string {
  const t = cell.replace(/`/g, '').trim()
  const lower = t.toLowerCase()
  if (ELIGIBILITY_CHECK_LABELS[lower]) return lower
  if (CHECK_BY_LABEL[lower]) return CHECK_BY_LABEL[lower]
  const snake = lower.replace(/[\s-]+/g, '_')
  if (ELIGIBILITY_CHECK_LABELS[snake]) return snake
  if (lower.startsWith('work auth') || lower.startsWith('work-auth') || lower.includes('visa')) return 'work_auth'
  if (lower.startsWith('other')) return 'other'
  return t
}

/** Split the `## Eligibility` section out of a report body. */
export function splitEligibility(md: string): { eligibility: ParsedEligibility | null; rest: string } {
  const headingRe = /^##\s+Eligibility\s*$/im
  const m = headingRe.exec(md)
  if (!m) return { eligibility: null, rest: md }
  const head = md.slice(0, m.index)
  const tail = md.slice(m.index + m[0].length)
  const next = /\n##\s+\S/m.exec(tail)
  const section = next ? tail.slice(0, next.index) : tail
  const afterBlock = next ? tail.slice(next.index + 1) : ''

  const checks: EligibilityFlag[] = []
  const questions: string[] = []
  let inQuestions = false
  let sawHeader = false
  for (const raw of section.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('|')) {
      if (/^\|[\s|:-]+\|$/.test(line)) continue // separator
      const cells = line.split('|').slice(1, -1).map(c => c.replace(/^\*\*(.+)\*\*$/, '$1').trim())
      if (!sawHeader) { sawHeader = true; if (/^check$/i.test(cells[0] ?? '')) continue }
      if (cells.length < 2) continue
      const status = normalizeEligibility((cells[1] ?? '').replace(/[^a-z]/gi, ' ').trim().split(/\s+/).find(w => normalizeEligibility(w)) ?? '')
      if (!status) continue
      checks.push({ check: checkKey(cells[0] ?? ''), status, reason: cells[2] ?? '' })
      continue
    }
    if (/ask the recruiter/i.test(line)) { inQuestions = true; continue }
    if (inQuestions) {
      const q = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)
      if (q) questions.push(q[1].replace(/^\*\*(.+)\*\*$/, '$1').trim())
    }
  }

  // Attach each question to the amber check it resolves when the counts line
  // up (the engine writes one question per amber, in table order).
  const ambers = checks.filter(c => c.status === 'amber')
  if (ambers.length === questions.length) ambers.forEach((c, i) => { c.question = questions[i] })

  const rest = `${head.trimEnd()}\n\n${afterBlock}`.replace(/\n{3,}/g, '\n\n').trim()
  return { eligibility: { checks, questions }, rest }
}

// Split the markdown around the "## Dimensional scoring" section, parse the
// table inside it, and group the rows by their v2 tag. Rows are routed by tag
// first; an untagged dimension row falls back to its position (before the
// Want rollup → a Want motivator; after it → an Ease dimension; after the
// Ease rollup → context). The rollup arithmetic text is kept as `reasoning`.
export function parseDimensionalScoring(md: string): {
  before: string
  dims: ParsedDimensions | null
  after: string
} {
  const headingRe = /^##\s+Dimensional\s+scoring\s*$/im
  const m = headingRe.exec(md)
  if (!m) return { before: md, dims: null, after: '' }

  const before = md.slice(0, m.index)
  const rest = md.slice(m.index + m[0].length)

  const nextHeadingRe = /\n##\s+\S/m
  const nextMatch = nextHeadingRe.exec(rest)
  const tableSection = nextMatch ? rest.slice(0, nextMatch.index) : rest
  const after = nextMatch ? rest.slice(nextMatch.index + 1) : ''

  const tableLines = tableSection
    .split('\n')
    .filter(l => l.trim().startsWith('|'))
    .filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l))

  if (tableLines.length < 2) return { before: md, dims: null, after: '' }

  const rows = tableLines.slice(1).map(parseRow).filter(Boolean) as Array<NonNullable<ReturnType<typeof parseRow>>>

  const dims: ParsedDimensions = {
    want:    { rollup: '', reasoning: '', motivators: [], hygiene: [] },
    ease:    { rollup: '', reasoning: '', rows: [] },
    context: { rows: [] },
  }

  type Phase = 'want' | 'ease' | 'post'
  let phase: Phase = 'want'

  for (const row of rows) {
    const labelLower = row.label.toLowerCase()
    const r: DimensionRow = { label: row.label, score: row.score, reasoning: row.reasoning }

    if (row.tag === 'rollup' || ((labelLower === 'want' || labelLower === 'ease') && !row.tag)) {
      if (labelLower.startsWith('want')) { dims.want.rollup = row.score; dims.want.reasoning = row.reasoning; phase = 'ease'; continue }
      if (labelLower.startsWith('ease')) { dims.ease.rollup = row.score; dims.ease.reasoning = row.reasoning; phase = 'post'; continue }
    }
    if (row.tag === 'want')    { dims.want.motivators.push(r); continue }
    if (row.tag === 'hygiene') { dims.want.hygiene.push(r); continue }
    if (row.tag === 'ease')    { dims.ease.rows.push(r); continue }
    if (row.tag === 'context' || phase === 'post') { dims.context.rows.push(r); continue }
    if (phase === 'want') dims.want.motivators.push(r)
    else dims.ease.rows.push(r)
  }

  // Sanity: if we found no group rows at all, abort and fall back.
  if (
    !dims.want.rollup && !dims.ease.rollup &&
    dims.want.motivators.length === 0 && dims.want.hygiene.length === 0 &&
    dims.ease.rows.length === 0 && dims.context.rows.length === 0
  ) {
    return { before: md, dims: null, after: '' }
  }

  return { before, dims, after }
}

// ─── `Salary math:` footer ───────────────────────────────────────────────────
//
// Reports end with ONE footer line carrying the full salary computation chain
// (comp → tax → cost of living → savings power). The Salary reasoning cell in
// the dimensional table is a one-line human summary; the chain lives here.
//
//   Salary math: €42k gross → €29.8k net (City, Country) → …
//
// The label may be bold (`**Salary math:**`). We carve the line out of the
// prose so the slide-over renders it as quiet small text instead of a
// paragraph.

export function splitSalaryMath(md: string): { salaryMath: string | null; rest: string } {
  const re = /^\s*(?:[-*]\s+)?\*{0,2}Salary math\s*:\s*\*{0,2}\s*(.+?)\s*$/im
  const m = re.exec(md)
  if (!m) return { salaryMath: null, rest: md }
  const value = m[1].replace(/^\*\*(.+)\*\*$/, '$1').trim()
  const rest = (md.slice(0, m.index) + md.slice(m.index + m[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { salaryMath: value || null, rest }
}

// ─── Retired: `## Why this score` ────────────────────────────────────────────
//
// v2 reports no longer carry a Why-this-score block (user feedback, scoring
// v2 rollout). Older reports that still have the heading render it as an
// ordinary prose section — nothing here parses it any more.

// ─── Static peer-ranking block (frozen at evaluation time) ────────────────────
//
// Reports optionally carry a 3-line peer block written at evaluation time
// (modes/scouting.md § Peer ranking):
//
//   ---                                          ← optional rule
//   ## Peer ranking …                            ← optional heading (template
//                                                  form; most reports omit it)
//   **Rank vs {Archetype} peers:** …
//   **Dimension outliers:** …
//   **Closest comparables:** …
//
// The slide-over recomputes this signal LIVE from score-history (see
// lib/peerRank.ts), so when the live panel renders we carve the frozen block
// out of the prose to avoid showing two conflicting rank claims. When the
// live panel is unavailable the markdown is left untouched and the static
// block (where the report has one in renderable prose) remains the fallback.
export function splitPeerBlock(md: string): { found: boolean; rest: string } {
  const lines = md.split('\n')
  const rankIdx = lines.findIndex(l => /^\s*\*\*Rank vs .+ peers:\*\*/i.test(l.trim()))
  if (rankIdx === -1) return { found: false, rest: md }

  // Extend down over the companion bold lines (blank lines between are ok).
  let end = rankIdx + 1
  const companionRe = /^\*\*(Dimension outliers|Closest comparables)\s*:\*\*/i
  while (end < lines.length) {
    const t = lines[end].trim()
    if (t === '') { end++; continue }
    if (companionRe.test(t)) { end++; continue }
    break
  }

  // Extend up over blank lines, then an optional `---` rule and/or the
  // template's `## Peer ranking …` heading (each also swallowing the blank
  // run above it).
  let start = rankIdx
  const swallowBlanks = () => { while (start > 0 && lines[start - 1].trim() === '') start-- }
  swallowBlanks()
  if (start > 0 && /^-{3,}\s*$/.test(lines[start - 1].trim())) { start--; swallowBlanks() }
  if (start > 0 && /^##\s+Peer ranking/i.test(lines[start - 1].trim())) { start--; swallowBlanks() }

  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { found: true, rest }
}

export type RowTag = 'want' | 'hygiene' | 'ease' | 'rollup' | 'context'

export function parseRow(line: string): { label: string; score: string; reasoning: string; tag: RowTag | null } | null {
  // "| a | b | c |" → ['', ' a ', ' b ', ' c ', ''] → ['a','b','c']
  const cells = line.split('|').slice(1, -1).map(c => c.trim())
  if (cells.length < 2) return null
  let [label, score, reasoning = ''] = cells
  // Strip surrounding markdown bold (whole-cell only — keeps inline emphasis)
  label = label.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  score = score.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  // Strip "/10" suffix
  score = score.replace(/\s*\/\s*\d+\s*$/, '').trim()
  // Detect and strip the trailing parenthetical tag (spec §8.5 exact tags)
  const tagRe = /\s*\(\s*(want|hygiene|ease|rollup|context)\s*\)\s*$/i
  const tagMatch = label.match(tagRe)
  const tag = tagMatch ? (tagMatch[1].toLowerCase() as RowTag) : null
  const cleanLabel = label.replace(tagRe, '').trim()
  return { label: cleanLabel, score, reasoning, tag }
}

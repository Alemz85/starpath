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

export interface DimensionRow {
  label: string
  score: string
  reasoning: string
}

export interface ParsedDimensions {
  overall: { score: string } | null
  currentFit: { rollup: string; rows: DimensionRow[] }
  aspirationalFit: { rollup: string; rows: DimensionRow[] }
  context: { rows: DimensionRow[] }
}

// Header metadata: keep contextual fields (Date / Mode / Location /
// Archetype / Verification) and drop the duplicated ones — URL has its
// own pill, the score fields are now visually prominent in the hero +
// section rollups, and Tier is in the slide-over header. Verification
// is kept because batch-mode reports need a visible "unconfirmed"
// caveat — see ReportMeta for the warning treatment.
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

// Split the markdown around the "## Dimensional scoring" section, parse the
// table inside it, and categorise the rows. Phase walks: rows before the
// Current Fit rollup → CF dimensions; between CF rollup and AF rollup → AF
// dimensions; after Overall → context. Rows tagged `(context)` are routed
// to the context group regardless of position. The arithmetic on rollup /
// Overall rows is intentionally discarded — section grouping replaces it.
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

  const rows = tableLines.slice(1).map(parseRow).filter(Boolean) as Array<{
    label: string
    score: string
    reasoning: string
    tag: 'rollup' | 'signal' | 'context' | null
  }>

  const dims: ParsedDimensions = {
    overall: null,
    currentFit:      { rollup: '', rows: [] },
    aspirationalFit: { rollup: '', rows: [] },
    context:         { rows: [] },
  }

  type Phase = 'cf' | 'af' | 'post-overall'
  let phase: Phase = 'cf'

  for (const row of rows) {
    const labelLower = row.label.toLowerCase()

    if (labelLower === 'overall' || labelLower.startsWith('overall ')) {
      dims.overall = { score: row.score }
      phase = 'post-overall'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('current fit')) {
      dims.currentFit.rollup = row.score
      phase = 'af'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('aspirational fit')) {
      dims.aspirationalFit.rollup = row.score
      continue
    }
    if (row.tag === 'context' || phase === 'post-overall') {
      dims.context.rows.push({ label: row.label, score: row.score, reasoning: row.reasoning })
      continue
    }

    const dimRow: DimensionRow = { label: row.label, score: row.score, reasoning: row.reasoning }
    if (phase === 'cf') dims.currentFit.rows.push(dimRow)
    else                dims.aspirationalFit.rows.push(dimRow)
  }

  // Sanity: if we found no group rows at all, abort and fall back.
  if (
    !dims.overall &&
    dims.currentFit.rows.length === 0 &&
    dims.aspirationalFit.rows.length === 0 &&
    dims.context.rows.length === 0
  ) {
    return { before: md, dims: null, after: '' }
  }

  return { before, dims, after }
}

// ─── "Why this score" block (explainability / fixability) ────────────────────
//
// Every report written by the current scouting template carries a
// `## Why this score` block immediately after the dimensional table. Its shape
// (see modes/_shared.md § Why-this-score block) is:
//
//   ## Why this score
//   {headline sentence}
//
//   - **Holding it back:** {binding constraint message}
//   - **Closest lever:** {cheapest band-crossing lever}   ← omitted when none
//
// We parse it into structured pieces so the Reports LIST can surface each
// report's binding constraint + cheapest lever as a badge and rank by "easiest
// near-miss to upgrade" — without the user having to open every slide-over.
//
// The block is deterministic (computed by scripts/score-listing.mjs), so a
// brittle exact-string parse would be fine; we keep the matchers forgiving
// anyway (bold optional, label synonyms, em-dash/colon variants) so a
// hand-tweaked or older report still yields what it can rather than nothing.

export interface WhyThisScore {
  /** The lede sentence under the heading (may be empty for terse reports). */
  headline: string
  /** The dimension/gate actually capping the tier — the "Holding it back" line. */
  bindingConstraint: string | null
  /** The cheapest single-dimension raise that crosses into a better band.
   *  Null when the report states no single lever exists (already top-band, or
   *  no dimension crosses alone). This is the load-bearing "fixability" signal. */
  lever: string | null
  /** True when the block is present at all (vs. an older report with no block).
   *  Distinguishes "parsed, no lever" from "never had a Why-this-score block". */
  present: boolean
}

const EMPTY_WHY: WhyThisScore = { headline: '', bindingConstraint: null, lever: null, present: false }

// Pull the body of the `## Why this score` section — from the heading to the
// next `## ` heading (or end of doc). Returns null when the section is absent.
export function extractWhyThisScoreSection(md: string): string | null {
  const headingRe = /^##\s+Why\s+this\s+score\s*$/im
  const m = headingRe.exec(md)
  if (!m) return null
  const rest = md.slice(m.index + m[0].length)
  const nextHeading = /\n##\s+\S/m.exec(rest)
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim()
}

// Strip a leading "- **Label:** " (or "* Label: ") bullet prefix and return the
// remaining value, or null if the line doesn't match this label. `labels` are
// matched case-insensitively and allow internal whitespace/hyphen variation.
function matchBulletLabel(line: string, labels: string[]): string | null {
  const labelAlt = labels
    .map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|')
  // Optional list marker, optional bold around the label. The colon may sit
  // inside the bold ("**Label:**") or outside ("**Label**:"), so we allow
  // `[:：]` and `*` to interleave between the label text and the value. The
  // value side then strips any leftover leading bold/colon.
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}\\s*(?:${labelAlt})\\s*[:：*]+\\s*(.+?)\\s*$`, 'i')
  const m = re.exec(line)
  if (!m) return null
  // Clean the value: drop a leftover leading colon (when the bold closed after
  // the colon), then strip a whole-value bold wrap. Keeps inline emphasis.
  return m[1]
    .replace(/^[:：*\s]+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim()
}

// Phrases the template uses when there is genuinely no single-dimension lever.
// We treat a lever line carrying one of these as "no lever" (null) rather than
// surfacing the disclaimer as if it were an actionable fix.
const NO_LEVER_RE = /\b(no single (?:dim|dimension)|already (?:top|the top)[- ]band|none\b|no lever|cannot cross alone)\b/i

export function parseWhyThisScore(md: string): WhyThisScore {
  const section = extractWhyThisScoreSection(md)
  if (section === null) return EMPTY_WHY

  const lines = section.split('\n')
  let headline = ''
  let bindingConstraint: string | null = null
  let lever: string | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const binding = matchBulletLabel(line, ['Holding it back', 'Binding constraint', 'Holding back'])
    if (binding !== null) { bindingConstraint = binding || null; continue }

    const lev = matchBulletLabel(line, ['Closest lever', 'Cheapest lever', 'Lever', 'Closest band-crossing lever'])
    if (lev !== null) {
      lever = lev && !NO_LEVER_RE.test(lev) ? lev : null
      continue
    }

    // First non-bullet, non-empty line is the headline lede. Don't let a
    // stray later paragraph overwrite it.
    if (!headline && !/^[-*]/.test(line)) headline = line
  }

  return { headline, bindingConstraint, lever, present: true }
}

// Carve the `## Why this score` section out of a markdown blob so the
// slide-over can render it as a structured callout (headline + binding
// constraint + lever) instead of leaving it as generic prose bullets.
//
// `ReportBody` feeds this the `after` content from `parseDimensionalScoring`
// (the markdown that trails the dimensional table — Why-this-score lives
// there, immediately after the table). We return:
//   - `why`:  the parsed WhyThisScore (present:false when no block exists)
//   - `rest`: the same markdown with the Why-this-score heading + body
//             removed, so it can be rendered as ordinary prose without the
//             block showing up twice.
//
// The heading-to-heading slice mirrors `extractWhyThisScoreSection` exactly,
// so whatever that parser scopes as "the block" is what we strip from `rest`.
export function splitWhyThisScore(md: string): { why: WhyThisScore; rest: string } {
  const headingRe = /^##\s+Why\s+this\s+score\s*$/im
  const m = headingRe.exec(md)
  if (!m) return { why: EMPTY_WHY, rest: md }

  const why = parseWhyThisScore(md)
  const head = md.slice(0, m.index)
  const tail = md.slice(m.index + m[0].length)
  const nextHeading = /\n##\s+\S/m.exec(tail)
  const afterBlock = nextHeading ? tail.slice(nextHeading.index + 1) : ''
  // Re-join the prose around the removed block and collapse the blank-line
  // run the excision leaves behind (same treatment as extractMetadata).
  const rest = `${head.trimEnd()}\n\n${afterBlock}`.replace(/\n{3,}/g, '\n\n').trim()
  return { why, rest }
}

export function parseRow(line: string) {
  // "| a | b | c |" → ['', ' a ', ' b ', ' c ', ''] → ['a','b','c']
  const cells = line.split('|').slice(1, -1).map(c => c.trim())
  if (cells.length < 2) return null
  let [label, score, reasoning = ''] = cells
  // Strip surrounding markdown bold (whole-cell only — keeps inline emphasis)
  label = label.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  score = score.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  // Strip "/N" suffix (handles both 1–10 and the old 1–5 reports)
  score = score.replace(/\s*\/\s*\d+\s*$/, '').trim()
  // Detect and strip the trailing parenthetical tag
  const tagMatch = label.match(/\(\s*(rollup|signal|context)\s*\)\s*$/i)
  const tag = tagMatch ? (tagMatch[1].toLowerCase() as 'rollup' | 'signal' | 'context') : null
  const cleanLabel = label.replace(/\s*\(\s*(rollup|signal|context)\s*\)\s*$/i, '').trim()
  return { label: cleanLabel, score, reasoning, tag }
}

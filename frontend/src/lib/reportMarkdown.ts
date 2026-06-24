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

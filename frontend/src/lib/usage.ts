// Token usage per spawn — the pure core behind Settings › Token usage.
//
// Cost nothing at run time: a `claude -p --output-format stream-json` run ends
// with one `result` event that already carries usage, cost, duration and turns
// (the batch runner reads the same fields from `--output-format json`). The
// spawn store sees that event go by while it humanizes the stream, keeps the
// numbers on the SpawnRecord, and when the process exits appends one row to
// batch/logs/app-usage.tsv. No extra request, no second process, no spawn
// argument changed.
//
// app-usage.tsv has the columns of batch/logs/usage.tsv (the batch runner's
// ledger, whose order is USAGE_TSV_HEADER in scripts/lib/batch-usage.mjs) plus
// `source` and `label`. It is a sibling file because the scheduler sums
// usage.tsv for a scheduled run's cost, and an evaluation the user fires from
// the app meanwhile is not part of that run. Both files read through
// `parseUsageTsv`, which goes by header name so the column order can change.

export const APP_USAGE_PATH = 'batch/logs/app-usage.tsv'
export const BATCH_USAGE_PATH = 'batch/logs/usage.tsv'

/** Column order of app-usage.tsv: the batch ledger's columns, then source and label. */
export const APP_USAGE_COLUMNS = [
  'timestamp',
  'batch_id',
  'report_num',
  'status',
  'score',
  'verdict',
  'input_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'output_tokens',
  'cost_usd',
  'duration_ms',
  'num_turns',
  'source',
  'label',
] as const

export const APP_USAGE_HEADER = APP_USAGE_COLUMNS.join('\t')

/** The numbers one finished Claude run reports. Fields the CLI omitted are null. */
export interface SpawnUsage {
  inputTokens: number | null
  cacheCreationTokens: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  durationMs: number | null
  numTurns: number | null
  isError: boolean
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Usage from one stream-json line when it is the final `result` event; otherwise null. */
export function parseResultUsage(raw: string): SpawnUsage | null {
  let evt: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    evt = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (evt.type !== 'result') return null
  const u = (evt.usage && typeof evt.usage === 'object' ? evt.usage : {}) as Record<string, unknown>
  return {
    inputTokens: num(u.input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    costUsd: num(evt.total_cost_usd),
    durationMs: num(evt.duration_ms),
    numTurns: num(evt.num_turns),
    isError: evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype !== 'success'),
  }
}

/** Input tokens as the model saw them: fresh + cache writes + cache reads. */
export function totalInputTokens(u: Pick<SpawnUsage, 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
  return (u.inputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0)
}

/**
 * What kind of spawn this was, from its arguments: an evaluation (the compact
 * bundle is loaded as the system prompt) or a slash command (`/career-ops pdf`
 * → `app:pdf`). Anything else is plain `app`.
 */
export function spawnSource(args: string[]): string {
  if (args.includes('--append-system-prompt-file')) return 'app:evaluate'
  const at = args.indexOf('-p')
  const prompt = at >= 0 ? (args[at + 1] ?? '') : ''
  const m = prompt.match(/^\/career-ops\s+([a-z][a-z-]*)/)
  return m ? `app:${m[1]}` : 'app'
}

const SOURCE_LABELS: Record<string, string> = {
  'app:evaluate': 'Evaluation',
  'app:pdf': 'Tailor CV',
  'app:apply': 'Draft application',
  'app:interview-prep': 'Prep application',
  'app:scan': 'Scan',
  'app:positioning': 'Positioning',
  batch: 'Batch',
}

/** The short name for a ledger `source` ("Evaluation", "Tailor CV", …). */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? 'Run'
}

export interface AppUsageInput {
  at: number
  spawnId: string
  label: string
  source: string
  usage: SpawnUsage
}

const cell = (v: unknown): string => (v == null ? '-' : String(v).replace(/[\t\r\n]+/g, ' '))

/** One app-usage.tsv line (no trailing newline). */
export function appUsageRow(e: AppUsageInput): string {
  const u = e.usage
  return [
    new Date(e.at).toISOString(),
    e.spawnId,
    '-',
    u.isError ? 'failed' : 'completed',
    '-',
    '-',
    u.inputTokens,
    u.cacheCreationTokens,
    u.cacheReadTokens,
    u.outputTokens,
    u.costUsd,
    u.durationMs,
    u.numTurns,
    e.source,
    e.label,
  ].map(cell).join('\t')
}

/** The file's text with `row` appended; the header is written when the file is empty or missing. */
export function appendUsageRow(existing: string | null, row: string): string {
  const base = existing && existing.trim() ? existing.replace(/\n*$/, '\n') : APP_USAGE_HEADER + '\n'
  return base + row + '\n'
}

// ─── Reading the ledgers ─────────────────────────────────────────────────────

export interface UsageEntry {
  /** ms since epoch. */
  at: number
  /** `batch` for the batch runner's rows; `app:…` for the app's spawns. */
  source: string
  label: string
  status: string
  inputTokens: number
  outputTokens: number
  /** Cache reads as a share of total input, 0–1 (0 when there is no input). */
  cachedShare: number
  costUsd: number | null
  durationMs: number | null
}

/**
 * Entries from a usage TSV, newest first. Goes by header name, so it reads the
 * batch ledger (`source` defaults to `batch`) and app-usage.tsv alike. Rows
 * with an unreadable timestamp are dropped; `-` cells are missing values.
 */
export function parseUsageTsv(text: string | null, defaultSource = 'batch'): UsageEntry[] {
  if (!text) return []
  const lines = text.split('\n').filter(l => l.trim() !== '')
  if (lines.length < 2) return []
  const head = lines[0].split('\t')
  const col = (name: string) => head.indexOf(name)
  const iAt = col('timestamp')
  if (iAt < 0) return []
  const iSource = col('source')
  const iLabel = col('label')
  const iBatch = col('batch_id')
  const iReport = col('report_num')
  const iStatus = col('status')
  const [iIn, iCc, iCr, iOut, iCost, iDur] =
    ['input_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'output_tokens', 'cost_usd', 'duration_ms'].map(col)
  const out: UsageEntry[] = []
  for (const line of lines.slice(1)) {
    const c = line.split('\t')
    const at = Date.parse(c[iAt] ?? '')
    if (!Number.isFinite(at)) continue
    const n = (i: number): number | null => {
      if (i < 0 || c[i] == null || c[i] === '-' || c[i] === '') return null
      const v = Number(c[i])
      return Number.isFinite(v) ? v : null
    }
    const cacheRead = n(iCr) ?? 0
    const input = (n(iIn) ?? 0) + (n(iCc) ?? 0) + cacheRead
    const report = iReport >= 0 && c[iReport] && c[iReport] !== '-' ? c[iReport] : null
    const label =
      iLabel >= 0 && c[iLabel] && c[iLabel] !== '-' ? c[iLabel]
      : report ? `Batch report ${report}`
      : iBatch >= 0 && c[iBatch] && c[iBatch] !== '-' ? `Batch ${c[iBatch]}`
      : 'Batch run'
    out.push({
      at,
      source: iSource >= 0 && c[iSource] && c[iSource] !== '-' ? c[iSource] : defaultSource,
      label,
      status: iStatus >= 0 && c[iStatus] ? c[iStatus] : '-',
      inputTokens: input,
      outputTokens: n(iOut) ?? 0,
      cachedShare: input > 0 ? cacheRead / input : 0,
      costUsd: n(iCost),
      durationMs: n(iDur),
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Monday 00:00 (local time) of the week containing `at`, as ms. */
export function weekStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  const sinceMonday = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - sinceMonday)
  return d.getTime()
}

export interface UsageTotals {
  runs: number
  inputTokens: number
  outputTokens: number
  /** Sum of the rows that reported a cost. */
  costUsd: number
  /** Rows that reported no cost (the CLI left it out), so the total is a floor. */
  unpriced: number
}

export function sumUsage(entries: UsageEntry[]): UsageTotals {
  const t: UsageTotals = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 }
  for (const e of entries) {
    t.runs += 1
    t.inputTokens += e.inputTokens
    t.outputTokens += e.outputTokens
    if (e.costUsd == null) t.unpriced += 1
    else t.costUsd += e.costUsd
  }
  return t
}

/** This calendar week (Monday on) and the week before, from `now`. */
export function weeklyTotals(entries: UsageEntry[], now: number): { thisWeek: UsageTotals; lastWeek: UsageTotals } {
  const start = weekStart(now)
  const prevStart = weekStart(start - 1)
  return {
    thisWeek: sumUsage(entries.filter(e => e.at >= start)),
    lastWeek: sumUsage(entries.filter(e => e.at >= prevStart && e.at < start)),
  }
}

export function formatCost(usd: number | null): string {
  if (usd == null) return '—'
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

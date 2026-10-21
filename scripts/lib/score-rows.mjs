/**
 * score-rows.mjs — append an evaluation's score rows to the two trajectory logs.
 *
 *   data/score-history.tsv     29 columns, header = SCORE_HISTORY_HEADER
 *   data/report-summaries.tsv  10 columns, headerless
 *
 * Unattended eval workers used to do this with `printf '…' >> file`, which
 * their least-privilege permissions deny (output redirection is refused), and
 * a free-text row (an apostrophe in a company name, a `$` in a salary) breaks
 * shell quoting anyway. They now write the row as JSON with the Write tool and
 * run scripts/append-score-rows.mjs, which builds the TSV line itself and
 * appends it under the file's lock (parallel batch workers write the same
 * files), atomically, header-checked, and idempotent for an identical row.
 *
 * Pure builders + one locked append; the CLI is the thin wrapper.
 */

import { existsSync, readFileSync } from 'node:fs'
import { lockPathFor, withLockSync } from './dir-lock.mjs'
import { SCORE_HISTORY_HEADER } from './profile-core.mjs'
import { writeFileAtomic } from './write-file-atomic.mjs'

export const HISTORY_COLUMNS = SCORE_HISTORY_HEADER.split('\t')
export const SUMMARY_COLUMNS = ['date', 'company', 'role', 'archetype', 'tier', 'want', 'ease', 'eligibility', 'key_gaps', 'verdict']

const HISTORY_REQUIRED = ['date', 'company', 'role', 'tier', 'verdict']
const SUMMARY_REQUIRED = ['date', 'company', 'role', 'tier', 'verdict']

/** One cell: nullish → '', and anything that would split the row (tab, CR, LF) → a space. */
const cell = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[\t\r\n]+/g, ' ').trim()

/**
 * A TSV line from an object keyed by column name. Unknown keys and missing
 * required keys are errors (a typo'd column would otherwise vanish silently).
 */
export function buildRow(columns, obj, required, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${label}: expected an object keyed by column name`)
  const unknown = Object.keys(obj).filter((k) => !columns.includes(k))
  if (unknown.length) throw new Error(`${label}: unknown column(s) ${unknown.join(', ')}`)
  const missing = required.filter((k) => !cell(obj[k]))
  if (missing.length) throw new Error(`${label}: missing required column(s) ${missing.join(', ')}`)
  return columns.map((c) => cell(obj[c])).join('\t')
}

/**
 * Append one line to a TSV under its lock.
 * @param {string} file
 * @param {string} line the row, no trailing newline
 * @param {{header?: string}} [opts] when set, the file must start with this header (created with it if missing/empty)
 * @returns {'appended'|'duplicate'}
 */
export function appendLine(file, line, { header } = {}) {
  return withLockSync(lockPathFor(file), () => {
    let text = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    if (header) {
      if (text.trim() === '') text = header + '\n'
      else if (text.split('\n', 1)[0] !== header) {
        throw new Error(`${file}: header does not match the current format; refusing to append (run npm run doctor)`)
      }
    }
    if (text.split('\n').includes(line)) return 'duplicate'
    writeFileAtomic(file, (text === '' || text.endsWith('\n') ? text : text + '\n') + line + '\n')
    return 'appended'
  }, { label: 'append-score-rows' })
}

/**
 * Append whichever of `score_history` / `report_summary` the input carries.
 * Both rows are built (and validated) before either file is touched.
 *
 * @param {{score_history?: object, report_summary?: object}} input
 * @param {{historyFile: string, summariesFile: string}} files
 */
export function appendScoreRows(input, { historyFile, summariesFile }) {
  if (!input || typeof input !== 'object') throw new Error('input must be a JSON object')
  const extra = Object.keys(input).filter((k) => k !== 'score_history' && k !== 'report_summary')
  if (extra.length) throw new Error(`unknown top-level key(s) ${extra.join(', ')} (use score_history and/or report_summary)`)
  if (!input.score_history && !input.report_summary) throw new Error('nothing to append: give score_history and/or report_summary')
  const history = input.score_history ? buildRow(HISTORY_COLUMNS, input.score_history, HISTORY_REQUIRED, 'score_history') : null
  const summary = input.report_summary ? buildRow(SUMMARY_COLUMNS, input.report_summary, SUMMARY_REQUIRED, 'report_summary') : null
  const out = {}
  if (history) out.score_history = appendLine(historyFile, history, { header: SCORE_HISTORY_HEADER })
  if (summary) out.report_summary = appendLine(summariesFile, summary)
  return out
}

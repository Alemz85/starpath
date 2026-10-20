/**
 * outcome-inputs.mjs — read the files outcome-stats.mjs joins, from a data
 * root. The I/O half of scripts/outcomes.mjs, shared with analyze-patterns.mjs
 * so both read the same inputs the same way.
 *
 *   data/applications.md     tracker rows (tracker-core parseAppRow)
 *   status-log.tsv           beside the real applications.md (status-ledger)
 *   data/score-history.tsv   targeting-core parseScoreHistory
 *   reports/…                the Team / Team size row, for company size
 *   materials index          optional: user/profile.yml
 *                            `outcomes.materials_index` (relative to the data
 *                            root, or absolute) or an explicit path. A
 *                            header-named TSV; the columns read are company,
 *                            role, app_num, sent, tailored, materials, notes.
 *
 * Every file is optional: a missing one yields an empty list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import yaml from 'js-yaml'
import { parseAppRow } from './tracker-core.mjs'
import { ledgerPathFor, readLedger, todayLocal } from './status-ledger.mjs'
import { parseScoreHistory } from './targeting-core.mjs'
import { classifyCompanySize } from './patterns-core.mjs'
import { applicationKey } from './application-key.mjs'

const read = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : '')

/** Header-named TSV → array of objects (blank lines skipped). */
export function parseHeaderTsv(raw) {
  const lines = String(raw ?? '').split('\n').filter((l) => l.trim() !== '')
  if (!lines.length) return []
  const header = lines[0].split('\t').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split('\t')
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]))
  })
}

/** user/profile.yml `outcomes:` block ({} when absent or unreadable). */
export function loadOutcomeSettings(profileFile) {
  try {
    const doc = yaml.load(read(profileFile)) || {}
    return doc.outcomes && typeof doc.outcomes === 'object' ? doc.outcomes : {}
  } catch {
    return {}
  }
}

function teamSize(reportText) {
  const m = String(reportText).replace(/\*\*/g, '').match(/\|\s*(?:Team|Team size|Company size|Equipo)\s*\|\s*(.*?)\s*\|/i)
  return m ? m[1].trim() : ''
}

/**
 * Everything analyzeApplicationOutcomes needs, read from `root`.
 * Options: materialsPath (overrides the profile setting), today, profileFile.
 */
export function loadOutcomeInputs(root, { materialsPath = null, today = todayLocal(), profileFile = join(root, 'user/profile.yml') } = {}) {
  const appsFile = existsSync(join(root, 'data/applications.md')) ? join(root, 'data/applications.md') : join(root, 'applications.md')
  const applications = []
  for (const line of read(appsFile).split('\n')) {
    const row = parseAppRow(line)
    if (row) applications.push({ num: row.num, date: row.date, company: row.company, role: row.role, status: row.status, notes: row.notes, report: row.report })
  }

  const ledger = existsSync(appsFile) ? readLedger(ledgerPathFor(appsFile)).rows : []
  const scores = parseScoreHistory(read(join(root, 'data/score-history.tsv')))

  const settings = loadOutcomeSettings(profileFile)
  const configured = materialsPath ?? (typeof settings.materials_index === 'string' ? settings.materials_index : null)
  const materialsFile = configured ? (isAbsolute(configured) ? configured : join(root, configured)) : null
  const materials = materialsFile ? parseHeaderTsv(read(materialsFile)) : []

  const sizes = new Map()
  for (const app of applications) {
    const link = String(app.report ?? '').match(/\]\(([^)]+)\)/)
    if (!link) continue
    const size = classifyCompanySize(teamSize(read(join(root, link[1]))))
    if (size !== 'unknown') sizes.set(applicationKey(app.company, app.role), size)
  }

  const days = Number(settings.no_response_days)
  return {
    applications, ledger, scores, materials, sizes, today,
    rules: Number.isFinite(days) && days > 0 ? { noResponseDays: days } : {},
    sources: { appsFile, materialsFile, materialsFound: Boolean(materialsFile && existsSync(materialsFile)) },
  }
}

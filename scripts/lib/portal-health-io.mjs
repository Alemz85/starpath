/**
 * portal-health-io.mjs — the file side of the portal health log.
 *
 * `data/portal-health.tsv` is shared across search profiles like the agent
 * log (it is about the boards, keyed by company name); the review reads the
 * ACTIVE profile's portals.yml, scan-history and score-history through the
 * canonical paths. The rules live in portal-health-core.mjs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { parseHistoryFile, getCell } from './scan-history.mjs'
import {
  HEALTH_HEADER, buildHealthRow, serializeHealthRow, parseHealthRows, reviewPortalHealth,
} from './portal-health-core.mjs'

export const PORTAL_HEALTH_PATH = 'data/portal-health.tsv'
const PORTALS_PATH = 'user/portals.yml'
const SCAN_HISTORY_PATH = 'data/scan-history.tsv'
const SCORE_HISTORY_PATH = 'data/score-history.tsv'

export function readHealthRows(path = PORTAL_HEALTH_PATH) {
  if (!existsSync(path)) return []
  return parseHealthRows(readFileSync(path, 'utf-8'))
}

/** Append records (validated by buildHealthRow); creates the file with its header. */
export function appendHealthRows(records, path = PORTAL_HEALTH_PATH) {
  const rows = records.map(buildHealthRow)
  if (rows.length === 0) return 0
  mkdirSync(dirname(path), { recursive: true })
  const fresh = !existsSync(path) || readFileSync(path, 'utf-8').trim() === ''
  const body = rows.map(serializeHealthRow).join('\n') + '\n'
  appendFileSync(path, (fresh ? HEALTH_HEADER + '\n' : '') + body, 'utf-8')
  return rows.length
}

function readTracked(path = PORTALS_PATH) {
  if (!existsSync(path)) return []
  try {
    const cfg = yaml.load(readFileSync(path, 'utf-8')) || {}
    return Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : []
  } catch { return [] }
}

function readScanHistory(path = SCAN_HISTORY_PATH) {
  if (!existsSync(path)) return []
  const { columns, rows } = parseHistoryFile(readFileSync(path, 'utf-8'))
  return rows.map((r) => ({
    company: getCell(r, columns, 'company'),
    source: getCell(r, columns, 'portal'),
    status: getCell(r, columns, 'status'),
  }))
}

function readScores(path = SCORE_HISTORY_PATH) {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const cols = lines[0].split('\t')
  const ci = cols.indexOf('company')
  const vi = cols.indexOf('verdict')
  if (ci < 0 || vi < 0) return []
  return lines.slice(1).map((l) => { const c = l.split('\t'); return { company: c[ci] || '', verdict: c[vi] || '' } })
}

/**
 * The review over the live files (any missing file is an empty input).
 * `root` is the checkout (or data root) the canonical paths hang off; the
 * health file can be given on its own for a shared location.
 */
export function reviewFromFiles({ root = '.', healthPath } = {}) {
  return reviewPortalHealth({
    rows: readHealthRows(healthPath || join(root, PORTAL_HEALTH_PATH)),
    tracked: readTracked(join(root, PORTALS_PATH)),
    scanHistory: readScanHistory(join(root, SCAN_HISTORY_PATH)),
    scores: readScores(join(root, SCORE_HISTORY_PATH)),
  })
}

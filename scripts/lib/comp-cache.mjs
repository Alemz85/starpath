// comp-cache.mjs — Salary-band cache for undisclosed-comp lookups.
//
// Schema of data/comp-cache.tsv (already exists):
//   company  role_archetype  city  currency  min  max  source  confidence  last_updated
//
// Used when a JD doesn't disclose comp. Agent runs a WebSearch
// (Levels.fyi → Glassdoor → ...) and stores the result here so future
// evaluations of the same `(company, role_archetype, city)` skip the
// search. See modes/_shared.md § Comp cache for the full lookup flow.

import { readTsv, appendTsv, isFresh, todayIso } from './cache-tsv.mjs'

const PATH    = 'data/comp-cache.tsv'
const HEADERS = ['company', 'role_archetype', 'city', 'currency', 'min', 'max', 'source', 'confidence', 'last_updated']

/**
 * Three-level lookup per _shared.md § Comp cache:
 *   1. Exact (company + role_archetype + city) within maxAgeDays
 *   2. Cross-city same role (Berlin↔Munich, etc.) — caller scales the
 *      result via the COL baseline ratio. We just return the matched row
 *      with a `proxy: 'cross-city'` tag so the caller knows.
 *   3. Same company, peer archetype — caller decides if it's close enough.
 *
 * For now, ONLY exact matches are returned. The cross-city / peer-archetype
 * proxies need more data than we currently have to do reliably; pushing
 * those branches back to the agent (which can WebSearch + judge) keeps
 * this script honest.
 */
export async function lookup({ company, role_archetype, city }, { maxAgeDays = 60 } = {}) {
  const { rows } = await readTsv(PATH)
  const exact = rows.filter(r =>
    r.company === company &&
    r.role_archetype === role_archetype &&
    r.city === city
  )
  if (exact.length === 0) return null
  const latest = exact.sort((a, b) => b.last_updated.localeCompare(a.last_updated))[0]
  if (!isFresh(latest.last_updated, maxAgeDays)) return null
  return {
    company:        latest.company,
    role_archetype: latest.role_archetype,
    city:           latest.city,
    currency:       latest.currency,
    min:            Number(latest.min),
    max:            Number(latest.max),
    source:         latest.source,
    confidence:     latest.confidence,
    last_updated:   latest.last_updated,
  }
}

/** Append a fresh row. */
export async function append({ company, role_archetype, city, currency, min, max, source, confidence }) {
  await appendTsv(PATH, HEADERS, {
    company,
    role_archetype,
    city,
    currency,
    min: String(min),
    max: String(max),
    source,
    confidence,
    last_updated: todayIso(),
  })
}

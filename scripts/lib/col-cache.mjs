// col-cache.mjs — Cost-of-living cache for the savings-power rubric.
//
// Schema of data/col-cache.tsv:
//   city  baseline_eur  source  last_updated
//
// baseline_eur = monthly comfortable-life baseline for a single 25-30yo
// professional in `city` (sum of Numbeo's "Single person estimated
// monthly costs without rent" + "Apartment 1 bedroom in City Centre").
//
// `lookup` returns the row if one exists and is within `maxAgeDays` of
// today; otherwise null (caller should fetch / re-fetch and `append`).

import { readTsv, appendTsv, isFresh, todayIso } from './cache-tsv.mjs'

const PATH    = 'data/col-cache.tsv'
const HEADERS = ['city', 'baseline_eur', 'source', 'last_updated']

/** Find the freshest row for this city; returns null if missing or stale. */
export async function lookup(city, { maxAgeDays = 60 } = {}) {
  const { rows } = await readTsv(PATH)
  const matches = rows.filter(r => r.city === city)
  if (matches.length === 0) return null
  const latest = matches.sort((a, b) => b.last_updated.localeCompare(a.last_updated))[0]
  if (!isFresh(latest.last_updated, maxAgeDays)) return null
  return {
    city:          latest.city,
    baseline_eur:  Number(latest.baseline_eur),
    source:        latest.source,
    last_updated:  latest.last_updated,
  }
}

/** Append a fresh row. Caller is responsible for not double-writing same-day. */
export async function append({ city, baseline_eur, source }) {
  await appendTsv(PATH, HEADERS, {
    city,
    baseline_eur: String(baseline_eur),
    source,
    last_updated: todayIso(),
  })
}

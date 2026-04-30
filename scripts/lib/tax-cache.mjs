// tax-cache.mjs — Effective-tax-rate cache for the savings-power rubric.
//
// Schema of data/tax-cache.tsv:
//   country  gross_band_eur  effective_rate  source  last_updated
//
// gross_band_eur is the gross annual rounded to the nearest €5K. The
// effective_rate is a decimal (e.g. 0.27 for 27%). source names whichever
// calculator the agent used (talent.com, gov.ie, etc.).
//
// Lookup returns the freshest row whose country matches AND whose
// gross_band_eur is within ±€5K of the queried gross — that band step
// keeps cache hits frequent without losing accuracy across tax brackets.

import { readTsv, appendTsv, isFresh, todayIso } from './cache-tsv.mjs'

const PATH    = 'data/tax-cache.tsv'
const HEADERS = ['country', 'gross_band_eur', 'effective_rate', 'source', 'last_updated']
const BAND_STEP_EUR = 5000

/** Round annual gross to the nearest €5K. */
export function roundToBand(gross) {
  return Math.round(gross / BAND_STEP_EUR) * BAND_STEP_EUR
}

/**
 * Find a fresh row for (country, gross-rounded-to-5K). Returns null if
 * nothing within `maxAgeDays`. Tax brackets shift slowly so 90 days is
 * a longer TTL than COL data.
 */
export async function lookup(country, gross, { maxAgeDays = 90 } = {}) {
  const band = roundToBand(gross)
  const { rows } = await readTsv(PATH)
  const matches = rows.filter(r => r.country === country && Number(r.gross_band_eur) === band)
  if (matches.length === 0) return null
  const latest = matches.sort((a, b) => b.last_updated.localeCompare(a.last_updated))[0]
  if (!isFresh(latest.last_updated, maxAgeDays)) return null
  return {
    country:        latest.country,
    gross_band_eur: Number(latest.gross_band_eur),
    effective_rate: Number(latest.effective_rate),
    source:         latest.source,
    last_updated:   latest.last_updated,
  }
}

/** Append a fresh row. */
export async function append({ country, gross, effective_rate, source }) {
  await appendTsv(PATH, HEADERS, {
    country,
    gross_band_eur: String(roundToBand(gross)),
    effective_rate: String(effective_rate),
    source,
    last_updated:   todayIso(),
  })
}

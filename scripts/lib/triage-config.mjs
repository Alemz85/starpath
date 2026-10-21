// triage-config.mjs — turn the user's parsed profile.yml + portals.yml into
// the company options triage-core's triagePending() takes. Shared by
// scripts/triage-pipeline.mjs and scripts/daily-brief.mjs so both rank the
// inbox the same way. Pure: callers read and parse the files.
//
//   profile.yml  target_roles.dream_companies     → dreamCompanies
//                calibration.brand_affinity_companies → affinityCompanies
//                triage.weights                   → weights (DEFAULT_WEIGHTS keys only)
//                triage.per_company_cap           → perCompanyCap
//   portals.yml  tracked_companies[].brand        → companyBrands

import { DEFAULT_WEIGHTS, buildCompanyBrands } from './triage-core.mjs'

/**
 * @param {{ profile?: object|null, portals?: object|null }} parsed  yaml.load() results
 * @returns {{ dreamCompanies, affinityCompanies, companyBrands, weights, perCompanyCap?, warnings: string[] }}
 */
export function triageOptsFromConfig({ profile, portals } = {}) {
  const warnings = []
  const p = profile ?? {}

  const dreams = p?.target_roles?.dream_companies ?? p?.profile?.dream_companies ?? []
  const dreamCompanies = (Array.isArray(dreams) ? dreams : [])
    .map(d => (typeof d === 'string' ? { name: d, priority: 'top' } : d))
    .filter(d => d?.name)
  const affinity = p?.calibration?.brand_affinity_companies
  const affinityCompanies = Array.isArray(affinity) ? affinity : []

  const weights = {}
  for (const [key, value] of Object.entries(p?.triage?.weights ?? {})) {
    if (!(key in DEFAULT_WEIGHTS)) warnings.push(`triage.weights.${key} is not a triage weight; ignored`)
    else if (typeof value !== 'number' || !Number.isFinite(value)) warnings.push(`triage.weights.${key} must be a number; ignored`)
    else weights[key] = value
  }

  const out = {
    dreamCompanies,
    affinityCompanies,
    companyBrands: buildCompanyBrands(portals?.tracked_companies),
    weights,
    warnings,
  }
  const cap = p?.triage?.per_company_cap
  if (cap != null) {
    if (Number.isInteger(cap) && cap >= 0) out.perCompanyCap = cap
    else warnings.push('triage.per_company_cap must be a whole number (0 = off); ignored')
  }
  return out
}

// prior-score.mjs — the previous evaluation of the same listing, and what moved.
//
// Judgment dimensions wobble by a point from one run to the next with no new
// information behind the move. A re-score therefore starts from the listing's
// last evaluation: the worker sees the prior dimension scores before judging,
// and every dimension that moves by 1 or more must be justified by something
// new (a changed posting, a new CV item, new insider or company knowledge) —
// otherwise it goes back to the prior value.
//
// Pure: callers pass parsed score-history rows (targeting-core.parseScoreHistory).

import { companyKey, normalizeRoleForIndex } from './tracker-core.mjs'
import { DIM_LABELS } from './explain-score.mjs'

/** Dimensions the anchoring applies to: every judged one. Salary is computed, not judged. */
export const PRIOR_DIMS = [
  'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
  'best_cities', 'work_life_balance',
  'skills_match', 'experience_bar', 'competition',
]

/** A move of this size or more needs a reason. */
export const PRIOR_CHANGE_AT = 1

const normUrl = (u) => String(u ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()

/**
 * Latest score-history row for the listing: same URL, else same company key +
 * normalized role. Returns null when the listing was never evaluated.
 *   { date, verdict, want, ease, eligibility, blocked, dims: {dim: n|null} }
 */
export function findPrior(rows, { company, role, url } = {}) {
  const u = normUrl(url)
  const ck = company ? companyKey(company) : null
  const rk = role ? normalizeRoleForIndex(role) : null
  const hits = rows.filter((r) =>
    (u && normUrl(r.url) === u) ||
    (ck && rk && companyKey(r.company) === ck && normalizeRoleForIndex(r.role) === rk))
  if (hits.length === 0) return null
  const last = [...hits].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1)
  const num = (v) => (Number.isFinite(v) ? v : null)
  return {
    date: last.date,
    verdict: last.verdict || null,
    want: num(last.want),
    ease: num(last.ease),
    eligibility: last.eligibility || null,
    blocked: last.eligibility === 'red' || last.verdict === 'blocked',
    dims: Object.fromEntries(PRIOR_DIMS.map((d) => [d, num(last[d])])),
  }
}

/**
 * Dimensions that moved by PRIOR_CHANGE_AT or more since the prior evaluation.
 *   [{ dimension, label, from, to, delta }]
 * A blocked prior (no scores) yields no changes.
 */
export function compareToPrior(prior, dims) {
  if (!prior || prior.blocked) return []
  const out = []
  for (const d of PRIOR_DIMS) {
    const from = prior.dims?.[d]
    const to = dims?.[d]
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const delta = Number((to - from).toFixed(2))
    if (Math.abs(delta) >= PRIOR_CHANGE_AT) out.push({ dimension: d, label: DIM_LABELS[d] ?? d, from, to, delta })
  }
  return out
}

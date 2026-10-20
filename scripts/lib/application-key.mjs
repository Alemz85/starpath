/**
 * application-key.mjs — one key for "this application", across every store
 * that records something about it.
 *
 * Four stores key applications differently:
 *   - the status log (status-log.tsv): num, guarded by lowercase company/role
 *   - the materials index (the user's CV folder index, header-named TSV):
 *     an application number plus the company/role strings as typed
 *   - score-history.tsv: company/role (dedup by companyRoleKey) and URL
 *   - the app: livenessKey = lowercase `company|role`
 *
 * applicationKey(company, role) is the join key for all of them: the dedup
 * index's normalizeCompany (diacritics folded, punctuation dropped, non-Latin
 * names hashed) plus the scanner's canonical role (req ids, gender tags and
 * trailing separators stripped, whitespace collapsed). It is exactly
 * merge-staging-core's companyRoleKey, so a score-history row and a tracker
 * row for the same listing always meet. '' when either side is blank.
 *
 * Pure; unit-tested in application-key.test.mjs.
 */

import { companyKeyAliases, normalizeCompany } from './dedup-index.mjs'
import { canonicalizeRole, companyRoleKey } from './merge-staging-core.mjs'

/** The join key for one application ('' when company or role is blank). */
export function applicationKey(company, role) {
  return companyRoleKey(company || '', role || '')
}

/**
 * Every key a row written by older code might carry for this application:
 * the current key first, then the legacy company key (Latin names whose key
 * lost diacritics before the identity-key change). Read with these, write
 * the first.
 */
export function applicationKeyAliases(company, role) {
  const r = canonicalizeRole(role || '')
  if (!r || !normalizeCompany(company || '')) return []
  return companyKeyAliases(company).filter(Boolean).map((c) => `${c}\t${r}`)
}

/**
 * Index rows by application key. `pick(prev, next)` decides which row wins
 * when two share a key (default: the later one in input order). Rows with no
 * usable key are returned in `unkeyed`.
 *
 * @returns {{ byKey: Map<string, any>, unkeyed: any[] }}
 */
export function indexByApplication(rows, { company = (r) => r.company, role = (r) => r.role, pick = (_prev, next) => next } = {}) {
  const byKey = new Map()
  const unkeyed = []
  for (const row of rows ?? []) {
    const k = applicationKey(company(row), role(row))
    if (!k) { unkeyed.push(row); continue }
    byKey.set(k, byKey.has(k) ? pick(byKey.get(k), row) : row)
  }
  return { byKey, unkeyed }
}

/** Look an application up in an index built by indexByApplication, trying its aliases. */
export function lookupApplication(index, company, role) {
  for (const k of applicationKeyAliases(company, role)) {
    if (index.byKey.has(k)) return index.byKey.get(k)
  }
  return undefined
}

/**
 * Group rows (status-log entries, say) by application key, keeping every row.
 * @returns {Map<string, any[]>}
 */
export function groupByApplication(rows, { company = (r) => r.company, role = (r) => r.role } = {}) {
  const out = new Map()
  for (const row of rows ?? []) {
    const k = applicationKey(company(row), role(row))
    if (!k) continue
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(row)
  }
  return out
}

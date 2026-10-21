// Database search-token parsing + matching — pure functions over the
// Database tab's free-text/token query box.
//
// Extracted from DatabaseView so (a) the parser and (b) the row predicate can
// be unit-tested, and — more importantly — so the row predicate has ONE
// definition. It used to be written twice in DatabaseView (the `filtered`
// pipeline and the facet-count `passGlobal`), and the two copies had already
// drifted on the `min-score:` edge case. One matcher, used by both, can't
// drift.

import type { ScoreEntry } from '@/types'
import { canonicalizeArchetype } from './archetype'
import { parseCities } from './entityId'
import { VERDICT_LABELS, verdictOf } from './scoreBands'

export interface TokenFilters {
  company?: string
  role?: string
  tier?: string
  archetype?: string
  location?: string
  type?: string
  /** Verdict key or label (`stretch`, `"growth target"`). */
  verdict?: string
  /** green | amber | red */
  eligibility?: string
  /** Scoring v2 replaces `min-score:` (there is no Overall) with one floor
   *  per axis. */
  minMatch?: number
  minEase?: number
}

// Token query parser. Supports both:
//   - Bare values:    `company:Stripe tier:T1`
//   - Quoted values:  `company:"JP Morgan" role:"Senior Engineer"`
// Quoted values are required for multi-word matches (company names with
// spaces, role titles, archetypes). The regex tries the quoted form
// first, then falls back to the unquoted single-token form. Anything left
// over after the recognized tokens are stripped is returned as free text.
export function parseTokenQuery(q: string): { tokenFilters: TokenFilters; freeText: string } {
  const tokenFilters: TokenFilters = {}
  // Key allows a hyphen so the advertised `min-match:` / `min-ease:` tokens
  // actually match — `\w` excludes `-`, so `(\w+):` would parse `min-match:7`
  // as the bare word `min` + an unhandled `match:7` token.
  const tokenRe = /([\w-]+):(?:"([^"]+)"|(\S+))/g
  let freeText = q
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(q)) !== null) {
    const [full, key, quotedVal, plainVal] = match
    const val = quotedVal ?? plainVal
    freeText = freeText.replace(full, '').trim()
    switch (key.toLowerCase()) {
      case 'company':    tokenFilters.company   = val; break
      case 'role':       tokenFilters.role      = val; break
      case 'tier':       tokenFilters.tier      = val; break
      case 'archetype':  tokenFilters.archetype = val; break
      case 'location':   tokenFilters.location  = val; break
      case 'type':       tokenFilters.type      = val; break
      case 'verdict':     tokenFilters.verdict     = val; break
      case 'eligibility':
      case 'elig':        tokenFilters.eligibility = val; break
      case 'min-match':
      case 'minmatch':     tokenFilters.minMatch     = parseFloat(val); break
      case 'min-ease':
      case 'minease':     tokenFilters.minEase     = parseFloat(val); break
    }
  }

  return { tokenFilters, freeText: freeText.trim() }
}

// True iff the entity satisfies every active token filter AND the free-text
// term. Matching rules:
//   company / role / type → case-insensitive substring
//   tier                  → case-insensitive exact
//   archetype             → substring of the raw OR the canonical bucket
//   location              → substring of the location field OR any parsed city
//   verdict               → verdict key or label, case-insensitive exact
//   eligibility           → green | amber | red, case-insensitive exact
//   min-match / min-ease   → Match / Ease ≥ N (ignored when N isn't finite, so a
//                           typo like `min-match:x` doesn't nuke results). A
//                           blocked row has no scores, so a floor excludes it.
//   freeText              → substring of company OR role
export function matchesTokenQuery(r: ScoreEntry, t: TokenFilters, freeText: string): boolean {
  if (t.company && !r.company.toLowerCase().includes(t.company.toLowerCase())) return false
  if (t.role && !r.role.toLowerCase().includes(t.role.toLowerCase())) return false
  if (t.tier && r.tier.toLowerCase() !== t.tier.toLowerCase()) return false
  if (t.archetype) {
    const ta = t.archetype.toLowerCase()
    if (!(r.archetype.toLowerCase().includes(ta) || canonicalizeArchetype(r.archetype).toLowerCase().includes(ta))) return false
  }
  if (t.location) {
    const needle = t.location.toLowerCase()
    const hit = r.location.toLowerCase().includes(needle) ||
      parseCities(r.location).cities.some(c => c.toLowerCase().includes(needle))
    if (!hit) return false
  }
  if (t.type && !r.employment_type.toLowerCase().includes(t.type.toLowerCase())) return false
  if (t.verdict) {
    const wantedVerdict = t.verdict.toLowerCase()
    const v = verdictOf(r)
    if (!v || (v !== wantedVerdict && VERDICT_LABELS[v].toLowerCase() !== wantedVerdict)) return false
  }
  if (t.eligibility && (r.eligibility ?? '').toLowerCase() !== t.eligibility.toLowerCase()) return false
  if (t.minMatch != null && Number.isFinite(t.minMatch) && !(r.match != null && r.match >= t.minMatch)) return false
  if (t.minEase != null && Number.isFinite(t.minEase) && !(r.ease != null && r.ease >= t.minEase)) return false
  if (freeText) {
    const q = freeText.toLowerCase()
    if (!(r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q))) return false
  }
  return true
}

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

export interface TokenFilters {
  company?: string
  role?: string
  tier?: string
  archetype?: string
  location?: string
  type?: string
  minScore?: number
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
  // Key allows a hyphen so the advertised `min-score:` token actually matches
  // — `\w` excludes `-`, so the old `(\w+):` parsed `min-score:7` as the bare
  // word `min` + an (unhandled) `score:7` token and silently dropped the floor.
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
      case 'min-score':
      case 'minscore':   tokenFilters.minScore  = parseFloat(val); break
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
//   min-score             → overall ≥ N (ignored when N isn't a finite number,
//                           so a typo like `min-score:x` no longer nukes results)
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
  if (t.minScore != null && Number.isFinite(t.minScore) && r.overall < t.minScore) return false
  if (freeText) {
    const q = freeText.toLowerCase()
    if (!(r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q))) return false
  }
  return true
}

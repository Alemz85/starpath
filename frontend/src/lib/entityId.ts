// Entity identity for the unified evaluation model.
//
// An "entity" is the persistent thing the user is tracking — one
// (company, role-canonical, city) tuple, stable across re-posts and
// re-evaluations. Multi-URL multi-city listings (Trade Republic Berlin
// posted under one URL, Paris under another) become N entities, one per
// city, linked as siblings. Single-URL multi-city listings (Rev-celerator
// listing 4 cities on one posting) become 1 entity with cities[] = the
// full list and the city-key in entity_id set to the literal "multi".
//
// The id is a deterministic slug used as the primary key everywhere —
// scouting.md row metadata, dedup-index.tsv, the SQLite cache, and
// reports/.history/ snapshot grouping. The function MUST stay pure and
// stable: changing the canonicalisation rules requires migrating data.

const KNOWN_CITY_ALIASES: Record<string, string[]> = {
  Milan:    ['Milano'],
  Milano:   ['Milan'],
  Rome:     ['Roma'],
  Roma:     ['Rome'],
  Munich:   ['München', 'Munchen'],
  Lisbon:   ['Lisboa'],
  Vienna:   ['Wien'],
  Brussels: ['Bruxelles'],
}

// Lower-bound on city tokens we recognize when scrubbing the role string.
// Stays narrow on purpose — only canonical names + the aliases above. A
// city not on this list won't get stripped from the role title, which is
// OK (the entity_id will just have a slightly-longer role part; siblings
// lookup is fuzzier but still works).
const KNOWN_CITIES = new Set<string>([
  'Amsterdam', 'Barcelona', 'Berlin', 'Brussels', 'Bruxelles',
  'Copenhagen', 'Dublin', 'Lisbon', 'Lisboa', 'London', 'Madrid',
  'Milan', 'Milano', 'Munich', 'München', 'Munchen', 'Paris', 'Porto',
  'Prague', 'Rome', 'Roma', 'Stockholm', 'Vienna', 'Wien', 'Warsaw',
  'Zurich', 'Geneva', 'Helsinki', 'Oslo', 'Athens', 'Hamburg',
  'Frankfurt', 'Cologne', 'Köln', 'Düsseldorf', 'Düsseldorf',
])

export function slug(s: string): string {
  return s.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Strip noise that doesn't change the role's identity:
// - requisition IDs in parens: "(req 7645479)", "(7645479)"
// - year suffixes: "(2025-2026)", "Spring 2026", "Start September 2026", "2026"
// - gender markers: "(all genders)", "(m/f/d)", "(f/m/x)"
// - the row's own city when it appears as a trailing or parenthetical
//   suffix (so multi-URL multi-city rows for the same role canonicalize
//   to the same role-slug and get linked as siblings)
// - bracket tags like "[DIG]", "[ADV]" stay (they're meaningful
//   line-of-business distinctions at PwC and similar firms)
export function canonicalRoleSlug(role: string, rowCity: string | null = null): string {
  let r = role

  r = r.replace(/\(req\s+\d+\)/gi, '')
  r = r.replace(/\(\d{4,}\)/g, '')

  r = r.replace(/\(\s*\d{4}\s*[-–]\s*\d{4}\s*\)/g, '')
  r = r.replace(/\b\d{4}\s*[-–]\s*\d{4}\b/g, '')
  r = r.replace(/\b(?:start\s+)?(?:spring|summer|fall|autumn|winter|q[1-4])\s+20\d{2}\b/gi, '')
  r = r.replace(/\b(?:start\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/gi, '')
  r = r.replace(/\b20\d{2}\b/g, '')

  r = r.replace(/\(\s*all\s+genders?\s*\)/gi, '')
  r = r.replace(/\(\s*[mwfx]\s*[\/\\]\s*[mwfx]\s*(?:[\/\\]\s*[mwfxd]\s*)?\)/gi, '')

  // Strip the row's city wherever it appears in the role title, using
  // word boundaries so we don't eat substrings of unrelated words
  // ("Berlin" inside "Berliner" stays). Tries the canonical name +
  // each known alias. Stripping the city ANYWHERE (not just trailing)
  // catches the "Junior Consultant - Roma - INTERNSHIP" / "...- Milano
  // - INTERNSHIP" sibling pair where the city sits mid-string.
  const cityCandidates = new Set<string>()
  if (rowCity && rowCity !== 'multi') {
    cityCandidates.add(rowCity)
    for (const alias of KNOWN_CITY_ALIASES[rowCity] ?? []) cityCandidates.add(alias)
  }
  for (const c of cityCandidates) {
    r = r.replace(new RegExp(`\\b${escapeRe(c)}\\b`, 'gi'), ' ')
  }

  // Collapse the separator residue stripping a mid-string city leaves
  // behind: "<sep> <sep>" pairs collapse to a single separator; empty
  // parens disappear; runs of whitespace collapse.
  r = r.replace(/[\s]*[-–—]\s*[-–—][\s]*/g, ' - ')
  r = r.replace(/\(\s*\)/g, '')
  r = r.replace(/\s{2,}/g, ' ')
  r = r.replace(/^[\s\-–—,]+|[\s\-–—,]+$/g, '').trim()
  return slug(r)
}

// Parse the score-history.tsv `location` field into a city list. The
// field is usually a single city token but can be slash-separated for
// multi-region postings (e.g., "Hong Kong / EU"). We treat ≥2 listed
// cities as multi-city — the row is a single-URL listing that names
// multiple locations, and the entity should expose a cities[] array.
export interface ParsedLocation {
  cities: string[]               // canonicalized list, deduped
  isMulti: boolean               // true ⇒ entity_id city-key = "multi"
  primary: string | null         // the canonical-best for this row, used
                                 // when the entity is single-city; null
                                 // when the location field is unusable
}

export function parseCities(location: string | null | undefined): ParsedLocation {
  if (!location) return { cities: [], isMulti: false, primary: null }
  const cleaned = location.replace(/\([^)]*\)/g, '').trim()
  if (!cleaned || /^n\/d$/i.test(cleaned)) return { cities: [], isMulti: false, primary: null }

  const tokens = cleaned.split(/\s*[,;\/]\s*/).map(t => t.trim()).filter(Boolean)

  // Keep every token that names a place — actual cities AND regional
  // labels like "EU". The Database city filter applies the same
  // multi-city logic ("filter by EU matches any entity whose cities[]
  // contains EU"), so dropping region labels would lose useful filter
  // signal. The only thing we strip is meta-noise like "Remote" used as
  // a prefix. cityHits keeps the token strings verbatim so the UI can
  // render them faithfully; the "primary" we return is the first
  // RECOGNIZED city if any exist (so the entity has a concrete city to
  // hang scoring on), else the first token.
  const cityHits: string[] = []
  for (const t of tokens) {
    if (/^remote$/i.test(t)) continue          // drop bare "Remote" — kept as suffix in token text otherwise
    cityHits.push(t)
  }
  if (cityHits.length === 0) return { cities: [], isMulti: false, primary: null }
  if (cityHits.length === 1) return { cities: cityHits, isMulti: false, primary: cityHits[0] }

  // Two or more named places → multi-city. Pick the first RECOGNIZED
  // city as primary (falls back to the first token if none are in the
  // known set — keeps things deterministic for unknown-city corpora).
  const dedup = [...new Set(cityHits)]
  const firstKnown = dedup.find(t => KNOWN_CITIES.has(t)) ?? dedup[0]
  return { cities: dedup, isMulti: true, primary: firstKnown }
}

// Compute the entity_id given a row's company, role, and parsed
// location. For single-city rows the city slug is in the id; for
// multi-city rows the city slug is the literal "multi" — the cities[]
// array is stored as an entity attribute, not as part of the id.
export function entityId(company: string, role: string, parsed: ParsedLocation): string {
  const cityKey = parsed.isMulti
    ? 'multi'
    : (parsed.primary ? slug(parsed.primary) : 'unknown')
  const roleKey = canonicalRoleSlug(role, parsed.isMulti ? null : parsed.primary)
  return `${slug(company)}::${roleKey}::${cityKey}`
}

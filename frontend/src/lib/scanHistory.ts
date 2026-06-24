// Scan-history derivations — pure functions over data/scan-history.tsv and
// data/discarded.tsv, plus the canonical entity-key builder.
//
// Extracted from store/data.ts so they're (a) testable and (b) deterministic:
// `deriveLiveness` and `countScansThisMonth` take an injectable `now` instead
// of reaching for `new Date()` internally, so a test can pin "today" and
// assert the exact threshold behaviour. The store calls them with the default
// (real clock) and owns only the file I/O.

export type Liveness = 'active' | 'stale' | 'closed'

const DAY_MS = 1000 * 60 * 60 * 24

// Liveness thresholds, in days since a listing was last seen in a scan.
//   < ACTIVE_WITHIN_DAYS         → active
//   < STALE_WITHIN_DAYS          → stale
//   ≥ STALE_WITHIN_DAYS / unseen → closed
export const ACTIVE_WITHIN_DAYS = 14
export const STALE_WITHIN_DAYS = 90

// THE canonical entity key — `company|role`, trimmed + lowercased. Every map
// that keys a listing by (company, role) — the liveness map, the discard
// tombstone set, the application-status map — must build its keys through this
// one function so the format can never drift between call sites. (It used to
// be hand-inlined in ~9 places; a single edit to the format would silently
// have broken every lookup that didn't get updated in lock-step.)
export function livenessKey(company: string, role: string): string {
  return `${company.trim().toLowerCase()}|${role.trim().toLowerCase()}`
}

// data/discarded.tsv is a flat tombstone log written by discardListing().
// Header row + `company\trole\tdate` per row; we collapse to a Set of
// livenessKey(company, role) so Database/Scouting views can do O(1) tests.
export function parseDiscarded(raw: string | null): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  const lines = raw.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t')
    const company = (cells[0] ?? '').trim()
    const role    = (cells[1] ?? '').trim()
    if (!company || !role) continue
    out.add(livenessKey(company, role))
  }
  return out
}

// Score-history entries don't have URLs but they do have company+role and a
// `source` (often the URL). scan-history.tsv has the canonical URL → date list.
// We can't perfectly join them, but we can map company+role → most-recent
// scan_dates entry and derive liveness from the recency.
//
// `now` is injectable for deterministic tests; defaults to the real clock.
export function deriveLiveness(
  raw: string | null,
  now: Date = new Date(),
): Record<string, Liveness> {
  if (!raw) return {}
  const lines = raw.split('\n')
  if (lines.length < 2) return {}
  const header = lines[0].split('\t')
  const companyIdx = header.indexOf('company')
  const titleIdx   = header.indexOf('title')
  const datesIdx   = header.indexOf('scan_dates')
  if (companyIdx < 0 || titleIdx < 0 || datesIdx < 0) return {}

  const out: Record<string, Liveness> = {}

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t')
    if (row.length < 3) continue
    const company = (row[companyIdx] ?? '').trim()
    const title   = (row[titleIdx] ?? '').trim()
    const dates   = (row[datesIdx] ?? '').split('|').filter(Boolean)
    if (!company || !title || dates.length === 0) continue

    const last = dates[dates.length - 1]
    const lastDate = new Date(last)
    if (Number.isNaN(lastDate.getTime())) continue
    const daysAgo = (now.getTime() - lastDate.getTime()) / DAY_MS

    const liveness: Liveness =
      daysAgo < ACTIVE_WITHIN_DAYS ? 'active' :
      daysAgo < STALE_WITHIN_DAYS  ? 'stale' : 'closed'

    const key = livenessKey(company, title)
    // Keep the freshest verdict if the same company+role appears in multiple rows.
    const cur = out[key]
    if (!cur || rank(liveness) > rank(cur)) out[key] = liveness
  }
  return out
}

function rank(l: Liveness): number {
  return l === 'active' ? 2 : l === 'stale' ? 1 : 0
}

// Count unique scan-run *dates* in the current calendar month. Each row of
// scan-history.tsv has a `scan_dates` column (pipe-separated YYYY-MM-DD list);
// many rows can share a scan date because a single scan adds many URLs at once,
// so we union dates across rows and dedupe before counting.
//
// `now` is injectable for deterministic tests; defaults to the real clock.
export function countScansThisMonth(raw: string | null, now: Date = new Date()): number {
  if (!raw) return 0
  const lines = raw.split('\n')
  if (lines.length < 2) return 0
  const header = lines[0].split('\t')
  const datesIdx = header.indexOf('scan_dates')
  if (datesIdx === -1) return 0

  const monthPrefix = now.toISOString().slice(0, 7)  // "YYYY-MM"
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t')
    const cell = row[datesIdx]
    if (!cell) continue
    for (const d of cell.split('|')) {
      if (d.startsWith(monthPrefix)) seen.add(d)
    }
  }
  return seen.size
}

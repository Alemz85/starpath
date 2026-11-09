// Pure rules for the company-logo cache (the main process's `logo:fetch`).
//
// The good logo source rate-limits anonymous clients, so a first load of a
// long company list gets "try later" for part of it. Those answers must not
// be mistaken for "this domain has no logo": the low-resolution favicon that
// stands in is kept as *provisional* and the good source is asked again
// later, instead of the favicon being cached for good.

/** What a logo request told us. */
export type LogoOutcome = 'ok' | 'missing' | 'unavailable'

/**
 * `missing`: the source answered and has no logo for the domain (cache the
 * fallback for good). `unavailable`: rate limit, server error, timeout or no
 * answer at all (says nothing about the domain; ask again later).
 */
export function outcomeForStatus(status: number | undefined): LogoOutcome {
  if (status === 200) return 'ok'
  if (status === undefined || status === 408 || status === 425 || status === 429 || status >= 500) return 'unavailable'
  return 'missing'
}

/** How long a stand-in favicon is shown before the good source is retried. */
export const PROVISIONAL_TTL_MS = 24 * 60 * 60 * 1000

/** How long the good source is left alone after it rate-limits us. */
export const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000

export function provisionalIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs >= PROVISIONAL_TTL_MS
}

/** Cache file names for a domain: the kept logo and the provisional stand-in. */
export function logoCacheNames(domain: string): { kept: string; provisional: string } {
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_')
  return { kept: `${safe}.b64`, provisional: `${safe}.provisional.b64` }
}

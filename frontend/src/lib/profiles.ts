// Pure logic for the multi-profile workspace switcher — no ipc/zustand/DOM,
// unit-tested in the node:test harness. The shapes here mirror the JSON
// contract of `scripts/profile.mjs --json` (docs/superpowers/specs/
// 2026-07-07-multi-profile-design.md §3); the main process passes the CLI's
// output through unmodified.

export interface ProfileCounts {
  scouting: number
  applications: number
  pipeline: number
  reports: number
}

export interface ProfileInfo {
  slug: string
  label: string
  created: string
  active: boolean
  counts: ProfileCounts
}

/** `profile:list` result. Pre-migration repos (no profiles/ dir) report
 *  `{ active: null, profiles: [] }` — every profile surface hides on that. */
export interface ProfileListResult {
  active: string | null
  profiles: ProfileInfo[]
}

/** switch / create result. `ok: false` carries either guard refusals
 *  (one-line reasons, rendered verbatim) or a message. */
export type ProfileMutationResult =
  | { ok: true; active: string; previous?: string }
  | { ok: false; error: string; guardFailures?: string[]; message?: string }

// Slug contract from the spec: ^[a-z0-9][a-z0-9-]{0,31}$, `active` reserved.
export const PROFILE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function isValidProfileSlug(slug: string): boolean {
  return PROFILE_SLUG_RE.test(slug) && slug !== 'active'
}

/** Live-validation copy for the create form. Empty string = valid (or the
 *  field is still empty — nothing to complain about yet). */
export function slugValidationHint(slug: string): string {
  if (!slug) return ''
  if (slug === 'active') return "'active' is reserved"
  if (!PROFILE_SLUG_RE.test(slug)) {
    return 'lowercase letters, digits and hyphens only — must start with a letter or digit, max 32 chars'
  }
  return ''
}

/** Initial letter for the switcher circle (collapsed sidebar + list rows).
 *  Prefers the label; falls back to the slug. */
export function profileInitial(p: { label?: string; slug: string }): string {
  const src = (p.label ?? '').trim() || p.slug.trim()
  return src ? src[0].toUpperCase() : '?'
}

/** Compact counts line for the switcher popover — zero buckets are dropped
 *  so short lists stay short; a profile with nothing in it reads "empty". */
export function formatProfileCounts(counts: ProfileCounts | null | undefined): string {
  if (!counts) return ''
  const parts: string[] = []
  if (counts.scouting) parts.push(`${counts.scouting} scouting`)
  if (counts.applications) parts.push(`${counts.applications} applications`)
  if (counts.reports) parts.push(`${counts.reports} reports`)
  return parts.length ? parts.join(' · ') : 'empty'
}

/** The profiles a switch can target — everything but the active one.
 *  Feeds the CmdK "Switch to profile: …" commands. */
export function switchTargets(profiles: ProfileInfo[]): ProfileInfo[] {
  return profiles.filter(p => !p.active)
}

/** Failure lines to render verbatim (popover + Settings). Guard refusals
 *  win over the generic message; the error code is the last resort. */
export function describeProfileFailure(res: ProfileMutationResult): string[] {
  if (res.ok) return []
  if (res.guardFailures?.length) return res.guardFailures
  if (res.message) return [res.message]
  return [res.error || 'unknown error']
}

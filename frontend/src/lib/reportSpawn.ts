// "Generate report" spawns (Database row popover). Each listing gets its own
// spawn id, so reports for different listings run side by side, each its own
// worker in Activity; a second click on a listing whose report is already
// running is refused by the id (the spawn store keeps one record per id).
// Reports write separate files (reports/tier-N/{Company} - {Role}.md, its
// jds/ archive) and only append to shared TSVs through locked scripts, so
// parallel workers don't collide.

import { slug } from '@/lib/entityId'

/** Spawn ids of report runs all start with this (Activity groups nothing on it; tests do). */
export const REPORT_SPAWN_PREFIX = 'report-'

/** One id per listing: company + role, so the same listing can't run twice at once. */
export function reportSpawnId(entry: { company: string; role: string }): string {
  return `${REPORT_SPAWN_PREFIX}${slug(entry.company)}--${slug(entry.role)}`
}

// Render-only: the listing was already scored by Filter to Database, so this
// run fetches the JD only to write prose. Numbers are copied from
// data/score-history.tsv + data/scouting.md verbatim — no re-scoring, no new
// score-history row.
const REUSE_INSTR =
  'RENDER-ONLY mode: do not re-score. Read the dimensional row from data/score-history.tsv (match by company + role) and the rollup score + tier from data/scouting.md, and copy those numbers verbatim into the report header and dimensional table. Write the prose sections (Role summary, Gaps, Comp, Recommendation, Career path impact) normally from the JD — do not narrate, justify, or comment on the score numbers; treat them as given. Do NOT append a new row to data/score-history.tsv, and never edit data/scouting.md: the app finds the report by its file name ({Company} - {Role}.md).'

/** The `/career-ops scouting …` task for one listing's report. */
export function reportPrompt(entry: { company: string; role: string; url?: string | null }): string {
  const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null
  return url
    ? `/career-ops scouting ${url} — write the per-listing report under reports/tier-N/{Company} - {Role}.md following the Tier-1 deep template in modes/scouting.md § "Full Report Format". ${REUSE_INSTR}`
    : `/career-ops scouting for ${entry.company} — ${entry.role} — write the per-listing report under reports/tier-N/ following the Tier-1 deep template in modes/scouting.md. ${REUSE_INSTR}`
}

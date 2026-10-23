// "Generate report" spawns (Database row popover). Each listing gets its own
// spawn id, so reports for different listings run side by side, each its own
// worker in Activity; a second click on a listing whose report is already
// running is refused by the id (the spawn store keeps one record per id).
// They run as worker kind `report`: the app's eval permissions plus
// reports/tier-4/, since a Blocked or Skip listing gets its report on request.
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

// The listing was already scored by Filter to Database, so the report starts
// from data/score-history.tsv + data/scouting.md. It re-scores only when the
// posting it fetches shows a fact the stored score didn't have (stated pay,
// dates, a requirement), through the normal re-evaluation path; a different
// estimate or reading of the same evidence keeps the stored numbers.
const REUSE_INSTR =
  'START FROM THE STORED SCORES: read the dimensional row from data/score-history.tsv (match by company + role) and the rollup score + tier from data/scouting.md, and use those numbers in the report header and dimensional table. Write the prose sections (Role summary, Gaps, Comp, Recommendation, Career path impact) from the JD. ' +
  'RE-SCORE ONLY ON A NEW FACT: if the posting you fetch states something that differs from what was scored (pay it now gives, start or end dates, duration, required languages, work rights or sponsorship, location, or a requirement the stored score missed), re-score: run node scripts/score-listing.mjs with the corrected input (judged dimensions keep their prior values unless that fact moves them, modes/_shared.md § Re-score anchoring), log it as a re-evaluation (append-score-rows.mjs, then a scouting TSV merged with merge-scouting.mjs, modes/scouting.md § Tracker Entry), write the report from the new numbers in the new tier folder, and add a `**Re-scored:**` line under the header naming the fact, the posting line it comes from, and the old → new Match, Ease and tier; say the same in your final message. ' +
  'A different estimate of something the posting does not state (pay, bonus, living costs) or a different reading of the same evidence is not a new fact: keep the stored numbers and leave the trackers alone. Never edit data/scouting.md directly: the app finds the report by its file name ({Company} - {Role}.md). The user asked for this report, so a Blocked or Skip (T4) listing gets one too, under reports/tier-4/.'

/** The `/career-ops scouting …` task for one listing's report. */
export function reportPrompt(entry: { company: string; role: string; url?: string | null }): string {
  const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null
  return url
    ? `/career-ops scouting ${url} — write the per-listing report under reports/tier-N/{Company} - {Role}.md following the Tier-1 deep template in modes/scouting.md § "Full Report Format". ${REUSE_INSTR}`
    : `/career-ops scouting for ${entry.company} — ${entry.role} — write the per-listing report under reports/tier-N/ following the Tier-1 deep template in modes/scouting.md. ${REUSE_INSTR}`
}

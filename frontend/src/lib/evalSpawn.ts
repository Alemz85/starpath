// Compact-bundle eval spawns — token-cost lever 3 (TODO.md).
//
// Every per-listing scouting evaluation the app fires used to go through the
// `/career-ops …` slash command, which makes each headless worker load the
// full skill router + CLAUDE.md + modes/*.md before it reads a single JD.
// The batch runner already solved this: batch/batch-prompt.md is the compact,
// self-contained eval bundle (parity-pinned against modes/_shared.md by
// scripts/batch-prompt-parity.test.mjs), passed via --append-system-prompt-file
// so the worker starts with the rubric already in its system prompt.
//
// This module routes the frontend's eval spawns through that same bundle:
//   - `claudeEvalArgs` mirrors `claudeArgs` (spawnFormat.ts) but adds
//     `--append-system-prompt-file batch/batch-prompt.md` (path relative to
//     the repo root — shell:spawn runs with cwd = repoPath).
//   - The prompt builders below carry only the per-run task framing (which
//     URLs, which deviations from the bundle's default pipeline); the rubric,
//     data-write contracts, and score-listing.mjs delegation come from the
//     bundle.
//   - The bundle's {{PLACEHOLDERS}} are resolved by the batch runner via sed;
//     the desktop app passes the file verbatim, so every prompt built here
//     states the URL/date/id values in the task message (the bundle documents
//     this contract in its "Unresolved placeholders" note).
//
// Not routed through here: Tailor CV / Draft Application / Prep Application
// and `/career-ops positioning` — those are different modes, not scouting
// evaluations, and still need their own mode files.

import { ipc } from '@/lib/ipc'
import { NON_INTERACTIVE_SUFFIX } from '@/lib/spawnFormat'

/** Repo-relative path to the compact scouting-eval bundle. */
export const COMPACT_EVAL_BUNDLE = 'batch/batch-prompt.md'

export type ClaudeModel = 'sonnet' | 'opus' | 'haiku'

/**
 * Args for a non-interactive Claude eval spawn that loads the compact bundle
 * as its system prompt instead of routing through the `/career-ops` skill.
 * Same flag set as `claudeArgs` otherwise (stream-json for the activity
 * panel, skip-permissions so tool prompts can't hang a headless run).
 */
export function claudeEvalArgs(taskPrompt: string, model?: ClaudeModel): string[] {
  return [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt-file', COMPACT_EVAL_BUNDLE,
    ...(model ? ['--model', model] : []),
    '-p',
    taskPrompt + NON_INTERACTIVE_SUFFIX,
  ]
}

/**
 * Best-effort refresh of the generated CV summary the bundle reads instead
 * of the full user/cv.md (the second half of token-cost lever 3). The script
 * is mtime-gated (regenerates only when user/cv.md or user/profile.yml is
 * newer than the artifact) and zero-token. Fire-and-forget from call sites:
 * it finishes in milliseconds while the Claude CLI is still booting, and the
 * bundle documents the fallback (workers read user/cv.md when
 * batch/cv-summary.md is missing), so a failure here is never fatal.
 */
export function refreshCvSummary(): Promise<void> {
  return ipc.run('node', ['scripts/cv-summary.mjs', '--if-stale'])
    .then(() => undefined)
    .catch(() => undefined)
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Shared prompt fragments ─────────────────────────────────────────────────

/** Supplies the values the bundle's unresolved placeholders would carry. */
function preamble(batchId: string, today: string): string {
  return (
    'Run the scouting-evaluation pipeline defined in the system prompt (the compact eval bundle). ' +
    `Its placeholders are unresolved in this desktop path — use these values: Date: ${today}. Batch ID: ${batchId}. ` +
    'No pre-fetched JD file exists; fetch each JD from its URL (Playwright if available, else WebFetch). '
  )
}

// Compact restatement of modes/pipeline.md § Step 2c (relevance gate) +
// § Step 2c.1 (multi-variant collapse), so inbox/batch triage doesn't need to
// load the mode file. Criteria are generic system rules — user specifics
// (archetypes, red flags, reachable set) are read from user/* at run time.
const RELEVANCE_GATE =
  'apply the relevance gate BEFORE scoring — DISCARD a listing if ANY of: ' +
  '(a) off-archetype: its core day-to-day maps to none of the archetypes in user/_profile.md ' +
  '(quota-carrying sales, pure support, pure logistics/delivery, clinical, legal, pure software engineering, ' +
  'pure finance/audit all count as off-archetype unless named in the archetypes); ' +
  '(b) wrong seniority: 5+ YoE required, or Senior/Lead/Principal/Director/Manager-with-reports title ' +
  '(internships, graduate programmes, and 0-3 YoE roles stay in); ' +
  '(c) geo-locked outside the candidate’s reachable set; ' +
  '(d) excluded domain (defense, oil & gas, gambling, adult, MLM, predatory lending, tobacco — unless opted in via user/_profile.md); ' +
  '(e) visa-locked (hard citizenship/clearance walls; soft visa friction is an Ease of Entry penalty, not a discard); ' +
  '(f) disclosed poverty wage (would score 1 on savings power); ' +
  '(g) matches a stated red flag in user/_profile.md. ' +
  'Borderline = DISCARD: the bar for inclusion is a one-sentence, JD-cited reason why the role fits an archetype. ' +
  'Move each discard to the "## Filtered Out" section of data/pipeline.md as ' +
  '`- [!] FILTERED | URL | Company | Role | reason` — never score it, never write score-history/scouting rows for it. ' +
  'If one company posts the same intake under many sub-flavor titles (≥6 surviving URLs for one ' +
  'company+archetype+level+region group), collapse them and score ONE master, noting the variant count. ' +
  'The survivor count is a result, not a target — flag it in the run summary if <5% or >80% survive. '

const NO_REPORT_DEVIATION =
  'DEVIATION — score only: skip the bundle’s Step 5 entirely (write NO report file under reports/); ' +
  'the report column in the scouting TSV is `—`. All Step 6 data writes still apply. '

const MERGE_STEP =
  'After the last evaluation, run `node scripts/merge-scouting.mjs` to fold the scouting TSVs into ' +
  'data/scouting.md (never edit data/scouting.md or data/applications.md directly). '

// ─── Prompt builders ─────────────────────────────────────────────────────────

/**
 * AddListingModal fast path: score one pasted URL into the Database, no
 * prose report. (Reports are opt-in later from the Database row popover.)
 */
export function scoreOnlyEvalPrompt(url: string, today: string = todayISO()): string {
  return (
    preamble('add-listing', today) +
    `Evaluate this single listing: ${url}. ` +
    NO_REPORT_DEVIATION +
    MERGE_STEP +
    'If the URL is queued in data/pipeline.md, mark it [x] done there. ' +
    'The user will trigger a prose report later from the Database if the score justifies it.'
  )
}

/**
 * Pipeline-inbox triage for one URL: title filters + relevance gate first,
 * then a score-only evaluation if it survives.
 */
export function inboxEvalPrompt(url: string, today: string = todayISO()): string {
  return (
    preamble('inbox-eval', today) +
    `Triage this single inbox URL: ${url}. ` +
    'First apply the user/portals.yml title filters and dedup against data/dedup-index.tsv, then ' +
    RELEVANCE_GATE +
    'If it survives, evaluate it through the system-prompt pipeline. ' +
    NO_REPORT_DEVIATION +
    MERGE_STEP +
    'Finally mark the URL [x] in data/pipeline.md (or leave it in Filtered Out if discarded).'
  )
}

/**
 * "Filter to Database": gate + score-only eval for every pending inbox URL.
 * Nothing lands under reports/ — the dimensional row in the Database is the
 * entire output of this path.
 */
export function filterAllPrompt(today: string = todayISO()): string {
  return (
    preamble('pipeline-filter', today) +
    'Process EVERY pending URL in data/pipeline.md, one listing at a time: ' +
    '(1) apply the user/portals.yml title filters and dedup against data/dedup-index.tsv; ' +
    '(2) ' + RELEVANCE_GATE +
    '(3) evaluate each SURVIVING listing through the system-prompt pipeline. ' +
    NO_REPORT_DEVIATION +
    '(4) mark each scored URL [x] in data/pipeline.md. ' +
    MERGE_STEP +
    'Survivors land in the Database with a meaningful 1-10 score; discards stay auditable in Filtered Out.'
  )
}

/**
 * "Generate top 5 reports": gate + score everything, then write the full
 * T1-depth report for only the 5 highest-scoring survivors — the user chose
 * few deep reports over many shallow ones.
 */
export function top5ReportsPrompt(today: string = todayISO()): string {
  return (
    preamble('pipeline-top5', today) +
    'Process EVERY pending URL in data/pipeline.md: ' +
    '(1) apply the user/portals.yml title filters and dedup against data/dedup-index.tsv; ' +
    '(2) ' + RELEVANCE_GATE +
    '(3) evaluate each SURVIVING listing through the system-prompt pipeline, but DEFER Step 5: ' +
    'write the score-history + report-summaries rows and the scouting TSV for ALL survivors first. ' +
    '(4) Identify the 5 highest-scoring survivors by Overall; for those 5 ONLY, write the per-listing report ' +
    'under reports/tier-{N}/{Company} - {Role}.md at FULL T1 depth (Role summary + Gaps and opportunities + ' +
    'Comp & demand + Recommendation + Career path impact) regardless of the entry’s actual tier — ' +
    'the user chose 5 deep, defensible reports over many shallow ones. ' +
    'Remaining survivors stay scored with no prose report (report column `—`). ' +
    '(5) Mark all scored URLs [x] in data/pipeline.md. ' +
    MERGE_STEP
  )
}

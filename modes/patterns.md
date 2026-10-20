# Mode: patterns -- Rejection Pattern Detector

## Purpose

Analyze all tracked applications to find patterns in outcomes and surface actionable insights. Identifies what's working (archetypes, remote policies, score ranges) and what's wasting time (geo-restricted roles, stack mismatches, low-score applications).

**Two complementary lenses:**

1. **Outcome patterns** (default) — reasons over *outcomes* in `data/applications.md` (Applied → Rejected → Offer …). Answers "why are applications failing?". Needs ≥5 entries that have progressed beyond `Evaluated`.
2. **Targeting intelligence** (`--scouting`) — reasons over the *scouting landscape* in `data/score-history.tsv` (every evaluation's archetype + dimension fingerprint + Want / Ease / verdict + eligibility). Answers "where am I finding strong matches, and what's dragging the rest down?". **Works from day one** — it needs no outcomes, only evaluations, so it's the right lens early in a search when `applications.md` is still thin.

Pick the lens that matches the question. "Why am I getting rejected?" → outcome lens. "How do I sharpen targeting / what should I scan for / where are my best matches?" → `--scouting`. When outcome data is too thin (the default lens returns an `error`), fall back to `--scouting` — `score-history.tsv` is almost always populated.

## Inputs

- `data/applications.md` — Application tracker (outcome lens)
- `data/score-history.tsv` — Per-evaluation score log (targeting lens, `--scouting`)
- `reports/` — Individual evaluation reports
- `user/profile.yml` — User profile (for recommendation context)
- `user/_profile.md` — User archetypes and framing
- `user/portals.yml` — Portal config (for filter update recommendations)

## Minimum Threshold

Before running analysis, check: does `data/applications.md` have at least 5 entries with status beyond "Evaluated" (i.e., Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP)?

If not, tell the user:
> "Not enough data yet -- {N}/5 applications have progressed beyond evaluation. Keep applying and come back when you have more outcomes to analyze."

Exit gracefully.

## Step 1 — Run Analysis Script

Execute:

```bash
node scripts/analyze-patterns.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Total entries, date range, analysis date, counts by outcome |
| `funnel` | Count per status stage (evaluated, applied, interview, offer, etc.) |
| `scoreComparison` | Avg/min/max score per outcome group (positive, negative, self_filtered, pending) |
| `archetypeBreakdown` | Per-archetype: total, positive, negative, self_filtered, conversion rate |
| `blockerAnalysis` | Most frequent hard blockers: geo-restriction, stack-mismatch, seniority, onsite |
| `remotePolicy` | Per-policy bucket: total, positive, negative, conversion rate |
| `companySizeBreakdown` | Per-size bucket: startup, scaleup, enterprise |
| `scoreThreshold` | Recommended minimum score + reasoning |
| `techStackGaps` | Most frequent tech gaps in negative outcomes |
| `recommendations` | Top 5 actionable items with reasoning and impact level |
| `rejections` | **Read from the status log, not from status text** (`scripts/lib/outcome-stats.mjs`): `rejections`, `afterProgress` (rejected after a reply or interview), `byStage` (where they happened: the explicit stage, else the status rejected from), `timing` (fast ≤ 2 days after sending / normal / late > 30 days, with its gated `medianDays` and `fastShare`), and per-slice rejection counts (`slices.easeBand / archetype / city / companySize`) each with its `sample` |

If the script returns `error` (fewer than 5 applications beyond Evaluated), display the error message, then still show the `rejections` block: it is always present and states its own gates.

**Rejection questions ("why am I getting rejected?", "am I hitting ATS filters?") are answered from `rejections` and from `node scripts/outcomes.mjs --chat`** (its why table: one row per application with stage, days, materials and the user's notes). The rules of `docs/scoring-statistical-design.md` § 3.7 apply: below a gate, give the counts and describe the applications; never a rate or a pattern. A fast rejection is *consistent with* an automated screen, not proof of one. A rejection that matches a low Ease score is not a finding.

## Step 2 — Generate Report

Write the report to `reports/pattern-analysis-{YYYY-MM-DD}.md`.

### Report Structure

```markdown
# Pattern Analysis -- {YYYY-MM-DD}

**Applications analyzed:** {total}
**Date range:** {from} to {to}
**Outcomes:** {positive} positive, {negative} negative, {self_filtered} self-filtered, {pending} pending

---

## Conversion Funnel

Show each status with count and percentage of total. Use a simple table:

| Stage | Count | % |
|-------|-------|---|
| Evaluated | X | X% |
| Applied | X | X% |
| ... | | |

## Score vs Outcome

| Outcome | Avg Score | Min | Max | Count |
|---------|-----------|-----|-----|-------|
| Positive | X.X/5 | X.X | X.X | X |
| Negative | ... | | | |
| Self-filtered | ... | | | |
| Pending | ... | | | |

## Archetype Performance

Table with each archetype, total applications, positive outcomes, conversion rate.
Highlight the best-performing archetype and the worst.

## Top Blockers

Frequency table of recurring hard blockers (geo-restriction, stack-mismatch, etc.).
Note the percentage of all applications affected by each.

## Remote Policy Patterns

Table showing conversion rate by remote policy bucket (global, regional, geo-restricted, hybrid/onsite).

## Tech Stack Gaps

List of most common missing skills in negative/self-filtered outcomes with frequency.

## Recommended Score Threshold

State the data-driven minimum score and reasoning.

## Recommendations

Number the top recommendations (from the script output). For each:
1. **[IMPACT]** Action to take
   Reasoning behind the recommendation.
```

## Step 3 — Present Summary

Show the user a condensed version with:
1. One-line stat summary (X applications, Y% applied, Z% positive outcome)
2. Top 3 findings (most impactful patterns)
3. Link to full report

Example:
> **Pattern Analysis Complete** (24 applications, Apr 7-8)
>
> Key findings:
> - 9 of 11 exactly dated rejections came within 2 days of sending (moderate confidence) -- consistent with automated screening; 7 of them were roles asking for a language the CV doesn't list
> - Regional/global remote roles: 6 of 10 got a reply (moderate); geo-restricted: 0 of 7 -- withheld (8 needed), but every one was a US/Canada-only posting
> - Nothing that scored below Solid got a reply (counts only: 0 of 6)
>
> Full report: `reports/pattern-analysis-2026-04-08.md`

## Step 4 — Offer to Apply Recommendations

Ask the user if they want to act on any recommendations:

> "Want me to apply any of these recommendations? I can:
> - Update `user/portals.yml` to filter out geo-restricted roles
> - Set a score threshold in `_profile.md` for PDF generation
> - Adjust archetype targeting based on what's converting
>
> Just say which ones, or 'all' to apply everything."

If the user agrees:
- For portal filter changes: edit `user/portals.yml`
- For profile/archetype changes: edit `user/_profile.md` (NEVER `_shared.md`)
- For score threshold: add to `user/profile.yml` under a `patterns` key

## Targeting Intelligence (`--scouting`)

When the user wants to sharpen *targeting* rather than diagnose *outcomes* — or whenever the outcome lens errors out for lack of data — run:

```bash
node scripts/analyze-patterns.mjs --scouting          # JSON
node scripts/analyze-patterns.mjs --scouting --summary # human-readable table
```

This reads `data/score-history.tsv` (not `applications.md`) and emits:

| Key | Contents |
|-----|----------|
| `metadata` | Evaluations analyzed, date range, analysis date |
| `landscape` | Avg/median Want and Ease, verdict mix (`go` / `stretch` / `growth` / `solid` / `thin` / `skip` / `blocked`), `wastedShare` (% of scored evals landing `skip`), eligibility mix (share Blocked / amber by check) |
| `archetypePerformance` | Per archetype (labels de-duplicated): count, avg Want, avg Ease, `actionableRate` (% `go` + `stretch` + `solid`), `share` of all evals |
| `dimensionDrag` | The judgment dimensions (Want motivators + hygiene, Ease dims), **weakest first** — the top entry is the systemic blocker most often holding Want or Ease down, with `lowShare` (% of evals where it scores ≤4). Blocked rows are excluded |
| `cityExposure` | Where `go` / `stretch` / `solid` matches geographically cluster (from the posting `location`) |
| `recommendations` | Concrete targeting moves: lean into the strongest archetype, pull back on the weakest, fix the dragging dimension, raise the bar if too much effort is wasted |

**How to read it for the user:**
- The **best archetype** (top of `archetypePerformance` with `count ≥ 4`) is what to source MORE of — feed it into scan keywords in `user/portals.yml`.
- The **weakest dimension** (top of `dimensionDrag`) is the one targeting fix with the most leverage. A low `Experience bar` means the user keeps evaluating roles above their level (tighten seniority filters); a low `Skills Match` means a recurring stack/skill gap; a low `Role content` means the scanner surfaces titles whose day-to-day isn't the target work (add negative keywords); a low `Brand Value` means the companies surfacing are weak (add stronger targets to portals).
- A large **Blocked share** on one eligibility check (e.g. `language`, `work_auth`) means the scanner keeps pulling roles the user can't take — tighten location / language filters in `user/portals.yml` before evaluation effort lands on walls.
- A high `wastedShare` means the scan is surfacing too many `skip` roles — tighten the upstream filters so evaluation effort isn't spent on roles that can't reach an actionable verdict.

Recommendations from `--scouting` map to the same Step 4 actions below (portal keyword changes, archetype targeting, score threshold), so offer to apply them the same way.

## Outcome Classification

For reference, outcomes are classified as:

| Status | Outcome |
|--------|---------|
| Interview, Offer, Responded, Applied | **Positive** (invested effort or got traction — *not* "it worked": for that, use `rejections` and `scripts/outcomes.mjs`, which read the dated history) |
| Rejected, Discarded | **Negative** (company said no or offer closed) |
| SKIP, NO APLICAR | **Self-filtered** (user decided not to apply) |
| Evaluated | **Pending** (no action taken yet) |

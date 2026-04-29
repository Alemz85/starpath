# Mode: scouting — Single Evaluation Mode

## Purpose

`scouting` is the system's **only evaluation mode**. Given one listing — JD, URL, or a row already in scan data — it produces a scored report. The report says how the role rates against the user's archetypes, where the gaps are, what the comp situation looks like, and what the role does for the user's career arc.

This mode does NOT do CV tailoring (`modes/pdf.md`), interview prep (`modes/interview-prep.md`), or live application drafting (`modes/apply.md`). Those are separate per-listing skills the user triggers when they want them.

The user's `phase` (`user/profile.yml → phase`, values `exploring` or `applying`) controls the CF/AF rollup weights — `exploring` uses 70/30 (reachability dominates), `applying` uses 60/40 (ambition weighs more). It does NOT change the report shape — every evaluation produces the same report structure.

## Inputs

- `user/cv.md` (read-only — never tailored during evaluation)
- `modes/_shared.md` — the **Dimensional Scoring Framework** section is the source of truth for dimensions, rubrics, rollup formulas, and TSV columns. Always read it before scoring.
- `user/_profile.md` (archetypes, narrative, location policy, comp targets, dream companies)
- `user/profile.yml` (candidate identity, `phase` weights)
- The listing: JD text, URL, or a row from scan data
- `data/score-history.tsv` (append-only log; see Data Layer below)

## Pre-eval Dedup

Dedup reads `data/dedup-index.tsv` (columns: `company_normalized`, `role_normalized`, `last_seen_date`) — NOT the full `data/scouting.md` or `data/applications.md`. Those markdown files are still the source of truth and the merge scripts (`scripts/merge-scouting.mjs`, `scripts/merge-tracker.mjs`) keep the index in sync automatically.

**Staleness gate (run BEFORE reading the index):**

Compare the maximum `last_seen_date` in `data/dedup-index.tsv` against the maximum `Date` column in `data/scouting.md` AND `data/applications.md`. If either source-of-truth file has a date newer than the index max, the index is stale (likely from an out-of-band manual edit).

**Halt the evaluation** and tell the user:

> Dedup index is stale (max index date {INDEX_DATE} < max scouting/applications date {SOURCE_DATE}). Run `node scripts/rebuild-dedup-index.mjs` and then re-run this evaluation.

Do NOT proceed with stale dedup data.

**Lookup:**

Compute the listing's entity_id (see `frontend/src/lib/entityId.ts`) and look it up in `data/dedup-index.tsv` (which stores `entity_id` plus the legacy `(company_normalized, role_normalized)` columns for fuzzy fallback). For the full set of states that a hit can land in (DUPE / REPOST / CROSS-PORTAL ALIAS / 6+ months STALE), see `modes/pipeline.md` § Step 2b — the same logic applies to single-listing scouting evaluations.

In short: when an entity_id match hits with `last_seen_date < 6 months`, do not generate a duplicate report. The pipeline mode determines whether to refresh the URL (REPOST), record an alias, or skip silently. **6+ months old hits surface in `## Needs re-evaluation` and require explicit user opt-in** — auto-rescoring would burn tokens on entities the user may no longer care about.

## The Scoring Model

Use the **Dimensional Scoring Framework** defined in `modes/_shared.md`. Read that section first — it is the single source of truth. Do not redefine dimensions here.

The framework gives you, for every listing:
- **6 numeric scoring dimensions** (1-10, half-steps allowed), three rolling up into **Current Fit** and three into **Aspirational Fit**
- **Sales-Trap Risk** (scored 1-10, displayed for decision-support but NOT in the AF rollup)
- **3 numeric context dimensions** + **1 text context dimension** (Best Cities, Salary Adj for City, Work-Life Balance, Best-fit Early-career Roles)
- An **Overall** rollup: `Current Fit × {CF_weight} + Aspirational Fit × {AF_weight}` — weights come from `phase` (see `_shared.md` § Overall).

The dimensional table is the load-bearing artifact. The prose around it is short.

### Required pre-scoring reads

Before assigning any scores, you MUST have read:
1. `user/cv.md` — for Skills Match anchoring
2. `user/_profile.md` — for archetype framing, dream-company list, location policy, comp targets, Score Calibration adjustments
3. `modes/_shared.md` § Dimensional Scoring Framework — the rubric AND the **Reasoning column quality bar** subsection that defines what evidence must appear in each reasoning cell.

### Pre-scoring JD audit (run BEFORE filling the dimensional table)

Skim the JD body for ~30 seconds and write down the four signals below in scratch. The reasoning cells in the dimensional table will draw directly from this audit — every cell that doesn't trace back to one of these is an *opinion*, not an evaluation. Skipping the audit is the failure mode that produces "competitive but reachable" cells with no evidence.

| Signal | What to extract | Example |
|--------|-----------------|---------|
| **Hard gates** | YoE bars, prior-background requirements, language minimums, citizenship/visa requirements, certifications. Quote the JD verbatim. | *"Previous working experience or internship at top-tier IB/PE/strategy consultancy/fast-growing tech"* |
| **Brand tier** | Place the company on the Brand Value 1-10 scale (`_shared.md` § per-step anchors). Top-100 / unicorn / Big-4 / regional / unknown. | Revolut → Brand Value 8 → Ease of Entry penalty −3 |
| **Comp disclosure** | Disclosed figure or range, OR `[undisclosed]`. Note the city threshold from `_profile.md` you'll score against. | `£45-55K` London, threshold £38K → midpoint = +29% above → 10 |
| **Geo / remote / visa** | Named office cities, remote policy, work-rights gating. | "Remote / multi-hub London-Barcelona-Lisbon" |

If any signal is missing from the JD, write `[not stated]` rather than guessing. The reasoning cells will then say `[no gate stated]` honestly instead of inventing one.

**The audit's job is traceability, not harshness.** Whatever scores the calibration math produces from the audit signals are the right scores — the audit doesn't bias toward lower numbers, it just makes sure each number can be defended by pointing at specific JD lines. A 7/10 Ease of Entry with the audit's hard-gate quote and a named brand-tier adjustment in the reasoning cell is fine. The same 7/10 with reasoning that says "competitive but reachable" is the failure mode, regardless of whether 7 was the right answer or not.

### Salary Adj for City — comp cache check

Follow the lookup flow defined in `modes/_shared.md` § Comp cache. On a cache miss in `exploring` phase, score from JD disclosure + city bands in `_profile.md` (don't trigger a WebSearch — keep evaluation cheap). In `applying` phase, run the WebSearch and write back to the cache. If the JD itself is silent and the cache misses, score 5 with `[undisclosed]` reasoning.

### Calibration hooks

- **Entry-level lens:** Apply the Score Calibration adjustments from `_profile.md` (e.g., entry-level comp bands, mentorship bonus, brand bonus for CEMS-adjacent firms).
- **Location policy:** The Best Cities context dimension reads from `_profile.md` → Your Location Policy. A preferred-cities top hit floors at 9.0; a non-preferred EU city floors at 6.0; outside EU drops to 2.0-3.0.
- **Dream-company floor:** If the company is in the user's dream list (`user/profile.yml` → `target_roles.dream_companies` or `_profile.md` → Dream Companies), floor **Brand Value at 10** AND **Aspirational Fit at 8.0** regardless of function match. The user wants their foot in the door.
- **Sales-Trap Risk reminder:** Sales-Trap Risk is scored (10 = well protected, 1 = high risk) and displayed in the table, but is **not included in the Aspirational Fit rollup**. It serves as a decision-support signal — a score of 1-2 should be flagged prominently as a red flag.

## Output Behavior — Tiered by Current Fit

The report format depends on where Current Fit lands. **Always compute the full dimensional table first**, then choose the tier — the same table appears in every tier so positioning can read it.

### Tier 1 — Current Fit ≥ 9.0 (or uniform fingerprint override: all 6 dims ≥ 8 AND both rollups ≥ 8.0)

Generate a **full report** following the format in the "Full Report Format" section below.

Surface to the user with the recommendation: *"Strong match — full evaluation ready. If you want a tailored CV, run `/career-ops pdf` against the URL. If you're ready to actively apply, click Apply in the Database to move it to your active applications, then click Prep Application for interview intel."*

### Tier 2 — Current Fit ≥ 7.0 (worth noting) AND Ease of Entry > 4

Generate a **short summary report**. Same dimensional table, lighter prose.

Verdict phrasing scales with Current Fit:
- CF 8.0–8.9 → "apply with prep"
- CF 7.0–7.9 → "apply if pipeline thin"

Both write `Tier: T2` to scouting.md and score-history.tsv — there is no T2-high sub-tier.

```markdown
# Scouting: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Mode:** scouting
**URL:** {url or "—"}
**Location:** {city, country, remote policy}
**Archetype:** {detected}
**Current Fit:** {X.X}/10
**Aspirational Fit:** {X.X}/10
**Overall:** {X.X}/10
**Tier:** T2

## Dimensional scoring

(use Standard report block format from modes/_shared.md § Standard report block format — do not reprint the table here)

## Fit / gaps
{2 bullets max: one on strongest match, one on biggest gap}

## Verdict
{One line — "Apply with prep" (CF 8.0+) | "Apply if pipeline thin" (CF 7.0–7.9) | "Track company only"}

## Path forward
{ONE sentence with a concrete next step. Examples:
 - "Apply now; lead with the Sabadell capstone as the FS-strategy proof point."
 - "Apply to the Rev-celerator internship first to satisfy this role's prior-background gate, then re-evaluate next cycle."
 - "Track only — re-evaluate if Italian language progresses past B2."
 No multi-step plans. No bullets. One sentence.}
```

### Tier 3 — Current Fit < 7.0 AND Aspirational Fit ≥ 7.0 (growth target), OR Ease of Entry ≤ 4 gate (see `_shared.md`)

Generate a **Gap & Growth Report**. This is the most valuable tier for a candidate who's not yet competitive — they can't get the job today, but it's exactly where they want to go. The report is a roadmap, not a rejection. The dimensional table is still required at the top.

**Exception — language wall:** if the binding gap is a foreign-language requirement the candidate doesn't have (and isn't learning), force Tier 4 instead. See `_shared.md` § "Language-barrier exception" for the rule. Language acquisition is a multi-year relocation/lifestyle decision, not a 6-12 month skill build, so a Gap & Growth roadmap would be misleading.

Tier 3 is the MOST COMPACT report format — ~25-30 lines total. The mental model is `T1 > T2 > T3 > T4(none)`: each tier is smaller than the one above it. The dimensional table is the load-bearing artifact; prose stays minimal.

```markdown
# Gap & Growth: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Mode:** scouting (growth target)
**URL:** {url or "—"}
**Location:** {city, country, remote policy}
**Archetype:** {detected}
**Current Fit:** {X.X}/10
**Aspirational Fit:** {X.X}/10
**Overall:** {X.X}/10

## Dimensional scoring

(use Standard report block format from modes/_shared.md § Standard report block format — do not reprint the table here)

## Gaps and opportunities

- **Gap:** {1 bullet — the single biggest CF blocker + dimension}
- **Revisit when:** {One line with concrete trigger}
```

### Tier 4 — Both scores low (skip)

Current Fit < 7.0 AND Aspirational Fit < 7.0 → **skip**. Do NOT write a report. **You still must compute the full dimensional table** so it can be logged to `data/score-history.tsv` (see Data Layer). Add a one-line entry to the scouting tracker (`data/scouting.md`) with tier `T4`, report `—`, and a note like "T4 skip — below threshold", and move on.

## Full Report Format (Tier 1)

The Tier 1 report leads with the dimensional table — it's the load-bearing artifact, so it appears immediately after the header. Everything else (role summary, gaps, comp, recommendation, career path) is short and grounded in the table.

```markdown
# Scouting: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Mode:** scouting (full)
**URL:** {url}
**Location:** {city, country, remote policy}
**Archetype:** {detected — primary + optional secondary}
**Current Fit:** {X.X}/10
**Aspirational Fit:** {X.X}/10
**Overall:** {X.X}/10

## Dimensional scoring

(use Standard report block format from modes/_shared.md § Standard report block format — do not reprint the table here)

## A) Role summary

| Field | Value |
|-------|-------|
| Archetype | {primary archetype, plus secondary if hybrid} |
| Domain | {industry / sector / vertical — e.g., "Q-commerce / on-demand delivery"} |
| Function | {what the role actually does day-to-day — e.g., "Rotational analyst across 6 named tracks"} |
| Seniority | {IC1 / IC2 / Manager / etc. + employment_type — e.g., "IC1 — entry-level, full-time permanent"} |
| Remote | {full / hybrid / onsite + city detail} |
| Team size | {if mentioned in JD; else "—"} |
| TL;DR | {1 sentence — what this role IS, in plain language} |

## B) Gaps and opportunities

For each gap that's actually closeable on a 6-12 month horizon, name it concretely, cite the JD evidence, and say how to close it. Skip generic advice — every bullet should be actionable for THIS candidate against THIS role. Max 3 bullets.

- **{Gap name}** — JD requires {verbatim quote}; CV doesn't show it. **Close in {X weeks/months}** via {specific action: cert / project / proof point}.
- **{Gap 2}** — {same shape}.

If there are no meaningful gaps, write a single line: *"No structural gaps — the candidate's profile maps directly onto the JD's stated requirements."*

## C) Comp & demand

One row. If estimated, mark it. Source = whichever the data came from (JD disclosure, comp-cache, Glassdoor estimate, etc.).

| Source | Band | Note |
|--------|------|------|
| {JD disclosed / Glassdoor estimate / comp-cache (cached YYYY-MM-DD)} | {€XX–YYK or €X/mo} | {1 line: vs. user threshold + posting freshness signal} |

## D) Recommendation

{2-3 lines max. The verdict (act / monitor / skip), the single biggest lever or blocker, and one growth pointer. No sub-sections, no bullets.}

## E) Career path impact

**Read `user/profile.yml → profile.dream_companies` at render time.**

{4 structured lines — no prose preamble:}
- **Accelerates toward:** {which dream targets / archetypes}
- **Detours from:** {which targets — often "none"}
- **Optionality:** {what exits/pivots this opens or closes}
- **Key gap to close:** {single most impactful skill/experience gap and a directional action}
```

**Expected shape of a Tier 1 report:** Header + Dimensional scoring + A (Role summary table, 7 rows) + B (Gaps, ≤3 bullets) + C (Comp & demand, 1 row) + D (Recommendation, 2-3 lines) + E (Career path impact, 4 lines). Net length ~70-90 lines.

**Do NOT include in Tier 1 reports:**
- "Match with CV" requirement-by-requirement table — the dimensional table's Skills Match cell + the Gaps section already covers it
- "Level and Strategy" prose paragraph — the dimensional table's Ease of Entry + Strategic/Analytical Fit cells already capture it
- "Personalization Plan" CV/LinkedIn changes — that's `modes/pdf.md`'s job
- "Interview Plan" with STAR stories + case study + red-flag questions — that's `modes/interview-prep.md`'s job
- "Posting Legitimacy" assessment — not part of the scoring model
- "Extracted keywords" list — token waste, not actionable
- A closing "## Notes" section — token waste, the Recommendation already says what's needed
- "Hard constraint" callouts, "What this report is good for" meta-justification, "What to do this week" tactical to-do lists, calibration meta-notes about `_profile.md` updates

The reader of the report has the dimensional table to anchor everything else. Each prose section earns its place by adding something the table doesn't already say.

## Multi-city role deduplication

When the pipeline feeds you **multi-city postings of the same role** (same JD copy, different cities — e.g., Trade Republic Analytics Engineer posted separately for Berlin and Paris), **generate a single "master" report at the highest-priority city and a one-line city-comparison delta for each additional city.** Do NOT produce two separate full reports.

**Detection:** same company + same role title + identical responsibilities/requirements section in the JD + different `office` / `location` field. The `Best Cities` and `Salary Adj for City` context dimensions are the only dimensions that vary between the variants; everything else in the fingerprint is the same.

**How to apply:**
1. Score the role once using the highest-priority city variant (defined by `_profile.md` → location policy, ordered preferred-cities list).
2. Write ONE report at `reports/tier-{N}/{Company} - {Role}.md` — the master.
3. For each additional city variant, append a one-line delta to the master report under a `## City variants` section:
   ```
   - **Paris variant:** Best Cities 6/10 (vs 8/10 Berlin), Salary Adj 6/10 (vs 8/10 Berlin); otherwise identical. Same tier.
   ```
4. Write ONE scouting tracker TSV entry referencing the master report; in the Notes column, list the other cities (e.g., `"Multi-city: Berlin (primary), Paris"`).
5. Log ONE row to `data/score-history.tsv` for the master. If the user wants per-city trajectory later, positioning mode can parse the `## City variants` section.

**Edge case:** if the role variants differ in more than just location (e.g., one has a language requirement the other doesn't, or responsibilities actually differ between offices), treat them as separate roles and score each independently.

## Data Layer — Score History Logging

**EVERY evaluation must append a row to `data/score-history.tsv`**, regardless of tier (including Tier 4 skips). This is the trajectory log.

The TSV format and column order are defined in `modes/_shared.md` § "Logging to data/score-history.tsv". Use exactly that format — do NOT invent columns here.

For evaluation rows:
- `mode` → `scouting` (kept for backward compatibility with rows written before mode consolidation; new rows always use this value)
- `tier` → `full` | `short` | `growth` | `skip`
- `source` → `url` | `paste` | `scan` | `pipeline`

The numeric dimension columns must be filled even for Tier 4 skips — that's the whole point of logging skipped listings (so positioning can see what the user *isn't* a fit for and why).

Also fill the 4 metadata columns: `location`, `employment_type`, `duration`, `salary_raw` (see `_shared.md` for definitions). Use `n/d` for any that are unknown.

## Report Summary Cache

After writing the report (or recording a T4 skip), also append a row to `data/report-summaries.tsv`:

```
{date}	{company}	{role}	{archetype}	{tier}	{overall}	{cf}	{af}	{key_gaps}	{verdict_one_line}
```

- `tier` — `T1` | `T2` | `T3` | `T4`
- `key_gaps` — pipe-separated list of dimensions scored ≤ 5/10, max 3 (e.g. `EoE|Skills Match`). Use `—` for T1.
- `verdict_one_line` — the 1-sentence recommendation from the report (e.g. `Apply with prep — brand + growth strong, EoE gap closeable by graduation`). For T4 skips: `T4 skip — {reason}`.

This lets `positioning` mode read one lightweight TSV instead of opening 70+ full report files.

## Tracker Entry

Evaluations are landscape-mapping inventory by default. They live in **`data/scouting.md`** — separate from `data/applications.md` — so the active-application flow stays uncontaminated by exploratory evaluations. The user clicks "Apply" in the Database (or runs `node scripts/promote-to-applications.mjs <num>`) to move an entry into the active flow.

Write a TSV entry to `batch/scouting-additions/{num}-{company-slug}.tsv` (let `scripts/merge-scouting.mjs` handle the merge into `data/scouting.md`). **11 tab-separated columns** (no status field — tier replaces status here):

```
{num}	{date}	{company}	{role}	{overall}/10	{tier}	{cf}/{af}	[{num}](reports/tier-{N}/{Company} - {Role}.md)	{deadline}	{promotion_hint}	{one-line tier summary}
```

**Report file path:** reports live in **`reports/tier-{N}/{Company} - {Role}.md`** where `{N}` is the tier digit (1, 2, 3, or 4). Tier 4 skips use `—` for the report column and write nothing to disk.

Column order:
1. `num` — sequential number (integer)
2. `date` — YYYY-MM-DD
3. `company` — short company name
4. `role` — job title
5. `score` — overall weighted score, `X.X/10`
6. `tier` — `T1` | `T2` | `T3` | `T4`
7. `cf_af` — `{current}/{aspirational}`, e.g. `8.3/7.5`
8. `report` — markdown link `[num](reports/tier-{N}/{Company} - {Role}.md)` or `—` for T4 skips
9. `deadline` — application deadline as stated in the JD (e.g. `2026-06-30`, `Rolling`, `n/d`). Use `n/d` if not stated.
10. `promotion_hint` — `READY` for Tier 1 hits (flags them for the user to promote to active applications), empty otherwise
11. `notes` — one-line tier summary

- **PDF:** Evaluation never auto-generates a PDF. CV / PDF generation is a separate, manual operation via `/career-ops pdf` (or the Database popover's "Tailor CV" button).
- **T4 skips:** still write the TSV with tier `T4`, report `—`, deadline `n/d`, and a short note.
- **Promotion:** Tier 1 hits get `READY` in column 10. The user runs `node scripts/promote-to-applications.mjs <num>` (or clicks Apply in the Database) to move an entry into `data/applications.md` with status `Evaluated`. The scouting row stays in `data/scouting.md` as a historical record (its Promotion Hint flips to `PROMOTED-{app_num}`).

## File Naming

Report files use a human-readable `{Company} - {Role}.md` naming convention:

```
reports/tier-{N}/{Company} - {Role}.md
```

Where `{N}` is the tier (1, 2, 3, or 4). Tier 4 skips do NOT write a file — they only get a one-line entry in `data/scouting.md` with `—` in the report column.

**Examples:**
- `reports/tier-1/Celonis - Intern Technology Consultant.md`
- `reports/tier-2/PwC - Customer Data Analyst.md`
- `reports/tier-3/Datadog - GTM Strategy-Operations Associate.md`

The tier subfolder layout makes it trivial to browse just the Tier 1 hits when deciding what to promote to active applications (`reports/tier-1/`), or scan the candidate-pool shape at a glance (`ls reports/tier-*` shows the distribution).

## Phase weights

`user/profile.yml → phase` controls the CF/AF rollup weights only — it does NOT change the report shape, the tier rules, or the data layout. Both phases produce identical report structures with identical dimensional tables.

- `phase: exploring` (default) — CF×0.70 + AF×0.30. Weights reachability higher; appropriate for landscape mapping.
- `phase: applying` — CF×0.60 + AF×0.40. Weights ambition higher; appropriate when the user is choosing between live offers.

The frontend cockpit's "Scouting" / "Applying" tabs are about *where the entry is in the user's workflow* (inventory vs active pipeline), not about which evaluation runs. Both tabs run this same mode. The phase flips when the user explicitly toggles it (Configuration tab, CmdK, or editing `profile.yml`).

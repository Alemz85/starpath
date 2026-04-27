# Mode: scouting — Lightweight Landscape Evaluation

## Purpose

Scouting is the **default mode for landscape mapping**. Unlike `oferta` (which is for active job-seeking and runs the full A-G evaluation + tailored CV), scouting is a lightweight, fast evaluation of a single listing against the user's current and aspirational profiles. It is optimized for *volume* — triaging a pipeline of listings to find the few worth investing in — not for per-listing CV tailoring.

**When to use scouting vs oferta:**
- `scouting` → default for anyone mapping their market, exploring career paths, or running accumulated scan data through a filter. **Never auto-generates PDFs at any tier.** Informs the `positioning` report.
- `oferta` → use when the user has decided to actively apply. Runs the full A-G evaluation, Block H dimensional scoring, Block I draft answers, and tailored PDF.

**IMPORTANT:** Do NOT touch or modify `modes/oferta.md`. Scouting is additive.

## Scouting never auto-generates PDFs

**Rule:** Scouting mode produces only markdown reports (or no artifact for Tier 4 skips). It NEVER auto-runs `node scripts/generate-pdf.mjs`, NEVER calls into `modes/pdf.md`, and NEVER produces a recruiter-facing CV at any tier — including Tier 1 hits via the uniform-fingerprint override.

**Why:** scouting is the analytical step. CV generation is a separate concern with its own modes:
- **`/career-ops pdf`** — manual tailored CV generation for any specific listing the user wants to actively pursue
- **`/career-ops oferta`** — full application flow, includes tailored PDF + interview prep + draft answers + legitimacy check

This separation:
- Keeps the user in control of when a recruiter-facing artifact gets produced (no surprise PDFs from a high-scoring scout)
- Lets scouting run cheaply across many listings without burning tokens on CV generation per hit
- Makes `scouting` → `pdf` → `oferta` a clean three-step ladder the user can stop at any rung

**For the rare Tier 1 hit:** the scouting report's recommendation should explicitly say *"if you want a tailored CV for this role, run `/career-ops pdf` against the URL. If you're ready to actively apply, run `/career-ops oferta` for the full application pipeline."* The framework surfaces the option, the user makes the call.

## Inputs

- `user/cv.md` (read-only — never tailored during scouting)
- `modes/_shared.md` — the **Dimensional Scoring Framework** section is the source of truth for dimensions, rubrics, rollup formulas, and TSV columns. Always read it before scoring.
- `user/_profile.md` (archetypes, narrative, location policy, comp targets, dream companies)
- `user/profile.yml` (candidate identity)
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

Look up `(normalize(company), normalize(role))` in `data/dedup-index.tsv` (normalize = lowercase + alphanum-only for company, lowercase + collapsed whitespace + trimmed for role). Apply fuzzy role matching against the `role_normalized` column (ignore minor title variations like trailing dates, parenthetical suffixes, or "(all genders)"). If a match exists **and `last_seen_date` is less than 6 months old**, **skip** — do not generate a duplicate report. Reference the existing entry and move on. If the existing entry is **6+ months old**, re-evaluate — the candidate's CV or the JD may have changed.

## The Scoring Model

Scouting uses the **Dimensional Scoring Framework** defined in `modes/_shared.md`. Read that section first — it is the single source of truth and is shared with `oferta` mode (Block H). Do not redefine dimensions here.

The framework gives you, for every listing:
- **6 numeric scoring dimensions** (1-10, half-steps allowed), three rolling up into **Current Fit** and three into **Aspirational Fit**
- **Sales-Trap Risk** (scored 1-10, displayed for decision-support but NOT in the AF rollup)
- **3 numeric context dimensions** + **1 text context dimension** (Best Cities, Salary Adj for City, Work-Life Balance, Best-fit Early-career Roles) — these inform the report but are NOT part of the rollups
- An **Overall** rollup: `Current Fit × 0.7 + Aspirational Fit × 0.3` (scouting weights; see `_profile.md` § CF/AF Phase Weighting)

In scouting, this dimensional table IS the core output. There's no separate Block A-G chain. The full report wraps the table with a thin role summary, gap notes, and a recommendation.

### Required pre-scoring reads

Before assigning any scores, you MUST have read:
1. `user/cv.md` — for Skills Match anchoring
2. `user/_profile.md` — for archetype framing, dream-company list, location policy, comp targets, Score Calibration adjustments
3. `modes/_shared.md` § Dimensional Scoring Framework — the rubric

### Salary Adj for City — comp cache check

Before scoring the `Salary Adj for City` context dimension:
1. Check `data/comp-cache.tsv` for a row matching the company + role_type + city that is less than **60 days old**
2. If found → use cached comp data for scoring; note *(cached {date})*
3. If missing or stale → note "comp data not cached — scoring from JD disclosure + city bands in `_profile.md`". Do NOT run a WebSearch just for scouting (save that for `oferta` Block D). Use the salary_raw from the JD (if disclosed) and the city bands from `_profile.md` § City-Specific Salary Bands to score.

### Calibration hooks

- **Entry-level lens:** Apply the Score Calibration adjustments from `_profile.md` (e.g., entry-level comp bands, mentorship bonus, brand bonus for CEMS-adjacent firms).
- **Location policy:** The Best Cities context dimension reads from `_profile.md` → Your Location Policy. A preferred-cities top hit floors at 9.0; a non-preferred EU city floors at 6.0; outside EU drops to 2.0-3.0.
- **Dream-company floor:** If the company is in the user's dream list (`user/profile.yml` → `target_roles.dream_companies` or `_profile.md` → Dream Companies), floor **Brand Value at 10** AND **Aspirational Fit at 8.0** regardless of function match. The user wants their foot in the door.
- **Sales-Trap Risk reminder:** Sales-Trap Risk is scored (5 = well protected, 1 = high risk) and displayed in the table, but is **not included in the Aspirational Fit rollup**. It serves as a decision-support signal — a score of 1 should be flagged prominently as a red flag.

## Output Behavior — Tiered by Current Fit

The report format depends on where Current Fit lands. **Always compute the full dimensional table first**, then choose the tier — the same table appears in every tier so positioning can read it.

### Tier 1 — Current Fit ≥ 9.0 (or uniform fingerprint override: all 6 dims ≥ 8 AND both rollups ≥ 8.0)

Generate a **full scouting report** (markdown file only — no PDF, ever, per the "Scouting never auto-generates PDFs" rule above).

The full scouting report follows the format in the "Full Report Format" section below. After writing it, surface this to the user with the recommendation: *"Strong match — full dimensional analysis ready. If you want a tailored CV for this role, run `/career-ops pdf` against the URL manually. If you're ready to actively apply, run `/career-ops oferta` for the full pipeline (legitimacy check, STAR stories, draft answers, tailored PDF)."*

### Tier 2 — Current Fit ≥ 7.0 (worth noting) AND Ease of Entry > 4

Two sub-tiers (same template, different verdict phrasing):
- **T2-high:** CF 8.0–8.9 → "apply with prep"
- **T2-standard:** CF 7.0–7.9 → "apply if pipeline thin"

Generate a **short summary report**. No PDF. No tailored CV. The dimensional table is still required.

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
**Tier:** T2-high (8.0-8.9) | T2-standard (7.0-7.9)  ← pick one

## Dimensional scoring

(use Standard report block format from modes/_shared.md § Standard report block format — do not reprint the table here)

## Fit / gaps
{2 bullets max: one on strongest match, one on biggest gap}

## Verdict
{One line — "Apply with prep" (T2-high) | "Apply if pipeline thin" (T2-standard) | "Track company only"}
```

### Tier 3 — Current Fit < 7.0 AND Aspirational Fit ≥ 7.0 (growth target), OR Ease of Entry ≤ 4 gate (see `_shared.md`)

Generate a **Gap & Growth Report**. This is the most valuable tier for the user's current phase — they can't get the job today, but it's exactly where they want to go. The report is a roadmap, not a rejection. The dimensional table is still required at the top.

**Exception — language wall:** if the binding gap is a foreign-language requirement the candidate doesn't have (and isn't learning), force Tier 4 instead. See `_shared.md` § "Language-barrier exception" for the rule. Language acquisition is a multi-year relocation/lifestyle decision, not a 6-12 month skill build, so a Gap & Growth roadmap would be misleading.

Tier 3 is the MOST COMPACT report format — ~25-30 lines total. The mental model is `T1 > T2 > T3 > T4(none)`: each tier is smaller than the one above it. T3 is shorter than T2's ~80 lines. The dimensional table is the load-bearing artifact; prose stays minimal.

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

**What NOT to include in Tier 3 reports** (cut from the old template):
- "Why this role is aspirational" multi-paragraph prose — the dimensional table already shows AF
- "What the JD requires vs what the user has today" requirement-by-requirement table — the dimensional table rolls this up
- Per-gap `Why it matters / Which dimension / How to close / Estimated time / Low-cost proxy` sub-sections — too detailed for a scouting-tier report
- "Timeline to competitiveness" with fastest/sustainable/unlikely paths — not a rescue plan, just a pointer to revisit
- "Stepping-stone roles" table — this belongs in the `positioning` report's holistic view, not in each per-listing T3
- Calibration-meta-notes about `_profile.md` updates — those belong in `_profile.md` revisions, not embedded in every report

### Tier 4 — Both scores low (skip)

Current Fit < 7.0 AND Aspirational Fit < 7.0 → **skip**. Do NOT write a report. Do NOT tailor a CV. **You still must compute the full dimensional table** so it can be logged to `data/score-history.tsv` (see Data Layer). Add a one-line entry to the scouting tracker (`data/scouting.md`) with tier `T4`, report `—`, and a note like "T4 skip — below threshold", and move on.

## Full Report Format (Tier 1)

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
**PDF:** {path or pending}

## A) Role summary
{Tight summary of the role — scope, team, seniority, stack, location.}

## B) Dimensional scoring

(use Standard report block format from modes/_shared.md § Standard report block format — do not reprint the table here)

## C) Recommendation
{2-3 lines max. The verdict (act / monitor / skip), the single biggest lever or blocker, and one growth pointer. No sub-sections.}

## D) Career path impact (compact)

**Read `user/profile.yml → profile.dream_companies` at render time.**

{4 structured lines — no prose preamble:}
- **Accelerates toward:** {which dream targets / archetypes}
- **Detours from:** {which targets — often "none"}
- **Optionality:** {what exits/pivots this opens or closes}
- **Key gap to close:** {single most impactful skill/experience gap and a directional action}
```

**Expected shape of a Tier 1 report: Header + A + B + C (2-3 lines) + D (4 lines).** Net length ~80-90 lines. Sections C and D appear **ONLY in Tier 1 reports** — Tier 2 short summaries and Tier 3 compact growth notes don't earn the career-arc treatment.

**Do NOT include in Section D** (cut from the older template):
- "Hard constraint: {X}" callouts — obvious in scouting mode, pure noise
- "What this report is good for" meta-justification — the user designed this mode, they know
- "What to do this week (zero urgency)" tactical to-do lists — wrong horizon; use Section E's 6-12 month shape instead
- "Calibration note for `_profile.md`" — calibration insights belong in `_profile.md` updates, not embedded in every report

**NOTE:** Scouting does NOT include Block F (interview STAR stories), Block G (legitimacy), or Block I (draft answers). Those live in `oferta` — use that mode when the user actually decides to apply. Scouting stays lightweight. The Block H content (dimensional scoring) IS shared between scouting and oferta — see `_shared.md`.

## Multi-city role deduplication

When the pipeline feeds you **multi-city postings of the same role** (same JD copy, different cities — e.g., Trade Republic Analytics Engineer posted separately for Berlin and Paris), **generate a single "master" report at the highest-priority city and a one-line city-comparison delta for each additional city.** Do NOT produce two separate full reports.

**Detection:** same company + same role title + identical responsibilities/requirements section in the JD + different `office` / `location` field. The `Best Cities` and `Salary Adj for City` context dimensions are the only dimensions that vary between the variants; everything else in the fingerprint is the same.

**How to apply:**
1. Score the role once using the highest-priority city variant (defined by `_profile.md` → location policy, ordered preferred-cities list).
2. Write ONE scouting report at `reports/tier-{N}/{Company} - {Role}.md` — the master.
3. For each additional city variant, append a one-line delta to the master report under a `## City variants` section:
   ```
   - **Paris variant:** Best Cities 6/10 (vs 8/10 Berlin), Salary Adj 6/10 (vs 8/10 Berlin); otherwise identical. Same tier.
   ```
4. Write ONE scouting tracker TSV entry referencing the master report; in the Notes column, list the other cities (e.g., `"Multi-city: Berlin (primary), Paris"`).
5. Log ONE row to `data/score-history.tsv` for the master. If the user wants per-city trajectory later, positioning mode can parse the `## City variants` section.

**Rationale:** scout-006 and scout-007 (Trade Republic Analytics Engineer Berlin + Paris) in the 2026-04-15 pilot run produced two near-identical Tier 3 reports, wasting ~3K tokens and ~15 minutes. The dimensional fingerprint differed only in the two city-context dimensions. A single master + one-line delta per extra city captures the same information at a fraction of the cost.

**Edge case:** if the role variants differ in more than just location (e.g., one has a language requirement the other doesn't, or responsibilities actually differ between offices), treat them as separate roles and score each independently.

## Data Layer — Score History Logging

**EVERY scouting evaluation must append a row to `data/score-history.tsv`**, regardless of tier (including Tier 4 skips). This is the trajectory log and stays unified across `scouting` and `oferta` modes — it is NOT split the way the per-entry trackers are.

The TSV format and column order are defined in `modes/_shared.md` § "Logging to data/score-history.tsv". Use exactly that format — do NOT invent columns here.

For scouting-mode rows:
- `mode` → `scouting`
- `tier` → `full` | `short` | `growth` | `skip`
- `source` → `url` | `paste` | `scan` | `pipeline`

The numeric dimension columns must be filled even for Tier 4 skips — that's the whole point of logging skipped listings (so positioning can see what the user *isn't* a fit for and why).

Also fill the 4 metadata columns added in 2026-04-26: `location`, `employment_type`, `duration`, `salary_raw` (see `_shared.md` for definitions). Use `n/d` for any that are unknown.

## Report Summary Cache

After writing the scouting report (or recording a T4 skip), also append a row to `data/report-summaries.tsv`:

```
{date}	{company}	{role}	{archetype}	{tier}	{overall}	{cf}	{af}	{key_gaps}	{verdict_one_line}
```

- `tier` — `T1` | `T2-high` | `T2` | `T3` | `T4`
- `key_gaps` — pipe-separated list of dimensions scored ≤ 5/10, max 3 (e.g. `EoE|Skills Match`). Use `—` for T1.
- `verdict_one_line` — the 1-sentence recommendation from the report (e.g. `Apply with prep — brand + growth strong, EoE gap closeable by graduation`). For T4 skips: `T4 skip — {reason}`.

This lets `positioning` mode read one lightweight TSV instead of opening 70+ full report files.

## Tracker Entry

Scouting observations are landscape-mapping inventory, NOT active applications. They live in **`data/scouting.md`** — a separate tracker from `data/applications.md` — so the active-application flow stays uncontaminated by exploratory runs.

Write a scouting TSV entry to `batch/scouting-additions/{num}-{company-slug}.tsv` (let `scripts/merge-scouting.mjs` handle the merge into `data/scouting.md`). **10 tab-separated columns** (no status field — tier replaces status for scouting):

```
{num}	{date}	{company}	{role}	{overall}/10	{tier}	{cf}/{af}	[{num}](reports/tier-{N}/{Company} - {Role}.md)	{deadline}	{promotion_hint}	{one-line tier summary}
```

**Report file path:** scouting reports live in **`reports/tier-{N}/{Company} - {Role}.md`** where `{N}` is the tier digit (1, 2, 3, or 4). Tier 4 skips use `—` for the report column and write nothing to disk.

Column order:
1. `num` — sequential number (integer)
2. `date` — YYYY-MM-DD
3. `company` — short company name
4. `role` — job title
5. `score` — overall weighted score, `X.X/10`
6. `tier` — `T1` | `T2` | `T2-high` | `T3` | `T4` (use `T2-high` for CF 8.0–8.9; score-history uses `short-high` for the tier column)
7. `cf_af` — `{current}/{aspirational}`, e.g. `8.3/7.5`
8. `report` — markdown link `[num](reports/tier-{N}/{Company} - {Role}.md)` or `—` for T4 skips
9. `deadline` — application deadline as stated in the JD (e.g. `2026-06-30`, `Rolling`, `n/d`). Use `n/d` if not stated.
10. `promotion_hint` — `READY` for Tier 1 hits (flags them for the user to promote to active applications), empty otherwise
11. `notes` — one-line tier summary

- **PDF:** Scouting never auto-generates PDFs at any tier. The scouting tracker has no PDF column — that's an applications.md concern. If the user later promotes a scouting entry to applications (via `scripts/promote-to-applications.mjs`), they can then run `/career-ops pdf` manually.
- **T4 skips:** still write the TSV with tier `T4`, report `—`, deadline `n/d`, and a short note.
- **Promotion:** Tier 1 hits get `READY` in column 10. The user runs `node scripts/promote-to-applications.mjs <num>` to move an entry into `data/applications.md` with status `Evaluated`. The scouting row stays in `data/scouting.md` as a historical record (its Promotion Hint flips to `PROMOTED-{app_num}`).

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

If the user later promotes a scouting hit into an active application via `node scripts/promote-to-applications.mjs <num>`, the oferta report uses the same `{Company} - {Role}.md` convention in the tier folder corresponding to its global Score.

## Mode Switching

If `user/profile.yml` has `current_mode: scouting`, this is the default for pasted JDs / URLs and for `pipeline` processing — auto-pipeline should route here instead of to `oferta`. If `current_mode: job-seeking`, auto-pipeline routes to `oferta` as before. The user can always override with an explicit `/career-ops oferta` or `/career-ops scouting` invocation.

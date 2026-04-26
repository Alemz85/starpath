# Mode: positioning — Holistic Career Positioning Report

## Purpose

`positioning` is a **standalone, manually invoked command** that produces a cross-cutting view of the user's career landscape. It does NOT evaluate a single listing. Instead, it reads *everything the system has accumulated* — scan data, scouting reports, `oferta` reports, tracker entries, score history — and answers the question: **"Given everything I've seen, where do I stand, and what path should I prioritize?"**

Think of it as the difference between looking at one X-ray (scouting) vs looking at the whole medical file (positioning).

**When to use:**
- After running `/career-ops scan` for a few weeks and wanting to zoom out
- When deciding whether to pivot archetypes
- Every 4-8 weeks as a progress check
- Before a big career decision (accepting an internship, choosing a specialization)

**This is NOT a per-listing mode.** It takes no listing argument. It reads accumulated data.

## Inputs — the whole corpus

Read ALL of these if they exist. Skip any that are missing with a note.

| Source | Purpose |
|--------|---------|
| `data/applications.md` | Active applications tracker (oferta-mode entries) |
| `data/scouting.md` | Scouting landscape tracker (scouting-mode entries with Tier column) |
| `data/score-history.tsv` | Per-archetype, per-dimension score trajectory over time. **Primary quantitative source.** Includes both scouting and oferta rows (distinguished by the `mode` column). |
| `data/report-summaries.tsv` | **Compact summary cache** (one row per evaluation). Read this FIRST for the quantitative analysis pass — it is far faster than opening full reports. Schema: `date\|company\|role\|archetype\|tier\|overall\|cf\|af\|key_gaps\|verdict_one_line`. Only open full `.md` reports when drilling into a specific company or archetype (max 5 full reads per positioning run). |
| `reports/tier-*/scout-*.md` | Scouting reports — open only for qualitative color (see rule below). |
| `reports/tier-*/[0-9]*.md` | Full oferta reports — open only for qualitative color. |
| `data/scan-history.tsv` | Portal scan history — demand signals by company/city |
| `data/landscape-companies.csv` | If it exists (landscape mapping data) |
| `data/landscape-cities.csv` | If it exists |
| `modes/_shared.md` | The Dimensional Scoring Framework definition (shared by scouting and oferta). Read this so you understand what each TSV column means. |
| `user/_profile.md` | Archetypes, narrative, comp targets, location policy |
| `user/profile.yml` | Identity, dream companies, target roles |
| `user/cv.md` | Current skill baseline |
| `user/article-digest.md` | Proof points |
| Previous positioning reports (`reports/positioning/positioning-*.md`) | For trajectory comparison |

**RULE:** Do not open individual report files for the quantitative analysis pass. Read `data/report-summaries.tsv` and `data/score-history.tsv` for all quantitative signals. Only open full `.md` reports (max 5 total) for qualitative color when you need specific gap phrasing, interview insights, or recommendation detail for a specific archetype or company.

### `data/score-history.tsv` schema (read this carefully)

The TSV is the primary quantitative input. Schema (see `modes/_shared.md` § "Logging to data/score-history.tsv" for the canonical definition):

```
date	archetype	skills_match	ease_of_entry	strategic_fit	current_fit	growth_mobility	optionality_exit	brand_value	sales_trap_risk	aspirational_fit	overall	best_cities	salary_adj_city	work_life_balance	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw
```

**Note:** Rows written before 2026-04-26 have only 21 columns (no metadata columns). Check `len(columns) >= 22` before reading `location` and beyond — treat missing as `n/d`.

Key facts for parsing:
- One row per evaluation. Both `scouting` and `oferta` modes write here — the `mode` column tells you which.
- Numeric columns are decimals. Treat blanks as missing data, not zero.
- `current_fit`, `aspirational_fit`, `overall` are **pre-computed rollups**, not for you to recompute. Use them directly.
- The 6 rollup scoring dimensions (`skills_match`, `ease_of_entry`, `strategic_fit`, `growth_mobility`, `optionality_exit`, `brand_value`) are the rich signal — averages and trends across these are what positioning is uniquely able to surface. `sales_trap_risk` is logged and displayed but is NOT part of the AF rollup — treat it as a decision-support signal in the positioning analysis.
- The 3 numeric context dimensions (`best_cities`, `salary_adj_city`, `work_life_balance`) inform the geographic and market sections but do NOT enter the Current Fit / Aspirational Fit averages.
- `best_fit_roles` is a free-text column with `; `-separated alternative roles. Tally these across the corpus to surface "the user repeatedly gets matched to X kind of role at Y kind of company".
- **Sales-Trap Risk:** This column is still logged and displayed but is **not part of the AF rollup**. Higher = better (lower risk of sales pigeonholing). When analyzing this in positioning, treat it as a decision-support signal — surface it in per-archetype deep dives and red-flag any archetype with consistently low Sales-Trap Risk scores, but do NOT include it when computing AF averages.

## Process

### Step 1 — Inventory what's available

Count:
- Total tracker entries and their status distribution
- Total scouting reports by tier (full / short / growth / skip)
- Total `oferta` reports
- Score-history.tsv row count and date range
- Previous positioning reports (for diff)

If the corpus is too thin to be useful, tell the user:
> "Not enough data for a meaningful positioning report yet. You have {N} scouting evaluations and {M} tracker entries. Come back after {recommended threshold} — or run `/career-ops scan` a few times first."

**Minimum thresholds:**
- At least 15 rows in `score-history.tsv` (or 10 tracker entries if score-history is empty) to produce the "where you stand today" section
- At least 2 prior positioning reports to produce the trajectory section (otherwise just establish a baseline)

### Step 2 — Compute quantitative signals

Run the math yourself (no external script — positioning is flexible enough that hard-coding logic in a script would rot fast). All numeric inputs come from `data/score-history.tsv` unless otherwise noted. Produce:

**A) Competitiveness by archetype — rollup view** (from `data/score-history.tsv`):

| Archetype | # evals | Avg Current Fit | Avg Aspirational Fit | Avg Overall | Trend CF (30d vs prior) | Trend AF |
|-----------|---------|-----------------|----------------------|-------------|-------------------------|----------|

- "Trend" compares the most recent 30 days against the prior window of equal length. Flag arrows: ↑ (improving by ≥ 0.3), → (flat ± 0.3), ↓ (declining by ≥ 0.3).
- Skip archetypes with fewer than 3 evaluations (insufficient signal — say "n/a").

**B) Per-dimension breakdown by archetype** (the unique value of the new framework):

For each archetype with ≥ 3 evaluations, show how the rollups *decompose* across the 7 underlying dimensions. This is the table that tells the user *why* a number is what it is.

| Archetype | Skills | Ease | Strategic | **CF** | Growth | Optionality | Brand | Sales-Trap | **AF** |
|-----------|--------|------|-----------|--------|--------|-------------|-------|------------|--------|

- Each cell is the **average** of that dimension across all rows for that archetype.
- Bold the rollup columns (CF, AF) for visual scanning.
- Highlight the lowest-scoring dimension per row in plain text below the table: "Value Engineering: Skills Match (avg 2.4) is the bottleneck — Ease and Strategic both above 4."
- For Sales-Trap Risk, phrase findings positively: "Sales-Trap Risk avg 4.3 → low pigeonhole risk across this archetype" (NOT "high sales-trap risk").

**C) Most common gaps** (from scouting reports — sample 3-5 per archetype):

Parse the "Key gaps" / "Gap analysis" sections from recent reports AND the lowest-scoring dimensions from Step 2B. Tally frequency. Output the top 5-8 gaps that show up across the corpus. Group semantically (e.g., "SQL proficiency", "3+ YoE in data role", "Cloud certification") rather than listing near-duplicates. Cross-reference: a gap that recurs in the qualitative text AND drags down the same dimension quantitatively is a high-conviction finding.

**D) Geographic opportunity map** (from `data/scan-history.tsv`, tracker, and the `best_cities` + `salary_adj_city` columns of score-history.tsv):

| City | # listings seen (last 90d) | Avg Current Fit | Avg Best Cities score | Avg Salary Adj for City | Preferred (per _profile.md)? |
|------|----------------------------|-----------------|------------------------|--------------------------|------------------------------|

Use the preferred_cities list from `_profile.md` / `user/profile.yml` to mark which cities are in-policy. Cities where `salary_adj_city` averages below 3.0 are flagged "comp doesn't justify cost-of-living" — call those out explicitly.

**E) Work-Life Balance and brand patterns** (from `work_life_balance` and `brand_value` columns):

| Archetype | Avg WLB (context) | Avg Brand Value | Notes |
|-----------|---------------------|------------------|-------|

Surface mismatches: e.g., "Tech Sales archetype averages Brand Value 4.5 but WLB 2.6 — recurring trade-off the user should be aware of."

**F) Best-fit early-career roles — recurring matches** (from `best_fit_roles` text column):

Tally across the corpus. Which alternative roles get suggested most often? Output the top 5-10 with frequency counts. This is the system telling the user "across all the listings I've scored, these are the roles your profile keeps pointing toward — even when the title you were evaluating was something else."

**G) Dream company coverage:**

For each dream company from `user/profile.yml` → `target_roles.dream_companies`:
- How many postings have been seen?
- Average rollups (CF / AF / Overall) and per-dimension averages observed?
- Which specific roles surfaced?
- Which dimensions consistently score highest / lowest at this company?
- Recommended next action (apply / watch / build prerequisites)

### Step 3 — Per-archetype deep dive

For each **primary** archetype from `_profile.md` (secondary ones get a single-paragraph treatment unless the data is surprising):

```markdown
### {Archetype name}

**Current standing:** {1-2 sentences summarizing the rollup numbers and trend arrow from Step 2A}

**Dimensional fingerprint** (from Step 2B):

| Dimension | Avg | Read |
|-----------|-----|------|
| Skills Match | X.X | {Strong / Mixed / Weak — one phrase} |
| Ease of Entry | X.X | ... |
| Strategic/Analytical Fit | X.X | ... |
| Growth/Mobility | X.X | ... |
| Optionality/Exit | X.X | ... |
| Brand Value | X.X | ... |
| Sales-Trap Risk | X.X | {5 = well protected, 1 = high pigeonhole risk} |

**The bottleneck:** {The single dimension dragging Current Fit or Aspirational Fit down the most. Be specific. E.g., "Ease of Entry averages 2.6 across 8 evals — the YoE bar is the wall, not the skills."}

**What you have** (from cv.md + user/article-digest.md, filtered to this archetype, anchored to the dimensions where the user already scores high):
- {bullet — proof point 1 relevant to this archetype}
- {bullet — proof point 2}
- {...}

**What's missing** (cross-reference Step 2C qualitative gaps with the dimension averages from Step 2B):
- {bullet — gap 1, name the dimension it lowers (e.g., "missing 2+ YoE → Ease of Entry capped at ~3"), name the proof point that would close it}
- {bullet — gap 2}
- {...}

**Risk / reward:**
- **Upside:** {What's the best realistic outcome if the user doubles down here? Comp range, title, company calibre. Anchor to Brand Value + Optionality dimension averages.}
- **Downside:** {What's the risk of investing months here and it not paying off? What's the walk-away cost? Anchor to Sales-Trap Risk and WLB context dimension if relevant.}
- **Optionality:** {Does this archetype leave doors open, or does it narrow the user's future? Cite Optionality/Exit avg directly.}

**Action plan** (each horizon should target the bottleneck dimension):

| Horizon | Action | Dimension it lifts |
|---------|--------|---------------------|
| 3 months | {concrete deliverable — a project, course, cert, outreach goal} | {Skills Match / Strategic-Analytical / Brand} |
| 6 months | {next milestone — typically a stepping-stone role, portfolio piece, or credential} | {Ease of Entry / Brand / Optionality} |
| 12 months | {target state — the role / title / comp the user should be competitive for} | {Growth/Mobility / Optionality} |

**Companies hiring this path** (from scan-history + landscape data):
{5-10 company names pulled from the actual scan data, not invented. Group by city if the data supports it.}

**Best-fit alternative roles at these companies** (from the `best_fit_roles` column tally in Step 2F):
{Top 3-5 alternative roles the system has repeatedly suggested for this archetype.}
```

### Step 4 — Priority recommendation

This is the punchline of the whole report. One clear recommendation, with reasoning.

```markdown
## Priority Recommendation

**Focus path:** {Archetype name}

**Why this path, given everything above:**
1. **Fit:** {What the score-history and gap analysis say about readiness}
2. **Market demand:** {What scan-history says about volume and geography}
3. **Growth potential:** {Where this path leads in 2-5 years, and why it fits _profile.md narrative}
4. **Counterfactual:** {Why NOT the runner-up path — be explicit}

**Concrete next actions this week:**
1. {action — be specific, time-bound}
2. {action}
3. {action}
```

Only recommend ONE priority path. The whole point of this report is to cut through ambiguity. If the user has 3 archetypes they're juggling, picking one for the next cycle is the value.

### Step 5 — Trajectory over time

Only if 2+ prior positioning reports exist in `reports/positioning/positioning-*.md` OR `score-history.tsv` has data spanning more than 60 days:

```markdown
## Trajectory

Comparison against the previous positioning report ({previous date}) AND across the score-history window:

**Rollup-level trajectory:**

| Metric | Previous | Current | Δ |
|--------|----------|---------|---|
| Avg Current Fit (all archetypes) | X.X | X.X | ↑/→/↓ |
| Avg Current Fit — {primary archetype 1} | X.X | X.X | ↑/→/↓ |
| Avg Current Fit — {primary archetype 2} | X.X | X.X | ↑/→/↓ |
| Avg Aspirational Fit (all archetypes) | X.X | X.X | ↑/→/↓ |
| Evaluations in window | N | M | — |
| Top recurring gap | {gap} | {gap} | — |

**Per-dimension trajectory (which underlying numbers are actually moving):**

For each primary archetype with enough data, show how the 7 underlying scoring dimensions have moved:

| Archetype | Skills | Ease | Strategic | Growth | Optionality | Brand | Sales-Trap |
|-----------|--------|------|-----------|--------|-------------|-------|------------|
| {arch 1} | X.X→X.X | ... | ... | ... | ... | ... | ... |

This is the "in April you averaged 2.8 Current Fit for Value Engineering, by October you're at 3.6 — and the lift came from Skills Match (+0.9) and Strategic Fit (+0.5), not from Ease of Entry which is still flat at 2.4" view. Name the specific dimensions that moved.

**What improved:**
- {bullet — specific archetype/dimension combo that lifted, and the most likely cause from the user's recent activity}

**What stagnated:**
- {bullet — dimensions that haven't budged despite effort, with a hypothesis why}

**What to do differently this cycle:**
- {bullet — a concrete change in approach, targeting, or priority, anchored to a specific stagnant dimension}
```

If this is the first positioning report AND `score-history.tsv` has fewer than 60 days of data, say so explicitly and establish a baseline:
> "This is your baseline positioning report — no prior reports to compare against, and score-history.tsv only spans {N} days. Run `/career-ops positioning` again in 4-8 weeks to see trajectory."

If `score-history.tsv` spans >60 days but no prior positioning report exists, you can still produce a within-TSV trajectory section by comparing the first half of the window against the second half. Note clearly that this is a within-TSV comparison, not a positioning-report-to-positioning-report comparison.

## Output

Write the full report to `reports/positioning/positioning-{YY-MM}.md`. Structure:

```markdown
# Career Positioning Report — {YY-MM}

**Evaluations analyzed:** {N} scouting + {M} oferta + {K} tracker entries
**Score-history rows:** {N_tsv} ({date_from} → {date_to})
**Primary archetypes considered:** {list}

---

## 1. Where You Stand Today

### 1A. Rollup view by archetype
{Step 2A output}

### 1B. Per-dimension breakdown by archetype
{Step 2B output — the dimensional fingerprint table}

### 1C. Recurring gaps
{Step 2C output — qualitative gaps cross-referenced with low-scoring dimensions}

### 1D. Geographic opportunity map
{Step 2D output}

### 1E. Brand vs WLB patterns
{Step 2E output}

### 1F. Recurring best-fit alternative roles
{Step 2F output}

### 1G. Dream company coverage
{Step 2G output}

## 2. Per-Archetype Analysis
{Step 3 output — deep dive per primary archetype, anchored to dimensional fingerprints}

## 3. Priority Recommendation
{Step 4 output — the one path to focus on}

## 4. Trajectory
{Step 5 output, or baseline note}

---

## Appendix: Data sources
- score-history.tsv ({N} rows, {from}-{to}, {N_scouting} scouting rows + {N_oferta} oferta rows)
- Tracker ({M} entries)
- Reports sampled: {list of report filenames used for qualitative signals}
- Previous positioning reports: {list or "none"}
```

## Present a tight summary to the user

After writing the full report, show the user a condensed version in chat:

```
Career Positioning Report — {date}
({N} scouting + {M} oferta evaluations spanning {date_from}-{date_to})

Where you stand:
- {archetype 1}: CF X.X / AF X.X {↑→↓}  · bottleneck: {dimension}
- {archetype 2}: CF X.X / AF X.X {↑→↓}  · bottleneck: {dimension}
- {archetype 3}: CF X.X / AF X.X {↑→↓}  · bottleneck: {dimension}

Top 3 recurring gaps:
1. {gap} ({dimension it lowers})
2. {gap}
3. {gap}

Priority path: {archetype}
Why: {one sentence — anchor to fit + market demand + which dimension closes most easily}

This week:
1. {action — explicitly targets {dimension}}
2. {action}
3. {action}

Full report: reports/positioning/positioning-{YY-MM}.md
```

## Rules

- **Never invent data.** If `score-history.tsv` has 4 rows for an archetype, do not claim a "trend" — say "insufficient signal".
- **Do not tailor CV or generate PDFs** in this mode. It's analytical, not generative.
- **Do not modify `_profile.md` or `user/profile.yml`** automatically. If the report recommends a change (e.g., drop a dead archetype), surface it as a suggestion and ask the user before editing.
- **Do not rerun `scan.mjs` or `analyze-patterns.mjs`** — those are separate modes. Positioning reads; it does not scan or re-process.
- **Respect the Data Contract.** This mode reads a lot of files but writes ONLY to `reports/positioning/positioning-*.md`.
- **One positioning report per month max.** If `reports/positioning/positioning-{YY-MM}.md` already exists, ask the user whether to overwrite or skip. Usually you want to skip — a month's gap allows enough new data to accumulate.

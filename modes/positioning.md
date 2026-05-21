# Mode: positioning — Holistic Career Positioning Report

## Purpose

`positioning` is a **standalone, manually invoked command** that produces a cross-cutting view of the user's career landscape. It does NOT evaluate a single listing. It reads *everything the system has accumulated* — scan data, evaluation reports, tracker entries, score history — and answers the question: **"Given everything I've seen, where do I stand, and what should I do differently this cycle?"**

Think of it as the difference between looking at one X-ray (scouting) and looking at the whole medical file (positioning).

**When to use:**
- After running `/career-ops scan` for a few weeks and wanting to zoom out
- When deciding whether to pivot archetypes
- Every 4–8 weeks as a progress check
- Before a big career decision (accepting an internship, choosing a specialization)

**This is NOT a per-listing mode.** It takes no listing argument. It reads accumulated data.

## The quality bar — read this before writing a single line

Past positioning reports have failed by being **table-led summaries of facts the user already knows**. The user reads `data/scouting.md` and the report files; they do not need a positioning report to re-tell them how many postings a given company has or what a given role scored. They need positioning to tell them **what to do differently and why**, anchored to those numbers — not narrating them.

A good positioning report passes all four of these tests:

1. **The TL;DR block at the top is sufficient to act on by itself.** A user who reads only the first 250 words knows the focus path, the three things to do next, and the single most important "stop doing X" call.
2. **Every numerical claim ties to a consequence.** "{Archetype} Ease of Entry averages {X.X}" is not a finding — it's a stat. "{Some structural gate} is the binding constraint across most archetypes in the corpus; the highest-leverage move is reframing {existing CV proof point} as {alternative framing the JD bar accepts} — that fix attacks the constraint everywhere it appears" — that's a finding. Substitute real values from `score-history.tsv` and the user's `cv.md` / `_profile.md`; don't hardcode the example. Every paragraph should either prescribe an action, kill an option, or change how the user reads the next paragraph.
3. **Per-archetype sections lead with a 2–3 sentence judgment paragraph, not a table.** The opening paragraph says "the bet here is X, the cost is Y, the call is {keep / cut / double down}". Tables come AFTER the judgment, as supporting evidence — not as the section itself.
4. **No more than 4 tables in the entire report.** Tables are a crutch that lets the agent dump structured data without committing to a read. Demote dimensional fingerprints, geographic maps, gap tallies, and dream-company coverage to a single Appendix. The body of the report is prose.

If you find yourself writing "Headlines:" or "Key takeaways:" as a bulleted list after a table, **stop and rewrite the section as one paragraph that leads with the conclusion**.

## Inputs — the whole corpus

Read ALL of these if they exist. Skip any that are missing with a note.

| Source | Purpose |
|--------|---------|
| `data/applications.md` | Active applications tracker — entries the user has decided to apply to |
| `data/scouting.md` | Landscape inventory tracker — every evaluation lands here by default (Tier column) |
| `data/score-history.tsv` | Per-archetype, per-dimension score trajectory over time. **Primary quantitative source.** |
| `data/report-summaries.tsv` | **Compact summary cache** (one row per evaluation). Read this FIRST for the quantitative pass — far faster than opening full reports. Schema: `date\|company\|role\|archetype\|tier\|overall\|cf\|af\|key_gaps\|verdict_one_line`. Only open full `.md` reports when drilling into a specific company or archetype (max 5 full reads per positioning run). |
| `reports/tier-*/{Company} - {Role}.md` | Full evaluation reports — open only for qualitative color (see rule below). |
| `data/scan-history.tsv` | Portal scan history — demand signals by company/city |
| `data/landscape-companies.csv` / `data/landscape-cities.csv` | If they exist |
| `modes/_shared.md` | The Dimensional Scoring Framework definition. Read this so you understand what each TSV column means. |
| `user/_profile.md` | Archetypes, narrative, comp targets, location policy |
| `user/profile.yml` | Identity, dream companies, target roles |
| `user/cv.md` | Current skill baseline |
| `user/article-digest.md` | Proof points |
| Previous positioning reports (`reports/positioning/positioning-*.md`) | For trajectory comparison |

**RULE:** Do not open individual report files for the quantitative pass. Read `data/report-summaries.tsv` and `data/score-history.tsv` for all quantitative signals. Only open full `.md` reports (**max 5 total**) for qualitative color when you need specific gap phrasing or recommendation detail.

### `data/score-history.tsv` schema (read this carefully)

The TSV is the primary quantitative input. Schema (see `modes/_shared.md` § "Logging to data/score-history.tsv" for the canonical definition):

```
date	archetype	skills_match	ease_of_entry	strategic_fit	current_fit	growth_mobility	optionality_exit	brand_value	sales_trap_risk	aspirational_fit	overall	best_cities	salary_adj_city	work_life_balance	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw	url
```

**Note:** Rows written before 2026-04-26 have only 21 columns (no metadata columns). Check `len(columns) >= 22` before reading `location` and beyond — treat missing as `n/d`.

Key facts for parsing:
- One row per evaluation. The `mode` column always says `scouting` for new rows; legacy rows may say `oferta` — treat them the same.
- Numeric columns are decimals. Treat blanks as missing data, not zero.
- `current_fit`, `aspirational_fit`, `overall` are **pre-computed rollups**, not for you to recompute. Use them directly.
- The 6 rollup scoring dimensions (`skills_match`, `ease_of_entry`, `strategic_fit`, `growth_mobility`, `optionality_exit`, `brand_value`) are the rich signal. `sales_trap_risk` is logged and displayed but is NOT part of the AF rollup — treat it as a decision-support signal.
- The 3 numeric context dimensions (`best_cities`, `salary_adj_city`, `work_life_balance`) inform the geographic and market sections but do NOT enter the Current Fit / Aspirational Fit averages.
- `best_fit_roles` is a free-text column with `; `-separated alternative roles. Tally these across the corpus to surface "the user repeatedly gets matched to X kind of role at Y kind of company".

## Process

### Step 0 — Decide whether to write the report at all

Count rows in `score-history.tsv` and tracker entries. If the corpus is too thin:

> "Not enough data for a meaningful positioning report yet. You have {N} evaluations and {M} tracker entries. Come back after {recommended threshold} — or run `/career-ops scan` a few times first."

**Minimum thresholds:**
- At least 15 rows in `score-history.tsv` (or 10 tracker entries if score-history is empty) to produce the "where you stand today" section
- At least 2 prior positioning reports OR 60 days of score-history data for a real trajectory section (otherwise establish a baseline only)

### Step 1 — Compute quantitative signals (kept internal until Step 3)

Run the math yourself, holding the results in working memory. You will **not** dump these as the first thing the user sees — they go into the Appendix and the body of the report only references them inline as evidence for a judgment.

Compute:

**A) Rollup view by archetype** — `# evals`, `Avg CF`, `Avg AF`, `Avg Overall`, plus a Trend arrow (most recent 30 days vs prior 30 days; ↑ ≥+0.3, → ±0.3, ↓ ≤−0.3; n/a if either window has <3 rows). Skip archetypes with <3 total evaluations.

**B) Dimensional fingerprint by archetype** — for each archetype with ≥3 evals, the average of each of the 7 dimensions (6 rollup + sales-trap). Identify the lowest-scoring dimension per archetype (the bottleneck).

**C) Recurring gaps** — open up to 5 full reports (one per primary archetype where possible). Parse the qualitative "Key gaps" sections. Cross-reference each gap with the dimensional fingerprint from B — a gap that recurs in the prose AND drags the same dimension quantitatively is a high-conviction finding worth surfacing in the body.

**D) Geographic opportunity** — by city: `# listings`, `Avg CF`, `Avg AF`, `Best Cities geo score`, `Salary Adj`. Mark preferred cities per `_profile.md` / `user/profile.yml`. Flag any city with `salary_adj_city` avg below 3.0.

**E) Brand vs WLB patterns** — per archetype: `Avg Brand`, `Avg WLB`, `Avg Sales-Trap`. Surface mismatches (e.g., high brand + low WLB = recurring trade-off).

**F) Best-fit alternative roles** — tally the `best_fit_roles` column across the corpus. Top 10–15 alternative roles with counts.

**G) Dream company coverage** — for each company in `user/profile.yml → target_roles.dream_companies`: postings seen, rollup averages, roles surfaced.

All seven outputs land in the **Appendix**. The body of the report uses them as evidence for judgments — it does not re-list them.

### Step 2 — Decide the punchline FIRST

Before writing any prose, force yourself to answer these four questions in one sentence each. Write them down at the top of your scratch notes; the entire report flows from these:

1. **What's the one path the user should focus on next cycle, and why?** (Anchor to the strongest archetype-by-Overall plus market demand and growth potential.)
2. **What's the one thing the user should STOP doing or de-prioritize?** (Anchor to the lowest-conviction archetype, the leakiest portal config, or a structural bottleneck the user has been ignoring.)
3. **What's the single cheapest fix with the largest cross-archetype leverage?** (Usually a positioning reframe, a portal-config tightening, or a missing portal entirely — something that attacks the binding constraint across multiple archetypes. Don't quote a timeline; just identify the move.)
4. **What's the runner-up path, and why is it runner-up rather than primary?** (Forces the counterfactual; prevents wishy-washy "do everything" recommendations.)

These four answers become the **TL;DR block at the top of the report** (Step 3, output structure below). They also constrain every per-archetype section — if a section's verdict contradicts the punchline, one of them is wrong and you need to reconcile before writing.

### Step 3 — Write the report

Use the output structure below. Strict rules:

- **TL;DR block at the very top** (before any section header). Tight, decision-grade.
- **Per-archetype sections lead with a judgment paragraph** ("The bet · The cost · The call"). Tables come after, not before. If an archetype has nothing surprising to say, give it one paragraph total and skip the fingerprint table.
- **Hard cap: ≤4 tables in the body.** Demote the dimensional fingerprint, geographic map, brand/WLB pattern, alternative-role tally, and dream-company coverage to the Appendix. The body uses inline numbers only when they change the read.
- **Forbidden patterns:** "Headlines:" bullet lists, "Key takeaways:" recaps, restating a table's contents in prose immediately after the table, the phrase "this is your baseline" repeated more than once.
- **Required pattern:** every numerical claim is followed by either (a) the action it implies, (b) the option it kills, or (c) the way it reframes the next paragraph. Stats without consequences get cut.

## Output structure

Write the full report to `reports/positioning/positioning-{YY-MM}.md`. Use this exact skeleton:

```markdown
# Career Positioning Report — {YY-MM}

**Evaluations analyzed:** {N} score-history rows ({date_from} → {date_to}) · {M} tracker entries · {K} previous positioning reports
**Primary archetypes considered:** {list}

---

## TL;DR

**Focus path:** {Archetype name + sub-route, ≤15 words total}.
**Why this and not the runner-up:** {1 sentence — anchor to fit + demand + the dimension that closes most easily}.

**Do next** (ordered by what unblocks what):
1. {Action — concrete, time-bound, names the file or portal or company to touch}
2. {Action}
3. {Action}

**Stop doing:** {The one path or behavior the user should de-prioritize this cycle, and why in one sentence}.

**Highest-leverage cheap fix:** {The single positioning / portal / framing change that attacks the binding constraint across multiple archetypes, with the dimension it lifts. No timeline — name the move and what it unlocks.}

---

## 1. Where You Stand

**3–5 paragraphs of prose.** No tables in this section. Anchor every claim to a number from the Appendix; format anchors as "{archetype} is the strongest fingerprint — CF {X.X} / AF {X.X} across {N} evals — and {what that means for the call}". The illustration is the *shape* of the sentence, not the archetype or score; substitute the user's actual values. Cover:

- The shape of the corpus — what's dense, what's thin, what's surprising
- The binding constraint — the single dimension or structural issue that recurs across multiple archetypes, and the one fix that addresses it
- The brand picture — where the user's brand stack is compounding vs. where the scanner is pulling mid-tier seats that don't help
- The geographic read — which city is structurally strongest, where comp doesn't justify cost, what's dormant but about to activate
- Any surprise — a counter-intuitive finding (e.g., "this archetype under-delivers because the scanner is pulling the wrong employer tier, not because the archetype is broken")

End the section with **one paragraph naming the biggest leverage move** if not already covered. This is the prose version of the TL;DR's "highest-leverage fix".

## 2. Per-Archetype Read

For each **primary** archetype (from `_profile.md`):

### {Archetype name}

**The bet · The cost · The call** — one paragraph (3–5 sentences). Open with the verdict: "Double down" / "Hold steady — secondary play" / "Cut — re-route through {sub-archetype}". Then in one breath: what the user gets if it works (anchored to AF and Brand averages), what they pay (anchored to the bottleneck dimension and the time cost to close it), and the call with reasoning.

**What's missing** (2–4 bullets max): each bullet names the gap and the dimension it lowers. If you can't name both, the gap isn't ready to surface yet.

**Path forward** — one short paragraph (3–6 sentences) describing the route, not a timeline. Name the entry move (where the user breaks in: a specific kind of role, the prerequisite proof point that gets them past the screen), the compounding move (the next role or pivot the entry seat sets up), and the exit options it leaves open. Anchor to the bottleneck dimension throughout — say what each step does to relieve it. Do **not** assign months or weeks to steps; the user's actual cadence depends on cycle windows you can't predict. If the path materially depends on the order of two moves, say so in prose ("X has to happen before Y because…") — don't fake a Gantt chart.

**Where to find this path** (one line): top 5 companies from the corpus, comma-separated, with city in parens. Pull from scan-history, not invented.

For **secondary** archetypes: one paragraph each. No fingerprint table, no action-plan table — just the call and one line on why.

Skip archetypes with <3 evaluations entirely (mention in the Appendix's data-quality note).

## 3. Priority Recommendation

This is the **expanded** version of the TL;DR's focus path — 4–6 paragraphs.

**Focus path:** {repeat from TL;DR}.

**Why this path, given everything above:** explicit numbered reasoning.
1. **Fit:** what the score-history and gap analysis say about readiness
2. **Market demand:** what scan-history says about volume and geography
3. **Growth potential:** where this path leads in 2–5 years, anchored to the user's `_profile.md` narrative
4. **Counterfactual:** why NOT the runner-up — for EACH plausible runner-up, one sentence on why it's not the call this cycle

**Concrete next actions** (no timelines — just the moves, ordered by what unblocks what):
1. {action — usually the positioning reframe or portal-config fix; what it unblocks}
2. {action — usually a missing-portal addition or a cycle-window calendar item; what it unblocks}
3. {action — usually a specific application paired with a referral path; what it unblocks}
4. {action — usually the highest-ROI skill / cert / proof point; what it unblocks}

Only recommend ONE priority path. The whole point of this report is to cut through ambiguity. If the user has 3 archetypes they're juggling, picking one is the value.

## 4. Trajectory

Only render this section as a real diff if 2+ prior positioning reports exist OR `score-history.tsv` spans >60 days. Otherwise: one-paragraph baseline note ("This is the baseline. Re-run in 4–8 weeks once the corpus crosses 60 days.") and skip the rest.

When you DO render trajectory:

**One paragraph of judgment first.** What's actually moving? What's stagnant despite effort? What does the user need to do differently this cycle? Name specific archetype × dimension combos that lifted or stagnated, and the most likely cause.

**Then one table** (max), comparing previous → current on the 4–6 metrics that actually moved or stagnated meaningfully. Do NOT exhaustively list every archetype × dimension combo — pick the 4–6 that change the read.

If the scanner pulled a different segment of the market between windows (a common confounder), say so explicitly so the user doesn't misread a corpus-mix shift as a real trajectory change.

---

## Appendix — Supporting Data

This is where ALL the tables live. The body of the report references them as evidence; the user opens the Appendix to verify a specific claim.

### A. Rollup by archetype
{Step 1A table}

### B. Dimensional fingerprint by archetype
{Step 1B table — full 7-dimension breakdown}

### C. Recurring gaps cross-reference
{Step 1C table — qualitative gap × dimension it lowers × time-to-close}

### D. Geographic opportunity map
{Step 1D table}

### E. Brand × WLB × Sales-Trap patterns
{Step 1E table}

### F. Best-fit alternative roles tally
{Step 1F table — top 10–15}

### G. Dream company coverage
{Step 1G table + one verdict line per company}

### H. Data sources
- `score-history.tsv`: {N} rows, {from} → {to}
- `applications.md`: {M} entries
- `report-summaries.tsv`: {K} cached summaries
- Reports sampled for qualitative color ({≤5}): {filenames}
- Previous positioning reports: {list or "none"}

### I. Archetype bucketing applied
{List spelling-variant merges if `score-history.tsv` has naming variance. Format: `"{Canonical archetype name}" includes: {variant 1} ({count}), {variant 2} ({count}), ...`. Only include this section if the TSV actually has duplicates worth surfacing.}

### J. Data-quality notes
{Any caveats: archetypes skipped for insufficient sample, dream companies with zero postings, scanner coverage gaps the user should know about. Surface fix suggestions for `user/portals.yml` but do NOT edit it automatically.}
```

## Present a tight summary to the user

After writing the full report, show the user a condensed version in chat (this is essentially a re-render of the TL;DR block):

```
Career Positioning Report — {YY-MM}
({N} evaluations · {date_from} → {date_to})

Focus path: {archetype + sub-route}
Why (1 line): {one sentence}

Do next:
1. {action}
2. {action}
3. {action}

Stop doing: {one sentence}
Highest-leverage cheap fix: {one sentence}

Full report: reports/positioning/positioning-{YY-MM}.md
```

## Rules

- **Never invent data.** If `score-history.tsv` has 4 rows for an archetype, do not claim a "trend" — say "insufficient signal" in the Appendix and skip the archetype in the body.
- **Lead with judgment, anchor with numbers.** Numbers go inline as evidence for a claim, not as the claim itself. If a paragraph contains 3 numbers and no action, rewrite it.
- **Hard cap: ≤4 tables in the body.** All others belong in the Appendix.
- **Do not tailor CV or generate PDFs** in this mode. It's analytical, not generative.
- **Do not modify `_profile.md` or `user/profile.yml`** automatically. If the report recommends a change (e.g., drop a dead archetype), surface it as a suggestion in Appendix J and ask the user before editing.
- **Do not rerun `scripts/scan.mjs` or `scripts/analyze-patterns.mjs`** — those are separate modes. Positioning reads; it does not scan or re-process.
- **Respect the Data Contract.** This mode reads a lot of files but writes ONLY to `reports/positioning/positioning-*.md`.
- **One positioning report per month max.** If `reports/positioning/positioning-{YY-MM}.md` already exists, ask the user whether to overwrite or skip. Usually skip — a month's gap allows enough new data to accumulate.

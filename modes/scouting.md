# Mode: scouting — Single Evaluation Mode

## Purpose

`scouting` is the system's **only evaluation mode**. Given one listing — JD, URL, or a row already in scan data — it produces a scored report. The report says how the role rates against the user's archetypes, where the gaps are, what the comp situation looks like, and what the role does for the user's career arc.

This mode does NOT do CV tailoring (`modes/pdf.md`), interview prep (`modes/interview-prep.md`), or live application drafting (`modes/apply.md`). Those are separate per-listing skills the user triggers when they want them.

CF/AF rollup weights are fixed at 70/30 (Current Fit dominates — reachability is the primary question for an entry-level user mapping the landscape). Every evaluation produces the same report structure.

## Inputs

- `user/cv.md` (read-only — never tailored during evaluation)
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

Compute the listing's entity_id (see `frontend/src/lib/entityId.ts`) and look it up in `data/dedup-index.tsv` (which stores `entity_id` plus the legacy `(company_normalized, role_normalized)` columns for fuzzy fallback). For the full set of states that a hit can land in (DUPE / REPOST / CROSS-PORTAL ALIAS / 6+ months STALE), see `modes/pipeline.md` § Step 2b — the same logic applies to single-listing scouting evaluations.

In short: when an entity_id match hits with `last_seen_date < 6 months`, do not generate a duplicate report. The pipeline mode determines whether to refresh the URL (REPOST), record an alias, or skip silently. **6+ months old hits surface in `## Needs re-evaluation` and require explicit user opt-in** — auto-rescoring would burn tokens on entities the user may no longer care about.

## The Scoring Model

Use the **Dimensional Scoring Framework** defined in `modes/_shared.md`. Read that section first — it is the single source of truth. Do not redefine dimensions here.

The framework gives you, for every listing:
- **6 numeric scoring dimensions** (1-10, half-steps allowed), three rolling up into **Current Fit** and three into **Aspirational Fit**
- **Sales-Trap Risk** (scored 1-10, displayed for decision-support but NOT in the AF rollup)
- **3 numeric context dimensions** + **1 text context dimension** (Best Cities, Salary Adj for City, Work-Life Balance, Best-fit Early-career Roles)
- An **Overall** rollup: `Current Fit × 0.70 + Aspirational Fit × 0.30` (fixed weighting; see `_shared.md` § Overall).

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
| **Comp disclosure** | Disclosed figure or range, OR `[undisclosed]`. Salary Adj for City is computed by `scripts/score-listing.mjs` — see `_shared.md` § Salary Adj for City for the inputs to feed in. | `£45-55K + 13th month + £80/mo gym` London → fed to score-listing.mjs → returns score + full math. |
| **Geo / remote / visa** | Named office cities, remote policy, work-rights gating. | "Remote / multi-hub London-Barcelona-Lisbon" |

If any signal is missing from the JD, write `[not stated]` rather than guessing. The reasoning cells will then say `[no gate stated]` honestly instead of inventing one.

**The audit's job is traceability, not harshness.** Whatever scores the calibration math produces from the audit signals are the right scores — the audit doesn't bias toward lower numbers, it just makes sure each number can be defended by pointing at specific JD lines. A 7/10 Ease of Entry with the audit's hard-gate quote and a named brand-tier adjustment in the reasoning cell is fine. The same 7/10 with reasoning that says "competitive but reachable" is the failure mode, regardless of whether 7 was the right answer or not.

### Salary Adj for City — comp cache check

Follow the lookup flow defined in `modes/_shared.md` § Comp cache. Single rule across both phases: on a cache miss, run the WebSearch (Levels.fyi → Glassdoor → LinkedIn → Payscale → Blind), score against the city-specific bands in `_profile.md`, prepend `[estimated from {source}]` to the reasoning, and append a row to `data/comp-cache.tsv`. Score 5 only when the WebSearch genuinely returns nothing usable (mark `[undisclosed — no public data]`).

### Calibration hooks

- **Entry-level lens:** Apply the Score Calibration adjustments from `_profile.md` and the structured `calibration:` block in `user/profile.yml` (e.g., entry-level comp bands, mentorship bonus, brand-affinity bonuses, per-company `extra_brand_bonuses`).
- **Location policy:** The Best Cities context dimension reads from `_profile.md` → Your Location Policy. A preferred-cities top hit floors at 9.0; a non-preferred EU city floors at 6.0; outside EU drops to 2.0-3.0.
- **Dream-company floor:** If the company is in the user's dream list (`user/profile.yml` → `target_roles.dream_companies` or `_profile.md` → Dream Companies), floor **Brand Value at 10** AND **Aspirational Fit at 8.0** regardless of function match. The user wants their foot in the door.
- **Sales-Trap Risk reminder:** Sales-Trap Risk is scored (10 = well protected, 1 = high risk) and displayed in the table, but is **not included in the Aspirational Fit rollup**. It serves as a decision-support signal — a score of 1-2 should be flagged prominently as a red flag.

## Output Behavior — Framed by Score Bands

The report format depends on which **Score Band** the listing falls into based on its Overall and dimensional scores. **Always compute the full dimensional table first**, then determine the score band — the same table appears in every format so positioning can read it.

To maintain perfect compatibility with SQLite schemas, TSV parsing scripts, and Electron desktop dashboard components, all physical directory routing and serialization keys use the legacy "Tier" indicators (`T1`–`T4` codes and physical directory routing `reports/tier-{N}/`).

### Universal header (every Score Band writes this)

```markdown
# Scouting: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**URL:** {listing-specific url or "—"}
**Location:** {city, country} {remote-policy in 2–4 words}
**Archetype:** {primary, plus secondary if hybrid}
**Current Fit:** {X.X}/10
**Aspirational Fit:** {X.X}/10
**Overall:** {X.X}/10
**Tier:** {T1|T2|T3}
```

**Header discipline.** Each value is a clean short key/value pair — no parentheticals, no run-context annotations, no assumption-justification mid-sentence. The Tier line is mandatory and must match the report's tier directory (`T1` for Stellar, `T2` for Strong or Decent, `T3` for Pass / Growth Target); Skip matches `T4` under the hood but doesn't write a report. If you'd write `(reused from row #...)` or `(assumed — JD city not surfaced; X is Microsoft's EMEA hub...)`, delete it and move the analytical content into the appropriate body section (Role summary's Remote field, or Best Cities reasoning).

**URL discipline (NEVER write a generic portal URL).** The `**URL:**` field MUST be listing-specific — it points to a single job posting, not a company careers page. A listing URL contains a job identifier: `/jobs/{id}` (Greenhouse), a job-token slug (Lever, Ashby), a UUID, or `?gh_jid=...`. If the only URL you have is a portal homepage (`https://boards.greenhouse.io/{company}`, `https://jobs.ashbyhq.com/{company}`, `https://jobs.lever.co/{company}`, `https://careers.{company}.com`, etc.) — write `—` instead. Same rule for the `url` column in `data/score-history.tsv` (write `n/d`). Writing the portal URL pollutes the cross-table join key: two unrelated listings at the same company would collide on the same URL and the frontend cache would link them to the wrong report.

The Pass / Growth Target report uses the same header but its title prefix is `# Gap & Growth:` and its Mode is `scouting (growth target)`.

### Stellar Band — Overall ≥ 9.0 (or uniform fingerprint override: all 6 dims ≥ 8 AND both rollups ≥ 8.0)

Generate a **full report** — header above + the body sections defined under "Stellar body" below. Net length ~70–90 lines. Under the hood, this is saved to `reports/tier-1/` and marked as `T1`.

Surface to the user with: *"Strong match — full evaluation ready. If you want a tailored CV, run `/career-ops pdf` against the URL. If you're ready to actively apply, click Apply in the Database to move it to your active applications, then click Prep Application for interview intel."*

### Strong / Decent Bands — Overall 7.0–8.9 AND Ease of Entry > 4

Generate a **short summary report**. Universal header (with `**Tier:** T2` to map to the `reports/tier-2/` directory), same dimensional table, lighter body:

```markdown
## Dimensional scoring
(Standard report block — see modes/_shared.md § Standard report block format)

## Fit / gaps
{2 bullets max — strongest match + biggest gap}

## Verdict
{One line — "Apply with prep" for Strong (Overall 8.0–8.9) | "Apply if pipeline thin" for Decent (Overall 7.0–7.9) | "Track company only"}

## Path forward
{ONE sentence, concrete next step. No multi-step plans, no bullets.}
```

Strong (Overall 8.0–8.9) → "Apply with prep" verdict. Decent (Overall 7.0–7.9) → "Apply if pipeline thin" verdict. Both write `Tier: T2` to scouting.md, report headers, and score-history.tsv (no `T2-high` or other sub-tiers).

### Pass / Growth Target Band — Overall 5.0–6.9, OR < 7.0 with AF ≥ 7.0, OR Ease of Entry ≤ 4 gate

Generate a **Gap & Growth Report** — a roadmap, not a rejection. Universal header (title becomes `# Gap & Growth:`, `**Tier:** T3` to map to `reports/tier-3/` directory). Body is the most compact, ~25–30 lines:

```markdown
## Dimensional scoring
(Standard report block)

## Gaps and opportunities
- **Gap:** {1 bullet — the single biggest CF blocker + dimension}
- **Revisit when:** {one line, concrete trigger}
```

**Exception — language wall:** if the binding gap is a foreign-language requirement the candidate doesn't have (and isn't learning), force the Skip band instead. See `_shared.md` § "Language-barrier exception" — language acquisition is multi-year, so a Gap & Growth roadmap would be misleading.

### Skip Band — Overall < 5.0 or status SKIP

Both scores low (Overall < 5.0) or language wall exception → **skip**. Do NOT write a report file. **Still compute the full dimensional table** for `data/score-history.tsv` (mapped to `tier=skip`). Add a one-line entry to `data/scouting.md` with tier `T4`, report `—`, note `"T4 skip — {reason}"`.

## Stellar body

The Stellar report leads with the dimensional table — it's the load-bearing artifact. Everything else is short and grounded in the table.

```markdown
## Dimensional scoring
(Standard report block — see modes/_shared.md § Standard report block format)

## Peer ranking (optional — include only when ≥5 peers exist for the primary archetype in `data/score-history.tsv`)

---
**Rank vs {Archetype} peers:** {X.X}/10 — {percentile or position} of {N} roles evaluated
**Dimension outliers:** {dim ±X above/below avg} · {dim ±X} · {dim ±X}
**Closest comparables:** {Company} ({score}) · {Company} ({score}) · {Company} ({score})

(Skip this block entirely when <5 peers exist — never write `*(Not enough archetype peers yet…)*` or any system-state placeholder.)

## A) Role summary
| Field | Value |
|-------|-------|
| Archetype | {primary, plus secondary if hybrid} |
| Domain | {industry / sector / vertical} |
| Function | {what the role does day-to-day} |
| Seniority | {IC1 / IC2 / Manager + employment_type} |
| Remote | {full / hybrid / onsite + city detail} |
| Team size | {if mentioned in JD; else "—"} |
| TL;DR | {1 sentence, plain language} |

## B) Gaps and opportunities
For each gap closeable on a 6–12 month horizon: name it, cite the JD evidence, say how to close it. Skip generic advice. Max 3 bullets.

- **{Gap}** — JD requires {verbatim quote}; CV doesn't show it. **Close in {X weeks/months}** via {cert / project / proof point}.
- **{Gap 2}** — same shape.

If there are no meaningful gaps: *"No structural gaps — your profile maps directly onto the JD's stated requirements."*

## C) Comp & demand
One row. If estimated, mark it.
| Source | Band | Note |
|--------|------|------|
| {JD disclosed / Glassdoor estimate / comp-cache (cached YYYY-MM-DD)} | {€XX–YYK or €X/mo} | {1 line: vs. user threshold + posting freshness} |

## D) Recommendation
{2–3 lines max. The verdict (act / monitor / skip), the single biggest lever or blocker, and one growth pointer.}

If a hard constraint exists (scheduling conflict, work-rights gate, language wall, deadline already passed) that materially changes the verdict, surface it as a sentence in the Recommendation — `"Hard constraint: your next degree program starts before this role's start window and isn't deferrable."` Don't bury it in the Gaps section.

## E) Career path impact
**Read `user/profile.yml → profile.dream_companies` at render time.**

- **Accelerates toward:** {dream targets / archetypes}
- **Detours from:** {targets — often "none"}
- **Optionality:** {what exits/pivots this opens or closes}
- **Key gap to close:** {single most impactful gap + directional action}

## Calibration note (optional — include only when this evaluation reveals a NEW generalizable pattern)

*If this evaluation surfaces a rule that should bias future scoring (e.g. "rotational programs at the user's base city consistently override to T1", "Sales Ops at top-tier brands de-risks Sales-Trap Risk above the usual baseline", "listings older than 6 months at this company tend to be ghost-posted"), append one bullet here as a copy-pasteable suggestion for the user:*

> **Calibration note for `user/_profile.md`:** *{generalizable rule, written in the same shape as existing entries in user/_profile.md § Score Calibration. The user can copy-paste it.}*

Restraint: only write a note when a pattern actually generalizes — most evaluations only confirm existing rules and don't deserve one. This is the system's self-improvement loop; treat it as costly.
```

**Do NOT include:**
- "Match with CV" requirement-by-requirement table — the Skills Match cell + Gaps section cover it
- "Level and Strategy" prose — the Ease of Entry + Strategic/Analytical Fit cells cover it
- "Personalization Plan" CV/LinkedIn changes — that's `modes/pdf.md`
- "Interview Plan" with STAR stories — that's `modes/interview-prep.md`
- "Posting Legitimacy" assessment — not part of the scoring model
- "Extracted keywords" list — token waste, not actionable
- Trailing "## Notes" section — Recommendation already covers what's needed

The reader has the dimensional table to anchor everything. Each prose section earns its place by adding something the table doesn't already say.

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

## Workflow stage vs scoring

The frontend cockpit's "Scouting" and "Applying" tabs are about *where the entry sits in the user's workflow* (inventory vs active pipeline) — they don't change which evaluation runs or how it scores. Every evaluation uses this same mode and the fixed CF×0.70 + AF×0.30 rollup defined in `_shared.md` § Overall.

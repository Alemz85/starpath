# Mode: scouting — Single Evaluation Mode

## Purpose

`scouting` is the system's **only evaluation mode**. Given one listing — JD, URL, or a row already in scan data — it produces a scored report. The report says how the role rates against the user's archetypes, where the gaps are, what the comp situation looks like, and what the role does for the user's career arc.

This mode does NOT do CV tailoring (`modes/pdf.md`), interview prep (`modes/interview-prep.md`), or live application drafting (`modes/apply.md`). Those are separate per-listing skills the user triggers when they want them.

Every listing runs the same model — eligibility gate first, then Match and Ease, then the verdict grid (`modes/_shared.md`; contract `docs/scoring-v2.md`) — and every report that gets written has the same structure.

## Inputs

- `user/cv.md` (read-only — never tailored during evaluation)
- `modes/_shared.md` — the **Dimensional Scoring Framework** section is the source of truth for the eligibility checks, dimensions, rubrics, verdict grid and TSV columns. Always read it before scoring.
- `user/_profile.md` (archetypes, narrative, location policy, comp targets, dream companies)
- `user/profile.yml` (candidate identity, `eligibility:`, `calibration:` and `scoring:` blocks)
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

In short: when an entity_id match hits with `last_seen_date < 6 months`, do not generate a duplicate report. The pipeline mode determines whether to refresh the URL (REPOST), record an alias, or skip silently. **6+ months old hits surface in `## Needs re-evaluation` and require explicit user opt-in** An explicit re-evaluation request (from the user, or in a batch job's notes) bypasses the dedup skip at any age; the re-score then anchors on the previous scores (`modes/_shared.md` § Re-score anchoring). — auto-rescoring would burn tokens on entities the user may no longer care about.

## The Scoring Model

Use the **Dimensional Scoring Framework** defined in `modes/_shared.md` (contract: `docs/scoring-v2.md`). Read that section first — it is the single source of truth. Do not redefine dimensions here.

The framework gives you, for every listing, in this order:
- An **Eligibility gate** — six checks (`start_date`, `duration`, `graduation`, `language`, `work_auth`, `other`) → `green` / `amber` / `red`. Run it first with `node scripts/score-listing.mjs --eligibility-only`; `red` means **Blocked** and you stop before scoring dimensions.
- **Match** (1–10) — 4 motivators (Growth / Mobility, Optionality / Exit, Brand Value, Role content) plus 3 hygiene factors (City, Salary Adj for City, Work-Life Balance).
- **Ease** (1–10) — Skills Match, Experience bar, Competition, minus 0.5 per amber eligibility check.
- A **verdict** from the Match × Ease grid (`go` · `stretch` · `growth` · `solid` · `thin` · `skip` · `blocked`) and its storage tier `T1`–`T4`. There is no Overall.

All of it is computed by `scripts/score-listing.mjs` from the facts and integer judgment scores you pass in. The dimensional table is the load-bearing artifact. The prose around it is short.

### Required pre-scoring reads

Before assigning any scores, you MUST have read:
1. `user/cv.md` — for Skills Match and Experience bar anchoring
2. `user/_profile.md` — for archetype framing (what counts as target work for Role content), dream-company list, location policy, comp targets, Score Calibration adjustments
3. `user/profile.yml` — the `eligibility:` block the gate checks against, the `calibration:` block and optional `scoring:` weights
4. `modes/_shared.md` § Report Voice and § Dimensional Scoring Framework — the rubric and the **Reasoning cells** rule (no score without a reason a person can check).

### Pre-scoring JD audit (run BEFORE filling the dimensional table)

Skim the posting for ~30 seconds and write down the signals below **in scratch** — the audit is never pasted into the report. The reasoning cells draw from it; a cell that doesn't trace back to one of these is an *opinion*, not an evaluation.

| Signal | What to extract | Example |
|--------|-----------------|---------|
| **Eligibility facts** | Start date / window, duration, graduation window, required languages + levels, work location + work-rights / sponsorship wording, any other hard requirement (degree field, enrolment status, clearance). Quote each line — they become `eligibility_facts` (`_shared.md` § Step 1). | *"6-month internship starting March 2027; fluent French required"* |
| **Experience gates** | YoE bars, prior-background preferences. | *"Previous internship at a top-tier consultancy, bank or fast-growing tech company"* |
| **Brand tier** | Where the company sits on the Brand Value scale — it feeds Brand Value and the Competition brand-tier adjuster. | Recognized European unicorn → Brand Value 8 → Competition −3 |
| **Comp disclosure** | Disclosed figure or range, or undisclosed. Salary Adj for City is computed by `scripts/score-listing.mjs` (inputs: `_shared.md` § Salary Adj for City). | `£45-55K + 13th month + £80/mo gym` London → fed to score-listing.mjs |
| **Work content** | The 2–3 responsibilities that fill the day; any quota / pipeline / outbound language (feeds Role content and its sales cap). | *"Own a pipeline of 40+ outbound accounts per quarter"* |
| **Application documents** | What the posting asks you to submit (CV, cover letter, transcript, references, language test, anything else) and any upload limit, quoted. Silence stays "not stated". Feeds the `**Documents:**` header line. | *"Upload your CV and latest transcript as one PDF, max 1 MB"* |
| **Live constraints** | Anything in `user/_profile.md` that applies to *this* company or moment — a cap on applications per company, a role already applied to there, a timing rule. These often decide the listing. | *"Max two applications per company per cycle"* |

If a signal is missing, note "not stated" in scratch rather than guessing; the cell then says so in words, and a missing eligibility fact stays `null` (the gate reads it as amber where it matters).

**The audit's job is traceability, not harshness.** It doesn't bias toward lower numbers; it makes each number defensible by pointing at something in the posting.

### Salary Adj for City — comp cache check

Follow the lookup flow defined in `modes/_shared.md` § Comp cache. On a cache miss, run the WebSearch (Levels.fyi → Glassdoor → LinkedIn → Payscale → Blind), say where the estimate came from in the Comp section, and append a row to `data/comp-cache.tsv`. Score 5 only when the WebSearch genuinely returns nothing usable (and say so plainly).

### Calibration hooks

- **Entry-level lens:** Apply the Score Calibration adjustments from `_profile.md` and pass the structured `calibration:` block from `user/profile.yml` to the script (dream-company Match floor, lower-tier dream Match preference, per-company `extra_brand_bonuses`, structured-onboarding signal) — the script applies them. Brand itself is scored as a CV signal, never raised for liking the company.
- **Location policy:** The City hygiene factor reads from `_profile.md` → Your Location Policy. Top preferred city floors at 9; a non-preferred city inside the reachable region floors at 6; outside it drops to 2–3.
- **Dream-company floor:** a company in `calibration.dream_companies` gets Brand Value 10 and a **Match floor of 8.0** from the script — the hygiene and Role-content vetoes still win over it.
- **Referral:** if `data/network.md` shows a warm path (`npm run outreach-plan -- "Company" --summary`), pass `referral: "warm-direct"` or `"warm-intro"`; the script adds it to Competition.

### Lead with what decides this listing (run AFTER scoring, BEFORE writing prose)

Before writing a word of prose, answer in scratch: **what decides this listing?** Usually one or two things — the script's `explanation.bindingConstraints[0]` and `levers[0]`, an eligibility amber, or a live constraint from the audit (an application cap at this company can outweigh everything in the table). That answer opens the Recommendation and the Gaps, and everything that doesn't bear on it gets one line or nothing.

Then check the report against itself:

1. **One deciding factor, named once.** The same thing opens Gaps (or Fit/gaps) and the Recommendation. Don't introduce a second, different "biggest blocker" the table never surfaced.
2. **Verdict = grid.** The Recommendation's call is consistent with the verdict the script returned. A sharper call is fine — "Message a recruiter about the start date first, then decide" on a `stretch` with an open start date — but not one the grid contradicts. If you disagree with the grid, fix the scores and their reasons, don't paper over it in prose.
3. **One comp figure.** The gross quoted in Comp is the gross that fed the Salary Adj math.
4. **No fabricated timelines.** No calendars ("close in 6 weeks", "by Q3"). Effort *shape* (weekend reframe / short course / from-scratch build) and capability *triggers* (once your CV shows X) are allowed.

## Output Behavior — by verdict and tier

The report format depends on the **verdict** the script returns. **Always compute the full dimensional table first** (unless the listing is Blocked), then read the verdict — the same table appears in every report so positioning can read it.

Physical storage uses the tier keys: `go` → `T1` · `stretch` / `solid` / `thin` → `T2` · `growth` → `T3` · `skip` / `blocked` → `T4`. Reports live under `reports/tier-{N}/`; a T4 evaluation writes no file. The one exception is a report the user asks for (the app's Generate report on a Blocked or Skip row, render-only): it goes to `reports/tier-4/{Company} - {Role}.md` in the same format, and its job description is saved like any other report's.

**Save the job description.** Every report (T1–T3, and a T4 report the user asked for) keeps its posting text, because postings disappear. Right after writing the report, write the job description you fetched, verbatim, to `jds/{num}-{company-slug}-{role-slug}.md` with the Write tool. `{num}` is the report number (the scouting row's `{num}`, 3 digits), and each slug is the lowercase ASCII name with every run of other characters replaced by one `-`, at most 60 characters (`Nimbus Robotics` + `Data Analyst (Lyon)` → `jds/012-nimbus-robotics-data-analyst-lyon.md`). Write nothing for a T4 evaluation (no report), when the fetch returned no posting text (never rebuild a posting from memory or search snippets), or when that file already exists (a re-evaluation keeps the first copy). Format, exactly:

```markdown
# {Company} — {Role}

- **Company:** {Company}
- **Role:** {Role}
- **URL:** {the report's URL}
- **Fetched:** {today, YYYY-MM-DD}
- **Source:** worker

---

{the posting text exactly as fetched: every section (role, responsibilities, requirements, benefits, application notes); no summary, no translation, no edits, no commentary}
```

**Length targets (prose, excluding the tables):** T1 roughly **600–900 words**; T2 roughly **250–400**; T3 roughly **150–300**. Shorter is better when the listing is simple. Every section follows `_shared.md` § Report Voice.

### Universal header (every report writes this)

```markdown
# Scouting: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Location:** {city, country} {remote-policy in 2–4 words}
**Archetype:** {primary, plus secondary if hybrid}
**Match:** {match}/10 · **Ease:** {ease}/10
**Eligibility:** {green | amber — reasons ;-joined}
**Verdict:** {verdict_label} — {action}
**TL;DR:** {one plain sentence: the deciding factor and the call}
**Tier:** {T1|T2|T3}
**URL:** {listing-specific url or "—"}
**Posted:** {YYYY-MM-DD | n/d}
**Posting check:** {clean | caution — … | suspect — … | unchecked — …}
**Documents:** {CV {state} · cover letter {state} · transcript {state} · references {state} · language test {state} · {upload limits} · from the posting | not stated}
```

The Verdict line is `{verdict_label} — {action}` exactly as `_shared.md` § Standard report block format lists it (`Go — apply now`, `Stretch — apply with prep`, `Solid — apply`, `If pipeline thin — apply only if your pipeline is thin`, `Growth target — close the gap first`).

**Header discipline.** Each value is a clean short key/value pair — no parentheticals, no run-context annotations. The Tier line is mandatory and must match the report's tier directory.

**Posted date.** Find when the listing was first posted, from the source only, in this order: the posting check's `posted` field (or a `Posted (from page):` value in the task message); a publish/creation date in the ATS's own JSON for this job (`datePosted`, `first_published`, `publishedAt`, `postedOn`, Lever `createdAt`); schema.org `JobPosting` → `datePosted` in the page; a visible "Posted on …" line, or "posted N days/weeks ago" / "today" / "yesterday" converted against today's date. Write `**Posted:** YYYY-MM-DD`, or `**Posted:** n/d` when the source gives none. Never guess, and never use an `updated_at`, a deadline / `validThrough`, the scan date or today's date; "30+ days ago" is `n/d`. Listings found by the scanner already carry a posting date in `data/scan-history.tsv` (the app prefers it); the report's line is what a listing added by URL has.

**Posting check.** `node scripts/posting-guard.mjs --url '{url}' --save-text batch/work/check-{company-slug}.txt` before reading the posting; copy its `line`, and read the saved file as the posting (`_shared.md` § Untrusted content).

**Documents.** What the application asks the candidate to submit, so a mandatory transcript never turns up for the first time at the upload step. Read the posting's application section (how to apply, required documents, upload notes) and write one line of parts separated by ` · `: the five items in this order, each with one state, `CV`, `cover letter`, `transcript` (university transcript or grade record), `references`, `language test` (a test score or certificate), each `required`, `optional`, `not asked` or `not stated`; then upload limits when the posting gives them (`1 file`, `2 MB max`, together `1 file, 2 MB max`); then, without ` · ` inside it, a short note for anything else it asks you to send (`all documents in one PDF`, `writing sample required`); last, the source, `from the posting`. **Silence is `not stated`, never `not asked`:** a state other than `not stated` needs a sentence in the posting that says so (a posting that never mentions a cover letter has not said it doesn't want one). When the posting says nothing about what to submit, the whole value is `not stated`. Example (fictional): `**Documents:** CV required · cover letter optional · transcript required · references not stated · language test not stated · 1 file, 1 MB max · from the posting`. The apply flow replaces the line with what the real form asks, ending `from the form YYYY-MM-DD` (`modes/apply.md` § Paso 4b).

**URL discipline (NEVER write a generic portal URL).** The `**URL:**` field MUST be listing-specific — a job identifier (`/jobs/{id}`, a job-token slug, a UUID, `?gh_jid=...`). If the only URL you have is a portal homepage (`https://boards.greenhouse.io/{company}`, `https://jobs.ashbyhq.com/{company}`, `https://jobs.lever.co/{company}`, `https://careers.{company}.com`) — write `—` instead (`n/d` in the `url` column of `data/score-history.tsv`). A portal URL collides across every listing at the company and the frontend cache would link the wrong report.

Every report body is `## Eligibility`, `## Dimensional scoring` (see `_shared.md` § Standard report block format), then the tier's prose sections, and it **ends with the footer line** `Salary math: {salary_adj_for_city.math}`. The Growth target report uses the title prefix `# Gap & Growth:` and Mode `scouting (growth target)`.

### `go` — Go: apply now (T1)

Generate a **full report** — header + tables + the sections under "T1 body" below. Saved to `reports/tier-1/`. Promotion hint `READY`.

Surface to the user with: *"Go — full evaluation ready. If you want a tailored CV, run `/career-ops pdf` against the URL. If you're ready to apply, click Apply in the Database to move it to your active applications, then click Prep Application for interview intel."*

### `stretch`, `solid`, `thin` (T2)

Generate a **short summary report**. Universal header (`**Tier:** T2`, `reports/tier-2/`), same tables, lighter body:

```markdown
## Fit / gaps
- **Strongest match:** {the one thing that makes this worth your time, and why — one sentence.}
- **Biggest gap:** {the deciding factor, in plain words. Same one the Recommendation names.}

## Recommendation
{One line, the plain call: "Stretch — apply, but first fix X" | "Solid — apply" | "Only if your pipeline is thin: …". Use "Track company only" only when a constraint the gate couldn't model (deadline passed, an application cap at this company) overrides the grid — and name it in the same line.}

## Path forward
{ONE sentence: the one thing to do before submitting ("Ask the recruiter about the start date before you spend time on the application"). No timelines, no bullets.}
```

Promotion hint: `MONITOR` for `stretch` and `solid`; blank for `thin`. All three write `T2` to scouting.md, report headers and score-history.tsv.

### `growth` — Growth target: close the gap first (T3)

Match ≥ 8.0 but Ease < 5.0 (often the experience wall). Generate a **Gap & Growth Report** — a roadmap, not a rejection. Universal header (title `# Gap & Growth:`, `**Tier:** T3`, `reports/tier-3/`):

```markdown
## Gaps and opportunities
- **Gap:** {the one thing standing between you and this role, in plain words, with the posting's ask quoted if it helps.}
- **Revisit when:** {a capability trigger, not a date — "once your CV shows a shipped {domain} project" or "after you clear the {N}-year mark they ask for".}
```

If no single change would move the verdict, say so honestly rather than inventing a revisit trigger.

### `skip` (T4)

Match < 6.5, or Match 6.5–8.0 with Ease < 5.0. Do NOT write a report file. **Still compute the full dimensional table** for `data/score-history.tsv` (`tier=T4`, `verdict=skip`). Add a one-line scouting entry with tier `T4`, report `—`, note `"T4 skip — {reason}"`.

### `blocked` (T4, eligibility red)

The gate returned `red` — a language wall, a start date inside a blocked window, a hard graduation window, missing work rights without sponsorship, or a mandatory `other` requirement the CV fails. Do NOT write a report file. **When the gate's result says `scored: true`** (the profile's `eligibility.score_through_red` allows every red check; `modes/_shared.md` § Eligibility gate), score the dimensions as usual and log Match / Ease in score-history and the scouting entry; the verdict stays `blocked`, tier `T4`, Priority empty. **Otherwise** do not score dimensions: log a score-history row with the dimension, `match`, `ease` and `priority` columns empty (`eligibility=red`, `eligibility_flags` set, `verdict=blocked`, `tier=T4`) and a scouting entry whose Eligibility cell is `red: {reason}` and whose Match / Ease cells are `—`. If the company is in `calibration.dream_companies` / `lower_tier_dream_companies` / `brand_affinity_companies`, the note starts `Revisit next cycle:`.

## T1 body

After the tables, five short sections. Each says what matters for *this* listing and leaves the rest out.

```markdown
## Peer ranking (optional — only with ≥5 peers for the primary archetype in `data/score-history.tsv`; otherwise omit, no placeholder)
---
**Rank vs {Archetype} peers:** Match {X.X} · Ease {X.X} — Priority {percentile} of {N} roles evaluated
**Dimension outliers:** {dim ±X above/below avg} · {dim ±X}
**Closest comparables:** {Company} (M {X.X} · E {X.X}) · {Company} (M {X.X} · E {X.X}) · {Company} (M {X.X} · E {X.X})

## A) Role summary
| Field | Value |
|-------|-------|
| Domain | {industry / sector} |
| Function | {what the role does day-to-day, in a phrase} |
| Seniority | {level + employment type} |
| Remote | {full / hybrid / onsite + city} |
| TL;DR | {one plain sentence} |

## B) Gaps and opportunities
{Only the gaps that actually move the decision — often one, sometimes none, never padded to a count and never a sweep of every dimension below 8. Lead with the deciding factor. For each: what they ask for (quoted if it helps), why it matters for you, and the closing move with its effort shape (weekend reframe / short course / from-scratch build). A structural wall (multi-year experience, a language you don't have) is a constraint, not a gap — say so in one line and move on. No real gaps: "Nothing here you need to close first."}

## C) Comp & demand
| Source | Band | Note |
|--------|------|------|
| {Disclosed / estimated from Glassdoor / Levels.fyi / cached comp data, with the date} | {€XX–YYK or €X/mo gross} | {what it means for you after living costs, in plain words — same gross the Salary Adj score used; flag if the cached figure is over 60 days old} |

## D) Recommendation
{2–4 sentences. Open with the deciding factor and a plain call — "Message a recruiter about the start date first, then decide", "Apply this week; lead with your pricing project", "Apply, but it uses one of your two slots at this company — spend it here only if this beats their other opening". Weigh live constraints from the audit when they apply. Then, if it adds something, the one thing to do before submitting. Honest odds, no softening. The call must be consistent with the verdict grid; `skip` / `blocked` never become "apply".}

## E) Career path impact
{One or two real consequences for your path — where this role takes you that you want to go (name your actual targets from your profile), or what it pulls you away from. Grounded in the Optionality and Growth scores; no template bullets, no filler.}

## Calibration note (optional — only when this evaluation reveals a NEW generalizable pattern)
> **Calibration note for your profile:** {one copy-pasteable rule, e.g. "rotational programmes in your base city keep landing Go — worth a dedicated scan query"}
```

**Do NOT include:**
- A "## Why this score" section — the explanation drives what leads; it is not rendered
- A "how to close this gap" note for every dimension below 8, or any per-dimension sweep
- Requirement-by-requirement tick lists, or a "Match with CV" table
- "Level and Strategy" prose, "Personalization Plan" (that's `modes/pdf.md`), "Interview Plan" (that's `modes/interview-prep.md`), "Posting Legitimacy", "Extracted keywords"
- A trailing "## Notes" section

The tables anchor the numbers. Each prose section earns its place by saying something the tables don't.

## Multi-city role deduplication

When the pipeline feeds you **multi-city postings of the same role** (same JD copy, different cities — e.g., a fintech posting one Analytics Engineer role separately for two capitals), **generate a single "master" report at the highest-priority city and a one-line city-comparison delta for each additional city.** Do NOT produce two separate full reports.

**Detection:** same company + same role title + identical responsibilities/requirements section in the JD + different `office` / `location` field. City and Salary Adj for City are normally the only dimensions that vary between the variants.

**How to apply:**
1. Score the role once using the highest-priority city variant (defined by `_profile.md` → location policy, ordered preferred-cities list).
2. Write ONE report at `reports/tier-{N}/{Company} - {Role}.md` — the master.
3. For each additional city variant, append a one-line delta to the master report under a `## City variants` section:
   ```
   - **City B variant:** City 6/10 (vs 8/10 City A), Salary Adj 6/10 (vs 8/10 City A); Match 7.9 (vs 8.3); otherwise identical. Verdict solid (vs stretch).
   ```
4. Write ONE scouting tracker TSV entry referencing the master report; in the Notes column, list the other cities (e.g., `"Multi-city: City A (primary), City B"`).
5. Log ONE row to `data/score-history.tsv` for the master. If the user wants per-city trajectory later, positioning mode can parse the `## City variants` section.

**One posting, several cities.** A single posting that lists several offices the candidate can choose between (a graduate programme "based in Lyon, Vienna, Prague or Brussels") is one listing, not variants. Score City and Salary for the city the candidate would pick (the best one for them by `_profile.md`'s location policy, and say so in the City cell), and write every city in the `location` column, the scored one first, separated by `; ` with nothing in parentheses: `Lyon, France; Vienna, Austria; Prague, Czechia; Brussels, Belgium`. The app splits on `;` and ignores parenthesised text, so `Lyon (also Vienna, Prague)` shows as Lyon only. If a city the candidate would also accept changes the verdict, add it as a one-line `## City variants` delta as above.

**Edge case:** if the variants differ in more than location (a language requirement one has and the other doesn't, different work-rights wording, different responsibilities), treat them as separate roles and run the gate and scoring on each independently.

## Data Layer — Score History Logging

**EVERY evaluation must append a row to `data/score-history.tsv`**, regardless of tier (including Tier 4 skips and Blocked listings). This is the trajectory log. Append it with `node scripts/append-score-rows.mjs --input batch/work/<id>-rows.json` (`modes/_shared.md` § Logging), never with shell redirection.

The TSV format and column order are defined in `modes/_shared.md` § "Logging to data/score-history.tsv". Use exactly that format — do NOT invent columns here.

For evaluation rows:
- `mode` → `scouting`
- `tier` → `T1` | `T2` | `T3` | `T4`
- `verdict` → the verdict key; `eligibility` → `green` | `amber` | `red`; `eligibility_flags` → `check:status:reason` for each non-green check, `;`-joined
- `source` → `url` | `paste` | `scan` | `pipeline`

The dimension columns must be filled even for `skip` rows — that's the point of logging them (so positioning can see what the user *isn't* a fit for and why). Blocked rows are the one exception: dimension, `match`, `ease` and `priority` columns stay empty, and the eligibility columns carry the why.

Also fill the metadata columns: `location`, `employment_type`, `duration`, `salary_raw`, `url` (see `_shared.md` for definitions). Use `n/d` for any that are unknown.

## Report Summary Cache

After writing the report (or recording a T4 skip / Blocked listing), also append a row to `data/report-summaries.tsv` (headerless, 10 columns; the `report_summary` object of the same `append-score-rows.mjs` input file, keys `date`, `company`, `role`, `archetype`, `tier`, `match`, `ease`, `eligibility`, `key_gaps`, `verdict`):

```
{date}	{company}	{role}	{archetype}	{tier}	{match}	{ease}	{eligibility}	{key_gaps}	{verdict}
```

- `tier` — `T1` | `T2` | `T3` | `T4`
- `match` / `ease` — the script's numbers; empty for Blocked rows
- `eligibility` — `green` | `amber` | `red`
- `key_gaps` — pipe-separated list of dimensions scored ≤ 5/10, max 3 (e.g. `Experience bar|Skills Match`). Use `—` when none (and for Blocked rows).
- `verdict` — the verdict key (`go` · `stretch` · `growth` · `solid` · `thin` · `skip` · `blocked`)

This lets `positioning` mode read one lightweight TSV instead of opening 70+ full report files.

## Tracker Entry

Evaluations are landscape-mapping inventory by default. They live in **`data/scouting.md`** — separate from `data/applications.md` — so the active-application flow stays uncontaminated by exploratory evaluations. The user clicks "Apply" in the Database (or runs `node scripts/promote-to-applications.mjs <num>`) to move an entry into the active flow.

Write a TSV entry to `batch/scouting-additions/{num}-{company-slug}.tsv` (let `scripts/merge-scouting.mjs` handle the merge into `data/scouting.md`). **12 tab-separated columns** (no status field — tier and verdict replace status here):

```
{num}	{date}	{company}	{role}	{match}	{ease}	{tier}	{eligibility}	[{num}](reports/tier-{N}/{Company} - {Role}.md)	{deadline}	{promotion_hint}	{one-line summary}
```

**Report file path:** reports live in **`reports/tier-{N}/{Company} - {Role}.md`** where `{N}` is the tier digit (1, 2 or 3). T4 (skip and blocked) uses `—` for the report column and writes nothing to disk; only a report the user asks for later lands in `reports/tier-4/` (§ Output Behavior).

Column order:
1. `num` — sequential number (integer)
2. `date` — YYYY-MM-DD
3. `company` — short company name
4. `role` — job title
5. `match` — the script's Match, plain number (`8.25`, no `/10`); `—` when blocked
6. `ease` — the script's Ease, plain number (`5.6`); `—` when blocked
7. `tier` — `T1` | `T2` | `T3` | `T4`
8. `eligibility` — `green`, `amber: {reasons ;-joined}`, or `red: {reason}`
9. `report` — markdown link `[num](reports/tier-{N}/{Company} - {Role}.md)` or `—` for T4
10. `deadline` — application deadline as stated in the JD (e.g. `2026-06-30`, `Rolling`, `n/d`). Use `n/d` if not stated.
11. `promotion_hint` — `READY` for `go`, `MONITOR` for `stretch` and `solid`, empty otherwise
12. `notes` — one-line summary naming this role's strongest signal; for Blocked rows the blocking reason (prefixed `Revisit next cycle:` for dream / affinity companies)

- **PDF:** Evaluation never auto-generates a PDF. CV / PDF generation is a separate, manual operation via `/career-ops pdf` (or the Database popover's "Tailor CV" button).
- **T4 rows:** still write the TSV with tier `T4`, report `—`, deadline as stated (or `n/d`), and a short note.
- **Promotion:** `go` rows get `READY`. The user runs `node scripts/promote-to-applications.mjs <num>` (or clicks Apply in the Database) to move an entry into `data/applications.md` with status `Evaluated` and a `M8.3 E5.6` Score cell. Blocked rows are never promoted. The scouting row stays as a historical record (its Promotion Hint flips to `PROMOTED-{app_num}`).

## File Naming

Report files use a human-readable `{Company} - {Role}.md` naming convention:

```
reports/tier-{N}/{Company} - {Role}.md
```

Where `{N}` is the tier (1, 2 or 3). In the filename only, drop `( ) [ ] : / \ ? * " < > |` and collapse spaces, so a role like "Data Analyst (Lyon, autumn start)" is saved as `Data Analyst Lyon, autumn start.md` and the markdown link never breaks; the tracker cells keep the exact title. The link text in the scouting row is that row's own `{num}`. T4 rows do NOT write a file — they only get a one-line entry in `data/scouting.md` with `—` in the report column.

**Examples (fictional):**
- `reports/tier-1/Acme Analytics - Intern Technology Consultant.md`
- `reports/tier-2/Northwind - Customer Data Analyst.md`
- `reports/tier-3/Globex - GTM Strategy-Operations Associate.md`

The tier subfolder layout makes it trivial to browse just the `go` hits when deciding what to promote (`reports/tier-1/`), or scan the candidate-pool shape at a glance (`ls reports/tier-*` shows the distribution).

## Workflow stage vs scoring

The frontend cockpit's "Scouting" and "Applying" tabs are about *where the entry sits in the user's workflow* (inventory vs active pipeline) — they don't change which evaluation runs or how it scores. Every evaluation uses this same mode and the eligibility → Match → Ease → verdict model defined in `_shared.md`.

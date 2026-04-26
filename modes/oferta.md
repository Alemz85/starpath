# Mode: oferta — Full A-H Evaluation (+ I conditional)

When the candidate pastes an offer (text or URL), ALWAYS deliver all 8 blocks (A-F evaluation + G legitimacy + H dimensional scoring). Block I (Draft Application Answers) is conditional on `score >= 9.0`.

## Step 0 — Archetype Detection

Classify the offer into one of the 6 archetypes (see `_shared.md`). If hybrid, indicate the 2 closest. This determines:
- Which proof points to prioritize in Block B
- How to rewrite the summary in Block E
- Which STAR stories to prepare in Block F

## Block A — Role Summary

Table with:
- Detected archetype
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Function (build/consult/manage/deploy)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Block B — Match with CV

Read `user/cv.md`. Build a concise table with the **top 5 JD requirements** mapped to CV evidence (prioritized by archetype — FDE: delivery/client-facing, SA: architecture, PM: product/metrics, LLMOps: evals/pipelines, Agentic: orchestration/HITL, Transformation: adoption/change).

Then a **gaps** section: list only hard blockers (max 3), each with a one-line mitigation.

## Block C — Level and Strategy

One paragraph covering: level detected vs candidate's natural level, the strongest "sell-up" angle (archetype-specific), and the downlevel contingency (comp floor + review timeline).

## Block D — Comp and Demand

**Comp cache check (do this FIRST, before any WebSearch):**
1. Derive `role_type` from the archetype (e.g., `internship-analyst`, `entry-sales`, `entry-consultant`)
2. Read `data/comp-cache.tsv` — find the most recent row matching `company + role_type + city`
3. If a match exists and is **less than 60 days old** → use cached values, skip the comp WebSearch, note *(cached {date})*
4. If no match or stale → run WebSearch (Glassdoor, Levels.fyi, Blind), then append a new row to `data/comp-cache.tsv`

**Company research cache check:**
1. Compute slug: company name → lowercase, hyphens
2. Read `data/companies/{slug}.md` if it exists; check `<!-- cached: YYYY-MM-DD -->` header
3. If **less than 30 days old** → use for company reputation / WLB section, skip company WebSearch
4. If missing or stale → run company research WebSearch; save result to `data/companies/{slug}.md`

**Output:** Table with comp data and cited sources. If there's no data, say so instead of inventing.

## Block E — Personalization Plan

Top 3 CV changes (table: Section | Change | Why). LinkedIn changes only if meaningfully different from CV changes.

## Block F — Interview Plan

**Before generating any stories:**
1. Read `interview-prep/story-bank.md` if it exists. Parse story titles (first `###` heading in each story block).
2. For each of the top 5 JD requirements, check if an existing story already covers it (match on skill/theme keywords).
3. **Reuse** matching stories — reference them by title rather than regenerating. Reframe the opening sentence to this specific role's context if needed, but do not recreate the full story.
4. **Only generate new STAR+R stories** for requirements not covered by existing bank stories.
5. **Dedup rule on append:** Before appending any new story to `interview-prep/story-bank.md`, check the title. If a story with the same title (case-insensitive) already exists in the bank, do not append — update the existing story instead.

**Output:** 3-5 STAR+R stories (STAR + **Reflection**) mapped to the most critical JD requirements, framed by archetype. For reused stories, note `[from story bank]`. For new stories, append them to `interview-prep/story-bank.md`.

Also: 1 recommended case study + top 2 red-flag questions with suggested answers.

## Block G — Posting Legitimacy

Analyze the job posting for signals that indicate whether this is a real, active opening. This helps the user prioritize their effort on opportunities most likely to result in a hiring process.

**Ethical framing:** Present observations, not accusations. Every signal has legitimate explanations. The user decides how to weigh them.

### What to check (in order):
1. **Freshness:** posting date, Apply button state, any redirect to generic page
2. **JD quality:** specific tech/tools named? realistic YoE? scope defined? comp mentioned?
3. **Hiring signals:** 1 WebSearch for `"{company}" layoffs OR hiring freeze {year}` — only note if same department
4. **Reposting:** check scan-history.tsv for same company + similar title with different URL

### Output format:

**Assessment:** `High Confidence` | `Proceed with Caution` | `Suspicious` — one line with the key signal behind the verdict. No signal table — just the verdict + 1-2 supporting observations.

### Edge case handling:
- **Government/academic postings:** Longer timelines are standard. Adjust thresholds (60-90 days is normal).
- **Evergreen/continuous hire postings:** If the JD explicitly says "ongoing" or "rolling," note it as context -- this is not a ghost job, it is a pipeline role.
- **Niche/executive roles:** Staff+, VP, Director, or highly specialized roles legitimately stay open for months. Adjust age thresholds accordingly.
- **Startup / pre-revenue:** Early-stage companies may have vague JDs because the role is genuinely undefined. Weight description vagueness less heavily.
- **No date available:** If posting age cannot be determined and no other signals are concerning, default to "Proceed with Caution" with a note that limited data was available. NEVER default to "Suspicious" without evidence.
- **Recruiter-sourced (no public posting):** Freshness signals unavailable. Note that active recruiter contact is itself a positive legitimacy signal.

## Block H — Dimensional Scoring (shared with scouting)

This block runs the **Dimensional Scoring Framework** defined in `modes/_shared.md` and **always** appears in every oferta report. It is the same framework `scouting` mode uses, so:
- A single career assessment can read both scouting reports and oferta reports
- The `positioning` mode can compute per-archetype, per-dimension trajectories regardless of which mode produced each row
- Comparing oferta evaluations to earlier scouting evaluations of the same role is straightforward

Read `modes/_shared.md` § "Dimensional Scoring Framework" for the full rubric. In short:

**7 numeric scoring dimensions (1-10, half-steps allowed):**
- *Current Fit components:* Skills Match, Ease of Entry, Strategic/Analytical Fit
- *Aspirational Fit components:* Growth/Mobility, Optionality/Exit, Brand Value, Sales-Trap Risk *(10 = well protected)*

**4 context dimensions (do not roll up):**
- Best Cities (1-10), Salary Adj for City (1-10), Work-Life Balance (1-10), Best-fit Early-career Roles (text list)

**Rollups:**
```
Current Fit       = (Skills Match + Ease of Entry + Strategic/Analytical Fit) / 3
Aspirational Fit  = (Growth/Mobility + Optionality/Exit + Brand Value) / 3
Overall (H)       = Current Fit × 0.6 + Aspirational Fit × 0.4   ← job-seeking weights (see _profile.md § CF/AF Phase Weighting)
```

**Render as the standard 14-row dimensional table** (see `_shared.md` for the exact format).

**How Block H relates to the other oferta blocks:**
- Block H **does not replace** the existing 1-10 global Score in the report header. The header Score reflects the broader oferta judgment (fit + comp + cultural + red flags). Block H adds the structured, comparable dimensional view.
- Block B (Match with CV) findings should anchor Skills Match.
- Block C (Level and Strategy) findings should anchor Ease of Entry.
- Block D (Comp and Demand) findings should anchor Salary Adj for City.
- Block A (role detection) and the JD content should anchor Strategic/Analytical Fit and Sales-Trap Risk.
- WebSearch findings on company reputation (Glassdoor / Blind / Levels.fyi) anchor Brand Value and Work-Life Balance.

**You may write Block H once you have completed Blocks A-D.** Blocks E, F, G can run in parallel with or after H; they do not need its output.

**Logging:** When the report is saved:

1. Append a row to `data/score-history.tsv` (see `_shared.md` § "Logging to data/score-history.tsv"):
   - `mode` → `oferta`
   - `tier` → `oferta`
   - `source` → `url` | `paste` | `scan` | `pipeline` | `batch`
   - Fill the 4 metadata columns: `location`, `employment_type`, `duration`, `salary_raw` (use `n/d` if not in JD)

2. Append a row to `data/report-summaries.tsv`:
   ```
   {date}	{company}	{role}	{archetype}	oferta	{overall}	{cf}	{af}	{key_gaps}	{verdict_one_line}
   ```
   - `key_gaps` — pipe-separated dims scored ≤ 5/10, max 3 (e.g. `EoE|Skills Match`). Use `—` if none.
   - `verdict_one_line` — the single-sentence recommendation from the report

---

## Post-evaluation

**ALWAYS** after generating blocks A-H:

### 1. Save report .md

Save the full evaluation to `reports/tier-{N}/{Company} - {Role}.md`.

- `{N}` = tier derived from the global Score: `Score ≥ 9.0 → tier-1`, `7.0 ≤ Score < 9.0 → tier-2`, `Score < 7.0 → tier-3`, `SKIP → tier-4`
- `{Company}` = company name as-is (e.g., `PwC`, `Celonis`, `Red Bull`)
- `{Role}` = job title as-is, with filesystem-unsafe characters replaced by hyphens

**Report format:**

```markdown
# Evaluation: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Archetype:** {detected}
**Score:** {X.X/10}
**Legitimacy:** {High Confidence | Proceed with Caution | Suspicious}
**Current Fit:** {X.X}/10  *(from Block H)*
**Aspirational Fit:** {X.X}/10  *(from Block H)*
**Overall (H rollup):** {X.X}/10
**PDF:** {path or pending}

---

## A) Role Summary
(full contents of block A)

## B) Match with CV
(full contents of block B)

## C) Level and Strategy
(full contents of block C)

## D) Comp and Demand
(full contents of block D)

## E) Personalization Plan
(full contents of block E)

## F) Interview Plan
(full contents of block F)

## G) Posting Legitimacy
(full contents of block G)

## H) Dimensional Scoring
(always present — the 14-row dimensional table from `_shared.md`. Shared format with `scouting` mode so positioning can read both. Rolls up into Current Fit / Aspirational Fit / Overall.)

## I) Draft Application Answers
(only if score >= 9.0 — draft answers for the application form)

---

## Extracted keywords
(list of 15-20 JD keywords for ATS optimization)
```

### 2. Register in tracker

**ALWAYS** register in `data/applications.md`:
- Next sequential number
- Current date
- Company
- Role
- Score: global oferta score (1-10)
- Status: `Evaluated`
- PDF: ❌ (or ✅ if auto-pipeline generated the PDF)
- Report: relative link to the report .md (e.g., `[001](reports/tier-2/001-company-2026-01-01.md)`)

**Tracker format:**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```

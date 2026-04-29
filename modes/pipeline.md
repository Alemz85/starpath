# Mode: pipeline — URL Inbox (Second Brain)

> **Autonomous-mode contract.** This mode is spawned non-interactively from the starpath frontend (`shell:spawn` → `claude -p`), so no human is in the loop to answer questions. Follow these rules at all times:
>
> - **Don't ask the user any questions.** Not "want me to continue?", not "should I also do X?", not "want me to run the update next?". Make the call yourself or fall through to a sensible default.
> - **Don't propose follow-up actions** at the end. Print a one-line completion summary (rows added, files written, exit code) and stop.
> - **Don't run side-checks** like update polls, "first message of session" hooks, or unrelated diagnostics — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed without input — corrupted file, missing config, ambiguous instruction — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task. Don't loiter waiting.

Process accumulated job offer URLs in `data/pipeline.md`. The user adds URLs whenever they want, then runs `/career-ops pipeline` to process them all.

## Step 0 — Source synchronization

Before processing any URL:
```bash
node scripts/cv-sync-check.mjs
```
If there's a desync, warn the user before continuing.

## Step 1 — Read and triage the Pending section

1. Read all `- [ ]` items from the "Pending" section of `data/pipeline.md`
2. **Age-flag stale entries:** Any entry whose date metadata (or the date it was added, if recorded) is **older than 14 days** from today → prepend `[STALE]` to the item. Before evaluating a stale entry, run a quick liveness check with Playwright (`browser_navigate` + `browser_snapshot`) to confirm the posting is still live. If it's closed → mark `[!] CLOSED` and skip evaluation.
3. **Company grouping:** Collect all URLs, then group by detected company name. Process all URLs from the same company consecutively — this ensures multi-city dedup logic (see `modes/scouting.md` § "Multi-city role deduplication") fires correctly.
4. **Priority ordering:** Within each company group, and across companies, sort the processing queue in this order:
   - **Priority 1 — Dream companies** (from `user/_profile.md` § Dream Companies): always first
   - **Priority 2 — Preferred companies** (from `user/profile.yml` → `target_roles` or any company in `_profile.md`'s archetype examples): second
   - **Priority 3 — Tier estimate from scan metadata** (if the pipeline entry was added by `scripts/scan.mjs` and includes a tier hint): T1 hints before T2 before unknown
   - **Priority 4 — Date added ascending** (oldest first among equals, so nothing ages out indefinitely)

## Step 2 — Pre-eval dedup check

Dedup uses `data/dedup-index.tsv` (columns: `company_normalized`, `role_normalized`, `last_seen_date`). The merge scripts append to this index automatically. The full `data/scouting.md` and `data/applications.md` markdown files remain the source of truth — only the dedup pointer changes.

**Step 2a — Staleness gate (run BEFORE reading the index):**

Compare the maximum `last_seen_date` in `data/dedup-index.tsv` against the maximum `Date` column in `data/scouting.md` AND `data/applications.md`. If either source-of-truth file has a date newer than the index max, the index is stale (likely from an out-of-band manual edit).

**Halt the evaluation** and tell the user:

> Dedup index is stale (max index date {INDEX_DATE} < max scouting/applications date {SOURCE_DATE}). Run `node scripts/rebuild-dedup-index.mjs` and then re-run this evaluation.

Do NOT proceed with stale dedup data — silent misses are exactly what this index is supposed to prevent.

**Step 2b — Lookup:**

For each URL's detected company + role, look up `(normalize(company), normalize(role))` in `data/dedup-index.tsv` (normalize = lowercase + alphanum-only for company, lowercase + collapsed whitespace + trimmed for role). Apply fuzzy role matching (ignore minor title variations like trailing dates, parenthetical market tags, "(all genders)" suffixes) against the `role_normalized` column.

- If a match exists **and `last_seen_date` is less than 6 months old** → skip:
  - Mark as `- [x] DUPE | URL | Company | Role | → existing #{num}`
  - Move to "Processed" referencing the existing report (look up the entry number in `data/scouting.md` or `data/applications.md` if needed)
- If the match is **6+ months old** → re-evaluate (CV or JD may have changed since)

## Step 2c — Relevance gate (DISCARD irrelevant listings BEFORE scoring)

**Why this exists:** the title-filter in `user/portals.yml` is permissive — a single positive keyword admits the URL into the pipeline. After scan typically lets a few hundred URLs through. Many are off-archetype on JD inspection. Scoring all of them dilutes the 1-10 scale and floods the Database with noise the user has to wade through. This gate cuts the scored set down to listings that are *actually plausible* given the user's archetypes, location, comp targets, and visa.

**The survivor count is a RESULT, not a TARGET.** Earlier versions of this rule had a "expect ~20-30% to survive" framing, which pressured the agent to pad the pass-list with marginal fits when the true number was lower. Don't do that. If 5 / 350 URLs are honest fits, the right answer is 5. If 250 / 350 are honest fits, the right answer is 250. Apply the gate per JD; let the count fall where it falls. (Sanity flag: if survivors < 5% of input OR > 80% of input, mention it in the run summary — that signals either an upstream pool problem or a gate calibration drift, both worth surfacing.)

For each non-duplicate URL, fetch the JD (Playwright/WebFetch) and run a fast pre-scoring check against the user's profile (`user/_profile.md` archetypes, `user/profile.yml` target_roles, location policy):

**Discard (mark `- [!] FILTERED — {reason}` in pipeline.md, do NOT score, do NOT add to scouting.md, do NOT write a row to score-history.tsv) if ANY of:**

1. **Wrong archetype.** The JD's actual day-to-day work does not map to any of the user's primary or secondary archetypes. Be honest about this — "could plausibly contribute to" is not the bar; "this role's core responsibilities are something the user actually wants to do" is the bar. Examples to discard: pure quota-carrying sales (BDR/SDR/AE) when user wants Strategy/Analytics; pure customer-support / customer-success-rep work without analytics scope; pure delivery / logistics / supply-chain ops; pure clinical / medical / nursing; pure legal counsel; pure backend / frontend / mobile engineering; pure finance / audit / tax / payroll / accounting (unless analytics-finance-bridge is named in archetypes).
2. **Wrong seniority.** The JD body requires **5+ years of experience**, OR titles "Senior", "Lead", "Principal", "Manager (with reports)", "Director" that slipped past title-filter. Internships, graduate programmes, and 0–3 YoE roles are in scope.
3. **Geo-locked outside user's reachable set.** Location is US-only (no EU work-rights / no remote-EU option), or restricted to a country the user cannot legally work in, or requires a clearance the user does not hold.
4. **Excluded domain.** Defense, weapons, oil & gas, online gambling, adult content, MLM/pyramid, predatory lending, tobacco/vaping — unless the user has explicitly opted in via `_profile.md`.
5. **Visa-locked.** "Must be a US citizen", "active TS/SCI clearance required", "Italian passport required" when user is non-Italian, etc. (Soft visa friction — e.g., UK roles for EU citizens — is NOT a discard; it's an Ease of Entry penalty per `_shared.md` § Ease of Entry calibration.)
6. **Poverty-wage.** Salary is disclosed and is < 50% of the city's threshold from `_profile.md` § City-Specific Salary Bands. (Disclosed-but-low-band stays in — gets a low Salary Adj score; only *poverty wage* discards.)
7. **JD body explicitly contradicts a user red flag.** `_profile.md` § Red Flags to Watch For lists categorical mismatches the user has surfaced (commission-only / 2-3+ years required / non-tech "analytics" = Excel reporting / etc). If a JD matches a stated red flag, discard.

**Borderline cases — DISCARD, don't score.** When in doubt, the listing is OUT. The bar for inclusion is *"I can write a one-sentence reason, citing JD evidence, why this role is a fit for one of the user's primary or secondary archetypes."* If you cannot articulate that sentence honestly, the listing is not a fit — move it to `## Filtered Out` and the user can audit. Padding the Database with 5/10s the user has to manually reject is worse than a tight gate the user has to occasionally widen.

(This is the opposite of the previous version of this rule, which said "when in doubt, score it." That framing produced runs where ~50/350 were honest fits but ~140/350 ended up scored, including obviously off-archetype rotations the user then had to filter out manually in the GUI. The corrected framing: trust the gate, let the user widen it via Filtered Out review if it overshoots.)

**Tracking discards.** Move discarded URLs from Pending to a new **Filtered Out** section in `data/pipeline.md`:

```markdown
## Filtered Out
- [!] FILTERED | URL | Company | Role | reason
```

This keeps an auditable trail without polluting `scouting.md`. The user can review the Filtered Out section if they think the gate was too aggressive — and if they spot a pattern (e.g., 5+ rotations they DID want that got dropped), they can update `_profile.md` archetypes and re-run.

### Step 2c.1 — Multi-variant collapse (after the discard gate, before scoring)

The discard gate above kills *off-archetype* listings. It does NOT catch the failure mode where a single company posts the **same role under many sub-flavor titles**. PwC Italy's "Milano DIG" rotation gets posted as 22 separate URLs (Customer Data Analyst, GenAI Adoption Intern, Tech Transfer Hub, Digital Innovation, Data & AI Consultant, AI Developer Intern, Hyperautomation Low-Code, etc.). PwC Brussels' "School Internship 2026-2027" gets 15 URLs (HR / Cloud & Data / Management Consulting / EU Procurement / People & Transformation / Talent / Industrials / Managed Services / Data Consulting / Tech Strategy + 2025-2026 dupes). A single graduate intake gets scored 22× and dominates the Database. Same problem the multi-city dedup in `modes/scouting.md` solved for cities — apply it here for sub-flavors.

**Trigger.** After the discard gate, group the surviving URLs by `(company, archetype, level, city or region)`. For any group with **≥ 6 URLs**, treat it as one "umbrella" and score ONE master.

- `company` — case-insensitive exact match.
- `archetype` — after `canonicalizeArchetype()` from `frontend/src/lib/archetype.ts` so "AI Developer" / "Data & AI Consultant" / "Customer Data Scientist / AI Consultant" all resolve to "Data Scientist" or similar canonical bucket.
- `level` — Intern / Graduate / Junior / Associate from the title or JD.
- `city or region` — same city if all rows share one (Milan), or the same internship-program region (Brussels School Internship covers all of Belgium for the candidate's purposes).

**Master selection.** Within a triggering group, pick the master by:

1. The variant whose role title most directly maps to a primary archetype in `_profile.md` § Target Role Matrix. (e.g., for the PwC Milano DIG cluster: "Data & AI Consultant" beats "Hyperautomation Low-Code" because Data Analyst is a primary archetype and Hyperautomation isn't.)
2. Tie-break on the variant with the most disclosed metadata (location, comp band, deadline).
3. Final tie-break on whichever variant the user's CV maps to most cleanly (Skills Match would be highest for that one).

**Scoring the master.** Score it normally per `modes/scouting.md`. The dimensional scoring reflects THIS specific variant — not an average across the cluster. Master gets the full row in `data/scouting.md` and a row in `data/score-history.tsv`.

**Variants → Notes column on the master row.** Add a one-line `## Variants` block to the master's Notes column (in `data/scouting.md`) listing the other variants:

```
## Variants
- AI Developer Intern Milano (DIG)         — slightly stronger AI/ML stack required
- GenAI Adoption Intern Milano (DIG)       — change-mgmt focus
- Junior Data Engineer Milano              — pipelines + cloud focus
- Customer Data Scientist Milano           — same archetype, customer-data emphasis
- (... 18 more variants)                    — same umbrella, different sub-flavor
```

If a variant materially differs from the master on any dimension (different stack, different client face, different city), note that in the one-line summary. If it's just a different sub-category of the same rotation, the variant line can be terse.

**Mark the absorbed variants** in `data/pipeline.md` as `- [x] VARIANT | URL | Company | Role | → master #{num}` and move them to "Processed" — same shape as DUPE. Do NOT write any other row anywhere for them.

**When NOT to collapse.**

- Cluster size < 6 — small batches stay individually scored. Worth the per-row signal.
- Different cities — already handled by `modes/scouting.md` § Multi-city role deduplication. Don't double-collapse.
- Different actual archetypes — if PwC Milano posts both an "Advisory Consultant Internship" AND a "Software Engineer Internship", those are different archetypes and both score (or one gets discarded by the gate).
- Different levels — an Internship and a Graduate role at the same company are different levels; keep both.

**Why this exists.** A pre-fix run produced 55/94 entries from PwC alone (15× School Internship Brussels, 22× Milano DIG, etc) — 59% of the Database from one company's posting hygiene. The umbrella collapse honestly represents the user's actual decision space ("apply to PwC Milano DIG: yes/no") instead of inflating it into 22 separate decisions about variants of the same rotation.

## Step 3 — Evaluate each non-duplicate URL

For each URL that **survived Step 2c** (in priority order):

a. Compute the next sequential entry number: read `data/scouting.md` + `data/applications.md`, take highest number + 1
b. **Extract JD:** Playwright (`browser_navigate` + `browser_snapshot`) → WebFetch → WebSearch
c. If not accessible → mark `- [!]` with a note and continue
d. **Run auto-pipeline** based on `user/profile.yml → current_mode`:
   - `scouting` → `modes/scouting.md`
   - `applying` → `modes/oferta.md`
e. **Move from Pending to Processed:** `- [x] #NNN | URL | Company | Role | Score/10 | Tier | PDF ✅/❌`

**If 3+ pending URLs:** launch agents in parallel (`Agent tool` with `run_in_background`) to maximize speed. Keep company grouping intact — evaluate the same-company batch together before dispatching the next company.

## Step 4 — Summary

When all URLs are processed, show:

```
| # | Company | Role | Score/10 | Tier | PDF | Action |
```

Sort by Score descending. Include a note for any `[STALE]` entries that were liveness-checked and found closed.

## Step 5 — Filter Intelligence (automatic, silent)

Run this after every batch of **3+ evaluations**. Takes ~10 seconds and requires no user input unless suggestions are ready.

### 5a — Detect false positives

Collect every posting in this batch that:
- Passed the title filter (i.e., the scanner let it through), AND
- Scored **< 4.5 Overall**

These are false positives from the scanner's perspective — the keywords were too permissive.

For each, identify the **suspicious title element**: the specific word or short phrase in the title that signals "wrong category" and is NOT currently in `user/portals.yml → title_filter.negative`. Ignore vague or generic terms — only flag clear categorical mismatches (e.g., "Forensic", "Risk Advisory", "SAP Consultant" if SAP is not already blocked).

### 5b — Update data/filter-log.md

Read `data/filter-log.md` (create it if absent with the header below). Append each false positive. If the same suspected pattern already exists in the log, increment its count.

```markdown
# Filter Intelligence Log

## False Positive Patterns
<!-- Postings that passed title filters but scored < 4.5 -->
| Date | Company | Title | Score | Suspected Pattern | Count |
|------|---------|-------|-------|-------------------|-------|
```

### 5c — Auto-apply when threshold is met

After updating the log, check if any pattern now has **count ≥ 3** and is **not already in `portals.yml → title_filter.negative`**.

If yes, **automatically add it to `user/portals.yml → title_filter.negative`**. Insert each new keyword into the most relevant comment block in the negative list (or at the end of the negative list if no obvious block fits), with a short inline comment explaining why it was added:

```yaml
    - "Forensic"       # auto-added 2026-04-27: 4× false positive — forensic accounting
    - "Risk Advisory"  # auto-added 2026-04-27: 3× false positive — Big 4 risk practice
```

Then update `## Applied` section in `filter-log.md`:

```markdown
## Applied to portals.yml
| Date | Pattern | Count | Reason |
|------|---------|-------|--------|
| 2026-04-27 | "Forensic" | 4 | forensic accounting/advisory, not tech |
```

And report what was changed at the bottom of the pipeline summary:

```
── Filter intelligence ──────────────────────────────────────────
Auto-added 2 keywords to portals.yml (3+ false positive occurrences):
  + "Forensic"      (4× — forensic accounting/advisory)
  + "Risk Advisory" (3× — Big 4 risk practice)
Run Scan → Audit to check filter health after any keyword changes.
─────────────────────────────────────────────────────────────────
```

If no patterns meet the threshold, print nothing. Do not mention this step in the summary.

### 5d — Rules

- Skip patterns already in `portals.yml → title_filter.negative`.
- Skip patterns that are substrings of a legitimate positive keyword (e.g., don't flag "Analyst").
- Skip overly generic single-word patterns that could appear in legitimate target titles (e.g., "Risk" alone is too broad — "Risk Advisory" is specific enough).
- Limit to **3 auto-adds max per run**, ranked by count descending.
- The Scan → Audit button is the circuit breaker: it detects over-filtering and shows which keywords to remove if needed.

### 5e — Comp-target drift watcher

This sub-step looks for the pattern: *"the user keeps scoring postings in their preferred cities, but `salary_adj_city` consistently lands low — the comp range in `profile.yml` may be out of sync with what those cities actually pay."* The signal is silent until it's strong enough to be actionable.

**Trigger window — only run when ALL of:**
1. The current batch has **≥ 3 entries** whose `location` matches one of `user/profile.yml → location.preferred_cities` (case-insensitive substring match).
2. The mean `salary_adj_city` across those entries is **≤ 5.0** (well below the "at threshold = 8" anchor).
3. At least 2 of those entries have a disclosed comp figure (i.e., their reasoning didn't fall back to `[undisclosed]`).

**On trigger — log to `data/comp-drift-log.md`** (create if absent):

```markdown
# Compensation Drift Log

Silent observations about gaps between the user's `profile.yml` comp targets and what evaluated postings in their preferred cities actually pay. The pipeline writes here; the user reads it when deciding whether to revise the targets.

## Observations
| Date | Cities | N | Avg salary_adj | Disclosed range observed | Profile target |
|------|--------|---|----------------|--------------------------|----------------|
| 2026-05-12 | Dublin, Amsterdam | 5 | 4.6 | €38–55K | €25–45K (target) / €15K (walk-away) |
```

**On 2nd consecutive trigger window with the same city set** — surface a one-line note in the pipeline summary:

```
── Compensation drift ──────────────────────────────────────────
Postings in Dublin, Amsterdam are scoring low on salary_adj_city
(avg 4.6 over 9 entries across 2 runs). Their disclosed comps
sit at €38–55K — your profile.yml target_range is €25–45K, which
the rubric reads as "below market" and dings accordingly.
Consider revising user/profile.yml → compensation.target_range
in the Configuration tab.
─────────────────────────────────────────────────────────────────
```

**Never auto-edit `profile.yml`.** Comp targets are personal — what counts as "above target" depends on the user's life situation, not market data alone. Surface, suggest, leave the decision to the user.

**Skip the watcher entirely when:**
- The batch has fewer than 3 preferred-city entries (insufficient signal).
- The user's `target_range` is already at or above the median disclosed comp (no drift).
- The user's `current_mode` is `applying` and they've actively decided to apply to roles below target (the `Discarded`/`SKIP` rows in `applications.md` are NOT in scope here — only fresh evaluations are).

## pipeline.md format

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [STALE] [ ] https://older.url/job | OldCo | Analyst  ← auto-flagged if >14 days old
- [!] https://private.url/job — Error: login required

## Filtered Out
- [!] FILTERED | https://example.com/job | DefenseCo | Analyst | excluded domain (defense)
- [!] FILTERED | https://example.com/job | BigBank | Senior Director | wrong seniority (10+ YoE)
- [!] FILTERED | https://example.com/job | USStartup | Engineer | geo-locked (US-only, no remote-EU)

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | Analyst | 8.2/10 | T2 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 5.1/10 | T3 | PDF ❌
- [x] DUPE | https://... | OldCo | Analyst | → existing #112
- [!] CLOSED | https://stale.url | ClosedCo | PM | stale + liveness check failed
```

## Smart JD detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright isn't available.
3. **WebSearch (last resort):** Look in secondary portals that index the JD.

**Special cases:**
- **LinkedIn:** May require login → mark `[!]` and ask the user to paste the text
- **PDF:** Read directly with the Read tool
- **`local:` prefix:** Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

Tracker entries use sequential numbers for ordering. To compute the next number:
1. Read `data/scouting.md` and `data/applications.md`
2. Take the highest existing entry number + 1

Report files use `{Company} - {Role}.md` naming (no numbers in filenames).

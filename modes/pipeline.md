# Mode: pipeline — URL Inbox (Second Brain)

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

## Step 3 — Evaluate each non-duplicate URL

For each URL in priority order (after dedup):

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

## pipeline.md format

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [STALE] [ ] https://older.url/job | OldCo | Analyst  ← auto-flagged if >14 days old
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | Analyst | 8.2/10 | T2-high | PDF ✅
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

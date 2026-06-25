# Mode: deadlines — Application Deadline Tracker

## Purpose

Answers "what's closing soon and what should I act on today?" by reading closing
dates from both `data/applications.md` (all active statuses) and `data/scouting.md`
(T1/T2 entries only), parsing every date value, and producing a time-bucketed
urgency view with a clear headline action.

Invoke with: `/career-ops deadlines`

Backed by a pure, tested library: `scripts/lib/deadlines-core.mjs`.
CLI shortcut: `npm run deadlines` (markdown to stdout) or `node scripts/deadlines.mjs --json`.

---

## Process

1. **Read sources** — both `data/applications.md` and `data/scouting.md` are read in
   full. Applications are filtered to non-terminal statuses (Evaluated, Applied,
   Responded, Interview, Offer). Scouting is filtered to T1 and T2 only — T3/T4
   are not actionable so tracking their deadlines is noise.

2. **Parse each Deadline cell** using the rules from `scripts/lib/deadlines-core.mjs`:
   - ISO date `YYYY-MM-DD` → compare to today
   - `YYYY-MM` → last day of that month
   - `End of <Month> <Year>` / `<Month> <Year>` → last day of that month
   - `Q1/Q2/Q3/Q4 <Year>` / `end of Q<N> <Year>` → last day of the quarter
   - `Rolling` / `open until filled` / `ongoing` → "always open"; list separately
   - Free text without a year, or `n/d` → treated as unknown; counted but not bucketed

3. **Bucket by urgency** relative to today:

   | Bucket | Criterion | Action cue |
   |--------|-----------|------------|
   | URGENT | ≤ 7 days left (or same day) | Act today / tomorrow |
   | THIS MONTH | 8–30 days | Schedule decision this week |
   | NEXT MONTH | 31–60 days | On radar |
   | FURTHER OUT | > 60 days | Watch list |
   | ROLLING | No fixed deadline | Apply when ready |
   | MISSED | Deadline passed | Probably closed — verify liveness |

4. **Sort each bucket** — date buckets ascending (most urgent first); MISSED
   descending (most-recently-missed first, still potentially salvageable).

5. **No-deadline summary** — count `n/d` cells per source and show the tally at
   the bottom so the user knows how much deadline coverage the tracker has.

---

## Output Format

Print directly to chat (no file written):

```
## Deadlines — {today}

> **{urgentCount} URGENT entries need decisions in the next week — Company (T1, 3d) and Company (Applied, 6d).**

### URGENT (closes ≤ 7 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|
| N | Acme    | Analyst | T1       | 2026-07-01 | 6d      |

### THIS MONTH (8–30 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|

### NEXT MONTH (31–60 days)
...

### FURTHER OUT (> 60 days)
...

### ROLLING (no fixed deadline)
| # | Company | Role | Tier/Status | Notes |
|---|---------|------|-------------|-------|

### MISSED (deadline passed)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|

### NO DEADLINE DATA
X T1/T2 scouting entries and Y active applications have Deadline = `n/d`.
Run `/career-ops scouting` or check the JD to fill in missing deadlines.
```

**Display rules:**
- `Tier/Status` shows T1/T2 for scouting rows; canonical status (Evaluated/Applied/Interview etc.) for application rows.
- Only show buckets that have at least one entry — skip empty buckets silently.
- For "Days left": exact integer. "< 1 day" if same day. Negative shown as "Nd ago" in MISSED.
- Headline: a one-sentence action callout only if URGENT bucket is non-empty. If the nearest deadline is in THIS MONTH, say so lightly. Suppress headline when everything is FURTHER OUT.

---

## Liveness Verification (for MISSED / stale entries)

For entries in the MISSED bucket or entries whose deadline is uncertain but still
worth applying to, the agent may call `node scripts/check-liveness.mjs <url>` to
verify whether the posting is still active before recommending the user act.

**IMPORTANT:** Claude-mode verification MUST use Playwright (see CLAUDE.md §
"Offer Verification"). Do NOT use WebFetch/WebSearch to conclude a posting is
closed — use `browser_navigate` + `browser_snapshot`. Batch-mode (`--json`) marks
those entries as "unconfirmed liveness".

---

## Deadline Extraction (for the evaluation mode — `scouting`)

When `scouting` evaluates a listing, it must extract the application deadline from
the JD and write it to the TSV's `deadline` column (col 8 of the 10-column format):

| Input | Write to TSV |
|-------|-------------|
| Explicit date in JD | `2026-06-30` (YYYY-MM-DD) |
| "Rolling" / "ongoing" / "open until filled" | `Rolling` |
| Vague ("end of May", "Q2 2026") | Best-effort ISO at end of period (`2026-05-31`, `2026-06-30`) + note in notes column |
| Month + year ("June 2026") | `2026-06-30` |
| Not stated | `n/d` |

Never leave the deadline column blank. `n/d` is the correct null value.

---

## Rules

- **Read-only mode.** Reads trackers, parses dates, prints. Does NOT modify any file.
- **No report file written.** The output is ephemeral — a status snapshot, not a
  persisted document.
- **T1/T2 scouting only.** T3 and T4 entries are not worth tracking deadlines for —
  they would not be acted on even if the window were closing tomorrow.
- **All non-terminal applications.** Any active application with a deadline is worth
  watching regardless of current status.
- **Unknown deadlines are counted, not listed.** The count at the bottom tells the
  user how much coverage is missing; it is not a blocker for running the mode.

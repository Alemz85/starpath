# Mode: deadlines — Application Deadline Tracker

## Purpose

Reads the `Deadline` column from both `data/scouting.md` (T1/T2 entries) and `data/applications.md` (active applications), parses dates, and outputs a time-bucketed view of what's still open, what's coming up, and what's already closed.

Invoke with: `/career-ops deadlines`

## Process

1. Read `data/scouting.md` — collect all rows where Deadline ≠ `n/d` AND Tier is T1 or T2
2. Read `data/applications.md` — collect all rows where Deadline ≠ `n/d`
3. Parse each deadline value:
   - ISO date `YYYY-MM-DD` or `YYYY-MM` → compare to today
   - `Rolling` → treat as always open; list separately
   - Free text like `"End of May"`, `"Q3 2026"` → parse best-effort, note uncertainty
   - `n/d` → skip (no deadline data)
4. Bucket by urgency relative to today (`{today}` — always read from system or `currentDate` in context)

## Output Format

Print directly to chat (no file written):

```
## Deadlines — {today}

### URGENT (closes in ≤ 7 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|
| ... | ... | ... | T1 | 2026-04-30 | 4 days |

### THIS MONTH (8–30 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|

### NEXT MONTH (31–60 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|

### FURTHER OUT (> 60 days)
| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|

### ROLLING (no fixed deadline)
| # | Company | Role | Tier/Status | Notes |
|---|---------|------|-------------|-------|

### MISSED (deadline already passed)
| # | Company | Role | Tier/Status | Deadline | Days ago |
|---|---------|------|-------------|----------|----------|

### NO DEADLINE DATA
X scouting entries and Y applications have Deadline = n/d.
Run `/career-ops scouting` or check the JD to fill in missing deadlines.
```

**Display rules:**
- Tier column shows T1/T2/T3 for scouting entries; canonical status (Evaluated/Applied/Interview etc.) for applications entries
- Sort each bucket by deadline ascending (most urgent first)
- For "Days left": use exact days. "< 1 day" if same day.
- Only show buckets that have at least one entry. Skip empty buckets silently.
- After the table: one-line action summary. Example: "2 URGENT entries need decisions in the next week — Revolut (T1, 4 days) and Celonis (Applied, 6 days)."

## Deadline Extraction (for evaluation modes)

When `scouting` or `oferta` evaluates a listing, it must extract the application deadline from the JD and write it to the TSV's `deadline` column. Rules:

- **Explicit date in JD** → use `YYYY-MM-DD` format (e.g., `2026-06-30`)
- **"Rolling" / "ongoing" / "open until filled"** → write `Rolling`
- **Vague ("end of May", "Q2 2026")** → write best-effort ISO date at end of period (e.g., `2026-05-31`, `2026-06-30`) with a note in the `notes` column
- **Not stated** → write `n/d`

Never leave the deadline column blank. `n/d` is the correct null value.

## Rules

- **Read-only mode.** This command reads trackers, parses dates, and prints. It does NOT modify any file.
- **No report file written.** The output is ephemeral — it's a status snapshot, not a persisted document.
- **Only T1/T2 from scouting.** T3 and T4 entries are not worth tracking deadlines for (they're not actionable).
- **All statuses from applications.md** — any active application with a deadline is worth watching.

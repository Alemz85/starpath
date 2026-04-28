# Mode: db — Offer Database View

## Purpose

Renders a filterable, sortable table of all evaluated offers from `data/score-history.tsv`. The "database view" — every role you've ever scored, in one place, with metadata and dimensional scores.

Invoke with: `/career-ops db [filters]`

## Inputs

- `data/score-history.tsv` — primary source. All scouting and oferta rows.
- `data/report-summaries.tsv` — fallback for `verdict_one_line` if not in score-history
- Optional filter args parsed from the user's command (see below)

## Filter Arguments

All filters are optional. Combine freely.

| Flag | Example | Effect |
|------|---------|--------|
| `--archetype X` | `--archetype "Value Engineering"` | Fuzzy-match archetype column |
| `--tier X` | `--tier T1` or `--tier T2` | Exact tier match (T1, T2, T3, T4) |
| `--location X` | `--location Madrid` | Fuzzy-match location column |
| `--type X` | `--type internship` | Exact match on employment_type |
| `--min-score X` | `--min-score 7.0` | Overall ≥ X |
| `--company X` | `--company Google` | Fuzzy-match company column |
| `--since YYYY-MM-DD` | `--since 2026-04-01` | date ≥ given date |
| `--mode X` | `--mode scouting` | `scouting` or `oferta` |
| `--include-closed` | | Include rows with overall = 0 or blank (default: excluded) |

If no filters are given, show all non-closed rows.

## Output

Render a markdown table directly in chat. Default sort: Overall descending.

```markdown
## Offer Database — {N} roles ({filters summary or "all"})

| # | Date | Company | Role | Location | Type | Duration | Salary | Archetype | Overall | CF | AF | EoE | Tier | Mode |
|---|------|---------|------|----------|------|----------|--------|-----------|---------|----|----|-----|------|------|
| 1 | 2026-04-25 | Celonis | Intern Value Advisory | Madrid | internship | 6mo | n/d | Value Engineering | 8.9 | 8.7 | 9.5 | 6.0 | T2 | scouting |
| 2 | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

**Summary:** {N} roles shown · avg Overall {X.X} · top archetype {Y} ({N} roles)
```

**Column notes:**
- `#` — row counter for this view (not the tracker entry number)
- `Overall`, `CF`, `AF` — from score-history rollup columns
- `EoE` — Ease of Entry score (most useful dimension for self-assessment)
- `Location`, `Type`, `Duration`, `Salary` — from the new metadata columns (may be `n/d` for rows written before 2026-04-26)
- `Tier` — score-history `tier` column value (full/short-high/short/growth/skip/oferta)
- `Mode` — scouting or oferta

**If the metadata columns are `n/d` for most rows** (pre-2026-04-26 data): note at top: *"Metadata columns (Location, Type, Duration, Salary) are n/d for rows evaluated before 2026-04-26 — new evaluations will fill these automatically."*

## Usage examples

```
/career-ops db
/career-ops db --tier T1
/career-ops db --archetype "Value Engineering" --min-score 7.0
/career-ops db --company Google
/career-ops db --location Amsterdam --type internship
/career-ops db --since 2026-04-01 --mode scouting
```

## Rules

- **Read-only.** This command reads `data/score-history.tsv` only. It does not write any files.
- **No report generated.** Output is ephemeral chat only — no `.md` file written.
- **Skip closed rows by default** (overall = 0, blank, or `—`) unless `--include-closed` is passed.
- **Truncate long tables.** If result set > 30 rows, show top 30 sorted by Overall descending and note "Showing top 30 of N. Use `--min-score` or `--archetype` to narrow."
- **Graceful n/d handling.** Rows with missing metadata columns still appear — just show `n/d` in those cells.

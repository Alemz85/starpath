# Mode: db — Offer Database View

## Purpose

Renders a filterable, sortable table of all evaluated offers from `data/score-history.tsv`. The "database view" — every role you've ever evaluated, in one place, with metadata, Want / Ease, eligibility and verdict.

Invoke with: `/career-ops db [filters]`

## Inputs

- `data/score-history.tsv` — primary source. All evaluation rows (v2 header, parsed by column name — see `modes/_shared.md` § Logging to `data/score-history.tsv`).
- Optional filter args parsed from the user's command (see below)

## Filter Arguments

All filters are optional. Combine freely.

| Flag | Example | Effect |
|------|---------|--------|
| `--archetype X` | `--archetype "Value Engineering"` | Fuzzy-match archetype column |
| `--verdict X` | `--verdict go` or `--verdict stretch,solid` | Exact match on `verdict` (`go` · `stretch` · `growth` · `solid` · `thin` · `skip` · `blocked`); comma-separated list allowed |
| `--tier X` | `--tier T1` | Exact tier match (T1, T2, T3, T4) |
| `--eligibility X` | `--eligibility amber` | Exact match on `eligibility` (`green` · `amber` · `red`) |
| `--check X` | `--check language` | Rows whose `eligibility_flags` name that check (`start_date` · `duration` · `graduation` · `language` · `work_auth` · `other`) |
| `--location X` | `--location Lyon` | Fuzzy-match location column |
| `--type X` | `--type internship` | Exact match on employment_type |
| `--min-want X` / `--min-ease X` | `--min-ease 5.0` | Want / Ease ≥ X (excludes Blocked rows) |
| `--company X` | `--company Acme` | Fuzzy-match company column |
| `--since YYYY-MM-DD` | `--since 2026-04-01` | date ≥ given date |
| `--include-blocked` | | Include Blocked rows (default: excluded unless `--verdict blocked`, `--eligibility red` or `--check` asks for them) |

If no filters are given, show all non-Blocked rows.

## Output

Render a markdown table directly in chat. Default sort: Priority (`priority` column) descending.

```markdown
## Offer Database — {N} roles ({filters summary or "all"})

| # | Date | Company | Role | Location | Type | Duration | Salary | Archetype | Want | Ease | Eligibility | Verdict | Tier |
|---|------|---------|------|----------|------|----------|--------|-----------|------|------|-------------|---------|------|
| 1 | 2026-04-25 | Acme Analytics | Intern Value Advisory | Lyon | internship | 6mo | n/d | Value Engineering | 8.25 | 5.6 | amber | Stretch | T2 |
| 2 | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

**Summary:** {N} roles shown · avg Want {X.X} · avg Ease {X.X} · verdict mix {go N · stretch N · …} · top archetype {Y} ({N} roles)
```

**Column notes:**
- `#` — row counter for this view (not the tracker entry number)
- `Want`, `Ease` — from the `want` / `ease` columns; `—` for Blocked rows
- `Eligibility` — `green` / `amber` / `red`; for red rows append the first `eligibility_flags` reason
- `Verdict` — the verdict label (`Go`, `Stretch`, `Growth target`, `Solid`, `If pipeline thin`, `Skip`, `Blocked`)
- `Location`, `Type`, `Duration`, `Salary` — from the metadata columns (`n/d` when unknown)
- `Tier` — the `tier` column (`T1`–`T4`)

Averages in the Summary line exclude Blocked rows (their scores are empty, never 0).

## Usage examples

```
/career-ops db
/career-ops db --verdict go
/career-ops db --archetype "Value Engineering" --min-ease 5.0
/career-ops db --eligibility amber
/career-ops db --verdict blocked --check language
/career-ops db --location Lyon --type internship
/career-ops db --since 2026-04-01
```

## Rules

- **Read-only.** This command reads `data/score-history.tsv` only. It does not write any files.
- **No report generated.** Output is ephemeral chat only — no `.md` file written.
- **Treat empty scores as missing**, never 0 — Blocked rows have empty dimension / `want` / `ease` / `priority` cells.
- **Truncate long tables.** If result set > 30 rows, show the top 30 by Priority and note "Showing top 30 of N. Use `--verdict`, `--min-ease` or `--archetype` to narrow."
- **Graceful n/d handling.** Rows with missing metadata still appear — just show `n/d` in those cells.

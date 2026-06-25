# Mode: deep — Deep Company Research → reusable on-disk intel

Deep research is not a one-off prose dump. It produces **one structured artifact
per company** that other modes consume directly: `interview-prep` mines its
interview-style + signals, `contacto` mines its talking points + role context,
and `scouting` can cite its business-model read. Write the artifact in the exact
schema below so those consumers can rely on it.

> **System-layer hygiene.** This mode is system layer — keep it generic. Every
> example below uses placeholders. All *candidate-specific* framing (what angle
> to play, which proof points matter) is read at runtime from `user/cv.md`,
> `user/profile.yml`, `user/_profile.md`, and `user/article-digest.md`. Never
> write a real school, employer, metric, city, or company into this file.

## The artifact

- **Location:** `data/companies/{slug}.md` — `{slug}` is the company name
  lowercased, accents stripped, non-alphanumerics collapsed to single hyphens
  (`Trade Republic` → `trade-republic`, `Société Générale` → `societe-generale`).
- **Accessor:** never reimplement slug/path/freshness logic in prose. Use the CLI:
  - `node scripts/company-research.mjs path "{Company}"` → the file path
  - `node scripts/company-research.mjs check "{Company}"` → freshness + schema check
  - `node scripts/company-research.mjs list --stale` → which cached files need a refresh
  The parsing lives in `scripts/lib/company-research-core.mjs`.

## Step 0 — Cache check (before any WebSearch)

Run `node scripts/company-research.mjs check "{Company}"` and read the verdict:

| Verdict (exit code) | Action |
|---------------------|--------|
| `fresh` + valid (0) | **Reuse it.** Skip all WebSearch. Tell the user: *"(Research from cache — {age}d old, data/companies/{slug}.md)"*. If they asked about a *specific new angle* not covered, do a targeted top-up and append, bumping `cached`. |
| `stale` (2) | Re-run the research below and overwrite the file (keep any still-true detail). |
| missing file (1) | First-time research — run the full pass below. |
| invalid schema (3) | The file exists but is malformed; re-run and rewrite it cleanly. |

Freshness window is 30 days (`FRESH_DAYS` in the core lib). The CLI does the date
math — don't eyeball it.

## Step 1 — Research the eight axes

Gather evidence for every section. **Cite a source for every non-obvious claim**
(URL, "{company} engineering blog", "Glassdoor N reviews", "Levels.fyi"). Where
data is thin, write `unknown — not enough data` rather than guessing. Use
WebSearch in interactive runs; in batch/headless runs use WebFetch and note
reduced confidence in the `confidence:` field.

1. **Business Model** — how they make money, who the customer is, stage/funding,
   scale (revenue/users if public), and the one-line "why this company exists".
2. **Recent Signals (last ~6 months)** — funding rounds, launches/pivots, notable
   hires or departures, layoffs, acquisitions, partnerships, leadership changes,
   regulatory news. These are the freshest hooks for outreach and "questions to
   ask them" — date each signal.
3. **Team & Role Context** — what the hiring team owns, where the role sits in the
   org, who it likely reports to, the problem the req is meant to solve, and
   adjacent teams. Name people only if you can verify they're current.
4. **Engineering / Org Culture** — how they ship (cadence, CI/CD), stack/tools,
   mono vs multi-repo, remote vs office, decision-making style, and candid notes
   from Glassdoor/Blind. For non-eng roles, read "org culture" broadly (process,
   autonomy, pace).
5. **Interview Style** — process shape (rounds, end-to-end days), formats
   (take-home / live coding / case / panel), difficulty signal, known quirks, and
   what they screen for. **Do not fabricate specific questions** — `interview-prep`
   owns question-level detail; this section gives it the scaffold.
6. **Compensation Hints** — bands from Levels.fyi / Glassdoor / public ranges,
   equity vs cash mix, location adjustment, negotiation signal. Label estimates as
   estimates. Never invent a number.
7. **Talking Points** — 3–6 specific, defensible things to raise that show
   homework: a recent signal, a product detail, a public value, internal
   vocabulary they use. Each must be concrete enough to drop into a message or an
   "ask them" question.
8. **Candidate Angle** — read `user/cv.md`, `user/_profile.md`,
   `user/article-digest.md` **at write time** and map *this* candidate to *this*
   company: the unique value they bring, which 1–2 proof points are most relevant,
   and the narrative thread to pull. Source every claim from the user files; if
   they're missing, write `unknown — user files not found` rather than inventing a
   background.

## Step 2 — Write the artifact (exact schema)

Write `data/companies/{slug}.md` with YAML frontmatter then the eight `##`
sections, **in this order and with these exact headings** (the consumer modes and
`scripts/lib/company-research-core.mjs` match on them):

```markdown
---
company: {Company Name}
slug: {slug}
role: {Role this was scoped to, or omit if company-wide}
cached: {YYYY-MM-DD}          # today
sources: {count of cited sources}
confidence: {high | medium | low}
---

## Business Model
{...}

## Recent Signals
- {YYYY-MM} {signal} — [source]
- ...

## Team & Role Context
{...}

## Engineering / Org Culture
{...}

## Interview Style
{...}

## Compensation Hints
{...}

## Talking Points
- {concrete point} — {why it lands}
- ...

## Candidate Angle
{mapped from user/* at write time}
```

Required frontmatter keys: `company`, `slug`, `cached`. Keep `slug` identical to
the filename stem. After writing, the artifact must pass
`node scripts/company-research.mjs check "{Company}"` with exit 0 (or exit 2 only
because of age, never 3 for schema).

## Step 3 — Confirm and point downstream

1. Run `node scripts/company-research.mjs check "{Company}"` and surface any
   schema warnings (e.g. a section you left empty).
2. Tell the user it's cached: *"(Research cached to data/companies/{slug}.md —
   reused for 30 days; other modes read it automatically.)"*
3. Note the handoffs so the funnel actually uses it:
   - `interview-prep` will read **Interview Style** + **Recent Signals** for this
     company+role.
   - `contacto` will read **Talking Points** + **Team & Role Context** for the hook.

## Rules

- **Cite or flag.** Every non-obvious claim gets a source or `unknown — not enough
  data`. Never fabricate comp numbers, interview questions, or named employees.
- **Reuse before researching.** Always run Step 0 first; burning tokens to
  re-derive fresh research is the failure mode this artifact exists to prevent.
- **Schema is a contract.** Don't rename sections, drop required frontmatter keys,
  or nest the frontmatter — downstream parsing is flat and heading-matched.
- **Candidate specifics are read at runtime**, never baked into this mode.
- Generate in the language of the role/JD (EN default).

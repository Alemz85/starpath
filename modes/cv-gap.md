# Mode: cv-gap -- CV vs. Target-Landscape Gap Analysis

## Purpose

The CV (`user/cv.md`) is the one asset that goes out with every application, yet nothing checks it against where the user is actually aiming. This mode compares the CV against the **recurring demand of the user's evaluated landscape** — not a single JD — and surfaces the *systematic* gaps:

1. **Keyword gaps** — in-demand terms that appear across many evaluated roles but never in the CV.
2. **Weak proof points** — achievement bullets with no quantified outcome (the proof-point weakness recruiters notice first).
3. **Dimension drag** — the scoring dimensions that systematically hold the user's Overall down, flagged **CV-fixable** (Skills Match) vs. **targeting-only** (everything else).

**How this differs from neighboring tools:**
- `scripts/ats-coverage.mjs` checks the CV against **one** JD. This checks it against the **whole landscape**.
- `modes/patterns.md --scouting` diagnoses **which dimension** drags. This connects that signal to **what to change in the CV** (or honestly says "this one isn't a CV fix").

Use it when the user asks "what's missing from my CV?", "how do I sharpen my CV for the roles I'm targeting?", or "where are my proof points weak?".

## Inputs

- `user/cv.md` — the canonical CV (the asset under analysis). Also accepts an `.html` CV via `--cv`.
- `reports/**/*.md` — every evaluation report; each report body is one role's demand document (its archetype/role-summary/gaps vocabulary).
- `data/score-history.tsv` — per-evaluation 6-dimension fingerprint, for the dimension-drag signal.
- Optional `--jd <file>` — extra raw JD text blobs to fold into demand (e.g. a target role not yet evaluated).

If `user/cv.md` is missing, the tool exits asking the user to create it (or pass `--cv`). If there are no reports **and** no score history, it exits — there's no landscape to compare against yet (point the user at `scan` + `scouting` first).

## Step 1 — Run the Analysis

```bash
node scripts/cv-gap.mjs            # human-readable summary
node scripts/cv-gap.mjs --json     # full structured JSON
```

Useful flags: `--cv <path>` (override CV), `--reports <dir>` (override reports dir), `--jd <file>` (add a demand doc, repeatable), `--min-roles <n>` (how many roles must demand a term before it counts as a systematic gap; default 2 — raise it on a large landscape).

The JSON contains:

| Key | Contents |
|-----|----------|
| `metadata` | analysis date, `rolesAnalyzed`, `scoreRows` |
| `keyword` | `coveragePct` of the demanded vocabulary, and `gaps[]` — each `{term, type, documentFrequency, share}` for terms the CV never surfaces, ranked by how many roles demand them |
| `proof` | `quantifiedPct` of achievement bullets, and `weak[]` — the impact bullets that carry no number/%/€/×/time |
| `dimension` | the systematically low scoring dimensions, each tagged `cvActionable` (only Skills Match) with a `hint` |
| `recommendations` | concrete `add / quantify / learn` moves with impact level |

## Step 2 — Read It Honestly for the User

The whole point is an **honest** report, so frame it that way:

- **Keyword gaps are not a license to keyword-stuff.** A missing term means one of two things: the user *has* the experience but isn't surfacing it in the role's vocabulary (a wording fix — reword a real bullet), or they genuinely *lack* it (a learn-it gap — don't fake it). Decide per term; pull real phrasing from `user/cv.md` and proof points from `user/article-digest.md`. **Never invent a skill the user doesn't have.**
- **Quantify from real figures only.** When recommending the user add numbers to weak bullets, pull the metrics from `user/article-digest.md` or ask the user — never fabricate a percentage.
- **Don't rewrite the CV for a targeting problem.** If the dimension drag is Ease of Entry, Brand Value, Strategic Fit, etc., the CV can't fix it — that's a sourcing change (scan keywords / `user/portals.yml`). Only **Skills Match** is a genuine CV lever, and even then only where the skill is real.

## Step 3 — Offer to Act

Ask whether the user wants to apply any recommendation:

> "Want me to act on these? I can:
> - Reword real bullets in `user/cv.md` to surface skills you have in the landscape's vocabulary (never inventing any)
> - Quantify the flagged bullets using figures from `user/article-digest.md` (or ask you for the numbers)
> - For the targeting drags, adjust scan keywords in `user/portals.yml` instead of touching the CV
>
> Say which ones, or 'all'."

When acting:
- CV edits → `user/cv.md` (user layer). Keep the user's real facts; reword, don't fabricate.
- New proof points / metrics → `user/article-digest.md`.
- Targeting/sourcing fixes → `user/portals.yml` / `user/_profile.md` (NEVER `_shared.md`).

## Notes

- All the analysis logic is pure and unit-tested in `scripts/lib/cv-gap.mjs` (`scripts/lib/cv-gap.test.mjs`); the CLI is just file I/O.
- It reuses `scripts/lib/ats-keywords.mjs` (keyword extraction + stem-lite matching) and `scripts/lib/targeting-core.mjs` (dimension drag) — imported, never modified — so the CV-gap keyword matching and the ATS coverage tool agree on what "a term is present" means.
- No user data is baked into the system layer: the CV, the reports, and the score history are all read at runtime from `user/*` + `data/*` + `reports/**`.

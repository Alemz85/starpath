# Mode: calibrate -- Scoring-Calibration Advisor

## Purpose

The scouting evaluation applies *calibration* the user set in `user/profile.yml`
and `user/_profile.md` — brand-bonus lists, dream companies, comp targets,
growth signals. The scorer applies those rules deterministically
(`scripts/lib/calibration.mjs`), but nothing ever tells the user whether that
calibration still **matches reality**. This mode closes that feedback loop.

It mines `data/score-history.tsv` (every evaluation's archetype + dimension
fingerprint + Want / Ease / verdict) and, when available, the outcome funnel in
`data/applications.md`, and surfaces where the calibration looks off — then
**suggests concrete edits to `user/*`**. It NEVER writes those files itself: the
user reviews each suggestion and applies the ones they agree with. That keeps
personalization in the user layer, where system updates can't overwrite it.

**This is complementary to `patterns --scouting` (targeting intelligence):**
- `patterns --scouting` asks *"where is the landscape strong / what's dragging
  scores down?"* — it's about **where to aim**.
- `calibrate` asks *"does my stated calibration match the evidence?"* — it's
  about **whether the scoring rubric itself is set right**.

Use `calibrate` when the user asks things like: "are my dream-company bonuses
still earning their keep?", "is my scoring trustworthy?", "why do my high scores
keep getting rejected?", "are my comp targets realistic for this market?".

## What it detects

| Check | Signal | Suggested fix lands in |
|-------|--------|------------------------|
| **Brand-bonus drift — inert** | A bonused company already reaches Want ≥ 8.0 unaided → the bonus is cosmetic | `user/profile.yml` |
| **Brand-bonus drift — misdirected** | A bonused company still lands `skip` even *with* the bonus → it never reaches an actionable verdict | `user/profile.yml` |
| **Un-credited strong company** | A company with *no* bonus consistently reaches Want ≥ 8.0 across ≥3 evals → candidate to add | `user/profile.yml` |
| **Rubric signal health** | A dimension is pinned at the ceiling/floor with tiny spread → it can't discriminate; its weight is wasted (consider `scoring.want_weights` / `ease_weights`) | `user/profile.yml` / `user/_profile.md` |
| **Comp-target reality** | `salary_adj_city` chronically low → comp targets above market; chronically maxed → comp floor never bites | `user/profile.yml` |
| **Score → outcome mismatch** | An archetype scores high Want / Ease but never converts (over-credited), or scores low but converts well (under-credited) — stated on Want and Ease separately | `user/_profile.md` |
| **Ease vs outcomes** (`scripts/outcomes.mjs`) | A higher Ease band progresses less often than a lower one, or the high band never gets past screening — only when the gap is past every gate, survives one application moving, and holds in both halves of the search | `user/profile.yml` (`scoring.ease_weights`) / `user/_profile.md` |

The score→outcome check only runs once `applications.md` has applications that
reached the market (Applied / Responded / Interview / Offer / Rejected /
Discarded). The other checks work from day one off `score-history.tsv` alone.
Blocked rows (empty scores) are excluded from every score check.

## Inputs

- `data/score-history.tsv` — per-evaluation score log (required)
- `user/profile.yml` — `calibration:` block, optional `scoring:` weights + `target_roles.dream_companies` (calibration source)
- `data/applications.md` — outcome funnel (optional; unlocks the score→outcome check)
- `data/status-log.tsv` (+ optional materials index) — dated outcomes, read by `scripts/outcomes.mjs` (Step 1b)

## Step 1 — Run the advisor

```bash
node scripts/calibration-advisor.mjs            # human-readable summary
node scripts/calibration-advisor.mjs --json     # structured JSON
```

Override input paths with `--score-history`, `--profile`, `--applications` if
the data lives elsewhere.

The JSON shape:

| Key | Contents |
|-----|----------|
| `metadata` | `evaluated`, `dateRange`, `calibrationConfigured`, `outcomesAvailable` |
| `diagnostics.brandBonusDrift` | `[{ company, source, kind, roles, avgWant, avgEase, verdict }]` |
| `diagnostics.brandBonusCandidates` | `[{ company, roles, avgWant }]` |
| `diagnostics.dimensionSignal` | per-dimension `{ mean, stdev, ceilShare, floorShare, status }` |
| `diagnostics.compReality` | `{ mean, median, lowShare, highShare, status }` |
| `diagnostics.scoreOutcome` | `{ available, archetypes: [{ applied, positive, convertRate, avgWant, avgEase, flag }] }` |
| `suggestions` | `[{ target, action, reasoning, severity, edit }]` sorted high→low severity |

If the script returns `error` (no score history yet), display the message and
exit gracefully — calibration feedback needs an accumulated history to mine.

## Step 1b — Ease against outcomes

```bash
node scripts/outcomes.mjs --json     # structured
node scripts/outcomes.mjs --chat     # the block + per-application why table
```

This joins the status log (dated status changes, rejection stages), the
tracker, the latest score per application and, when
`user/profile.yml` → `outcomes.materials_index` points at one, the materials
index, on one application key. Rules and gates:
`docs/scoring-statistical-design.md` § 3.7. Read `easeCheck.comparisons`:

| `status` | Meaning | What you say |
|----------|---------|--------------|
| `insufficient` | a band has fewer resolved applications than the gate | the shortfall ("high band 2 resolved, 8 needed"), nothing else |
| `agrees` | outcomes line up with Ease | that the Ease bands are holding up; **no suggestion** — agreement is not a correction |
| `within-resolution` | inverted, but one application per band would undo it | not a finding |
| `not-persistent` | inverted overall, not in both halves of the search | not a finding yet; say it is being watched |
| `gap` | every condition holds | the matching entry in `suggestions` |

Only `suggestions` (confirmed gaps, each with a stable `id`) are proposals.
Present them like the advisor's, with the counts from `evidence`, and point
the user at the applications in the why table that make up the gap. A rate
from `overall` or `slices` is quoted only when its `sample.sufficient` is true,
with its n.

## Step 2 — Present the suggestions

Relay the `suggestions` to the user, highest-severity first. For each:
- State the **action** (what to reconsider) and the **evidence** behind it.
- Show the **exact edit** and **which user file** it lands in.

**CRITICAL — do not auto-apply.** This mode only advises. If the user says "yes,
make that change", THEN edit `user/profile.yml` / `user/_profile.md` directly (as
the personalization rules in `CLAUDE.md` allow) — but never before they confirm.
A calibration change silently alters every future score, so the user must own it.

## Guardrails

- **Read-only over the scoring engine.** This mode and its scripts never modify
  `scripts/lib/score-bands.mjs`, `calibration.mjs`, `explain-score.mjs`, or
  `targeting-core.mjs`, and never change scoring behavior. They only *observe*.
- **Suggest, don't write.** All output is a proposed edit to `user/*`. The user
  applies what they agree with.
- **Respect the gates.** Diagnostics appear from small samples (2 evals for a
  company's bonus, 3 applications for an archetype's conversion), but every
  advisory is gated (`GATES` in `scripts/lib/scoring-stats.mjs`: 4 roles per
  company, 8 applications per archetype; `OUTCOME_GATES` for the Ease check) and
  anything below lands in `insufficientData`. Never present an
  `insufficientData` entry or a withheld outcome comparison as a
  recommendation, and don't override the gates.

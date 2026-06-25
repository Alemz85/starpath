# Mode: calibrate -- Scoring-Calibration Advisor

## Purpose

The scouting evaluation applies *calibration* the user set in `user/profile.yml`
and `user/_profile.md` — brand-bonus lists, dream companies, comp targets,
growth signals. The scorer applies those rules deterministically
(`scripts/lib/calibration.mjs`), but nothing ever tells the user whether that
calibration still **matches reality**. This mode closes that feedback loop.

It mines `data/score-history.tsv` (every evaluation's archetype + 6-dimension
fingerprint + Overall) and, when available, the outcome funnel in
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
| **Brand-bonus drift — inert** | A bonused company already scores `strong` (≥7.5) unaided → the bonus is cosmetic | `user/profile.yml` |
| **Brand-bonus drift — misdirected** | A bonused company scores `weak` (<6.0) even *with* the bonus → it never clears the apply bar | `user/profile.yml` |
| **Un-credited strong company** | A company with *no* bonus consistently scores strong across ≥3 evals → candidate to add | `user/profile.yml` |
| **Rubric signal health** | A dimension is pinned at the ceiling/floor with tiny spread → it can't discriminate; its weight is wasted | `user/_profile.md` |
| **Comp-target reality** | `salary_adj_city` chronically low → comp targets above market; chronically maxed → comp floor never bites | `user/profile.yml` |
| **Score → outcome mismatch** | An archetype scores high but never converts (over-credited), or scores low but converts well (under-credited) | `user/_profile.md` |

The score→outcome check only runs once `applications.md` has applications that
reached the market (Applied / Responded / Interview / Offer / Rejected /
Discarded). The other checks work from day one off `score-history.tsv` alone.

## Inputs

- `data/score-history.tsv` — per-evaluation score log (required)
- `user/profile.yml` — `calibration:` block + `target_roles.dream_companies` (calibration source)
- `data/applications.md` — outcome funnel (optional; unlocks the score→outcome check)

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
| `diagnostics.brandBonusDrift` | `[{ company, source, kind, roles, avgOverall, band, verdict }]` |
| `diagnostics.brandBonusCandidates` | `[{ company, roles, avgOverall }]` |
| `diagnostics.dimensionSignal` | per-dimension `{ mean, stdev, ceilShare, floorShare, status }` |
| `diagnostics.compReality` | `{ mean, median, lowShare, highShare, status }` |
| `diagnostics.scoreOutcome` | `{ available, archetypes: [{ applied, positive, convertRate, avgScore, flag }] }` |
| `suggestions` | `[{ target, action, reasoning, severity, edit }]` sorted high→low severity |

If the script returns `error` (no score history yet), display the message and
exit gracefully — calibration feedback needs an accumulated history to mine.

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
- **Respect minimums.** The advisor already gates each check on a minimum sample
  (e.g. ≥2 evals before judging a company's bonus, ≥3 applications before
  flagging an archetype's conversion) so single data points don't drive advice.
  Don't override those thresholds without a reason.

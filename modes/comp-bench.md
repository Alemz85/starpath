# Mode: comp-bench -- Compensation Benchmarking

## Purpose

Benchmark **what the roles the user targets actually pay** against the comp
expectations they've stated, mining the landscape they've *already evaluated*
(`data/score-history.tsv`) rather than any external salary source. It answers a
question that comes *before* any offer exists:

> "For my archetypes, in my cities, what does this landscape pay — and is my
> stated target band above or below it?"

**This is NOT `ofertas` / `compare-offers`.** That mode ranks 2+ concrete *live
offers* the user is holding. `comp-bench` never sees an offer; it reads the
user's own evaluation history and flags comp *drift* — where their target floor
or ceiling has drifted out of step with the roles they keep evaluating.

### The two signals it reports (and why)

Disclosed comp in a real landscape is **sparse** — most postings don't publish
pay, so only a handful of rows carry a parseable salary. A benchmark built only
on those would speak from ~8 data points and mislead. So the mode reports two
distinct layers, and is honest about which is which:

1. **Savings-power proxy (dense, trustworthy backbone).** Every scored row
   carries `salary_adj_city` — the 1-10 *savings-power-after-cost-of-living*
   score the scouting engine already computes (see `modes/_shared.md` § Salary
   Adj for City). Benchmarked per archetype and per city, this says *where the
   comp pressure is* across the whole landscape. It exists for every role, so
   it's the reliable read.
2. **Disclosed-salary anchors (sparse, ground-truth in euros).** The few rows
   with a real number (`€2,300/mo`, `£42K + 10% bonus`, `€2.2-3.3K/mo`) are
   parsed to annual EUR and used for the only thing that can be compared
   *directly in money* to the user's stated band: the **drift verdict**.

Keep the distinction visible when you present: the proxy is the read you can
trust; the euro figures are checkpoints, not a full market survey.

## Inputs

- `data/score-history.tsv` — every evaluation's archetype + `salary_adj_city` +
  `salary_raw` + `employment_type` + `location`. The substrate for everything.
- `user/profile.yml` § `compensation` — the user's stated `target_range`,
  `minimum` (floor), `currency`. Read verbatim; **never** hardcode a band.

## When to use

- "Am I asking for the right salary?" / "Is my target realistic?"
- "Which of my archetypes / cities pay best?"
- "Where is comp dragging my scores down?"
- Whenever the user is about to set or revise `compensation.target_range` and
  wants it grounded in what they've actually been seeing.

## Step 1 — Run the benchmark script

```bash
node scripts/comp-bench.mjs            # human-readable summary (default)
node scripts/comp-bench.mjs --json     # structured JSON to read off programmatically
```

Optional flags:

| Flag | Effect |
|------|--------|
| `--min-roles N` | Minimum roles for an archetype/city group to be ranked (default 3 — smaller groups are too noisy to benchmark). |
| `--gbp-eur RATE` | Override the GBP→EUR rate used to normalize £-denominated anchors (default 1.17). The repo has no FX feed; pass the current rate if precision matters. |
| `--score-history PATH` / `--profile PATH` | Override the input file locations. |

If the script returns an `error` (no scored evaluations yet), tell the user to
evaluate some roles first (`scouting`) — the benchmark mines their score
history and has nothing to work with on an empty landscape.

The `--json` output (and what to read off it):

| Key | Contents |
|-----|----------|
| `metadata` | `evaluated`, `withSalaryAdj`, `disclosedAnchors` (how many salaries were parseable), `gbpToEur`, date range. |
| `landscape` | Landscape-wide `adjMedian` / `adjMean` savings-power. |
| `target` | The parsed `targetLow` / `targetHigh` / `floor` (annual EUR) from profile.yml. |
| `drift` | The headline. `drift.drift` is `{ verdict, deltaEur, basis, note }` or `null` when there are too few full-time anchors to judge honestly. `drift.byType` splits anchors into `fulltime` / `intern` / `other`. |
| `byArchetype` | Per archetype (≥ `minRoles`): `adjMedian`, `compWeakShare` (% at savings-power ≤ 4), `anchorCount` + `anchorMedianEur` where disclosed. Ranked best-comp first. |
| `byCity` | Same shape, grouped by posting city. |
| `floorRisks` | Non-intern roles evaluated at savings-power ≤ 4 — each took a −0.4 Overall penalty from the comp modifier. The roles where comp is actively dragging the score. |
| `recommendations` | Concrete comp moves with `impact` level. |

## Step 2 — Interpret the drift verdict for the user

`drift.drift.verdict` is one of:

- **`target-above-landscape`** — the user's *floor* sits above the median
  disclosed full-time comp in their landscape. Either they're aiming at a tier
  the roles they evaluate don't pay, or the disclosed sample skews low. Surface
  it as: *consider whether to widen sourcing toward higher-band companies, or
  whether the floor is set too high for this segment.*
- **`target-below-landscape`** — the disclosed full-time median *exceeds* the
  user's ceiling. They may be **under-asking**. This is a high-value finding:
  raising the target ceiling could be leaving money on the table.
- **`aligned`** — the band brackets the disclosed median. Expectations match
  reality; say so plainly and move on.
- **`null` drift** — fewer than 2 disclosed full-time salaries. Do **not**
  invent a verdict. Say the disclosed sample is too thin for a euro-denominated
  call, and pivot the user to the savings-power proxy (which is always
  populated).

**Always split intern vs full-time** when discussing euros. Intern stipends
annualize far below any full-time floor *by design*, so a landscape of mostly
intern roles will show low anchor medians that say nothing about full-time
target realism. The script already buckets them (`drift.byType`); keep them
separate in your narration.

## Step 3 — Interpret the proxy (the part you can trust)

- **Best/worst archetype by comp:** the top of `byArchetype` is where
  savings-power runs strongest; the bottom is weakest. If comp is a priority for
  the user, this is a sourcing signal — weight scan keywords toward the
  stronger-comp archetypes. A high `compWeakShare` on an archetype means many of
  those roles land in the band that penalizes Overall.
- **Best cities by comp:** the top of `byCity`. High savings-power means the
  pay-vs-cost-of-living math works out well there, not just that salaries are
  nominally high.
- **Comp-floor drag (`floorRisks`):** these non-intern roles each took a −0.4
  Overall hit purely from comp. If there are several, either they're in
  expensive cities relative to pay or genuinely low-paying — a filtering or
  sourcing signal.

## Step 4 — Present a condensed summary

Lead with the drift verdict (the one thing the user most wants), then the proxy
highlights, then 2-3 recommendations. Keep euro figures tagged as anchors when
the sample is thin.

*Illustrative shape (substitute the user's real numbers — never reuse these):*

> **Comp Benchmark** — N roles evaluated, M disclosed salaries
>
> - **Target vs landscape:** your ceiling sits below the disclosed full-time
>   median — you may be under-asking on full-time roles. (Based on a thin
>   disclosed sample; the savings-power read below is the reliable one.)
> - **Best-comp archetype:** "{archetype}" (median savings-power X/10);
>   weakest: "{archetype}" (Y/10).
> - **Best-comp cities:** {city} and {city} top the savings-power ranking.
>
> Want me to update `compensation.target_range` in `user/profile.yml`, or weight
> your scan keywords toward the stronger-comp archetypes?

## Step 5 — Offer to act

If the user agrees to a comp-target change, edit **`user/profile.yml`**
(`compensation.target_range` / `minimum`) — that's the user layer. For sourcing
shifts, edit `user/portals.yml` keywords. **Never** write comp targets or
preferences into a system-layer file (`modes/*`, `scripts/*`).

## System-layer hygiene (read before editing this mode)

This mode and its scripts must stay free of the current user's actual comp
numbers, cities, or archetypes (per `CLAUDE.md` § System Layer Hygiene):

- The target band lives **only** in `user/profile.yml` and flows in at runtime.
  `scripts/comp-bench.mjs` reads it; it is never a default in code.
- There is no hardcoded FX rate baked as truth — `--gbp-eur` is an explicit,
  documented, overridable parameter defaulting to a single named constant.
- Worked examples here use fictional `{archetype}` / `{city}` placeholders, not
  the user's real targets. Substitute from the live data at presentation time.
- The parser **never invents** a salary: undisclosed / "competitive" / hourly /
  USD strings yield no number, not a guess.

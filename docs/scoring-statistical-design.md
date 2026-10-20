# Scoring statistical design

**Scoring model: v2** (`docs/scoring-v2.md` §9). Re-derived for Want / Ease /
Priority; the v1 Overall floor and the CF / AF weights are retired.

This document is the contract for every analytic derived from
`data/score-history.tsv`, and for the application-outcome stats that join it
with the status log (§ 3.7). Those analytics — peer rank, score trend, calibration
advice — read a log of **LLM judgments recorded on a coarse ordinal rubric**.
They can rank, bucket, and flag; they cannot measure. Nothing in this repo may
present a score movement, a percentile, or a calibration recommendation as
though the underlying number were a measurement with decimal resolution.

The numbers stated here are binding. They live in exactly one place in code —
`scripts/lib/scoring-stats.mjs` — and this document and that module must state
the same values. A change to one without the other is a defect.

## 1. What a score is

Scoring model: **v2** (`docs/scoring-v2.md`). An evaluation first runs the
eligibility gate (green / amber / red), then scores ten rubric dimensions on
**integers 1–10** and rolls them up into two independent numbers:

```
Want  = mean(4 motivators, weighted) − 0.30 per motivator ≤ 2 + hygiene terms h(x)   (then dream floor, vetoes)
Ease  = weighted geometric mean(Skills Match 0.35, Experience bar 0.35, Competition 0.30)
        (then the experience wall, then −0.5 per amber check, max −1.0)
Priority = √(Want × Ease)   — a sort key only, never a headline score
```

A **blocked** listing (eligibility red) has no dimensions, no Want, no Ease and
no Priority: those cells are empty in `data/score-history.tsv`. Every reader
treats empty as **missing**, never as 0. Blocked rows are excluded from every
score analytic in this document and counted only in eligibility analytics
(share of red / amber listings per check, from `eligibility_flags`).

Two consequences follow from that structure, and they are the basis of this
contract.

**Want and Ease live on lattices.** One dimension moving by one integer step
moves its rollup by a roughly fixed amount:

| Dimension moved by one step | Moves |
|---|---|
| any motivator (default equal weights) | Want by 1 / 4 = **0.25** |
| a hygiene factor crossing a threshold (8, 5, 4, 3) | Want by **0.25–0.40** (0 when it stays inside a band) |
| a 0.35-weight Ease stage near 6 | Ease by **≈ 0.33 up / ≈ 0.37 down** |
| the 0.30-weight Competition stage near 6 | Ease by **≈ 0.28 up / ≈ 0.32 down** |

The Ease step grows as the stage value falls (it is a geometric mean: one weak
stage drags more than a strong one lifts). These are mid-scale figures; at the
low end of a stage a single step moves Ease by more.

**A re-evaluation wobbles by about one step.** The rubric concedes that two
agents reading the same JD can land a judgment dimension a step apart. A
judgment dimension therefore has a re-evaluation spread on the order of one
integer step, in either direction, with no change in the world.

### The noise floors

| Metric | Constant | Value | Derivation |
|---|---|---|---|
| Want | `WANT_NOISE_FLOOR` | **0.30** | One motivator re-judged one step = 0.25; the floor is that, rounded up. Two motivators agreeing (0.50) clear it. |
| Ease | `EASE_NOISE_FLOOR` | **0.35** | One step on a 0.35-weight stage near 6 ≈ 0.32 (spec §9); 0.35 is the round value above it. |
| Priority | `PRIORITY_NOISE_FLOOR` | **0.30** | Priority = √(W·E): a one-step Want wobble moves it ≈ 0.13 and a one-step Ease wobble ≈ 0.16 at mid-scale; 0.30 sits above both. |

Want and Ease are classified **separately**, each against its own floor. A
surface never combines them into one movement statistic; when it needs one
sortable number it uses Priority with the Priority floor.

**A delta under its floor is not evidence of change.** It is not a small
improvement, not a slight decline, and not a weak signal. It is the resolution
limit of the instrument. Surfaces report it as *flat within noise* — see § 4 —
and never render it with a direction, an arrow, or a sign-carrying verb.

**Known limits of the floors.** Three single-step moves can reach a floor on
their own: a hygiene factor crossing the 5 → 4 threshold (−0.40 Want), a
motivator dropping to the bottom range (3 → 2: −0.25 and the −0.30 penalty),
and a downward step on a 0.35-weight Ease stage near 6 (≈ −0.37 Ease). These
are threshold effects in the engine, not noise in the judge, and they are
mostly carried by explicit engine rules (hygiene steps, bottom penalty) the
explain-score bundle names; but a surface cannot tell them apart from a
re-judgment using `data/score-history.tsv` alone. The floors are what the spec
fixes; treat a delta that only just clears a floor as the weakest admissible
claim.

**Bands come from the verdict, never from new thresholds on a number.** The
display/sorting buckets are the verdict cells (`go`, `stretch`, `growth`,
`solid`, `thin`, `skip`, `blocked`) computed by `assignVerdict` in
`scripts/lib/score-bands.mjs`. No surface invents its own cut-offs on Want,
Ease or Priority. A corpus "actionable share" is the share of scored rows whose
verdict is `go`, `stretch` or `solid`.

**The floor is not a significance test.** It is a resolution limit derived from
the rubric's arithmetic. It says nothing about how many observations back a
claim; sample-size gates in § 3 do that job, and both must pass independently.

**Mechanical carve-out, and why the engines do not use it.** A sub-floor delta
that is fully explained by a mechanical input — comp becoming disclosed and
moving `salary_adj_city` across a hygiene threshold, or an amber check being
resolved (+0.5 Ease) — is a fact, not a judgment, and may be stated as such
when the provenance is in hand. `data/score-history.tsv` logs the eligibility
flags but not which hygiene terms or calibration adjustments fired, so **no
engine in this repo claims the carve-out** for dimension-driven deltas. Every
sub-floor delta is classified as within-noise.

## 2. Dimension classes

The ten v2 dimensions are not equally reproducible, and the claims they support
differ in kind. Every surface must respect the class.

**Mechanical dimensions** resolve against a table, a document, or a stated fact.
Given the same JD and the same user configuration they reproduce exactly:

- **Brand Value** (`brand_value`) — read off the brand-tier table, then adjusted
  by the calibration lists in `user/profile.yml`.
- **Salary Adj for City** (`salary_adj_city`) — computed by
  `scripts/score-listing.mjs` from comp, tax and cost of living.
- **City** (`best_cities`) — a lookup against the user's preferred-cities list.

Mechanical dimensions support factual claims: *comp is now disclosed and the
salary term changed*. A change in a mechanical dimension across
re-evaluations means an **input** changed — the JD, the comp cache, or the
user's configuration — and may be reported as such, naming the input. The
eligibility gate is mechanical in the same sense: it is computed from JD facts
against the profile's `eligibility:` block.

**Judgment dimensions** are an agent's reading of prose against a CV:

- **Skills Match**, **Experience bar**, **Competition** (Ease), and
  **Growth / Mobility**, **Optionality / Exit**, **Role content**,
  **Work-Life Balance** (Want). Experience bar and Competition have anchor
  tables (years required; brand-competition tier, cohort size, school match),
  but their discretionary share dominates; their table adjustments are still
  mechanical facts.

Judgment dimensions support ordinal and comparative claims only: *this role
scores higher on Skills Match than most peers in its archetype*; *the pool
clusters at the ceiling on Brand Value*. They support nothing finer.

**Binding rules for judgment dimensions:**

- A judgment dimension **must never be read as precise to a decimal across
  re-evaluations**. Report the integer band or report nothing.
- A per-dimension delta across re-evaluations may be shown as the **driver** of
  a Want or Ease move that itself cleared its noise floor. It may never be the
  headline claim on its own.
- A mean of a judgment dimension across a pool (peer averages, corpus
  fingerprints) is a **pool descriptor**, valid for ranking pools against each
  other. It is not a property of any individual role, and it inherits the
  sample-size gates in § 3.
- Mechanical and judgment dimensions must never be averaged into a single
  "dimension moved" statistic without labelling which class moved.

## 3. Per-surface gates

Each surface below states its gate, the sample it counts, and what it must emit
when the gate fails. **Silence and an explicit insufficient-data marker are the
only permitted outputs below a gate.** Rendering a weaker version of the claim,
a hedged version, or the same claim with a caveat is not permitted.

### 3.1 Confidence tiers — one rule for every surface

Given a sample size `n` and that surface's gate `g`:

| Condition | Tier |
|---|---|
| `n < g` | **insufficient** — the claim is not rendered |
| `g ≤ n < 2g` | **low** |
| `2g ≤ n < 4g` | **moderate** |
| `n ≥ 4g` | **high** |

The doubling structure is not decorative. A pool of `n` observations resolves a
share or a rank to about `100 / n` percentage points. At the gate the claim is
barely supported and one observation can flip its coarsest bucket; at `2g` it
survives one observation moving; at `4g` the resolution matches what the surface
actually prints. `confidenceTier(n, gate)` in `scripts/lib/scoring-stats.mjs` is
the only implementation.

### 3.2 Peer rank — `scripts/peer-rank.mjs`

**Gate: `minPeers = 5` same-archetype, non-blocked peers with a finite
Priority.** The rank is computed on Priority (spec §5: the peer percentile is
one of Priority's sanctioned uses); the block also states where the role's Want
and Ease sit among the same peers, each as its own claim. The
existing omission rule stands unchanged: below five peers the block is **omitted
entirely**, returning `null`. It is never rendered with a placeholder, a
"not enough data yet" line, or a partial block. This preserves the rule stated
in the file header and in `modes/_shared.md` § Comparative Rank Block.

Above the gate:

- Every rendered claim **states its n**. The human-readable block says
  "of N peers"; the structured output carries `n_peers` (the n) and
  `confidence` from § 3.1 with `g = 5` — so 5–9 peers is `low`, 10–19 is
  `moderate`, 20+ is `high`.
- The tier is set by resolution, not by taste. At n = 5 one peer is 20
  percentile points, so only the top-half / bottom-half split is meaningful. At
  n = 10 one peer is 10 points, so quartile claims hold. At n = 20 one peer is
  5 points, which is the rounding `modes/_shared.md` already prescribes for the
  rendered percentile — that is where `high` begins.
- A **`low`-confidence rank must not be read as a quartile or decile claim**
  even though the label may say "top quartile"; the label is a bucket name, and
  at `low` confidence the only supported reading is which half the role sits in.
- Dimension outliers carry their own `peer_n` (peers with that dimension
  scored) and their own `confidence` on the same rule. An outlier computed
  against fewer peers than the block's own n is weaker than the block, and says
  so.
- The outlier threshold stays at |Δ| ≥ 1.5 against the peer mean. It is a
  full step and a half on the raw rubric — comfortably above one-step judge
  wobble — and is deliberately expressed in raw dimension points, not in
  Want / Ease points, so it is not confused with the noise floors.

### 3.3 Score trend — `scripts/score-trend.mjs`, `scripts/lib/score-trend-core.mjs`

**Per-listing movement** requires both:

1. **≥ 2 evaluations on distinct dates** for the same canonical (company, role)
   key. Same-date rows are duplicate writes, not re-evaluations, and collapse to
   the last one. This is already how trajectories are built.
2. **|Δ Want| ≥ 0.30** or **|Δ Ease| ≥ 0.35** — each metric is classified
   against its own floor from § 1, and reported separately. A trajectory can
   be "Ease improving, Want flat within noise".

A metric failing (2) is classified **`within-noise`** and reported as
*flat within noise*, with its n (evaluation count) and its confidence from
§ 3.1 with `g = 2`: 2–3 evals is `low`, 4–7 `moderate`, 8+ `high`. A two-point
trajectory is `low` by construction and can never be more — one difference
cannot separate a trend from a single noisy evaluation, no matter how large it
is.

**Corpus-level trend** — the "targeting is sharpening / sliding" claim —
requires **≥ 10 scored evaluations in each of the two calendar windows**
(`GATES.trendMinPerWindowForVerdict = 10`, so ≥ 20 in total), in addition to the existing
balanced-split construction.

Derivation. The claim compares two window means. A window mean must not be at
the mercy of one evaluation, so require that no single evaluation can move its
window's mean by more than the noise floor. The usable spread of Want in a real
landscape runs about three points between a weak role and a dream one, so a
single extreme role deviates from its window mean by up to ≈ 3.0 and shifts
that mean by `3.0 / k`; `3.0 / k ≤ 0.30` gives **k ≥ 10 per window**. Ease
spreads a little wider (≈ 3.5) against a wider floor: `3.5 / k ≤ 0.35` gives
the same k ≥ 10. Blocked rows are not scored evaluations and do not count
toward k.
Below that, the verdict is a report about one role wearing the costume of a
trend.

A corpus trend under the gate emits an **explicit insufficient-data marker** —
never a verdict, never a direction, never an arrow. Above the gate, each verdict
is additionally subject to its noise floor: a window-mean Want delta with
|Δ| < 0.30, or Ease delta with |Δ| < 0.35, is `flat-within-noise`, not
"slightly improving". The corpus trend also reports the change in the
**actionable share** (verdict `go` / `stretch` / `solid`) between windows; a
share is a band count, not a measurement, so it is stated with both window
counts and never given an arrow below the gate.

The corpus claim carries its own confidence from § 3.1 with `g = 10` on the
smaller of the two window counts: 10–19 is `low`, 20–39 `moderate`, 40+ `high`.

**Corpus movement is not causal.** Even at `high` confidence, a rise in recent
average Want or Ease is compatible with the scanner having pulled a different segment
of the market — different archetypes, employer tiers, or cities — on either side
of the split date. `modes/positioning.md` already requires that caveat to be
stated; this contract makes it binding. A trend claim states what moved, not why.

### 3.4 Calibration advisories — `scripts/calibration-advisor.mjs`

The advisor produces two different kinds of output and they are held to
different standards.

**Diagnostics describe; advisories prescribe.** A diagnostic ("this company's
evaluated roles average Want 5.8") is a statement about the log and may be shown with
its n at any sample size. An advisory ("remove this company from your bonus
list") asks the user to change their configuration, which silently alters every
future score. Advisories are gated; diagnostics are not.

**Every advisory carries `sampleSize` and `confidence`.** An advisory whose
sample is below its gate is **suppressed into an explicit `insufficientData`
section** and must not be rendered as a recommendation anywhere — not in the
CLI summary, not in JSON consumed by a mode, not in a UI.

| Advisory | Sample counted | Gate | Why |
|---|---|---|---|
| Brand-bonus drift (inert / misdirected) | scored (non-blocked) roles at that company | **4** | The verdict places a company's mean **Want** on one side of a verdict-row boundary (Want 6.5 / 8.0). Role-to-role spread within a company is about a full point, so the standard error of the mean is `1.0/√n`; the narrowest band the verdict must resolve is half a point wide, giving `n ≥ 4`. |
| Brand-bonus candidate (company to add) | evaluated roles at that company | **4** | Same claim shape, same boundary, same gate. |
| Dimension pinned at ceiling / floor | evaluations scoring that dimension | **20** | The claim is a share claim ("≥ 70% of evaluations sit at ≥ 9") plus a dispersion claim. A share estimated from 5 observations has a confidence interval wide enough to contain 50%, i.e. no pinning at all; 20 observations narrow it to roughly ±20 points, which keeps the estimate on the claimed side. Dispersion estimates from fewer than 20 points are unstable in the same way. |
| Comp targets above / below market | scored evaluations with a `salary_adj_city` score | **20** | Identical share-plus-mean claim over one dimension; identical gate. |
| Archetype scores high (Priority / verdict) but never converts / scores low but converts | applications that reached the market in that archetype | **8** | "0 of n converted" is only remarkable if 0 is unlikely under a healthy rate. At a 20% true conversion rate, seeing zero successes has probability `0.8^n`; that only drops below ~1-in-6 at `n = 8`. Below 8, a zero-conversion archetype is an ordinary run of bad luck and must not be presented as a rubric defect. |

Sub-gate advisories appear in `insufficientData` with the same `action` text,
their `sampleSize`, their gate, and the reason — so the user can see what the
advisor *would* say once the evidence arrives, without being asked to act on it.

### 3.5 Targeting momentum — `frontend/src/lib/trendsAnalytics.ts`

The Trends view's momentum card splits the date-windowed scored corpus into two
chronological halves and contrasts per-half **medians** (typical Want and
Ease, each against its own floor, and the actionable share). It asserts a direction — `improving` / `steady` /
`declining` — so it is a verdict surface and must be gated. Its parameters:

- **Deadband = the metric's noise floor** (Want 0.30, Ease 0.35, Priority
  0.30). A median swing below the floor is `steady`, never a direction. The card must not restate the floor locally;
  it reads the shared constant.
- **Gate: ≥ 5 scored evaluations in EACH half** (`momentumMinPerHalf`). The
  corpus-trend derivation (`k ≥ 10` per window, § 3.3) bounds how far one
  extreme role can move a window **mean** and does not transfer to a median: a
  median's breakdown is bounded by adjacent real observations, not by the
  outlier's magnitude. At `n = 5` the median is the 3rd order statistic — one
  aberrant listing can shift it only to a neighbouring observed value, and
  flipping the verdict requires at least two listings moving together past the
  floor. Five per half also makes the 10-evaluation total match § 3.3's
  evidence minimum, so the two trend surfaces cannot disagree about whether
  the corpus is trendable at all.
- **Below the gate the card reports low signal explicitly** ("keep evaluating",
  with the shortfall) and renders no direction — the § 4 rules apply to it in
  full.

### 3.6 Listings per period — `frontend/src/lib/trendsAnalytics.ts` (`buildByPeriod`)

The Trends time chart counts distinct listings per week or month **by the
period they were posted** (scan-history's `posted_date`, else the period they
were first evaluated). Each bar is split into the **wanted** listings (Want ≥
`WANT_HIGH` and not blocked: the high-Want row of the verdict grid, i.e. Go,
Stretch or Growth target) and the rest, with the blocked share on top. The
count and the split are tallies, not score claims, so they are **ungated**.
No score statistic (no mean Want) is drawn on this chart: at one person's
volume a per-week mean would sit under § 3.3's gate almost every week.

- **What counts.** A re-evaluated listing counts once, in the period it was
  posted (else first evaluated), and is wanted or not on its latest
  evaluation. Blocked listings count in the bar and in the blocked share,
  never as wanted.
- **Say which date placed it.** Each bucket carries how many listings it
  placed by posting date and how many by first evaluation; the tooltip states
  it and the footnote gives the totals, so a bar of fallbacks is not read as a
  hiring cycle.

### 3.7 Application outcomes — `scripts/lib/outcome-stats.mjs`

Outcome stats read what happened to the applications the user actually sent:
the status log (`data/status-log.tsv`, every status change with its date and
rejection stage), `data/applications.md`, the latest `data/score-history.tsv`
row per application (Ease, verdict, archetype, location) and, when configured,
the user's materials index (what was sent, and when). All of them are joined on
one key, `applicationKey(company, role)` in `scripts/lib/application-key.mjs`.
Consumers: `calibrate` (Ease against outcomes), `patterns` (rejection
patterns) and the chat (an outcomes block plus a per-application "why" table).
The scorer may cite an outcome stat in a report only when its gate clears.

**What an application's outcome is.** An application counts once it reached
the market: its history shows `Applied` or anything after it. Each one is
classified on its whole history, not its current cell:

| Outcome | Rule |
|---|---|
| `progressed` | Reached `Responded`, `Interview` or `Offer` at any point (a later rejection keeps it here; its stage records how far it got) |
| `rejected` | Moved to `Rejected` without progressing |
| `no-response` | Still `Applied`, sent `OUTCOME_RULES.noResponseDays` (30) or more days ago |
| `pending` | Still `Applied`, sent less than 30 days ago |
| `withdrawn` | `Discarded` after applying (the user stopped, or the posting closed) |

`pending` and `withdrawn` are excluded from every rate: neither is an answer
from the employer. The **resolved** set is `progressed + rejected +
no-response`; rates are over it. *No response* is derived, never a status: a
rejection that arrives months later is logged as `Rejected` with its real date
and the application moves from `no-response` to `rejected` by itself.

**Dates and their quality.** The sent date is the materials index's `sent`
date, else the logged move to `Applied`, else the tracker row's date. A date
from a `source=backfill` ledger row (unless the user has since corrected it)
or from the tracker row is **approximate**, and so is a materials date for an
application that predates the status log (no history, or a backfilled origin
row): such rows were reconstructed after the fact. For those, an exact
(corrected) logged move to `Applied` wins over the materials date. Days to rejection (or to first reply) are computed only when
both ends are exact; an approximate pair is shown in the why-table with `~` and
left out of every timing statistic. Timing classes, on exact dates only:
**fast** rejection ≤ `OUTCOME_RULES.fastRejectionDays` (2) days after sending —
consistent with an automated ATS filter, never stated as one —, **late**
rejection > `OUTCOME_RULES.lateRejectionDays` (30) days, **normal** between.

**Slices.** Rates are reported overall and sliced by Ease band, archetype, city
and company size (when a report states it). The Ease band is the verdict
grid's Ease column (`low` < 5.0 ≤ `mid` < 7.0 ≤ `high`, `EASE_MID` /
`EASE_HIGH` in `score-bands.mjs`), never a new cut-off. An application with no
score row lands in an `unscored` band and is never part of an Ease comparison.

**Gates** (`OUTCOME_GATES` in `scripts/lib/scoring-stats.mjs`):

| Claim | Sample counted | Gate | Why |
|---|---|---|---|
| A rate in a slice (reply, progress, interview rate) | resolved applications in that slice | **8** (`minResolved`) | Same shape as § 3.4's conversion gate: "0 of n progressed" is only remarkable when 0 is unlikely under a healthy rate; at a 20% rate `0.8^n` drops below ~1-in-6 at n = 8. At 8 one application is 12.5 points, so the rate is printed as a count ("2 of 9"), with the percentage only from `moderate` up. |
| Timing (median days to rejection, share of fast rejections) | rejections with exact dates in that slice | **8** (`minTimedRejections`) | The headline timing claim is "most rejections are fast". Under a coin flip, 6 or more of 8 fast has probability ≈ 0.14 — the same ~1-in-6 bar. Below 8 a run of quick form rejections is not a pattern. |
| Ease-band gap (the only outcome finding that may suggest a change) | resolved applications in each band compared | **8 per band** (`minResolved`), **4 per band in each half** (`minPerHalfBand`) | See below. |

Every slice carries `{ n, gate, confidence, sufficient }` from
`describeSample`, with tiers per § 3.1. Below the gate a rate or timing claim
is **withheld**: the structured output keeps the raw counts (they are facts:
"1 of 3 got a reply") and sets `sufficient: false`; renderers print the counts
and "withheld (3 of 8)" and never a rate, a direction or an interpretation.

**Agreement is not a correction.** Ease predicts how realistic getting in is.
Outcomes that agree with it — low-Ease applications rejected, high-Ease ones
progressing — confirm the score and are labelled `agrees`. Nothing about the
rubric moves on them, at any sample size.

**What counts as a gap.** Only two findings can produce a calibration
suggestion, and only when every condition holds:

1. **Inversion.** A higher Ease band progresses *less often* than a lower one.
   Both bands clear `minResolved`; the inversion survives moving one
   application in the adverse direction in each band (one more progressed in
   the higher band, one fewer in the lower) — so a single application cannot
   create it; and it holds, in the same direction, in both chronological
   halves of the applications (split at the median sent date), each band
   carrying at least `minPerHalfBand` resolved applications in each half.
2. **High Ease never progresses.** The `high` Ease band has ≥ `minResolved`
   resolved applications and none progressed — § 3.4's zero-conversion rule
   applied to the band that claims to be easiest — with at least
   `minPerHalfBand` in each half.

Anything short of that is reported as `insufficient` (with the shortfall) or
`no-gap`; a gap that holds overall but not in both halves is `not-persistent`.
A confirmed gap becomes a **suggestion** with a stable id (so a later inbox or
the user can track it): it names the bands, the counts, and the edit to
consider (`scoring.ease_weights` in `user/profile.yml`, or the archetype's
framing in `user/_profile.md`). It is never applied automatically.

**Citing outcomes in a report.** An evaluation may cite an outcome stat for
its archetype or Ease band only when that stat's `sufficient` is true, and
states it with its n ("3 of 11 comparable applications got past screening").
Below the gate a report says nothing about outcomes.

## 4. Presentation rules

These bind every renderer: CLI summaries, mode prose, report blocks, and any UI
that consumes these outputs.

1. **Always show n.** Every rendered claim states the sample it rests on, in the
   same sentence or the adjacent cell. A percentile without its n, a trend arrow
   without its evaluation count, or an advisory without its sample size is not
   publishable output.
2. **Tiers and bands over point precision.** Prefer "top quartile of 12 peers"
   to "the 78th percentile"; prefer "moved up a band" to "+0.42". Where a raw
   number is shown for auditability, its confidence tier is shown beside it.
3. **"Flat within noise" is a first-class result.** It is reported, not omitted.
   A trajectory whose |Δ| is below the floor renders as *flat within noise
   (|Δ| 0.10 < 0.30 floor, 2 evals)* — a stated finding with its evidence, not
   an empty row and not a "stable" verdict dressed up as a decision.
4. **Insufficient data is stated, never approximated.** Under a gate, surfaces
   emit the marker and the shortfall ("corpus verdict withheld: 6 evaluations in
   the earlier window, 10 required"). They do not fall back to a smaller window,
   a looser threshold, or a hedged verdict.
5. **No arrows, signs, or directional verbs below the floor.** ↑ ↓ + − and words
   like *improving*, *sliding*, *sharpening* are reserved for movements that
   cleared both the floor and the sample gate.
6. **Ordinal claims stay ordinal.** Ranks, bands, and tiers may be compared;
   they may not be arithmetically combined into an average of ranks or a
   percentage improvement in tier.

## 5. Compatibility rule

The switch to scoring v2 was a breaking change: v1 history was archived
(`data/archive/scoring-v1/`) and the Overall-based fields (`avgOverall`,
Overall bands, CF / AF fingerprints) were replaced by Want / Ease / verdict
fields. Within v2 the contract is enforced through the fields `confidence`,
`sampleSize`, `movementClass`, `verdictGate`, `reportableVerdict` and
`insufficientData`; the desktop app mirrors these numbers in
`frontend/src/lib/scoringStats.ts` (same constant names) and its suite pins the
two runtimes together.

**New surfaces must read the contract fields.** Where a convenience field and a
contract field disagree — `verdict: "improving"` against
`movementClass: "within-noise"` — the contract field is correct. No renderer may
present the convenience field as the answer.

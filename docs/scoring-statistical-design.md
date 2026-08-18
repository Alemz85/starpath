# Scoring statistical design

This document is the contract for every analytic derived from
`data/score-history.tsv`. Those analytics — peer rank, score trend, calibration
advice — read a log of **LLM judgments recorded on a coarse ordinal rubric**.
They can rank, bucket, and flag; they cannot measure. Nothing in this repo may
present a score movement, a percentile, or a calibration recommendation as
though the underlying number were a measurement with decimal resolution.

The numbers stated here are binding. They live in exactly one place in code —
`scripts/lib/scoring-stats.mjs` — and this document and that module must state
the same values. A change to one without the other is a defect.

## 1. What a score is

An evaluation produces six rubric dimensions on **integers 1–10** (half-steps
permitted only when the reasoning explicitly justifies one), rolled up by the
fixed weights in `modes/_shared.md`:

```
Current Fit       = mean(Skills Match, Ease of Entry, Strategic Fit)      − 0.30 per bottom-range dim
Aspirational Fit  = mean(Growth/Mobility, Optionality/Exit, Brand Value)  − 0.30 per bottom-range dim
Overall           = CF × 0.70 + AF × 0.30 + context modifiers
```

Two consequences follow directly from that structure, and they are the whole
basis of this contract.

**Overall lives on a lattice.** Because each rollup is a mean of three integers,
one dimension moving by one integer step moves Overall by a fixed amount:

| Dimension moved by one step | Overall moves by |
|---|---|
| any Current Fit dimension | 0.70 / 3 = **0.2333** |
| any Aspirational Fit dimension | 0.30 / 3 = **0.1000** |

An Overall delta smaller than 0.1000 cannot correspond to any dimension changing
its mind. It can only come from a rounding artifact, a context modifier, or a
rewritten comp figure.

**A re-evaluation wobbles by about one step.** The rubric itself concedes this:
`modes/_shared.md` § Reasoning column quality bar states that two agents reading
the same JD "might land at 5 or 7 depending on how they weigh the audit signals"
and calls that range of judgment fine. A judgment dimension therefore has a
re-evaluation spread on the order of one integer step, in either direction, with
no change in the world.

### The noise floor

**`OVERALL_NOISE_FLOOR = 0.30`.**

Derivation. The floor must be strictly greater than the largest Overall move a
*single* dimension can produce by wobbling one step, because that wobble is
exactly what a re-evaluation does for free:

- one Current Fit dimension wobbling one step → 0.2333
- one Aspirational Fit dimension wobbling one step → 0.1000
- two Aspirational Fit dimensions wobbling the same way → 0.2000

and it must be no greater than the smallest move that needs **two** dimensions
to agree, since that is the cheapest configuration we are willing to call real:

- one Current Fit + one Aspirational Fit dimension, same direction → 0.3333
- two Current Fit dimensions, same direction → 0.4667

0.30 is the round value inside `(0.2333, 0.3333]`. It is the tightest threshold
that **no single dimension re-judgment can clear**, while still admitting the
smallest genuine two-dimension move. Anything looser discards real signal;
anything tighter promotes one agent's shrug into a trend.

**A delta with |Δ| < 0.30 is not evidence of change.** It is not a small
improvement, not a slight decline, and not a weak signal. It is the resolution
limit of the instrument. Surfaces must report it as *flat within noise* — see
§ 4 — and must never render it with a direction, an arrow, or a sign-carrying
verb.

**The floor is not a significance test.** It is a resolution limit derived from
the rubric's arithmetic. It says nothing about how many observations back a
claim; sample-size gates in § 3 do that job, and both must pass independently.

**Mechanical carve-out, and why the engines do not use it.** A sub-floor delta
that is *fully explained by a deterministic context modifier* — a comp figure
becoming disclosed and flipping the `Salary Adj ≤ 4 → −0.4` or
`WLB ≤ 4 → −0.2` modifier — is a mechanical fact, not a judgment. Such a change
may be stated as a fact ("comp disclosed; the salary modifier no longer fires")
when the provenance is in hand. `data/score-history.tsv` does not log which
modifiers fired, so **no engine in this repo may claim the carve-out**. Every
sub-floor delta is classified as within-noise until a surface can prove the
mechanical provenance.

## 2. Dimension classes

The six rollup dimensions are not equally reproducible, and the claims they
support differ in kind. Every surface must respect the class.

**Mechanical dimensions** resolve against a table, a document, or a stated fact.
Given the same JD and the same user configuration they reproduce exactly:

- **Brand Value** — read off the brand-tier table in `modes/_shared.md`, then
  adjusted by the calibration lists in `user/profile.yml`.
- **Ease of Entry**, in the part driven by the visa / country / school
  calibration tables — the stated table adjustments are deterministic.
- The context dimensions **Salary Adj for City** (computed by
  `scripts/score-listing.mjs` from comp inputs) and **Best Cities** (a lookup
  against the user's preferred-cities list).

Mechanical dimensions support factual claims: *this role is in a country that
costs −2 on Ease of Entry*; *comp is now disclosed and the modifier changed*.
A change in a mechanical dimension across re-evaluations means an **input**
changed — the JD, the comp cache, or the user's configuration — and may be
reported as such, naming the input.

**Judgment dimensions** are an agent's reading of prose against a CV:

- **Skills Match**, **Strategic/Analytical Fit**, **Growth/Mobility**,
  **Optionality/Exit**, the discretionary share of **Ease of Entry**, and
  **Work-Life Balance**. **Sales-Trap Risk** is judgment too, though it is
  excluded from the rollups.

Judgment dimensions support ordinal and comparative claims only: *this role
scores higher on Skills Match than most peers in its archetype*; *the pool
clusters at the ceiling on Brand Value*. They support nothing finer.

**Binding rules for judgment dimensions:**

- A judgment dimension **must never be read as precise to a decimal across
  re-evaluations**. `7.0 → 7.4` on Skills Match is one agent phrasing a
  half-step differently, not a 0.4 improvement. Report the integer band or
  report nothing.
- A per-dimension delta across re-evaluations may be shown as the **driver** of
  an Overall move that itself cleared the noise floor. It may never be the
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

**Gate: `minPeers = 5` same-archetype peers with a finite Overall.** The
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
  Overall points, so it is not confused with the noise floor.

### 3.3 Score trend — `scripts/score-trend.mjs`, `scripts/lib/score-trend-core.mjs`

**Per-listing movement** requires both:

1. **≥ 2 evaluations on distinct dates** for the same canonical (company, role)
   key. Same-date rows are duplicate writes, not re-evaluations, and collapse to
   the last one. This is already how trajectories are built.
2. **|Δ Overall| ≥ 0.30** — the noise floor from § 1.

A trajectory failing (2) is classified **`within-noise`** and reported as
*flat within noise*, with its n (evaluation count) and its confidence from
§ 3.1 with `g = 2`: 2–3 evals is `low`, 4–7 `moderate`, 8+ `high`. A two-point
trajectory is `low` by construction and can never be more — one difference
cannot separate a trend from a single noisy evaluation, no matter how large it
is.

**Corpus-level trend** — the "targeting is sharpening / sliding" claim —
requires **≥ 10 scored evaluations in each of the two calendar windows**
(`MIN_TREND_WINDOW = 10`, so ≥ 20 in total), in addition to the existing
balanced-split construction.

Derivation. The claim compares two window means. A window mean must not be at
the mercy of one evaluation, so require that no single evaluation can move its
window's mean by more than the noise floor. The usable spread of Overall in a
real landscape runs about three points between a weak role and a stellar one, so
a single extreme role deviates from its window mean by up to ≈ 3.0 and shifts
that mean by `3.0 / k`. Setting `3.0 / k ≤ 0.30` gives **k ≥ 10 per window**.
Below that, the verdict is a report about one role wearing the costume of a
trend.

A corpus trend under the gate emits an **explicit insufficient-data marker** —
never a verdict, never a direction, never an arrow. Above the gate, the verdict
is additionally subject to the noise floor: a window-mean delta with |Δ| < 0.30
is `flat-within-noise`, not "slightly improving".

The corpus claim carries its own confidence from § 3.1 with `g = 10` on the
smaller of the two window counts: 10–19 is `low`, 20–39 `moderate`, 40+ `high`.

**Corpus movement is not causal.** Even at `high` confidence, a rise in recent
average Overall is compatible with the scanner having pulled a different segment
of the market — different archetypes, employer tiers, or cities — on either side
of the split date. `modes/positioning.md` already requires that caveat to be
stated; this contract makes it binding. A trend claim states what moved, not why.

### 3.4 Calibration advisories — `scripts/calibration-advisor.mjs`

The advisor produces two different kinds of output and they are held to
different standards.

**Diagnostics describe; advisories prescribe.** A diagnostic ("this company's
evaluated roles average 5.8") is a statement about the log and may be shown with
its n at any sample size. An advisory ("remove this company from your bonus
list") asks the user to change their configuration, which silently alters every
future score. Advisories are gated; diagnostics are not.

**Every advisory carries `sampleSize` and `confidence`.** An advisory whose
sample is below its gate is **suppressed into an explicit `insufficientData`
section** and must not be rendered as a recommendation anywhere — not in the
CLI summary, not in JSON consumed by a mode, not in a UI.

| Advisory | Sample counted | Gate | Why |
|---|---|---|---|
| Brand-bonus drift (inert / misdirected) | evaluated roles at that company | **4** | The verdict places a company mean on one side of a band boundary. Role-to-role spread within a company is about a full point, so the standard error of the mean is `1.0/√n`; the narrowest band the verdict must resolve is half a point wide, giving `n ≥ 4`. |
| Brand-bonus candidate (company to add) | evaluated roles at that company | **4** | Same claim shape, same boundary, same gate. |
| Dimension pinned at ceiling / floor | evaluations scoring that dimension | **20** | The claim is a share claim ("≥ 70% of evaluations sit at ≥ 9") plus a dispersion claim. A share estimated from 5 observations has a confidence interval wide enough to contain 50%, i.e. no pinning at all; 20 observations narrow it to roughly ±20 points, which keeps the estimate on the claimed side. Dispersion estimates from fewer than 20 points are unstable in the same way. |
| Comp targets above / below market | evaluations with a Salary Adj score | **20** | Identical share-plus-mean claim over one dimension; identical gate. |
| Archetype scores high but never converts / scores low but converts | applications that reached the market in that archetype | **8** | "0 of n converted" is only remarkable if 0 is unlikely under a healthy rate. At a 20% true conversion rate, seeing zero successes has probability `0.8^n`; that only drops below ~1-in-6 at `n = 8`. Below 8, a zero-conversion archetype is an ordinary run of bad luck and must not be presented as a rubric defect. |

Sub-gate advisories appear in `insufficientData` with the same `action` text,
their `sampleSize`, their gate, and the reason — so the user can see what the
advisor *would* say once the evidence arrives, without being asked to act on it.

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

Every field these engines emitted before this contract existed still exists,
with its original type and meaning, including the pre-contract `verdict` and
`stable` classifications that use their own dead-bands. The contract is enforced
through **added** fields — `confidence`, `sampleSize`, `movementClass`,
`verdictGate`, `reportableVerdict`, `insufficientData` — so downstream consumers
that mirror this math independently (the desktop app maintains its own
renderer-side ports) keep working unchanged while they migrate.

**New surfaces must read the added fields.** Where a legacy field and a
contract field disagree — legacy `verdict: "improving"` against
`movementClass: "within-noise"` — the contract field is correct and the legacy
field is retained only for compatibility. No new renderer may present the legacy
field as the answer.

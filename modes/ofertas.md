# Mode: ofertas — Multi-Offer Comparison

The end-of-funnel decision engine. When you have **2+ live offers**, this mode
produces a structured, weighted comparison and a clear recommendation with the
tradeoffs made explicit — so the call is grounded in the same scoring math the
rest of the system uses, not a fresh ad-hoc rubric.

Report voice is second person (`modes/_shared.md` § Report Voice): the comparison
is written FOR you, about roles being weighed for you.

## When to use

User has multiple offers in hand (or near-offers worth weighing side by side)
and asks which to take, or to compare them. Offers can be: pasted text, URLs,
or references to roles already in the tracker / with scouting reports on disk.
If they're not in context, ask for them.

## The six comparison factors

Each offer is scored **1–10** on six factors. These are deliberately aligned
with the canonical scoring primitives so an offer's factor here sits on the same
scale as its scouting report — never invent a parallel rubric.

| Factor | 1–10 score is… | Source |
|--------|----------------|--------|
| **comp** | Cost-of-living-adjusted savings power | `compFactorFromSavings(monthlyNet, colBaseline)` → reuses the savings band in `scripts/lib/score-bands.mjs`. Build total comp with `buildTotalComp(...)`, net it with `grossToNet(...)`, pull the city baseline from `data/col-cache.tsv` (`scripts/lib/col-cache.mjs`). |
| **fit** | The scouting **Overall** for this role | `fitFactorFromDims(sixDims, context)` → replays `rollupCurrentFit`/`rollupAspirationalFit`/`rollupOverall`. If the role already has a scouting report, use that Overall directly. |
| **growth** | Growth / mobility — does it lead somewhere | The role's Growth/Mobility dimension from its scouting evaluation (1–10). |
| **brand** | Brand value on a CV | The role's Brand Value dimension (1–10). |
| **location** | How well the location fits **your** preferences | Derive from `user/profile.yml` (`location.preferred_cities`, `visa_status`, relocation appetite) — NOT a hardcoded city. A role in a top-preference city + no visa friction scores high; one requiring an unwanted move scores low. |
| **risk** | Stability / downside (higher = safer) | Funding stage, layoff signals, role clarity, manager risk, probation terms. A late-stage profitable employer scores high; a runway-constrained startup or an ambiguous "will I actually do analytics?" role scores low. |

The agent derives growth/brand/location/risk the same way it scores the rollup
dimensions during scouting — read `user/cv.md`, `user/profile.yml`,
`user/_profile.md`, and any existing report for the role; substitute real values
at comparison time. Never hardcode a candidate's cities, target companies, or
comp targets into the comparison.

## Weights — read from the candidate at runtime

The factors are weighted by what **this** candidate is optimizing for. Source the
weights from `user/_profile.md` / `user/profile.yml` (e.g. comp-heavy for someone
maximizing savings runway; brand/growth-heavy for someone optimizing the next
move). If the user hasn't expressed priorities, ask — or fall back to uniform
weights and say so. Weights are relative: pass raw 1–5 importance ratings; the
engine normalizes them to sum to 1.

**Never** bake a default weight profile that encodes one candidate's priorities
into the mode or the script. The script's fallback is uniform (neutral) on
purpose.

## How to run it (deterministic)

All ranking, tradeoff, and recommendation math lives in the pure, unit-tested
`scripts/lib/offer-compare.mjs`. Build a small JSON file and run the CLI so the
result is reproducible and auditable:

```json
{
  "weights": { "comp": 3, "fit": 2, "growth": 2, "brand": 1, "location": 1, "risk": 1 },
  "offers": [
    { "label": "Company A — Role", "scores": { "comp": 8, "fit": 9, "growth": 8, "brand": 9, "location": 6, "risk": 7 } },
    { "label": "Company B — Role", "scores": { "comp": 6, "fit": 7, "growth": 5, "brand": 4, "location": 9, "risk": 8 } }
  ]
}
```

```
node scripts/compare-offers.mjs offers.json        # formatted table + recommendation
node scripts/compare-offers.mjs offers.json --json  # raw result object for further use
```

(`weights` is optional — uniform if omitted. Every offer needs all six factor
scores in [1,10] and a unique `label`.)

## What to present back

1. **Ranking table** — every offer's six factor scores + weighted total, best first.
2. **Tradeoffs** — the material factors (≥2-point gap) where the top offer wins,
   and the ones it concedes to the runner-up. This is the honest part: name what
   you'd be giving up.
3. **Recommendation** — the engine's verdict, including whether it's a **close
   call** (margin < 0.5 → treat as a near-tie; a deadline, a referral, or your gut
   on the named tradeoff can legitimately flip it) or a clear pick, and the single
   factor the winner won on.
4. **Decision-support beyond the score** — time-to-decision / exploding-offer
   deadlines, negotiation leverage (a competing offer is leverage — see
   `user/_profile.md` negotiation scripts), and anything the numeric factors don't
   capture. The score ranks; you decide.

Don't oversell the precision: this is a structured aid, not an oracle. Surface
the math, make the tradeoffs explicit, and leave the final call to the user.

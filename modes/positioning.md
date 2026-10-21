# Mode: positioning — Holistic Career Positioning Report

## Purpose

`positioning` is a **standalone, manually invoked command** that produces a cross-cutting view of the user's career landscape. It does NOT evaluate a single listing. It reads *everything the system has accumulated* — scan data, evaluation reports, tracker entries, score history — and answers the question: **"Given everything I've seen, where do I stand, and what should I do differently this cycle?"**

Think of it as the difference between looking at one X-ray (scouting) and looking at the whole medical file (positioning).

**When to use:**
- After running `/career-ops scan` for a few weeks and wanting to zoom out
- When deciding whether to pivot archetypes
- Every 4–8 weeks as a progress check
- Before a big career decision (accepting an internship, choosing a specialization)

**This is NOT a per-listing mode.** It takes no listing argument. It reads accumulated data.

## The quality bar — read this before writing a single line

Past positioning reports have failed by being **table-led summaries of facts the user already knows**. The user reads `data/scouting.md` and the report files; they do not need a positioning report to re-tell them how many postings a given company has or what a given role scored. They need positioning to tell them **what to do differently and why**, anchored to those numbers — not narrating them.

A good positioning report passes all four of these tests:

1. **The TL;DR block at the top is sufficient to act on by itself.** A user who reads only the first 250 words knows the focus path, the three things to do next, and the single most important "stop doing X" call.
2. **Every numerical claim ties to a consequence.** "{Archetype} Ease averages {X.X}" is not a finding — it's a stat. "{Some structural gate} is the binding constraint across most archetypes in the corpus; the highest-leverage move is reframing {existing CV proof point} as {alternative framing the JD bar accepts} — that fix attacks the constraint everywhere it appears" — that's a finding. Substitute real values from `score-history.tsv` and the user's `cv.md` / `_profile.md`; don't hardcode the example. Every paragraph should either prescribe an action, kill an option, or change how the user reads the next paragraph.
3. **Per-archetype sections lead with a 2–3 sentence judgment paragraph, not a table.** The opening paragraph says "the bet here is X, the cost is Y, the call is {keep / cut / double down}". Tables come AFTER the judgment, as supporting evidence — not as the section itself.
4. **No more than 4 tables in the entire report.** Tables are a crutch that lets the agent dump structured data without committing to a read. Demote dimensional fingerprints, geographic maps, gap tallies, and dream-company coverage to a single Appendix. The body of the report is prose.

If you find yourself writing "Headlines:" or "Key takeaways:" as a bulleted list after a table, **stop and rewrite the section as one paragraph that leads with the conclusion**.

## Inputs — the whole corpus

Read ALL of these if they exist. Skip any that are missing with a note.

| Source | Purpose |
|--------|---------|
| `data/applications.md` | Active applications tracker — entries the user has decided to apply to |
| `data/scouting.md` | Landscape inventory tracker — every evaluation lands here by default (Tier column) |
| `data/score-history.tsv` | Per-archetype, per-dimension score trajectory over time. **Primary quantitative source.** |
| `data/report-summaries.tsv` | **Compact summary cache** (one row per evaluation). Read this FIRST for the quantitative pass — far faster than opening full reports. Schema: `date\|company\|role\|archetype\|tier\|match\|ease\|eligibility\|key_gaps\|verdict` (headerless). Only open full `.md` reports when drilling into a specific company or archetype (max 5 full reads per positioning run). |
| `scripts/score-trend.mjs` (run, don't read) | **The deterministic trajectory engine.** Splits all evaluations into an earlier vs recent calendar window and replays the real verdict grid to answer "is my targeting sharpening?" — plus per-listing re-evaluation deltas. This is what makes § 4 Trajectory decision-grade instead of an eyeball of old report files. |
| `reports/tier-*/{Company} - {Role}.md` | Full evaluation reports — open only for qualitative color (see rule below). |
| `data/scan-history.tsv` | Portal scan history — demand signals by company/city |
| `data/landscape-companies.csv` / `data/landscape-cities.csv` | If they exist |
| `modes/_shared.md` | The Dimensional Scoring Framework definition (contract: `docs/scoring-v2.md`). Read this so you understand what each TSV column means. |
| `user/_profile.md` | Archetypes, narrative, comp targets, location policy |
| `user/profile.yml` | Identity, dream companies, target roles |
| `user/cv.md` | Current skill baseline |
| `user/article-digest.md` | Proof points |
| Previous positioning reports (`reports/positioning/positioning-*.md`) | For trajectory comparison |

**RULE:** Do not open individual report files for the quantitative pass. Read `data/report-summaries.tsv` and `data/score-history.tsv` for all quantitative signals. Only open full `.md` reports (**max 5 total**) for qualitative color when you need specific gap phrasing or recommendation detail.

### The quantitative backbone — run BOTH, reason off them

Before any hand-computation, run the two backbone scripts. They do the entire quantitative pass for you — deterministically, off the same scoring engine that produced the reports — so you spend your tokens on the *read*, not the arithmetic. The first answers **"where do I stand and what's the cheapest move?"**; the second answers **"is my targeting sharpening over time?"** — the two halves of a decision-grade review.

```bash
node scripts/positioning-intel.mjs --summary    # WHERE I STAND: fingerprints, levers, systemic constraint
node scripts/score-trend.mjs --summary          # IS IT SHARPENING: earlier-vs-recent landscape trend + per-listing re-eval deltas
```

Add `(no --summary)` to either for full JSON when you need a field the summary omits. Run both into your scratch notes before writing a line — the TL;DR's "trajectory" call and § 4 come straight off `score-trend`, and they are NOT derivable from `positioning-intel` (which is time-blind — it pools the whole corpus flat).

What it returns (all derived from `data/score-history.tsv` at runtime — nothing hardcoded):

| Field | What it gives you | Where it lands in the report |
|-------|-------------------|------------------------------|
| `landscape` | corpus avg/median Match and Ease, verdict mix, `wastedShare` (% of scored evals landing `skip`), and the eligibility mix (share of red / amber by check) | § 1 opening + Appendix |
| `fingerprints[]` | per-archetype dimension averages + `bottleneck` (lowest dim) + `avgMatch` / `avgEase` / `actionableShare` (% landing `go` / `stretch` / `solid`) / `share` | § 2 per-archetype judgments + Appendix B |
| `levers[]` | for each archetype's **average role**: replayed `match` / `ease` / `verdict`, its `bindingConstraint`, and the **`cheapestLever`** — the smallest single-dimension raise that moves the typical role to a better verdict cell | § 2 "Path forward" + § 3 |
| `systemicConstraint.dominant` | the one dimension that binds the typical role across the **most** archetypes, with the list of archetypes it gates | § 1 binding-constraint paragraph + TL;DR |
| `systemicConstraint.lever` | the cheapest-lever dimension shared by the most archetypes — the **single fix with the largest cross-archetype leverage** | TL;DR "highest-leverage cheap fix" + § 3 |
| `dimensionDrag[]` | corpus-wide per-dimension average + `lowShare` (% of evals where it scored ≤ 4) | Appendix B/C cross-reference |
| `cityExposure[]` | where `go` / `stretch` / `solid` matches cluster geographically | § 1 geographic read + Appendix D |

**Why this is the backbone, not a sidecar:** `systemicConstraint` *is* the answer to Step 2's "single cheapest fix with the largest cross-archetype leverage". The distinction it draws is the whole point of the report — the dimension that *binds* the most archetypes (`dominant`) is often NOT the dimension that's *cheapest to lift* (`lever`). Example shape: Experience bar may gate the typical role in most of your archetypes, but it is a slow fix (experience/credential); meanwhile a one-point lift in Skills Match (a reframe that surfaces a skill you already have) or Competition (a referral path) might move the typical role to a better verdict in several archetypes at once. **The report's headline move is `systemicConstraint.lever`, framed against `systemicConstraint.dominant`** — substitute the actual dimensions the script returns; never assume which they are.

Treat the script's numbers as canonical. Do not recompute Match/Ease/verdict by hand — the script replays the real engine (`score-bands.mjs` via `explain-score.mjs`), so a hand-computed number that disagrees is YOUR error, not the script's.

#### What `score-trend.mjs` returns (the time axis `positioning-intel` is blind to)

`positioning-intel` pools every evaluation into one flat landscape — it cannot see whether *this month's* roles score better than *last month's*. `score-trend` adds exactly that axis, replayed off the same verdict grid, and it trends **Match and Ease separately** (`landscapeTrend.match` / `landscapeTrend.ease`, each carrying the fields below; Blocked rows are excluded from both), so the report's trajectory section is a deterministic read, not a guess from old report files.

| Field | What it gives you | Where it lands in the report |
|-------|-------------------|------------------------------|
| `…reportableVerdict` | the GATED headline call per axis: `improving` / `declining` when the window-mean delta clears that axis's noise floor (Match 0.30, Ease 0.35), `flat-within-noise` when it doesn't, `insufficient-data` when either window has too few evals (`verdictGate`, per `docs/scoring-statistical-design.md`). Carry `verdictConfidence` wherever the call is stated | TL;DR trajectory line + § 4 opening verdict |
| `…earlier` / `.later` | each window's `count`, mean, `actionableShare` (% `go` / `stretch` / `solid`), `dateRange` — the numbers the verdict is built from | § 4 comparison table |
| `…delta` / `.actionableShareDelta` | signed move between windows and the cleaner "share of actionable roles" move | § 4 + § 1 if it changes the read |
| `landscapeTrend.splitDate` | the boundary the engine chose (closest-to-50/50, NOT a naive median) | § 4 confounder check — see below |
| `landscapeTrend.insufficientData` + `reason` | true when the dates are too thin/concentrated to trend | gates § 4: if true, render the baseline note instead |
| `trajectorySummary` | of the listings re-evaluated 2+ times: `improving`/`declining`/`stable` split, `avgDelta`, `verdictUpgrades`/`verdictDowngrades` | § 4 + § 2 (a role re-climbing on re-eval is a "prioritize before it closes" signal) |
| `listingTrajectories[]` | per re-evaluated company+role: first→latest Match and Ease, verdict transition, the single dimension that moved most (`topMover`) | § 2 per-archetype color when a listing in that archetype changed verdict |
| `recommendations[]` | conservative, pre-phrased "re-check this decliner / prioritize this improver / targeting is sharpening" lines — already impact-ranked | seed for § 3 actions and § 4 judgment (rewrite in your own voice; don't paste verbatim) |

**The split is calendar-balanced, not a naive median** — `score-trend` scans every candidate boundary and picks the one that splits rows closest to 50/50, so a bursty scan day can't shove almost everything into one window. Read `splitDate` and state it in § 4; if the scanner pulled a different *segment* of the market on either side of it (different archetypes / employer tiers / cities), a rise or fall in avg Match or Ease is a corpus-mix artifact, not real targeting movement — say so explicitly so the user doesn't over-read it.

**Read the Ease trajectory first.** Ease is point-in-time — it moves as the profile grows — so its per-archetype trend is the key positioning signal: rising Ease means you are closing the gap to "applyable today"; flat Ease despite effort means the gap-closing strategy isn't working. A Match trend mostly says whether the scanner is surfacing roles you'd actually want.

### `data/score-history.tsv` schema (read this carefully)

The TSV is the primary quantitative input. Schema (see `modes/_shared.md` § "Logging to data/score-history.tsv" for the canonical definition):

```
date	archetype	skills_match	experience_bar	competition	ease	growth_mobility	optionality_exit	brand_value	role_content	best_cities	salary_adj_city	work_life_balance	match	priority	eligibility	eligibility_flags	verdict	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw	url
```

Key facts for parsing:
- One row per evaluation, parsed by header name. `mode` is always `scouting`.
- `match`, `ease`, `priority` are **pre-computed by the script**, not for you to recompute. Use them directly. There is no Overall.
- **Blocked rows** (`eligibility=red`, `verdict=blocked`) have every dimension column and `match` / `ease` / `priority` **empty** — treat empty as missing, never 0. Exclude them from every score average; count them in the eligibility read (share of red / amber by check, from `eligibility_flags`).
- Ease dimensions: `skills_match`, `experience_bar`, `competition`. Match motivators: `growth_mobility`, `optionality_exit`, `brand_value`, `role_content`. Hygiene factors (`best_cities`, `salary_adj_city`, `work_life_balance`) only hurt Match when low — they inform the geographic and market sections.
- `best_fit_roles` is a free-text column with `; `-separated alternative roles. Tally these across the corpus to surface "the user repeatedly gets matched to X kind of role at Y kind of company".

## Process

### Step 0 — Decide whether to write the report at all

Count rows in `score-history.tsv` and tracker entries. If the corpus is too thin:

> "Not enough data for a meaningful positioning report yet. You have {N} evaluations and {M} tracker entries. Come back after {recommended threshold} — or run `/career-ops scan` a few times first."

**Minimum thresholds:**
- At least 15 rows in `score-history.tsv` (or 10 tracker entries if score-history is empty) to produce the "where you stand today" section
- For a real § 4 Trajectory section, don't eyeball a day count — let `score-trend.mjs` decide: if `landscapeTrend.insufficientData` is false AND `landscapeTrend.verdictGate.met` is true, the engine found two adequately-sized calendar windows and the section is real; if either fails (or 2+ prior positioning reports exist as a coarse fallback), establish a baseline only — `reportableVerdict` will already say `insufficient-data` in that case.

### Step 1 — Gather quantitative signals (kept internal until Step 3)

**Run `node scripts/positioning-intel.mjs --summary` AND `node scripts/score-trend.mjs --summary` first** and paste both into your scratch notes. `positioning-intel` delivers A, B, the systemic constraint, geographic clustering, and the per-archetype levers below; `score-trend` delivers H (the trajectory / "is it sharpening?" read) — all replayed off the real scoring engine. Then layer in the few signals neither script can derive (the qualitative gaps in C, the comp/Brand-WLB reads in E, the free-text tallies in F/G) by reading `report-summaries.tsv` and at most 5 full reports.

You will **not** dump any of this as the first thing the user sees — it goes into the Appendix, and the body only references it inline as evidence for a judgment.

**A) Match / Ease + lever view by archetype** — straight from `fingerprints[]` + `levers[]`: `# evals`, `Avg Match`, `Avg Ease`, `actionableShare`, the replayed `verdict` of the average role, and its `cheapestLever` (the smallest single-dim raise that moves it to a better verdict). Add a Trend arrow per axis if you have the data (most recent 30 days vs prior 30 days; ↑ / ↓ only beyond the axis noise floor — Match 0.30, Ease 0.35 — else →; n/a if either window has <3 rows). The script already skips archetypes with <3 evals (`minRoles`), so its list IS the set you analyze in the body.

**B) Dimensional fingerprint by archetype** — `fingerprints[].dims` gives the per-dimension average; `fingerprints[].bottleneck` flags the lowest-scoring dimension (the archetype's own bottleneck). Cross-reference with corpus-wide `dimensionDrag[]` to see whether an archetype's bottleneck is idiosyncratic or part of the systemic drag.

**The systemic constraint (new, and the spine of the report)** — `systemicConstraint.dominant` names the dimension that gates the typical role across the most archetypes; `systemicConstraint.lever` names the cheapest shared lever. These two answers ARE Step 2's questions 2 and 3. Do not re-derive them — read them off the JSON and reason about *why* the dominant constraint is expensive while the lever is cheap.

**C) Recurring gaps** — open up to 5 full reports (one per primary archetype where possible). Parse the qualitative "Key gaps" sections. Cross-reference each gap with the dimensional fingerprint from B — a gap that recurs in the prose AND drags the same dimension quantitatively (per `dimensionDrag[]`) is a high-conviction finding worth surfacing in the body.

**D) Geographic opportunity** — `cityExposure[]` gives where solid+ matches cluster. For the comp/Salary-Adj read, pull `salary_adj_city` per city from the TSV yourself. Mark preferred cities per `_profile.md` / `user/profile.yml`. Flag any city with `salary_adj_city` avg below 3.0.

**E) Brand vs WLB vs Role content patterns** — per archetype: `Avg Brand`, `Avg WLB`, `Avg Role content` (from `fingerprints[].dims`). Surface mismatches (e.g., high brand + low WLB = recurring trade-off; high brand + low Role content = the scanner is pulling prestigious seats with the wrong day-to-day).

**F) Best-fit alternative roles** — tally the `best_fit_roles` column across the corpus. Top 10–15 alternative roles with counts.

**G) Dream company coverage** — for each company in `user/profile.yml → target_roles.dream_companies` / `calibration.dream_companies`: postings seen, Match / Ease averages, roles surfaced, and how many were Blocked (with the check).

**I) Eligibility walls** — from `landscape`'s eligibility mix (or by tallying `eligibility_flags` yourself): the share of evaluations Blocked or amber, by check. A check that blocks a large share of the landscape (e.g. `language` or `work_auth`) is a sourcing problem — tighten `user/portals.yml` location / language filters so evaluation effort stops landing on walls — or, if it's a recurring amber, a single recruiter question worth asking everywhere.

**H) Trajectory — is targeting sharpening?** — straight from `score-trend.mjs`. Read `landscapeTrend`: if `insufficientData` is true OR `reportableVerdict` is `insufficient-data`, the corpus can't be trended yet (record the `reason` — or `verdictGate.reason` — in Appendix H and render § 4 as a baseline note). Otherwise capture, for Ease and for Match, the `reportableVerdict` + `verdictConfidence`, the earlier-vs-recent means, the `delta`, the `actionableShareDelta`, and the `splitDate`. Then read `trajectorySummary` (the improving/declining/stable split across re-evaluated listings, with counts in `verdictMoves`; the per-listing lists are `landscapeTrend.verdictUpgrades` / `.verdictDowngrades`) and skim `listingTrajectories[]` for any role whose verdict changed on re-eval — those are the per-listing color points for § 2 and § 4. This is the ONLY signal that answers whether the user is getting better at sourcing, so it earns a line in the TL;DR even though its detail lands in § 4 and the Appendix.

All of these outputs land in the **Appendix** (H feeds § 4 directly; I feeds § 1 when a wall is large). The body of the report uses them as evidence for judgments — it does not re-list them.

### Step 2 — Decide the punchline FIRST

Before writing any prose, force yourself to answer these five questions in one sentence each. Write them down at the top of your scratch notes; the entire report flows from these:

1. **What's the one path the user should focus on next cycle, and why?** (Anchor to the archetype whose typical role sits in the best verdict cell — high Match AND workable Ease — plus market demand and growth potential.)
2. **What's the one thing the user should STOP doing or de-prioritize?** (Anchor to the archetype from `fingerprints[]` with the lowest `actionableShare` that still eats real `share`, an eligibility wall that keeps blocking evaluations, the leakiest portal config, or a structural bottleneck the user has been ignoring.)
3. **What's the single cheapest fix with the largest cross-archetype leverage?** (This is `systemicConstraint.lever` — the dimension whose single-point lift moves the typical role to a better verdict in the most archetypes. Frame it against `systemicConstraint.dominant`: the dimension that *binds* the most archetypes is usually the expensive one, so the move is the cheaper lever that buys the most verdict upgrades. Usually that lever cashes out as a positioning reframe, a portal-config tightening, or a missing portal — something that attacks the constraint across multiple archetypes. Don't quote a timeline; just identify the move.)
4. **What's the runner-up path, and why is it runner-up rather than primary?** (Forces the counterfactual; prevents wishy-washy "do everything" recommendations.)
5. **Is the user's targeting sharpening, flat, or sliding — and what does that change?** (This is `score-trend`'s `reportableVerdict` — lead with the **Ease** axis, then Match. It's not decoration: a *sharpening* trend means "keep sourcing the way you have been — the cheap fixes in Q3 compound" and the user can lean in; a *sliding* trend means the most urgent action is upstream — re-tighten scan keywords or raise the pre-evaluation bar BEFORE chasing levers, because the funnel itself is drifting. A *flat-within-noise* verdict says the levers in Q3 are where the movement has to come from, since sourcing isn't moving the needle beyond the noise floor. If it's `insufficient-data`, say "baseline — can't yet tell" and don't fake a direction — the gate withheld the verdict for a reason.)

These five answers become the **TL;DR block at the top of the report** (Step 3, output structure below). They also constrain every per-archetype section — if a section's verdict contradicts the punchline, one of them is wrong and you need to reconcile before writing. Q5 in particular sets the *tone* of the whole report: a sharpening funnel earns an offensive review (double down, harvest), a sliding one earns a defensive one (fix sourcing first).

### Step 3 — Write the report

Use the output structure below. Strict rules:

- **TL;DR block at the very top** (before any section header). Tight, decision-grade.
- **Per-archetype sections lead with a judgment paragraph** ("The bet · The cost · The call"). Tables come after, not before. If an archetype has nothing surprising to say, give it one paragraph total and skip the fingerprint table.
- **Hard cap: ≤4 tables in the body.** Demote the dimensional fingerprint, geographic map, brand/WLB pattern, alternative-role tally, and dream-company coverage to the Appendix. The body uses inline numbers only when they change the read.
- **Forbidden patterns:** "Headlines:" bullet lists, "Key takeaways:" recaps, restating a table's contents in prose immediately after the table, the phrase "this is your baseline" repeated more than once.
- **Required pattern:** every numerical claim is followed by either (a) the action it implies, (b) the option it kills, or (c) the way it reframes the next paragraph. Stats without consequences get cut.

## Output structure

Write the full report to `reports/positioning/positioning-{YY-MM}.md`. Use this exact skeleton:

```markdown
# Career Positioning Report — {YY-MM}

**Evaluations analyzed:** {N} score-history rows ({date_from} → {date_to}) · {M} tracker entries · {K} previous positioning reports
**Primary archetypes considered:** {list}

---

## TL;DR

**Focus path:** {Archetype name + sub-route, ≤15 words total}.
**Why this and not the runner-up:** {1 sentence — anchor to fit + demand + the dimension that closes most easily}.

**Do next** (ordered by what unblocks what):
1. {Action — concrete, time-bound, names the file or portal or company to touch}
2. {Action}
3. {Action}

**Stop doing:** {The one path or behavior the user should de-prioritize this cycle, and why in one sentence}.

**Highest-leverage cheap fix:** {The single positioning / portal / framing change that attacks the binding constraint across multiple archetypes, with the dimension it lifts. No timeline — name the move and what it unlocks.}

**Trajectory:** {the Ease `reportableVerdict` in plain words, always with the window sizes — "Ease rising: recent {n} evals avg {X.X} vs {Y.Y} across {n} earlier (+{Δ}, {verdictConfidence} confidence); Match flat within noise" / "Ease sliding: …" / "Flat within noise (|Δ| under the {noiseFloor} floor)" / "Baseline — not enough history to trend yet". One clause on what it changes: lean in (rising) · fix sourcing first (sliding) · levers carry the movement (flat).}

---

## 1. Where You Stand

**3–5 paragraphs of prose.** No tables in this section. Anchor every claim to a number from the Appendix; format anchors as "{archetype} is the strongest fingerprint — Match {X.X} / Ease {X.X} across {N} evals — and {what that means for the call}". The illustration is the *shape* of the sentence, not the archetype or score; substitute the user's actual values. Cover:

- The shape of the corpus — what's dense, what's thin, what's surprising
- The binding constraint — lead with `systemicConstraint.dominant`: name the dimension that gates the typical role across the most archetypes and list how many it binds. Then make the report's signature move: contrast it with `systemicConstraint.lever` — "X binds the most archetypes but is the slow fix; the cheapest move that actually upgrades the most typical roles' verdicts is a single-point lift in Y, because [reframe / referral / portal change]". This is the sentence the rest of the report hangs on; anchor it to the exact dimensions and archetype counts the script returned, never an assumed pair.
- The eligibility read — if a check (Appendix I) blocks or ambers a meaningful share of the corpus, say so and what it implies for sourcing
- The brand picture — where the user's brand stack is compounding vs. where the scanner is pulling mid-tier seats that don't help
- The geographic read — which city is structurally strongest, where comp doesn't justify cost, what's dormant but about to activate
- Any surprise — a counter-intuitive finding (e.g., "this archetype under-delivers because the scanner is pulling the wrong employer tier, not because the archetype is broken")

End the section with **one paragraph naming the biggest leverage move** if not already covered. This is the prose version of the TL;DR's "highest-leverage fix".

## 2. Per-Archetype Read

For each **primary** archetype (from `_profile.md`):

### {Archetype name}

**The bet · The cost · The call** — one paragraph (3–5 sentences). Open with the verdict: "Double down" / "Hold steady — secondary play" / "Cut — re-route through {sub-archetype}". Then in one breath: what the user gets if it works (anchored to the Match and Brand averages), what they pay (anchored to the bottleneck dimension and the time cost to close it), and the call with reasoning.

**What's missing** (2–4 bullets max): each bullet names the gap and the dimension it lowers. If you can't name both, the gap isn't ready to surface yet.

**Path forward** — one short paragraph (3–6 sentences) describing the route, not a timeline. Anchor it to this archetype's own `cheapestLever` from `levers[]`: that field tells you the exact dimension + raise (e.g. "Competition 5 → 6") that moves the *typical* role in this archetype from its current `verdict` to a better one — so the entry move should be whatever closes that specific gap (the prerequisite proof point, reframe, or role choice that lifts that dimension past the screen). When this archetype's `cheapestLever` shares a dimension with `systemicConstraint.lever`, say so — that's the move that pays off here AND across the rest of the landscape, so it sequences first. Then name the compounding move (the next role or pivot the entry seat sets up) and the exit options it leaves open. Anchor to the `bottleneck` dimension throughout — say what each step does to relieve it. If the archetype's average role is already `go` (`cheapestLever` is null), say so and pivot the paragraph to "protect and harvest" rather than "break in". Do **not** assign months or weeks to steps; the user's actual cadence depends on cycle windows you can't predict. If the path materially depends on the order of two moves, say so in prose ("X has to happen before Y because…") — don't fake a Gantt chart.

**Re-eval signal** (one line, only if present): if any `listingTrajectories[]` entry in this archetype changed verdict on re-evaluation, surface it — an *improving* role that moved to a better verdict is a "prioritize before it closes" prompt (cite the company, the first→latest Match / Ease, and its `topMover` dimension); a *declining* one is a "re-check, fit may be drifting" prompt. Skip the line entirely if nothing in this archetype was evaluated twice.

**Where to find this path** (one line): top 5 companies from the corpus, comma-separated, with city in parens. Pull from scan-history, not invented.

For **secondary** archetypes: one paragraph each. No fingerprint table, no action-plan table — just the call and one line on why.

Skip archetypes with <3 evaluations entirely (mention in the Appendix's data-quality note).

## 3. Priority Recommendation

This is the **expanded** version of the TL;DR's focus path — 4–6 paragraphs.

**Focus path:** {repeat from TL;DR}.

**Why this path, given everything above:** explicit numbered reasoning.
1. **Fit:** what the score-history and gap analysis say about readiness
2. **Market demand:** what scan-history says about volume and geography
3. **Growth potential:** where this path leads in 2–5 years, anchored to the user's `_profile.md` narrative
4. **Counterfactual:** why NOT the runner-up — for EACH plausible runner-up, one sentence on why it's not the call this cycle

**Concrete next actions** (no timelines — just the moves, ordered by what unblocks what):
1. {action — usually the positioning reframe or portal-config fix that cashes out `systemicConstraint.lever`; name the dimension it lifts and the archetypes whose verdict it upgrades, then what that unblocks}
2. {action — usually a missing-portal addition or a cycle-window calendar item; what it unblocks}
3. {action — usually a specific application paired with a referral path; what it unblocks}
4. {action — usually the highest-ROI skill / cert / proof point; what it unblocks}

Only recommend ONE priority path. The whole point of this report is to cut through ambiguity. If the user has 3 archetypes they're juggling, picking one is the value.

## 4. Trajectory — Is Your Targeting Sharpening?

**This section is now driven by `score-trend.mjs`, not by eyeballing old report files.** The engine splits every scored evaluation into a calendar-balanced earlier vs recent window and trends Match and Ease separately on each — so "your targeting is improving" is a deterministic claim with two numbers behind it, not a vibe.

**Gate:** if `landscapeTrend.insufficientData` is true OR `reportableVerdict` is `insufficient-data`, render only the baseline note ("Not enough history to trend yet — {the engine's `reason`, or `verdictGate.reason` when the windows are too thin}. Re-run once the corpus spans a wider date range.") and stop. Do NOT fabricate a direction from a handful of dates, and never fall back to the legacy ungated `verdict` — it exists only for compatibility. (Prior positioning reports, if any exist, can still add a second, coarser data point — mention them, but the engine's verdict is the primary signal.)

When `landscapeTrend` IS usable:

**Lead with the verdict in one paragraph — Ease first.** State the Ease `reportableVerdict` plainly (then Match in one clause) — with each window's `count` and the `verdictConfidence` — and what it changes: *sharpening* → the funnel is working, lean into the focus path and let the cheap levers compound; *sliding* → the most urgent move is upstream, re-tighten scan keywords / raise the pre-evaluation bar before chasing levers, because the corpus quality is drifting down; *flat-within-noise* → sourcing isn't moving the needle beyond the noise floor, so the levers in § 3 are where movement has to come from. Anchor to the earlier-vs-recent Ease and Match means and the `actionableShareDelta` (the cleanest "am I sourcing better roles?" number). Then fold in `trajectorySummary`: of the listings you looked at twice, how the improving/declining/stable split fell and whether any changed verdict (`verdictUpgrades`/`verdictDowngrades`) — a wave of upgrades on re-eval is the user getting better-positioned for roles they already saw.

**Then one table** (max): earlier window vs recent window on `count`, avg Match, avg Ease, `actionableShare`, and `dateRange`, plus the 1–2 re-evaluated listings that changed verdict (from `listingTrajectories[]`). Don't exhaustively list every re-evaluated role — pick the ones that change the read.

**Confounder check (mandatory):** state the engine's `splitDate`, then ask whether the scanner pulled a different *segment* of the market on either side of it — different archetypes, employer tiers, or cities. If it did, a rise or fall in avg Match or Ease is a corpus-mix artifact, not real targeting movement; say so explicitly so the user doesn't over-read it. (Cross-check the per-window archetype mix against the Appendix-A counts if you're unsure.)

---

## Appendix — Supporting Data

This is where ALL the tables live. The body of the report references them as evidence; the user opens the Appendix to verify a specific claim.

### A. Match / Ease by archetype
{Step 1A table}

### B. Dimensional fingerprint by archetype
{Step 1B table — per-dimension breakdown from `fingerprints[].dims`, with each archetype's `bottleneck` dimension and its average-role `cheapestLever` (dimension · from → to · resulting verdict) appended as columns. This is also where the systemic-constraint detail lives: list `systemicConstraint.dominant` (dimension + the archetypes it binds) and `systemicConstraint.lever` (dimension + the archetypes a single lift upgrades + avg lift), so the body's headline claim is verifiable here.}

### C. Recurring gaps cross-reference
{Step 1C table — qualitative gap × dimension it lowers × time-to-close}

### D. Geographic opportunity map
{Step 1D table}

### E. Brand × WLB × Role content patterns
{Step 1E table}

### F. Best-fit alternative roles tally
{Step 1F table — top 10–15}

### G. Dream company coverage
{Step 1G table + one verdict line per company}

### H. Trajectory detail (from `score-trend.mjs`)
{The numbers behind § 4, so its verdict is verifiable. If `landscapeTrend.insufficientData`, state the `reason` and skip the rest. Otherwise, for Ease and for Match: the earlier-vs-recent window table (`splitDate`, each window's `count` / mean / `actionableShare` / `dateRange`) and the `delta` + `actionableShareDelta`; then the `trajectorySummary` split (improving/declining/stable + `verdictUpgrades`/`verdictDowngrades`), and the full `listingTrajectories[]` movers list (company · role · first→latest Match / Ease · verdict transition · `topMover` dimension).}

### I. Eligibility walls
{Step 1I table — per check: Blocked count, amber count, share of the corpus, the most common reason. Omit when every evaluation was green.}

### J. Data sources
- `score-history.tsv`: {N} rows ({B} Blocked), {from} → {to}
- `positioning-intel.mjs`: backbone aggregates (run `node scripts/positioning-intel.mjs --summary`); {archetypesAnalyzed} archetypes with ≥ {minRoles} roles
- `score-trend.mjs`: trajectory engine (run `node scripts/score-trend.mjs --summary`); {landscapeTrend.reportableVerdict}, {reevaluatedListings} re-evaluated listings, split at {splitDate or "n/a"}
- `applications.md`: {M} entries
- `report-summaries.tsv`: {K} cached summaries
- Reports sampled for qualitative color ({≤5}): {filenames}
- Previous positioning reports: {list or "none"}

### K. Archetype bucketing applied
{List spelling-variant merges if `score-history.tsv` has naming variance. Format: `"{Canonical archetype name}" includes: {variant 1} ({count}), {variant 2} ({count}), ...`. Only include this section if the TSV actually has duplicates worth surfacing.}

### L. Data-quality notes
{Any caveats: archetypes skipped for insufficient sample, dream companies with zero postings, scanner coverage gaps the user should know about. Surface fix suggestions for `user/portals.yml` but do NOT edit it automatically.}
```

## Present a tight summary to the user

After writing the full report, show the user a condensed version in chat (this is essentially a re-render of the TL;DR block):

```
Career Positioning Report — {YY-MM}
({N} evaluations · {date_from} → {date_to})

Focus path: {archetype + sub-route}
Why (1 line): {one sentence}

Do next:
1. {action}
2. {action}
3. {action}

Stop doing: {one sentence}
Highest-leverage cheap fix: {one sentence}
Trajectory: {sharpening / sliding / flat / baseline — one clause on what it changes}

Full report: reports/positioning/positioning-{YY-MM}.md
```

## Rules

- **Never invent data.** If `score-history.tsv` has 4 rows for an archetype, do not claim a "trend" — say "insufficient signal" in the Appendix and skip the archetype in the body.
- **Lead with judgment, anchor with numbers.** Numbers go inline as evidence for a claim, not as the claim itself. If a paragraph contains 3 numbers and no action, rewrite it.
- **Hard cap: ≤4 tables in the body.** All others belong in the Appendix.
- **Do not tailor CV or generate PDFs** in this mode. It's analytical, not generative.
- **Do not modify `_profile.md` or `user/profile.yml`** automatically. If the report recommends a change (e.g., drop a dead archetype), surface it as a suggestion in Appendix L and ask the user before editing.
- **Do run BOTH `scripts/positioning-intel.mjs` AND `scripts/score-trend.mjs`** — both are pure, zero-token, read-only aggregations over `data/score-history.tsv` (neither writes anything). `positioning-intel` is the "where I stand" backbone; `score-trend` is the "is it sharpening" trajectory engine. Trust their Match/Ease/verdict/lever/trend numbers over any you compute by hand; both replay the canonical scoring engine, so a hand-computed number that disagrees is your error.
- **Do not rerun `scripts/scan.mjs` or `scripts/analyze-patterns.mjs`** — those are separate modes. Positioning reads; it does not scan or re-process. (`analyze-patterns.mjs --scouting` overlaps with `positioning-intel.mjs` but reasons at corpus level only; positioning-intel adds the per-archetype lever layer this mode needs.)
- **Respect the Data Contract.** This mode reads a lot of files but writes ONLY to `reports/positioning/positioning-*.md`.
- **One positioning report per month max.** If `reports/positioning/positioning-{YY-MM}.md` already exists, ask the user whether to overwrite or skip. Usually skip — a month's gap allows enough new data to accumulate.

## When something blocks you

**If something blocks you, tell the user in Messages.** When this runs from the app, nobody reads your final output, so a question or "what I need from you" there goes unanswered. If a tool call is denied, a step fails in a way only the user can fix, or you need their decision, post ONE message and keep going with whatever you can still do: `node scripts/messages.mjs post --source worker --kind alert --title "…" --body "…" --key positioning:<YYYY-MM-DD>`. The body says what you finished, what is left undone (which sections) and what you need from them. Never work around a denial (for example by writing a file another way); the message is the way out.

# Scoring v2 — Eligibility gate, Match, Ease

**Status:** canonical spec for the scoring model. Replaces the v1 model (6 dims → Current Fit / Aspirational Fit → Overall, Sales-Trap Risk signal, CF/AF-based tiers). Every writer, reader, prompt and UI surface follows this file; the executable source of truth is `scripts/lib/score-bands.mjs` + `scripts/lib/eligibility.mjs`, and this doc must change in the same commit as any rule change.

The first axis was called **Want** until 2026-10-21. Data written before the rename (a `want` score-history column, a `Want` scouting column, `W8.3 E5.6` score cells, `**Want:**` report headers, `(want)` dimension tags, `scoring.want_weights`) is carried over by `scripts/migrate-match-rename.mjs`. Until it runs, the readers accept the old names, but new score-history rows are refused (the append checks the header) and `npm run doctor` points at the migration.

A listing gets three things, evaluated in order:

1. **Eligibility** — a gate, not a score: `green` / `amber` / `red`, computed from JD facts vs. the candidate's `eligibility:` block in `user/profile.yml`.
2. **Match** (1–10) — how well the role fits what the candidate is after: the work, where it leads, the life around it.
3. **Ease** (1–10) — how realistic it is to get in.

The **verdict** (and the legacy `T1`–`T4` storage tier) comes from the Match × Ease grid. A `red` listing is **Blocked**: no Match, no Ease, its reason is shown instead of a score.

There is no Overall. Surfaces that need one sortable number use **Priority** (§5), which is never shown as a headline score.

---

## 1. Eligibility gate

### 1.1 Inputs

**JD facts** (the agent extracts these from the JD; `null` = the JD doesn't say):

```jsonc
"eligibility_facts": {
  "employment": "internship" | "graduate_programme" | "fixed_term" | "permanent" | "working_student",
  "start":    { "earliest": "2027-06-01" | null, "latest": "2027-09-30" | null, "flexible": false, "text": "verbatim JD quote or null" },
  "duration_months": 6 | null,               // internship / programme / fixed-term length
  "graduation": { "from": "2025-06" | null, "to": "2027-12" | null, "soft": false, "text": "..." },
                                              // "must have graduated / be graduating between from..to"; soft = "ideally", "preferably"
  "languages": [ { "language": "German", "level": "C1", "required": true, "text": "..." } ],
                                              // level: A1..C2 | native | fluent | professional | business | conversational | basic
                                              // required: false for "a plus", "nice to have"
  "country": "DE",                            // ISO-3166 alpha-2 of the work location; "REMOTE-EU" allowed
  "work_auth": {
    "requires_existing_right": false,         // "must already have the right to work in X"
    "sponsorship": "offered" | "not_offered" | "unknown",
    "below_sponsorship_salary_floor": false   // true when a sponsored visa route has a statutory salary floor the role's comp misses
  },
  "other": [                                  // agent-judged requirements the five checks don't model:
    { "status": "amber", "reason": "STEM degree required", "question": "Does a Business Analytics MSc count?", "text": "..." }
  ]                                           // e.g. degree field, enrolment status ("one term remaining after the internship"),
                                              // citizenship-grade clearances. status: amber | red; red only when the JD states it as
                                              // mandatory AND the CV clearly fails it.
}
```

**Candidate profile** — `user/profile.yml` → `eligibility:` (user layer; the system ships an example in `config/profile.example.yml`). `scripts/score-listing.mjs` reads it from `user/profile.yml` itself; tests pass it as `eligibility_profile` in the input JSON (input wins over file).

```yaml
eligibility:
  available_from: "2026-11-01"           # earliest date the candidate can start anything
  blocked_windows:                        # no role may START or RUN inside these
    - { from: "2027-01-01", to: "2027-05-31", reason: "study term" }
  graduations:                            # candidate's own graduation dates (YYYY-MM)
    - { degree: "MSc", date: "2026-10" }
  languages:
    - { language: "English", level: "C2" }
    - { language: "Spanish", level: "B2" }
  work_authorisation: ["EU"]              # "EU" expands to EU-27 + EEA (IS, LI, NO); CH = amber; also ISO codes, e.g. "GB"
  duration_months:                        # acceptable length: one range, or one per employment type
    default: { min: 3, max: 12 }          # internships, fixed-term, working student, unknown type
    graduate_programme: { min: 12, max: 24 }
  permanent_start_ok_before_block: false  # if false, a permanent role starting before a blocked window that it would run through is red
  score_through_red:                      # optional: red listings that still get Match / Ease (see below)
    checks: [start_date, duration, graduation, work_auth, other]
    languages: [German]                   # a language red is scored only for these languages
    except_employment: [working_student]  # never scored, whatever the red
```

### 1.2 Checks

The checks are `start_date`, `duration`, `graduation`, `language`, `work_auth` and `other`. Each check returns `{ check, status: "green"|"amber"|"red", reason, question? }`. `question` is set on every amber: the one thing to ask the recruiter to resolve it.

| Check | Red | Amber | Green |
|---|---|---|---|
| `start_date` | The role's period overlaps a blocked window and `start.flexible` is false. Role period = `[start.earliest, start.earliest + duration_months)` for internships/fixed-term/graduate programmes; for `permanent`, `[start.earliest, ∞)` when `permanent_start_ok_before_block` is false, else just the start date. Also red when `start.latest` < `available_from`. | Start not stated (`start.earliest` null) for internship / fixed-term / graduate programme; or an overlap exists but `start.flexible` is true; or start < `available_from` but `latest` ≥ it. | Known start, no overlap, ≥ `available_from`. Permanent role with no stated start → amber only if a blocked window lies in the next 9 months, else green. |
| `duration` | — | `duration_months` outside the `[min, max]` range for the listing's `employment` type (§ 1.2.1); or null for an internship. | Inside range, or not applicable (permanent role, or no range for that type). |
| `graduation` | A hard window (`soft: false`) and no candidate graduation date falls inside `[from, to]`. The agent sets `soft: false` only when the JD words it as mandatory ("must", "only", "required"); "penultimate year", "graduating in 2028", "ideally" are `soft: true`. | Same, but `soft: true`. |
| `other` | An `other` entry with `status: red`. | An `other` entry with `status: amber` (its `question` is required). | No entries. | No requirement, or a candidate date falls inside. |
| `language` | A `required` language the candidate lacks; or ≥2 CEFR steps below the required level; or **any** gap when the required level is C1 or above (fluent/C2/native — a fluency bar is tested in interviews, so B2 vs. C1 is a wall, not a grey zone). | A `required` language 1 step below a required level of B2 or lower. | All required languages met; `required: false` languages never block. |
| `work_auth` | Country not covered by `work_authorisation` AND (`requires_existing_right` OR `sponsorship = not_offered` OR `below_sponsorship_salary_floor`). | Country not covered and `sponsorship` is `offered` or `unknown`; or country is CH for an "EU" candidate. | Country covered (or `REMOTE-EU` with EU authorisation). |

#### 1.2.1 Duration ranges per employment type

Internships, graduate programmes and fixed-term contracts run for very different lengths, so one range for all of them flags every 18–24-month graduate programme as amber when the range was set for internships. `duration_months` therefore takes either form:

```yaml
duration_months: { min: 3, max: 12 }          # one range for every type (the original form)

duration_months:                               # a range per type
  default: { min: 3, max: 12 }                 # the types not listed below
  internship: { min: 3, max: 6 }
  graduate_programme: { min: 12, max: 24 }
```

The type is the JD's `employment` fact (the same field `start_date` reads). Keys that can carry their own range: `internship`, `graduate_programme`, `fixed_term`, `working_student`. A type without its own range uses `default`; without `default`, a top-level `min` / `max` (so `{ min: 2, max: 12, graduate_programme: { max: 24 } }` also works); with neither, that type's length is not checked. A missing bound in a range means no bound on that side. A `permanent` role is never length-checked. The amber reason names the type whose range applied (`30 months is outside your accepted range for a graduate programme (12–24 months)`). Executable source: `durationRangeFor()` in `scripts/lib/eligibility.mjs`.

**Level ladder** (CEFR steps): `basic`=A2(2), `conversational`=B1(3), `professional`/`business`=B2(4), `fluent`=C1(5), `C2`=6, `native`=7; A1=1, A2=2, B1=3, B2=4, C1=5. A candidate's `native` meets any requirement.

**Overall eligibility** = worst status across checks. `amber_count` = number of amber checks.

**Unknown is not green.** A JD that is silent on the start date of an internship is amber, because that is where most hand-caught misses came from.

### 1.3 Effects

- **red, scored through** → when `score_through_red` allows every red check (`eligibility.scored: true`; a language red only when every language that caused it is listed; never for an `except_employment` type), the listing stays `blocked` / `T4` with no Priority and no report file, but Match and Ease are scored and stored, so the Database still shows what that part of the market looks like. The app shows the scores with the red flag beside them and sorts them by √(Match × Ease). Absent block → no red listing is scored.
- **red** → verdict `blocked`, tier `T4`, no Match / Ease / Priority, no report file. The row still lands in `data/score-history.tsv` and `data/scouting.md` with the blocking reason, so it shows in the app with its reason instead of a score. If the company is in `calibration.dream_companies` / `lower_tier_dream_companies` / `brand_affinity_companies`, the note starts `Revisit next cycle:`.
- **amber** → scored normally; Ease −0.5 per amber check, max −1.0 (§3.3). Every amber `question` goes into the report's Eligibility block.
- **green** → no effect.

Eligibility runs **first**: `node scripts/score-listing.mjs --eligibility-only` returns only the eligibility result, so an agent can stop before scoring dimensions on a red listing.

### 1.4 What it replaces

- v1 language-barrier exception (force Skip) → `language` red.
- v1 Step 2c discards #3 (geo-locked) and #5 (visa-locked) → `work_auth` red (the listing is now logged as Blocked instead of silently filtered).
- v1 UK salary-floor gate → `work_auth.below_sponsorship_salary_floor`.
- v1 visa-friction sub-table (−1…−3 on Ease of Entry) → `work_auth` amber (−0.5 Ease). The rubric keeps the per-country reference table (which countries need sponsorship, which salary floors exist) as guidance for filling `work_auth`.

---

## 2. Match

### 2.1 Dimensions (integers 1–10, high = better)

**Motivators** (averaged — they are what makes a role worth wanting):

| Key | Dimension | Notes |
|---|---|---|
| `growth_mobility` | Growth / Mobility | v1 anchors unchanged. Growth calibration (structured onboarding +1 / sink-or-swim −1) still applies. |
| `optionality_exit` | Optionality / Exit | v1 anchors unchanged. |
| `brand_value` | Brand Value | A **CV signal**: how a recruiter at another company reads the name (v1 tier anchors). The candidate's wish lists never move it; only `extra_brand_bonuses` corrects a genuine perception gap. |
| `role_content` | Role content | The old Strategic/Analytical Fit **plus the old Sales-Trap Risk**: is the day-to-day work the kind the candidate wants? A quota / pipeline / cold-outreach-heavy role, or an ops role with an analytical title, scores low here. Anchors: v1 Strategic Fit anchors; and cap the score at 3 when the JD is ≥50% quota-carrying or outbound sales. |

**Hygiene factors** (they hurt when bad, add little when good):

| Key | Dimension | Notes |
|---|---|---|
| `best_cities` | City | Position in the candidate's preferred-cities list. Unchanged. |
| `salary_adj_city` | Salary (savings power) | Computed by the script from comp, tax and cost of living. Unchanged math. |
| `work_life_balance` | WLB | Unchanged. |

### 2.2 Formula

```
weights      = user/profile.yml → scoring.match_weights, else { growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1 }
M            = Σ wᵢ·xᵢ / Σ wᵢ                              over the 4 motivators
M_penalty    = 0.30 × (number of motivators scoring ≤ 2)
H            = h(best_cities) + h(salary_adj_city)* + h(work_life_balance)
               * salary term is 0 when is_intern (stipends are not salaries)
h(x)         = +0.25  if x ≥ 8
                0     if 5 ≤ x < 8
               −0.40  if 4 ≤ x < 5
               −0.80  if 3 ≤ x < 4
               −1.20  if x < 3
P            = PREFERRED_COMPANY_MATCH_BONUS (0.25) when company ∈ calibration.lower_tier_dream_companies, else 0
               (the candidate's liking for a company is preference: it lives here, never in Brand)
Match_raw     = clamp(M − M_penalty + H + P, 1, 10)
dream floor  : company ∈ calibration.dream_companies → Match = max(Match_raw, 8.0)
vetoes (applied after the floor; they win over it):
               any hygiene factor < 3 (salary ignored for interns) → Match = min(Match, 5.0)
               role_content ≤ 3                                 → Match = min(Match, 6.0)
Match         = round to 2 decimals
```

Constants live in `scripts/lib/score-bands.mjs` as `HYGIENE_STEPS`, `MOTIVATOR_BOTTOM_PENALTY = 0.30`, `HYGIENE_VETO_CAP = 5.0`, `ROLE_CONTENT_VETO_AT = 3`, `ROLE_CONTENT_VETO_CAP = 6.0`, `DREAM_MATCH_FLOOR = 8.0`, `PREFERRED_COMPANY_MATCH_BONUS = 0.25`, `DEFAULT_MATCH_WEIGHTS`.

Poverty-wage discard (salary score 1) stays a pre-scoring discard in `modes/pipeline.md` Step 2c.

---

## 3. Ease

### 3.1 Dimensions (integers 1–10, high = easier)

| Key | Dimension | What it measures |
|---|---|---|
| `skills_match` | Skills match | v1 anchors unchanged: listed skills vs. CV, skills only. |
| `experience_bar` | Experience bar | YoE and prior-background demands vs. the CV. 10 = no experience asked / exact persona; 7 = 1 preferred year or a prior internship preferred, which the candidate roughly has; 5 = 1 year required or a "top-tier prior internship" preference the candidate partly meets; 4 = 1–2 years required; 3 = 2–3 years required; 2 = 3+ years; 1 = senior / specialist. |
| `competition` | Competition | How selective the brand is and how big the pool is. Start at 7 and adjust: brand-competition tier −1…−4; preferred-background signalling the candidate lacks −2; internship at the same brand +1; cohort ≥10 seats +1; a required language the candidate has that filters most of the pool +1/+2; local target-school match +1, CEMS double-match +2 (replaces +1). Clamp 1–10. |

**Referral modifier** (applied by the script to `competition` before the rollup): input `referral: "warm-direct"` → +1.0, `"warm-intro"` → +0.5, else 0; clamp to 10. The agent sets it from `data/network.md` (e.g. `npm run outreach-plan -- "Company" --summary`); batch workers may leave it null.

### 3.2 Formula

Getting hired is a funnel: each stage multiplies the odds, so a weak stage drags more than a strong one lifts. Ease is a **weighted geometric mean**.

```
weights   = user/profile.yml → scoring.ease_weights, else { skills_match: 0.35, experience_bar: 0.35, competition: 0.30 }
Ease_geo  = exp( Σ wᵢ·ln(xᵢ) / Σ wᵢ )
wall      : experience_bar ≤ 3 → Ease_geo = min(Ease_geo, 4.5)
amber     : Ease = Ease_geo − min(0.5 × amber_count, 1.0)
Ease      = clamp(Ease, 1, 10), rounded to 2 decimals
```

Constants: `DEFAULT_EASE_WEIGHTS`, `EXPERIENCE_WALL_AT = 3`, `EXPERIENCE_WALL_CAP = 4.5`, `AMBER_EASE_PENALTY = 0.5`, `AMBER_EASE_PENALTY_MAX = 1.0`, `REFERRAL_BONUS = { 'warm-direct': 1.0, 'warm-intro': 0.5 }`.

Ease is point-in-time: it moves as the candidate's profile grows, so its trajectory per archetype is the key positioning signal (it replaces v1's Ease of Entry as "the trajectory canary").

---

## 4. Verdict grid

Constants: `MATCH_HIGH = 8.0`, `MATCH_MID = 6.5`, `EASE_HIGH = 7.0`, `EASE_MID = 5.0`.

| | Ease ≥ 7.0 | 5.0 ≤ Ease < 7.0 | Ease < 5.0 |
|---|---|---|---|
| **Match ≥ 8.0** | `go` — Go: apply now (T1) | `stretch` — Stretch: apply with prep (T2) | `growth` — Growth target: close the gap first (T3) |
| **6.5 ≤ Match < 8.0** | `solid` — Solid: apply (T2) | `thin` — Only if your pipeline is thin (T2) | `skip` (T4) |
| **Match < 6.5** | `skip` — easy, but a weak match (T4) | `skip` (T4) | `skip` (T4) |
| **Eligibility red** | `blocked` (T4) | | |

`assignVerdict({ match, ease, eligibility })` → `{ verdict, tier, reason }` in `score-bands.mjs`. Labels (`VERDICT_LABELS`): go "Go", stretch "Stretch", growth "Growth target", solid "Solid", thin "If pipeline thin", skip "Skip", blocked "Blocked".

Report depth by tier is unchanged: T1 full report, T2 short (Fit/gaps + Verdict + Path forward), T3 Gap & Growth roadmap, T4 no file.

**Ethical-use rule:** recommend against applying when the verdict is `skip` or `blocked` (this replaces "Overall below 7.0"). `thin` is allowed with an explicit "only if your pipeline is thin" caveat.

Promotion hint: `READY` for `go`; `MONITOR` for `stretch` and `solid`; blank otherwise.

---

## 5. Priority (sort key only)

`priority = round(sqrt(match × ease), 2)`; `null` when blocked. Used where a surface needs one number: sort orders, the batch runner's `--min-score` gate and average, dedup "higher wins" in the merge scripts, peer percentile. Never rendered as the headline score — UIs show **Match · Ease** and the eligibility chip.

---

## 6. Script I/O (`scripts/score-listing.mjs`)

**Input** (v1 fields kept: `company`, `role_archetype`, `city`, `country`, `comp`, `comp_source`, `tax_override`, `col_override`, `is_intern`, `soft_benefits_modifier`, `calibration`). `comp_source` is `disclosed` · `estimate` · `none`; `none` (pay undisclosed, nothing public found) takes no `comp` and gives Salary Adj for City a default 5 before the soft-benefits modifier, with no tax or city lookup:

```jsonc
{
  "eligibility_facts": { ... §1.1 ... },
  "eligibility_profile": { ... optional; else read from user/profile.yml ... },
  "scoring_weights": { "match": {...}, "ease": {...} },   // optional; else user/profile.yml → scoring.*
  "referral": "warm-direct" | "warm-intro" | null,
  "judgment_scores": {
    "growth_mobility": 8, "optionality_exit": 8, "brand_value": 9, "role_content": 7,
    "best_cities": 8, "work_life_balance": 6,
    "skills_match": 8, "experience_bar": 6, "competition": 5
  }
}
```

`--eligibility-only`: needs only `eligibility_facts` (+ profile); returns `{ eligibility }`.
On red: returns eligibility + `verdict: "blocked"`, `tier: "T4"`, `match: null`, `ease: null`, `priority: null`, and skips the tax/COL lookups (no `judgment_scores` needed).

**Output:**

```jsonc
{
  "eligibility": { "status": "amber", "amber_count": 1, "checks": [ { "check": "start_date", "status": "amber", "reason": "...", "question": "..." }, ... ] },
  "salary_adj_for_city": { "score": 5.3, "base_score": 5, "modifier": 0.3, "summary": "About €260 a month left after living costs in Lyon.", "math": "comp €… → net … → savings … → final 5.3", "provenance": {...}, "computed": {...} },   // summary = the Salary cell; math = the footer line, markdown-safe
  "calibrated_dims": { "brand_value": {...}, "growth_mobility": {...}, "competition": { "raw": 5, "final": 6, "adjustments": [ { "source": "warm-direct referral", "value": 1 } ] } },
  "match": { "score": 8.25, "motivators_mean": 8.0, "motivator_penalty": 0, "hygiene": { "best_cities": 0.25, "salary_adj_city": 0, "work_life_balance": 0 }, "floor": null, "vetoes": [] },
  "ease": { "score": 5.6, "geometric": 6.1, "wall": false, "amber_penalty": 0.5 },
  "priority": 6.8,
  "verdict": "stretch",
  "verdict_label": "Stretch",
  "tier": "T2",
  "tier_reason": "Match 8.25 ≥ 8.0, Ease 5.6 in 5.0–7.0",
  "explanation": { ... §7 ... }
}
```

`match`/`ease` are objects in the script output; everywhere else (TSV, DB, types) they are the plain numbers `match.score` / `ease.score`.

---

## 7. Explainability (`scripts/lib/explain-score.mjs`)

Same purpose as v1 (binding constraint, drivers, cheapest lever), re-implemented on the v2 engine and replaying it (never re-deriving rules). The result is **not rendered as its own report section**: the worker uses `bindingConstraints[0]` and `levers[0]` to decide what the Recommendation and Gaps lead with, translated into plain words.

- **Binding constraints** (kinds): `eligibility_red` (the red check), `experience_wall`, `hygiene_veto` (which factor), `role_content_veto`, `amber` (each amber check — its lever is "resolve: {question}", worth +0.5 Ease), `low_match` (Match below the next row's threshold), `low_ease` (Ease below the next column's threshold).
- **Levers:** the smallest single-dimension integer change (or single amber resolved) that moves the verdict to a better cell. Better-cell order: `blocked < skip < thin < growth < solid < stretch < go`. Search one dimension at a time, up to +4 steps; report `{ dimension, from, to, newVerdict }` or "no single lever".
- `headline` and the per-item `message` strings stay in the output for the frontend and for the worker's scratch reasoning; reports don't paste them.

---

## 8. Storage formats

### 8.1 `data/score-history.tsv` (v2 header, 29 columns)

```
date	archetype	skills_match	experience_bar	competition	ease	growth_mobility	optionality_exit	brand_value	role_content	best_cities	salary_adj_city	work_life_balance	match	priority	eligibility	eligibility_flags	verdict	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw	url
```

- `tier` is `T1`–`T4` (v1's `full|short|growth|skip` vocabulary is retired).
- `eligibility` = `green|amber|red`; `eligibility_flags` = `;`-joined `check:status:reason` for every non-green check (empty when green).
- Blocked rows: all dimension columns, `match`, `ease`, `priority` are **empty** (not 0). Readers must treat empty as missing (`null`/`NaN`), never as 0.
- Readers parse by header name. v1 history was archived on the switch (`data/archive/scoring-v1/`), so readers need no v1 compatibility.

### 8.2 `data/scouting.md` (12 columns)

```
| # | Date | Company | Role | Match | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes |
```

- `Match` / `Ease`: `8.25` / `5.6` (no `/10`), `—` when blocked.
- `Eligibility`: `green`, `amber: <reasons ;-joined>`, `red: <reason>`.
- Scouting additions TSV (`batch/scouting-additions/`), 12 tab-separated columns in the same order: `num date company role match ease tier eligibility report deadline hint notes`.

### 8.3 `data/applications.md`

Column layout unchanged (10 columns). The `Score` cell for new rows is `M8.3 E5.6` (blocked listings are never promoted). Legacy `X.X/10` cells on existing rows stay valid and are displayed as-is. Shared helper `parseScoreCell(cell)` → `{ match, ease }` | `{ legacy: 7.4 }` | `null` — in `scripts/lib/tracker-core.mjs` and mirrored in the frontend parser. Tracker-additions TSV score column uses the same `M.. E..` form. Cells written before Match was renamed from Want (`W8.3 E5.6`) still parse; `scripts/migrate-match-rename.mjs` rewrites them.

### 8.4 `data/report-summaries.tsv` (headerless)

`date company role archetype tier match ease eligibility key_gaps verdict` — `key_gaps` = dimensions ≤ 5; `verdict` = verdict key.

### 8.5 Report header + body

```
**Match:** 8.25/10 · **Ease:** 5.6/10
**Eligibility:** amber — start date not stated
**Verdict:** Stretch — apply with prep
**Tier:** T2
**URL:** ...
```

Body, in order: `## Eligibility` (table: Check | Status | Reason; then an "Ask the recruiter" list of amber questions), `## Dimensional scoring` (one table, three groups in this row order and with these exact tags, so the parser can split them):

```
| Dimension | Score | Reasoning |
| Growth / Mobility (match) | 8/10 | ... |
| Optionality / Exit (match) | ... |
| Brand Value (match) | ... |
| Role content (match) | ... |
| City (hygiene) | ... |
| Salary Adj for City (hygiene) | {salary_adj_for_city.summary} |
| Work-Life Balance (hygiene) | ... |
| **Match (rollup)** | **8.25/10** | carried by brand and the work itself |
| Skills Match (ease) | ... |
| Experience bar (ease) | ... |
| Competition (ease) | ... |
| **Ease (rollup)** | **5.6/10** | held down by the open start date |
| Best-fit Early-career Roles (context) | text | ... |
```

Reasoning cells are plain prose — no backticks, no bracketed tokens, at most an occasional bold; rollup rows give the number plus a few plain words, never the formula. The Salary cell is `salary_adj_for_city.summary`, a one-line human summary the script returns (e.g. "About €150 a month left after living costs in Lyon (estimated pay)").

Then the tier's prose sections (`modes/scouting.md` § Output Behavior; there is no `## Why this score` section). The report's **last line** is the footer `Salary math: {salary_adj_for_city.math}` — the full math chain, exactly once.

### 8.6 Batch worker final JSON

`{ ..., "match": 8.25, "ease": 5.6, "eligibility": "amber", "verdict": "stretch", "tier": "T2", "score": <priority or null> }` — `score` stays the key the batch runner reads, now carrying Priority.

---

## 9. Statistical contract

`docs/scoring-statistical-design.md` and `scripts/lib/scoring-stats.mjs` are re-derived for v2. Constants (backend and the frontend mirror `frontend/src/lib/scoringStats.ts` use these exact names): `MATCH_NOISE_FLOOR = 0.30` (one integer step on one motivator at equal weights = 0.25, rounded up), `EASE_NOISE_FLOOR = 0.35` (one step on a 0.35-weight dimension near 6 ≈ 0.32), `PRIORITY_NOISE_FLOOR = 0.30`. Bands for display/sorting come from `verdict`, never from new thresholds on a number. Gates unchanged in kind (peers ≥5, ≥10 evals per trend window, per-claim calibration minimums), trend/peer/calibration claims stated on Match and Ease separately, blocked rows excluded from score analytics but counted in eligibility analytics (share of red/amber by check).

---

## 10. Dropped from v1

`strategic_fit` (→ `role_content`), `sales_trap_risk` (→ `role_content`), `ease_of_entry` (→ `experience_bar` + `competition` + eligibility), `current_fit`, `aspirational_fit`, `overall`, the CF×0.70+AF×0.30 rollup, the Overall context modifiers (Salary/WLB → hygiene), the Stellar uniform-fingerprint override, the EoE ≤4 gate (→ experience wall + verdict grid), the band names Stellar/Strong/Decent/Pass.

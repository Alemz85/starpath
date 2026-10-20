# System Context -- career-ops
<!-- scoring-version: 2026-10-20 -->

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Don't put personal data here.
     
     Your customizations go in user/_profile.md (never auto-updated).
     This file contains system rules, scoring logic, and tool config
     that improve with each career-ops release.
     ============================================================ -->

## Sources of Truth

| File | Path | When |
|------|------|------|
| cv.md | `user/cv.md` (project root) | ALWAYS |
| user/article-digest.md | `user/article-digest.md` (if exists) | ALWAYS (detailed proof points) |
| profile.yml | `user/profile.yml` | ALWAYS (candidate identity and targets) |
| _profile.md | `user/_profile.md` | ALWAYS (user archetypes, narrative, negotiation) |
| applications sent | `data/applications-sent/{company-slug}-{role-slug}-{YYYY-MM}.md` | When one matches the listing (what was actually submitted: CV version, cover letter, transcripts) |

**RULE: NEVER hardcode metrics from proof points.** Read them from cv.md + user/article-digest.md at evaluation time.
**RULE: For article/project metrics, user/article-digest.md takes precedence over cv.md.**
**RULE: Read _profile.md AFTER this file. User customizations in _profile.md override defaults here.**

---

## Report Voice

**A report is a sharp advisor talking to the candidate about one listing — not an audit of the rubric.** Every prose section and every reasoning cell addresses the candidate in **second person** (*"you"*, *"your"*; imperatives are fine).

**Lead with what decides this listing.** Most listings are settled by one or two things: a start date that clashes with a study term, a fluency bar, a cap on how many applications the candidate can send to one company (a live constraint in `user/_profile.md`), a quota-heavy day-to-day, a brand that opens exactly the door they want. Find those first — the script's `explanation` (binding constraint, closest lever) plus any constraint in `user/_profile.md` that applies to this company — put them first, and give them the space. Leave out what doesn't move the decision: a 7 on work-life balance does not get a paragraph, and no section sweeps every dimension below 8.

**Opinion with its reason, in one sentence.** Tone reference (fictional CV advice): *"'Vibecoder' is the one I'd change. Right above it there's a serious section on AI-built projects, and a consulting recruiter may read 'vibecoder' as 'can't really code,' which undercuts that section."* A view, the reason, tied to the candidate's situation — no hedging, no checklist.

**Objective, not flattering.** Knowing the candidate changes what gets emphasised, never the score. Name the weakest requirement plainly and give honest odds.

**Evidence is a judgment call, not a quota.** Quote the posting in plain prose when it carries the point (*"they want advanced Excel, including macros"*). Mention a CV item only when it changes the judgment. Never walk the CV to prove coverage, and never tick through the requirements one by one.

**Numbers stay in the tables.** Prose says what they mean for the candidate.

**Banned in report prose and reasoning cells:**
- *"the user"*, *"the candidate"*, third-person possessives about the candidate, recruiter-memo register (*"this profile demonstrates…"*)
- file paths and section references (*"cv.md § Technical Skills shows…"*)
- bracketed tokens (*"[undisclosed]"*, *"[no gate stated]"*) and backticks — cells are plain prose with at most an occasional bold
- rubric vocabulary: anchor, calibration, adjuster, rollup, hygiene term, binding constraint, lever, tier, band
- score-fragility talk (*"a −1 here would drop this to T2"*)
- point arithmetic (*"big pool (minus two), CEMS channel (plus two)"*, *"+1 for the cohort"*) — say what raises or lowers the odds in words; the number in the Score column is the result
- *"the JD"* on repeat — say *"they"*, *"the posting"*, *"the role"*
- **metawriting** — narrating the process instead of stating the finding: *"I checked the comp cache like you asked and here is the salary I found"*, *"as instructed, I looked up…"*, *"after reviewing your CV…"*, *"based on my research"*, *"note: this score was calculated using…"*. Nobody asked how the report was made; say what is true (*"Pay is about €2,000 a month gross, from Glassdoor reports"*). The same holds for the end-of-run summary a worker prints: results, not a diary of steps.

**Where third person is still correct:** internal system docs and mode files (written for the agent and maintainers), TSV / cache / log rows, and references to other people (recruiters, hiring managers, alumni).

This rule is universal across modes (`scouting`, `interview-prep`, `apply`, `pdf`, `positioning`, `ofertas`, `contacto`, `deep`, `training`, `project`, `tracker`, `patterns`, `followup`, `deadlines`).

---

## Scoring System

There is **one evaluation mode**: `scouting` (defined in `modes/scouting.md`). Every listing gets three things, **in this order**:

1. **Eligibility** — a gate, not a score: `green` / `amber` / `red`, from JD facts vs. the candidate's `eligibility:` block in `user/profile.yml`.
2. **Want** (1–10) — how much the candidate wants this role.
3. **Ease** (1–10) — how realistic it is to get in.

The **verdict** comes from the Want × Ease grid (§ Verdict grid). A `red` listing is **Blocked**: no Want, no Ease, its reason is shown instead of a score. There is **no Overall** — surfaces that need one sortable number use **Priority**, which is never shown as a headline score.

**The contract is `docs/scoring-v2.md`; the executable source of truth is `scripts/score-listing.mjs`** (`scripts/lib/eligibility.mjs` + `scripts/lib/score-bands.mjs`). The agent extracts facts and assigns integer judgment scores with evidence; the script computes eligibility, Want, Ease, Priority, verdict and tier. **Never re-derive any of them by hand.** If this file and the script disagree, the script wins and this file has a bug.

> [!NOTE]
> **Storage tiers.** `T1`–`T4` and the `reports/tier-{N}/` folders stay the serialization layer (Electron app, SQLite cache, TSV pipelines). The verdict maps to a tier; candidate-facing prose talks in verdicts.
>
> Tier folders: `T1` → `reports/tier-1/` · `T2` → `reports/tier-2/` · `T3` → `reports/tier-3/` · `T4` → no report file.

## Dimensional Scoring Framework

**Scale:** every judgment dimension is an **integer 1–10, high = better** (for Ease dimensions, high = easier). Half-steps are not allowed — the script's levers and noise floors assume integer steps.

### Step 1 — Eligibility gate

#### Extracting `eligibility_facts` from the JD

Fill one object per listing. `null` means **the JD doesn't say** — never guess a value to make a check pass.

| Field | How to fill it |
|-------|----------------|
| `employment` | `internship` · `graduate_programme` · `fixed_term` · `permanent`. A working-student contract is `fixed_term`. |
| `start` | `{ earliest, latest, flexible, text }`. ISO dates. "Starting September 2028" → `earliest: "2028-09-01"`, `latest: "2028-09-30"`. "Start date flexible" / "rolling start" → `flexible: true`. **Several intakes the candidate picks between** ("March or September 2028 intake") → extract the intake that fits the candidate's availability and name the choice in `text`; it is green, not amber. Only when no offered intake fits, or the employer assigns the intake, does the clash count. `text` = the verbatim JD line, or `null`. |
| `duration_months` | Internship / fixed-term length as an integer. "6-month internship" → `6`. `null` if not stated. |
| `graduation` | `{ from, to, soft, text }` (`YYYY-MM`). Set `soft: false` **only** when the JD words the window as mandatory ("must", "only", "required"). "Penultimate year", "graduating in 2028", "ideally", "preferably" → `soft: true` (amber, flagged, never an auto-reject). |
| `languages[]` | `{ language, level, required, text }`. `level` = A1–C2 or `native` / `fluent` / `professional` / `business` / `conversational` / `basic`. `required: false` for "a plus", "nice to have", "is an advantage". |
| `country` | ISO-3166 alpha-2 of the work location (`DE`, `GB`). Remote within the EU → `REMOTE-EU`. |
| `work_auth` | `requires_existing_right` — the JD says "must already have the right to work in X". `sponsorship` — `offered` / `not_offered` / `unknown`. `below_sponsorship_salary_floor` — see § Filling `work_auth` below. |
| `other[]` | Agent-judged requirements the five structured checks don't model: degree field ("STEM degree required"), enrolment status ("at least one term remaining after the internship"), citizenship-grade clearances. Each `{ status, reason, question, text }`. `status: red` **only** when the JD states the requirement as mandatory AND the CV clearly fails it; otherwise `amber`. Every amber needs a recruiter `question`. **Only requirements the posting actually states**, quoted in `text`. A suspicion the posting doesn't voice ("they don't mention Danish, but the clients are Danish") is not an eligibility flag: it belongs in Competition and, if it matters, in the prose. |

**Worked extraction** (fictional JD, fictional candidate):

> *"6-month internship in our Lyon office, starting March 2027. You are enrolled in a Master's programme with at least one semester remaining after the internship. Fluent French required; German is a plus. Applicants must already hold the right to work in France."*

```jsonc
"eligibility_facts": {
  "employment": "internship",
  "start": { "earliest": "2027-03-01", "latest": "2027-03-31", "flexible": false, "text": "starting March 2027" },
  "duration_months": 6,
  "graduation": null,
  "languages": [
    { "language": "French", "level": "fluent", "required": true, "text": "Fluent French required" },
    { "language": "German", "level": "basic", "required": false, "text": "German is a plus" }
  ],
  "country": "FR",
  "work_auth": { "requires_existing_right": true, "sponsorship": "unknown", "below_sponsorship_salary_floor": false },
  "other": [
    { "status": "amber", "reason": "must have a semester remaining after the internship",
      "question": "Does a thesis-only final term count as a remaining semester?",
      "text": "at least one semester remaining after the internship" }
  ]
}
```

A candidate at French B2 is **red** on `language` here (C1+ bar, any gap blocks); German never blocks because it is `required: false` — at most it raises Competition.

#### The six checks

The script runs `start_date`, `duration`, `graduation`, `language`, `work_auth` and `other`. Each returns `{ check, status, reason, question? }`; every amber carries the one `question` to ask the recruiter.

| Check | Red | Amber | Green |
|-------|-----|-------|-------|
| `start_date` | The role's period overlaps a `blocked_windows` entry and `start.flexible` is false (permanent roles run open-ended unless `permanent_start_ok_before_block`); or `start.latest` is before `available_from`. | Start not stated for an internship / fixed-term / graduate programme; an overlap exists but the start is flexible; or the earliest start is before `available_from` but the latest isn't. Permanent role, no stated start → amber only if a blocked window lies in the next 9 months. | Known start, no overlap, on/after `available_from`. |
| `duration` | — | `duration_months` outside the candidate's `[min, max]`, or null for an internship. | In range, or not applicable. |
| `graduation` | Hard window (`soft: false`) and no candidate graduation date inside it. | Same, but `soft: true`. | No requirement, or a candidate date falls inside. |
| `language` | A required language the candidate lacks; ≥2 CEFR steps below; or **any** gap when the required level is C1+ (fluent / C2 / native — a fluency bar is tested in interviews). | 1 step below a required level of B2 or lower. | All required languages met. `required: false` never blocks. |
| `work_auth` | Country not covered by `work_authorisation` AND (`requires_existing_right` OR `sponsorship: not_offered` OR `below_sponsorship_salary_floor`). | Country not covered and sponsorship `offered` / `unknown`; or CH for an "EU" candidate. | Country covered (or `REMOTE-EU` with EU authorisation). |
| `other` | Any `other` entry with `status: red`. | Any `other` entry with `status: amber`. | No entries. |

CEFR ladder: A1=1 · A2/`basic`=2 · B1/`conversational`=3 · B2/`professional`/`business`=4 · C1/`fluent`=5 · C2=6 · `native`=7. A candidate's `native` meets anything.

**Unknown is not green.** A JD silent on an internship's start date is amber — that is where most hand-caught misses came from. The listing's eligibility is the worst of its checks.

#### Run it first

```bash
echo '{ "eligibility_facts": { ... } }' | node scripts/score-listing.mjs --eligibility-only
```

It reads the candidate's `eligibility:` block from `user/profile.yml` and returns only `{ eligibility }`. **If it says `red`, stop scoring** — no judgment dimensions are needed.

- **red → Blocked.** Verdict `blocked`, tier `T4`, no Want / Ease / Priority, **no report file**. The listing is still logged — a `data/score-history.tsv` row (dimension and score columns empty) and a scouting TSV row whose Eligibility cell carries the reason — so it shows in the app with its reason instead of silently vanishing. If the company is in `calibration.dream_companies` / `lower_tier_dream_companies` / `brand_affinity_companies`, the note starts `Revisit next cycle:`.
- **amber → scored normally**, Ease −0.5 per amber check (max −1.0, applied by the script). Every amber `question` goes into the report's `## Eligibility` block.
- **green → no effect.**

#### Filling `work_auth` — sponsorship reference

Read the candidate's `work_authorisation` from `user/profile.yml` → `eligibility:`. When the role's country isn't covered, this table decides `sponsorship` and the salary-floor flag. It is guidance for filling facts, not a score penalty.

| Role's country (candidate not authorised there) | Typical `sponsorship` | Salary floor to check |
|-------|-----------------------|-----------------------|
| EU / EEA member state, candidate has non-EU status | `unknown` unless the JD says otherwise; entry-level sponsorship varies by employer | National highly-skilled / Blue Card thresholds where the JD's comp is disclosed |
| Switzerland, EU candidate | — (the script makes CH amber for an "EU" candidate) | — |
| UK, candidate without UK status | `offered` only for structured graduate cohorts at established sponsors or when the JD says so; `unknown` for ad-hoc entry-level hires; `not_offered` when the JD says "no sponsorship" | Skilled Worker: **£38,700/year** (or the SOC going rate, if higher); new-entrant rate ~£30,960 only when the JD signals it |
| US / Canada | `not_offered` unless the JD opens the door (entry-level H-1B / TN sponsorship is rare) | — |
| Other (Singapore, UAE, …) | `unknown` unless stated | Local employment-pass salary floors |

- **`below_sponsorship_salary_floor: true`** when a sponsored route has a statutory floor the role's disclosed comp misses (e.g. UK full-time below £38,700 with no new-entrant or graduate-route mention). If comp is undisclosed but peer data (Glassdoor / Levels.fyi) lands it below the floor, leave the flag false, set `sponsorship: "unknown"`, and name the ambiguity in the report.
- "We sponsor visas for graduate roles" → `offered`. "Must have unrestricted right to work in X" → `requires_existing_right: true`. Passport / citizenship-grade requirements ("EU citizenship required", security clearance) go in `other[]`.
- UK internships at established sponsors usually run on the Temporary Worker (Government Authorised Exchange) route → `offered`; at smaller or unclear employers → `unknown`.

### Step 2 — Want

#### Motivators (averaged — what makes a role worth wanting)

| Dimension | What it measures | 10 = | 1 = |
|-----------|------------------|------|-----|
| **Growth / Mobility** | Does this role lead somewhere? | Documented multi-level track, mobility across functions, structured mentorship / LDP | Explicitly capped; no promotion, no mobility |
| **Optionality / Exit** | How good a stepping stone is it? | Skills + brand transfer to top destinations immediately | Locks you into one company's processes |
| **Brand Value** | Does the name carry weight on a CV — how does a recruiter at another company read it? (Not how much the candidate likes the company: that is Want preference.) | Global top-tier brand, recognized everywhere | No recognition outside one local market |
| **Role content** | Is the day-to-day work the kind the candidate wants (per the archetypes in `user/_profile.md`)? Absorbs the old sales-pigeonholing signal. | Every day is the target work | None of the target work; the title is misleading |

**Per-step anchors — Growth / Mobility:**
- **10:** Explicit multi-level promotion track; internal mobility to multiple functions; structured mentorship; LDP / rotational
- **9:** Clear ladder with named next roles; strong mobility across teams / geos
- **8:** Good growth signals; mentor assigned; structured programme (grad scheme, rotation)
- **7:** Growth possible, less structured; company growing; scope expands with performance
- **6:** Depends on individual performance + team fit; no formal path
- **5:** Some growth, narrow scope; limited functional mobility
- **4:** Capped function; years in the same role-type
- **3:** Dead-end role type; doesn't grow beyond ~2 years
- **2:** No growth indicators; execution-only; no ladder visible
- **1:** Explicitly capped; no promotion, mobility or scope expansion

**Per-step anchors — Optionality / Exit:**
- **10:** Transfers to top destinations (big tech, top consulting, top unicorns) on day one
- **9:** Very transferable skills; globally recognized brand; top-tier next moves in 2–3 years
- **8:** Portable to multiple sectors; recognized brand in target markets
- **7:** Portable skills with some niche exposure; good roles in adjacent sectors
- **6:** Moderately transferable; known in one region or sector
- **5:** Useful stepping stone, limited portability
- **4:** Mostly company-specific skills; narrow exits without retraining
- **3:** Very niche; limited portability outside one company or sector
- **2:** Locks you into one company's processes
- **1:** Dead-end exit; actively harms future options

**Per-step anchors — Brand Value:**
- **10:** Global top-tier (Google, McKinsey, Goldman Sachs); instantly recognized everywhere
- **9:** Near-global tier (Amazon, Meta, Stripe, BCG, Bain); top-tier in most markets
- **8:** Strong European / global tech or professional-services brand (Datadog, Revolut, Spotify, Big-4); recognized by most tech recruiters
- **7:** Known tech company or regional leader; solid signal in target markets
- **6:** Solid mid-market brand; known in sector, not prestige-signalling
- **5:** Smaller / regional company; known within a market or vertical
- **4:** Startup or early-stage; brand depends on future outcomes
- **3:** Unknown outside its immediate market
- **2:** No meaningful recognition
- **1:** Zero or actively negative recognition

**Per-step anchors — Role content** (read "target work" as the work the candidate's archetypes describe; the shares below are time spent on it):
- **10:** Pure target work; every day is what the archetype describes
- **9:** Predominantly target work; minor coordination (≤10%)
- **8:** Clearly target work; some project management or client-facing (~20%)
- **7:** Target-work core with a meaningful operational component (~30%)
- **6:** Half target work, half something else; the title says one thing, the reality is mixed
- **5:** More operational than target work; the target work is a support function
- **4:** Mostly execution / coordination with some target work
- **3:** Target work is incidental or reporting-only
- **2:** Execution-only with target-work framing in the title
- **1:** No target work at all; the title is misleading

**Sales cap (absorbs the retired sales-pigeonholing signal).** When the JD is **≥50% quota-carrying or outbound sales** (pipeline targets, cold outreach, BDR/SDR work), cap Role content at **3**; a BDR/SDR seat with analytical branding is a 2; pure quota-carrying sales is a 1. Consultative client-facing work with no quota is not capped. Say in the reasoning cell what the quota or outbound work is, quoting the posting when that makes the point. The cap does not apply when the candidate's own archetypes in `user/_profile.md` are sales roles — then sales work *is* the target work.

#### Hygiene factors (they hurt when bad, add little when good)

| Dimension | What it measures |
|-----------|------------------|
| **City** (`best_cities`) | Position in the candidate's preferred-cities list (`user/_profile.md` → Location Policy). Top preferred city floors at 9; a non-preferred city inside the candidate's reachable region floors at 6; outside it, 2–3. |
| **Salary Adj for City** (`salary_adj_city`) | Savings power after cost of living — computed by the script (rubric below). |
| **Work-Life Balance** (`work_life_balance`) | Reputation for WLB (Glassdoor / Blind / known culture). 10 = healthy ~40h; 1 = known burnout culture. |

**Best-fit Early-career Roles** (context, text): 1–4 roles at this company that would suit the candidate better than the one evaluated, free text. Not scored.

#### Calibration (applied by the script — pass the `calibration:` block, don't hand-apply)

- **Brand is a CV signal, never preference.** Score it on the tier anchors from how recruiters elsewhere read the name, including in the candidate's target markets. The candidate's own wish lists never move it. Only `extra_brand_bonuses` adjusts it, for a genuine perception gap the tiers miss (a name that carries more weight in the target market than its global tier).
- **Preference (Want):** `lower_tier_dream_companies` → +0.25 Want; `dream_companies` → the Want floor below. `brand_affinity_companies` (e.g. CEMS partners) have no score effect: their recruiting channel belongs in Competition.
- **Growth:** structured onboarding / learning path → +1; sink-or-swim → −1.
- **Dream floor:** `dream_companies` → Want ≥ 8.0 (the vetoes below still win).

#### Want formula (summary — the script is the source of the math)

```
M         = weighted mean of the 4 motivators (user/profile.yml → scoring.want_weights; default equal)
penalty   = −0.30 per motivator scoring ≤ 2
H         = h(City) + h(Salary Adj)* + h(WLB)      * salary term is 0 for interns
h(x)      = +0.25 (x ≥ 8) · 0 (5–7) · −0.40 (4) · −0.80 (3) · −1.20 (< 3)
P         = +0.25 for a lower-tier dream company (preference), else 0
Want      = clamp(M − penalty + H + P, 1, 10); dream floor 8.0
vetoes    : any hygiene factor < 3 (salary ignored for interns) → Want ≤ 5.0
            Role content ≤ 3                                     → Want ≤ 6.0
```

#### Salary Adj for City — savings-power rubric

**Score what the salary actually saves**, not how it compares to the local labour market. A modest salary in a cheap city and a high one in an expensive city can both be "competitive for their city" yet save very different amounts; this dimension scores the savings.

The math is encoded in `scripts/score-listing.mjs` (and `scripts/lib/score-bands.mjs`). The agent's job is to:

1. **Build total comp inputs** from the JD:
   - Base salary, bonus % (industry-typical estimate when undisclosed: big tech ≈ 15%, top consulting ≈ 20%, banking ≈ 30%+, most other ≈ 0–10%), 13th/14th month, monthly cash benefits (transit / meals / gym / housing), one-off sign-on.
   - **Equity:** prefer Levels.fyi (`company × role × level × city`). If Levels.fyi has nothing AND the JD discloses an equity number, annualize over vest — public RSU at face value, private RSU/options at 50% haircut (say in the Comp section that the equity value is speculative). If neither resolves it, set it to zero and say the figure is base pay only. Don't speculate.
   - Statutory benefits the country requires anyway (basic healthcare, statutory PTO, statutory parental leave) DO NOT count.
2. **Resolve the tax rate** for `(country, gross-rounded-to-€5K)`: check `data/tax-cache.tsv` for a row within 90 days. On a miss, WebSearch a tax calculator at this exact gross, pass it as `tax_override` and run with `--write-cache`.
3. **Resolve the city baseline:** check `data/col-cache.tsv` within 60 days. On a miss, WebSearch `numbeo.com/cost-of-living/in/{city}` and parse `Single person estimated monthly costs without rent + Apartment 1BR City Centre`. Pass as `col_override`, run with `--write-cache`.
4. **Decide the soft-benefits modifier** (judgment call, ±1.0 max — table below) and pass it as `soft_benefits_modifier`.
5. **Run the script.** It computes total comp → net → minus baseline → savings band → applies the modifier → returns the score with full math provenance.

**Soft-benefits modifier** — applied by the script, value picked by the agent:

| Signal | Modifier |
|--------|----------|
| Any 2 of: PTO ≥30 days, fully flexible / remote / hybrid 2–3d max, exceptional perks (sabbatical / housing / parental leave > statutory / learning stipend ≥€2K), Glassdoor benefits ≥4.0/5 | **+0.5 to +1.0** |
| 1 of the above OR explicitly-named meaningful perks | **+0.3** |
| Statutory minimums only | **0** |
| PTO ≤22 days, on-site mandatory in a high-COL city, Glassdoor benefits ≤2.5/5 | **−0.3 to −0.5** |

WebSearch `{company} benefits {city} site:glassdoor.com OR site:levels.fyi` if the posting doesn't surface enough to judge. Apply in 0.1 steps mid-bucket; when it moves the score, say why in plain words in the Comp section (*"generous leave and two office days a week"*).

**Internships** — pass `is_intern: true`; the script halves the city baseline (shared housing assumed) unless the JD states company-provided housing, and the salary hygiene term drops out of Want (stipends are not salaries).

**Poverty-wage discard:** if the script returns `score: 1` (savings < −€400/mo), `modes/pipeline.md` § Step 2c discards the listing before scoring.

#### Comp cache (`data/comp-cache.tsv`)

When a JD doesn't disclose salary, look up `(company, role_archetype, city)` in `data/comp-cache.tsv` — the system's persistent memory of comp data, populated at evaluation time, reused for ~60 days, then refreshed.

**Schema (TSV with header row; rows are fictional examples):**

```
company	role_archetype	city	currency	min	max	source	confidence	last_updated
Acme Analytics	Strategy & Ops Analyst	Dublin	EUR	45000	58000	glassdoor	high	2026-04-28
Northwind	Solutions Engineer	Dublin	EUR	68000	85000	levels.fyi	high	2026-04-28
Globex	Revenue Planning Intern	Berlin	EUR	2000	2500	jd	high	2026-04-28
```

- `role_archetype` = canonical archetype string, not the verbose JD title. Roles in the same archetype share a band.
- `currency` = ISO 4217. Values are /mo for interns and /yr for full-time.
- `source` = `glassdoor` | `levels.fyi` | `blind` | `payscale` | `jd` | `manual` (user-edited).
- `confidence` = `high` (multiple sources agree) | `medium` (single source) | `low` (extrapolated from an adjacent role / city).
- `last_updated` = ISO date the row was written.

**Lookup flow (stop at the first hit):**

1. **Exact match** within 60 days → use min/max as if disclosed.

**A band always resolves to its midpoint** — `(min + max) / 2` — as the base, whether it came from the cache, the posting ("€40–50K") or a lookup. Never pick a band's low or high end by feel; that's what makes the same listing score differently on two runs. Bonus / equity are added on top as usual.
2. **Cross-city same role** in a peer city within 60 days → adjust by the ratio of the two cities' baselines; note it as a cross-city estimate.
3. **Same company, peer archetype** in the same city within 60 days → note it as a proxy from a similar role.
4. **Miss or stale** → WebSearch **Levels.fyi → Glassdoor → LinkedIn Salary → Payscale → Blind**, aim for 2 sources, take the median of the entry / target-level band, say where the estimate came from in plain words in the Comp section (*"estimated from Glassdoor"*), and **append a row to the cache**.
5. **Nothing useful found** → score **5** and say plainly that pay is undisclosed and nothing public turned up. Never fabricate a band. This is the only path to a default 5.

**Refresh:** a stale row consulted → WebSearch and **overwrite** it (no duplicate), update `last_updated`. `source = manual` pins a row until the user touches it again.

### Step 3 — Ease

| Dimension | What it measures |
|-----------|------------------|
| **Skills Match** | Listed skills vs. the CV — skills only. |
| **Experience bar** | YoE and prior-background demands vs. the CV. |
| **Competition** | How selective the brand is and how big the applicant pool is. |

**Per-step anchors — Skills Match:**
- **10:** Every required + all preferred skills covered; domain knowledge a perfect match
- **9:** Every required covered; 1 minor preferred gap
- **8:** All required covered; 2+ preferred gaps
- **7:** Strong foundational coverage; 1 domain-specific required skill missing
- **6:** Required mostly covered; 1–2 meaningful gaps in central tools or domain
- **5:** Foundational overlap; 2–3 significant gaps
- **4:** Adjacent stack; transferable skills but core tools missing
- **3:** Weak overlap; most domain skills absent
- **2:** Only generic skills match
- **1:** Wrong stack entirely

**Re-score anchoring.** A listing evaluated before starts from its previous scores: `node scripts/score-listing.mjs --prior-only` (input `company`, `role`, `url`) returns them, and every score-listing run returns `prior.changes`, the judged dimensions that moved by 1 or more. Each such move needs something new since the prior date (the posting changed or more of it became available, a new CV item, new insider or company knowledge in `user/_profile.md`), stated in the reasoning cell as a plain fact, never as a comparison with the old run. A different reading of the same evidence keeps the prior score. Judgment dimensions otherwise wobble by a point between runs with nothing behind it.

**Duties are not requirements.** Tasks the posting says you "may" do ("your tasks may include building financial models") are not skills it requires. Count a skill gap only when the posting lists it as a qualification (required or preferred) or the selection process tests it.

**Skills only, not experience.** Walk the JD's required + preferred skills line by line against `user/cv.md` (Skills, Education, Projects). "3+ years in X" or "prior consulting background" are not skills — they belong to **Experience bar**. Domain-specific skills (a named ads ecosystem, an LLM stack, a CRM-admin skill) ARE skills: strong analytical foundations without the domain skill the role runs on is a 7, not an 8. The split is the point: "Skills 9, Experience bar 3" tells the candidate "you have the skills, not the experience" — the actionable read.

**Per-step anchors — Experience bar:**
- **10:** No experience asked, or the exact persona the JD describes
- **7:** 1 preferred year, or a prior internship preferred, which the candidate roughly has
- **5:** 1 year required, or a "top-tier prior internship" preference the candidate partly meets
- **4:** 1–2 years required
- **3:** 2–3 years required — **the experience wall** (Ease capped at 4.5 by the script)
- **2:** 3+ years required
- **1:** Senior / specialist

(8–9 and 6 interpolate between the named anchors.)

**Competition** — start at **7** and adjust; clamp 1–10. Apply an adjuster only when JD or company evidence supports it, and name it in the reasoning cell:

| Factor | Adjustment | Why |
|--------|------------|-----|
| **Brand competition tier:** top-100 SaaS, top consulting, NASDAQ-listed tech, recognized European unicorns | −1 to −4 | These brands draw thousands of applicants for a handful of entry-level seats |
| **Preferred-background signalling:** the JD prefers alumni of top consulting / IB / PE / top enterprise sales / big tech and the candidate has none | −2 | Other applicants will have it; at competitive brands the cut goes to them |
| **Internship at the same brand** (structured programme) | +1 | Larger cohorts, lower stakes than a full-time hire |
| **Cohort ≥10 seats** (rotational programme, graduate scheme, LDP) | +1 | Per-cohort selection, not one seat |
| **Language filter:** the JD requires a language the candidate has that filters most of the pool out (a "plus" language the candidate has also counts here) | +1 to +2 | A single-language requirement can remove most of the cross-border pool |
| **Local target-school match:** role's country is a primary recruiting market of one of the candidate's schools (table below) | +1 | Local alumni networks and recruiter familiarity raise screening pass-rates |
| **CEMS double-match:** company is a CEMS Corporate Partner AND the candidate has a CEMS school AND the role is in that school's primary market | **+2** (replaces the local-school +1; does not stack) | Partner-only channels compound with local network strength |

**Referral modifier** (applied by the script to Competition before the rollup): pass `referral: "warm-direct"` → +1.0, `"warm-intro"` → +0.5. Set it from `data/network.md` (`npm run outreach-plan -- "Company" --summary`). Batch workers leave it `null`.

A top-tier-brand internship the candidate is an exact persona match for typically lands Competition at 4–6, not 10 — the persona match lives in Experience bar, the crowd lives here.

**Local target-school sub-table.** Read the candidate's institutions from `user/cv.md` § Education. Apply **+1** when the role's country appears in a school's primary column; **+2** (instead) for the CEMS double-match. The user can extend or override this table in `user/_profile.md`.

| School | Primary recruiting market | Secondary markets | CEMS member? |
|--------|---------------------------|-------------------|--------------|
| **Esade** (Barcelona) | Spain (esp. Barcelona, Madrid) | Italy, France, Latin America, Portugal | Yes |
| **IESE** (Barcelona / Madrid) | Spain | Italy, Latin America, US (MBA-tier) | No |
| **IE** (Madrid) | Spain | Latin America, Portugal, MENA | No |
| **Bocconi** (Milan) | Italy | Switzerland, Spain, EU broadly | Yes |
| **HEC Paris** | France | Switzerland, Belgium, Luxembourg, EU broadly | Yes |
| **ESSEC / ESCP** (Paris) | France | Belgium, Luxembourg, Germany | ESCP yes / ESSEC yes |
| **INSEAD** (Fontainebleau / Singapore) | France, Singapore | Global — recognized everywhere at MBA tier | No |
| **LBS / LSE / Oxford / Cambridge / Imperial** | UK | EU broadly (post-Brexit reduced), US | LSE yes |
| **Copenhagen Business School (CBS)** | Denmark | Sweden, Norway, Finland, Germany, Netherlands | Yes |
| **Rotterdam School of Management (RSM)** | Netherlands | Belgium, Germany | Yes |
| **St Gallen (HSG)** | Switzerland | Germany, Austria, Liechtenstein | Yes |
| **WHU / ESMT / Mannheim** | Germany | Austria, Switzerland | WHU yes / ESMT no / Mannheim no |
| **Stockholm School of Economics (SSE)** | Sweden | Finland, Norway, Denmark | Yes |
| **NHH Norwegian School of Economics** | Norway | Sweden, Denmark | Yes |
| **Aalto University School of Business** | Finland | Sweden, Estonia | Yes |
| **Trinity College Dublin / UCD Smurfit** | Ireland | UK | UCD Smurfit yes |
| **Vienna University of Economics (WU)** | Austria | Germany, CEE | Yes |
| **Católica Lisbon** | Portugal | Spain, Brazil, Angola | Yes |
| **Warsaw School of Economics (SGH)** | Poland | CEE | Yes |

**How to apply:** list the candidate's schools; if the role's country is in any school's **primary** column → +1; if the company is a CEMS Corporate Partner (per `https://cems.org/corporate-partners` — e.g. McKinsey, BCG, L'Oréal, Mastercard, Accenture, Allianz, AXA, Danone, Henkel, ING, LVMH, Procter & Gamble, Roland Berger, Telefónica, Generali, Hermès, Schroders, Swiss Re) AND the candidate has a CEMS school AND the role is in that school's primary market → +2 instead. Secondary markets give no bonus by default. The school boost lifts Competition only; it never moves Experience bar, so it cannot break the experience wall.

#### Ease formula (summary — the script is the source of the math)

```
Ease_geo  = weighted geometric mean of Skills Match, Experience bar, Competition
            (user/profile.yml → scoring.ease_weights; default 0.35 / 0.35 / 0.30)
wall      : Experience bar ≤ 3 → Ease_geo ≤ 4.5
amber     : Ease = Ease_geo − min(0.5 × amber checks, 1.0)
Ease      = clamp(Ease, 1, 10)
```

Getting hired is a funnel — each stage multiplies the odds — so one weak dimension drags Ease more than a strong one lifts it.

**Ease is point-in-time.** Skills Match moves when the candidate gains skills; Experience bar and Competition move as the profile grows (degree finished, internship done, referral built). The same role evaluated six months apart can score very differently. The **Ease trajectory per archetype is the key positioning signal** — when it trends up, the candidate is closing the gap to "applyable today"; when it stays flat despite effort, the gap-closing strategy isn't working. `positioning` reads it from `data/score-history.tsv`.

### Verdict grid

| | Ease ≥ 7.0 | 5.0 ≤ Ease < 7.0 | Ease < 5.0 |
|---|---|---|---|
| **Want ≥ 8.0** | `go` — Go: apply now (T1) | `stretch` — Stretch: apply with prep (T2) | `growth` — Growth target: close the gap first (T3) |
| **6.5 ≤ Want < 8.0** | `solid` — Solid: apply (T2) | `thin` — Only if your pipeline is thin (T2) | `skip` (T4) |
| **Want < 6.5** | `skip` — easy, but you wouldn't want it (T4) | `skip` (T4) | `skip` (T4) |
| **Eligibility red** | `blocked` (T4) | | |

Verdict labels: `go` "Go" · `stretch` "Stretch" · `growth` "Growth target" · `solid` "Solid" · `thin` "If pipeline thin" · `skip` "Skip" · `blocked` "Blocked". The script returns `verdict`, `verdict_label`, `tier` and `tier_reason` — use them verbatim.

**Report depth by tier:** T1 full report · T2 short report (Fit/gaps + Verdict + Path forward) · T3 Gap & Growth roadmap · T4 no file (skip and blocked are still logged).

**Promotion hint:** `READY` for `go`; `MONITOR` for `stretch` and `solid`; blank otherwise.

**Ethical-use rule:** recommend against applying when the verdict is `skip` or `blocked`. `thin` is allowed only with an explicit "only if your pipeline is thin" caveat. The verdict is downstream of the scores — if it feels wrong, fix the scores and their evidence, never the prose.

### Priority (sort key only)

`priority = √(Want × Ease)`, rounded to 2 decimals; `null` when blocked. It exists for sort orders, the batch runner's `--min-score` gate, dedup "higher wins" in the merge scripts, and peer percentiles. **Never render it as the headline score** — reports and UIs show **Want · Ease** plus the eligibility chip.

### Running `score-listing.mjs`

```bash
echo '{
  "company": "...", "role_archetype": "...", "city": "...", "country": "..",
  "comp": { "base": 0 }, "comp_source": "disclosed|estimate",
  "is_intern": false, "soft_benefits_modifier": 0,
  "calibration": { ...from user/profile.yml calibration block... },
  "eligibility_facts": { ...Step 1... },
  "referral": null,
  "judgment_scores": {
    "growth_mobility": 0, "optionality_exit": 0, "brand_value": 0, "role_content": 0,
    "best_cities": 0, "work_life_balance": 0,
    "skills_match": 0, "experience_bar": 0, "competition": 0
  }
}' | node scripts/score-listing.mjs
```

Optional `scoring_weights: { want: {...}, ease: {...} }` overrides `user/profile.yml` → `scoring:`. The output carries `eligibility`, `salary_adj_for_city` (`.summary` is the one-line Salary cell; `.math` is the report's footer line), `calibrated_dims`, `want` / `ease` objects (their `.score` is the number you write everywhere else), `priority`, `verdict`, `verdict_label`, `tier`, `tier_reason` and `explanation`.

### Reasoning cells

**One hard rule: no score without a reason a person can check.** *"Competitive but designed for new grads"* is not a reason; *"a big-name brand with one intern seat — expect hundreds of applicants"* is. This is about depth, not direction: two agents may land at 5 or 7 on the same posting, and that range of judgment is fine. A number with no checkable reason is not.

Everything else is judgment (see § Report Voice): one or two plain sentences per cell, quote the posting when the quote carries the point, mention a CV item only when it changes the score, no backticks, no bracketed tokens, at most an occasional bold. When the posting is silent, say so in words (*"they don't say how big the intake is"*).

- **Eligibility rows** (each non-green check): name the posting line behind it in plain words (*"they ask for a June start; your term runs to July"*), or say it's not stated. Every amber carries its recruiter question.
- **Salary Adj for City:** paste the script's `salary_adj_for_city.summary` (e.g. *"About €150 a month left after living costs in Lyon (estimated pay)"*). The full `salary_adj_for_city.math` chain goes in the report's footer line, never in the cell. When the comp is an estimate, pass `comp_source: "estimate"` so both say so.
- **Rollup rows** (`**Want (rollup)**`, `**Ease (rollup)**`): the number plus a few plain words (*"carried by brand and the work itself"*, *"held down by the experience ask"*) — never the formula.

**Worked example — Experience bar, a graduate programme that prefers a top-tier prior internship.** Old voice (don't): *"JD lists prior-background preference: 'previous internship at a top-tier…'. Your cv.md § Experience shows a boutique internship (~2mo); no calibration adjustment applies. Net 5."* Advisor voice (do), two defensible readings of the same posting:

```
| Experience bar (ease) | 5/10 | They want a previous internship at a top-tier firm. Your one internship
  was short and at a small boutique, and your degree only partly makes up for that. |
```

```
| Experience bar (ease) | 7/10 | They prefer a top-tier internship, but your degree and main capstone
  are the academic equivalent they say they'll accept. |
```

The difference is a real judgment call; both give a reason the candidate can check.

**For agents running in parallel:** the JD audit (see `modes/scouting.md` § Pre-scoring JD audit) is scratch work that feeds these cells. Run it first; don't paste it into the report.

#### Anti-fingerprint-reuse

When an agent processes many listings from the same company (e.g. 15 variants of one consulting firm's rotation in one sub-batch), the temptation is to score the first carefully and copy the fingerprint to the siblings. Don't. **Identical 9-dimension fingerprints across two distinct roles is the clearest signal that scoring is copy-paste, not grounded in the posting.**

Sibling roles still differ on **Skills Match** (different stacks), **Role content** (delivery ≠ advisory ≠ client-facing pre-sales) and **Experience bar** (one variant may want a prior internship). If they really are indistinguishable seats, use the multi-variant collapse rule in `modes/pipeline.md` Step 2c.1 — score one master, list the rest as variants. The Notes column in `data/scouting.md` is **not optional** for these rows: one line naming this role's strongest signal.

### Standard report block format

**Header** (after the `# Scouting:` / `# Gap & Growth:` title and the Date / Location / Archetype lines), exactly these five lines in this order:

```markdown
**Want:** 8.25/10 · **Ease:** 5.6/10
**Eligibility:** amber — start date not stated
**Verdict:** Stretch — apply with prep
**Tier:** T2
**URL:** {listing-specific url or "—"}
```

- `**Eligibility:**` is `green`, or `amber — {reasons, ;-joined}`. (Red listings write no report.)
- `**Verdict:**` is `{verdict_label} — {action}`: `Go — apply now` · `Stretch — apply with prep` · `Growth target — close the gap first` · `Solid — apply` · `If pipeline thin — apply only if your pipeline is thin`.

**Body**, in order:

```markdown
## Eligibility
| Check | Status | Reason |
|-------|--------|--------|
| start_date | amber | They don't say when the internship starts |
| duration | green | Six months, inside the length you can take |
| graduation | green | No graduation window |
| language | green | They want fluent English; you're beyond that |
| work_auth | green | Germany is covered by your EU work rights |
| other | green | Nothing else they require |

**Ask the recruiter:**
- When does the internship start, and is the start date flexible?

## Dimensional scoring
| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Growth / Mobility (want) | 8/10 | ... |
| Optionality / Exit (want) | X/10 | ... |
| Brand Value (want) | X/10 | ... |
| Role content (want) | X/10 | ... |
| City (hygiene) | X/10 | ... |
| Salary Adj for City (hygiene) | X/10 | {salary_adj_for_city.summary} |
| Work-Life Balance (hygiene) | X/10 | ... |
| **Want (rollup)** | **8.25/10** | Carried by brand and the work itself |
| Skills Match (ease) | X/10 | ... |
| Experience bar (ease) | X/10 | ... |
| Competition (ease) | X/10 | ... |
| **Ease (rollup)** | **5.6/10** | Held down by the open start date |
| Best-fit Early-career Roles (context) | text | 1–4 alternative roles at this company |

{the tier's prose sections — modes/scouting.md § Output Behavior}

Salary math: {salary_adj_for_city.math}
```

Row order and the `(want)` / `(hygiene)` / `(ease)` / `(context)` tags are fixed — the frontend parser splits the groups on them. Omit the "Ask the recruiter" list when nothing is amber. The `Salary math:` line is the **last line of every report**, plain text, exactly once.

### Using the `explanation` object

`scripts/score-listing.mjs` returns `explanation` — `bindingConstraints[]` (kinds `eligibility_red`, `experience_wall`, `hygiene_veto`, `role_content_veto`, `amber`, `low_want`, `low_ease`) and `levers[]` (the smallest single change that moves the verdict to a better cell). **It is not rendered as a section.** Use it to decide what the report leads with: `bindingConstraints[0]` is usually the deciding factor the Recommendation opens with and the first gap, and `levers[0]` is usually the move you recommend (an `amber` lever is a question to ask the recruiter). Translate it into plain words — never write "binding constraint" or "lever" in the report — and never contradict it: if your read differs, the scores are wrong, fix them. When there is no lever, don't invent one.

### Comparative Rank Block

Same-archetype peer comparison from `data/score-history.tsv`, computed by `scripts/peer-rank.mjs` (gates and confidence tiers per `docs/scoring-statistical-design.md`). **Primary archetype segment** = the archetype string before the first ` + ` (hybrids are `Primary + Secondary`; `/` stays inside compound names). Peers = rows whose primary segment matches, excluding Blocked rows (empty `want` / `ease`), which are not peers.

**Drift gate:** if the same hybrid is written both as `X + Y` and `X / Y` in the history (`cut -f2 data/score-history.tsv | tail -n +2 | sort -u`) and the drift touches this primary segment, skip the block and say so in a `## Notes` line naming the variants; if it touches other archetypes only, note it and proceed.

**Only render the block with ≥ 5 peers.** Below that, omit it entirely (no placeholder line). Render, directly below the dimensional table:

```
---
**Rank vs [Archetype] peers:** Want X.X · Ease X.X — Priority top N% of M roles evaluated
**Dimension outliers:** Skills Match +X.X above avg · Experience bar −X.X below avg
**Closest comparables:** [Company A] (W X.X · E X.X) · [Company B] (W X.X · E X.X) · [Company C] (W X.X · E X.X)
```

Outliers are dimensions ≥ 1.5 points from the peer average (positive first); with none, write `**Dimension outliers:** profile close to archetype average`. Comparables are the 3 peers with the closest Priority. The block is informational — it never changes the verdict.

### Per-entry trackers are split by workflow stage

| File | Holds | Merge script | TSV drop folder | Columns |
|------|-------|--------------|-----------------|---------|
| `data/scouting.md` | Landscape inventory — every evaluation (including Blocked) lands here | `scripts/merge-scouting.mjs` | `batch/scouting-additions/` | `# \| Date \| Company \| Role \| Want \| Ease \| Tier \| Eligibility \| Report \| Deadline \| Promotion Hint \| Notes` |
| `data/applications.md` | Active applications — entries promoted from scouting | `scripts/merge-tracker.mjs` | `batch/tracker-additions/` | `# \| Date \| Company \| Role \| Score \| Status \| PDF \| Deadline \| Report \| Notes` |

In `data/applications.md` the Score cell for new rows is `W8.3 E5.6` (legacy `X.X/10` cells stay valid). `go` rows flagged `READY` are promoted via `node scripts/promote-to-applications.mjs <num>` (or Apply in the Database UI) with status `Evaluated`. Blocked listings are never promoted.

`data/score-history.tsv` stays **unified** — it's the trajectory log, not a per-entry tracker.

### Logging to `data/score-history.tsv`

Every evaluation — including skips and Blocked listings — appends one row. Columns, in order:

```
date	archetype	skills_match	experience_bar	competition	ease	growth_mobility	optionality_exit	brand_value	role_content	best_cities	salary_adj_city	work_life_balance	want	priority	eligibility	eligibility_flags	verdict	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw	url
```

**Column definitions:**
- Dimension columns: the values the script actually used — `calibrated_dims[dim].final` where calibration applied (Brand bonuses can make it non-integer), else your judgment integer; `salary_adj_city` as the script returned it.
- `ease`, `want`, `priority`: the script's numbers (`ease.score`, `want.score`, `priority`), baked in at write time — readers never recompute.
- **Blocked rows:** every dimension column plus `want`, `ease`, `priority` are **empty** (not 0). Readers treat empty as missing, never as 0.
- `eligibility`: `green` | `amber` | `red`.
- `eligibility_flags`: `;`-joined `check:status:reason` for every non-green check (empty when green). Keep `;`, `:` and tabs out of the reason text.
- `verdict`: the verdict key (`go` · `stretch` · `growth` · `solid` · `thin` · `skip` · `blocked`).
- `best_fit_roles`: free text, multiple roles separated by `; `. Never a literal tab.
- `mode`: always `scouting`.
- `tier`: `T1` | `T2` | `T3` | `T4`.
- `source`: `url` | `paste` | `scan` | `pipeline` | `batch` — where the listing entered the system, not its URL.
- `location`: city as stated in the JD (`Remote-EU`, `Lyon (hybrid)`); `n/d` if not stated. **One posting open in several cities** → list every city, the one scored first, separated by `; ` and outside any parentheses (`Lyon, France; Vienna, Austria; Prague, Czechia; Brussels, Belgium`) — the app splits on `;` and drops parenthesised text, so `Lyon (also Vienna, Prague)` reads as Lyon only.
- `employment_type`: `internship` | `full-time` | `working-student` | `graduate-program` | `contract` | `n/d`.
- `duration`: free text (`6mo`, `12mo`, `permanent`, `n/d`).
- `salary_raw`: the figure as stated (`€1,500/mo`, `€35–45K`, `competitive`); `n/d` if undisclosed.
- `url`: the **listing-specific** URL — the stable join key the frontend uses to bind a row to its report. **NEVER a bare portal / careers-homepage URL** (`https://boards.greenhouse.io/{company}`, `https://jobs.ashbyhq.com/{company}`, `https://jobs.lever.co/{company}`, `https://careers.{company}.com`) — those collide across every listing at the company. A listing URL carries a job identifier (`/jobs/{id}`, a job-token slug, a UUID, `?gh_jid=...`). Use `n/d` for a paste with no URL or when only a portal homepage is known.

If the file does not exist, create it with the 29-column header exactly as above. Readers parse by header name. Append-only; never rewrite. (v1 history was archived to `data/archive/scoring-v1/` on the switch.)

## Archetype Detection

**Archetypes are user data — the taxonomy lives in `user/_profile.md` (§ Target Role Matrix or equivalent), never here.** Classify every offer into one of the user's archetypes (or a hybrid of 2, written `Primary + Secondary`) by matching the JD's core responsibilities against each archetype's key signals as the user has defined them.

The matrix follows this *pattern* (illustrative example only — a fictional candidate targeting operations roles; substitute the actual archetypes from `user/_profile.md` at evaluation time):

| Archetype | Key signals in JD |
|-----------|-------------------|
| Strategy & Operations | "business planning", "operational excellence", "cross-functional" |
| Data Analyst | "SQL", "dashboards", "insights", "reporting", "A/B testing" |

If `user/_profile.md` defines no archetypes yet, that's an onboarding gap — prompt the user to define them rather than inventing a taxonomy.

After detecting the archetype, read `user/_profile.md` for the user's specific framing and proof points for that archetype.

## Global Rules

### NEVER

1. Invent experience or metrics
2. Modify cv.md or portfolio files
3. Submit applications on behalf of the candidate
4. Share phone number in generated messages
5. Recommend comp below market rate
6. Generate a PDF without reading the JD first
7. Use corporate-speak
8. Ignore the tracker (every evaluated offer gets registered)

### ALWAYS

0. **Cover letter:** If the form allows it, ALWAYS include one. Same visual design as CV. JD quotes mapped to proof points. 1 page max.
1. Read cv.md, _profile.md, and user/article-digest.md (if exists) before evaluating
1b. **First evaluation of each session:** Run `node scripts/cv-sync-check.mjs`. If warnings, notify user.
2. Detect the role archetype and adapt framing per _profile.md
3. Point at a CV item only when it changes the judgment — never walk the CV to prove coverage
4. **Before WebSearch for comp/company intel:** check `data/comp-cache.tsv` (60-day TTL) and `data/companies/{slug}.md` (30-day TTL). Use cached data if fresh; run WebSearch and save if stale or missing.
5. Register in tracker after evaluating
6. Generate content in the language of the JD (EN default)
7. Be direct and actionable -- no fluff
8. Native tech English for generated text. Short sentences, action verbs, no passive voice.
8b. Case study URLs in PDF Professional Summary (recruiter may only read this).
9. **Tracker additions as TSV** -- NEVER edit applications.md directly. Write TSV in `batch/tracker-additions/`.
10. **Include `**URL:**` in every report header.**

### Tools

| Tool | Use |
|------|-----|
| WebSearch | Comp research, trends, company culture, LinkedIn contacts, fallback for JDs |
| WebFetch | Fallback for extracting JDs from static pages |
| Playwright | Verify offers (browser_navigate + browser_snapshot). **NEVER 2+ agents with Playwright in parallel.** |
| Read | cv.md, _profile.md, user/article-digest.md, cv-template.html |
| Write | Temporary HTML for PDF, applications.md, reports .md |
| Edit | Update tracker |
| Canva MCP | Optional visual CV generation. Duplicate base design, edit text, export PDF. Requires `canva_resume_design_id` in profile.yml. |
| Bash | `node scripts/generate-pdf.mjs` |

### Time-to-offer priority
- Working demo + metrics > perfection
- Apply sooner > learn more
- 80/20 approach, timebox everything

### Operational issues

Hit a schema mismatch, an unparseable data file, a URL pattern that consistently fails verification, or a rubric ambiguity? Don't silently work around it and don't just mention it once in chat — log it so repeat patterns surface: `node scripts/agent-log.mjs log --category <schema|data|url|rubric|other> --subject "<short>" "<what happened>"`. Maintenance sessions check unresolved entries first (`node scripts/agent-log.mjs list --unresolved`).

---

## Professional Writing & ATS Compatibility

These rules apply to ALL generated text that ends up in candidate-facing documents: PDF summaries, bullets, cover letters, form answers, LinkedIn messages. They do NOT apply to internal evaluation reports.

### Avoid cliché phrases
- "passionate about" / "results-oriented" / "proven track record"
- "leveraged" (use "used" or name the tool)
- "spearheaded" (use "led" or "ran")
- "facilitated" (use "ran" or "set up")
- "synergies" / "robust" / "seamless" / "cutting-edge" / "innovative"
- "in today's fast-paced world"
- "demonstrated ability to" / "best practices" (name the practice)

### Unicode normalization for ATS
`scripts/generate-pdf.mjs` automatically normalizes em-dashes, smart quotes, and zero-width characters to ASCII equivalents for maximum ATS compatibility. But avoid generating them in the first place.

### Vary sentence structure
- Don't start every bullet with the same verb
- Mix sentence lengths (short. Then longer with context. Short again.)
- Don't always use "X, Y, and Z" — sometimes two items, sometimes four

### Prefer specifics over abstractions
- "Cut p95 latency from 2.1s to 380ms" beats "improved performance"
- "Postgres + pgvector for retrieval over 12k docs" beats "designed scalable RAG architecture"
- Name tools, projects, and customers when allowed

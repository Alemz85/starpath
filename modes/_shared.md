# System Context -- career-ops
<!-- scoring-version: 2026-04-26 -->

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

**RULE: NEVER hardcode metrics from proof points.** Read them from cv.md + user/article-digest.md at evaluation time.
**RULE: For article/project metrics, user/article-digest.md takes precedence over cv.md.**
**RULE: Read _profile.md AFTER this file. User customizations in _profile.md override defaults here.**

---

## Scoring System

The full `oferta` evaluation uses 8 blocks total: 6 evaluation blocks (A-F), Block G (Posting Legitimacy, qualitative), and Block H (Dimensional Scoring, shared with `scouting` mode — see the dedicated section below). The 1-10 **global Score** in the report header is computed from the A-F evaluation, NOT from Block G or Block H. Block G is a separate qualitative assessment. Block H produces its own rollups (Current Fit, Aspirational Fit, Overall) which sit alongside the global Score in the header.

The global Score (A-F) reflects:

| Dimension | What it measures |
|-----------|-----------------|
| Match con CV | Skills, experience, proof points alignment |
| North Star alignment | How well the role fits the user's target archetypes (from _profile.md) |
| Comp | Salary vs market (10=top quartile, 1=well below) |
| Cultural signals | Company culture, growth, stability, remote policy |
| Red flags | Blockers, warnings (negative adjustments) |
| **Global** | Weighted average of above |

**Score interpretation (global Score and Block H Overall both follow this scale):**
- 9.0+ → Strong match, recommend applying immediately (Tier 1)
- 8.0–8.9 → Good match, worth applying with prep (Tier 2-high)
- 7.0–7.9 → Decent match, apply only if pipeline thin (Tier 2-standard)
- Below 7.0 → Recommend against applying (see Ethical Use in CLAUDE.md)

`scouting` mode skips A-G entirely and uses only the Dimensional Scoring Framework (the Block H content) as its core output — see `modes/scouting.md` for the lightweight tier behavior.

## Dimensional Scoring Framework (Scouting + Oferta)

Both `scouting` mode and `oferta` mode (Block H) use the same set of underlying dimensions. They share definitions so that:
- Reports are directly comparable across modes
- `data/score-history.tsv` can hold rows from either mode and `positioning` can read both
- The user only has to learn one rubric

There are **6 numeric scoring dimensions** that roll up into two summary scores (Current Fit, Aspirational Fit), plus **Sales-Trap Risk** (scored but not in the rollups — a decision-support signal) and **4 context dimensions** that inform the report but do NOT roll up into the summaries.

**Scale:** All numeric dimensions use **integers 1–10**. Half-steps (e.g. 7.5) are permitted only when the reasoning explicitly justifies a half-step distinction that cannot be captured by the nearest integer. Rollups always use decimals from averaging.

### Current Fit dimensions (roll up into Current Fit, 1-10)

These answer: *Could I get this job today?*

| Dimension | What it measures | 10 = | 1 = |
|-----------|------------------|------|-----|
| **Skills Match** | Do my current skills match what the JD asks for? | Every required + all preferred skills covered; domain knowledge is a perfect match | Wrong stack entirely; no meaningful skill overlap |
| **Ease of Entry** | How realistic is it for someone at my level to actually land this role? | Perfectly designed for this profile; exact persona, no competition | Out of range; senior role requiring multi-year credentials |
| **Strategic/Analytical Fit** | Is the actual day-to-day work analytical/strategic, or would I end up doing something different from what the title suggests? | Pure analytical work; every day is data analysis, modeling, insights delivery | No meaningful analytical work; pure ops/sales/support role |

**Per-step anchors — Skills Match:**
- **10:** Every required + all preferred skills covered; domain knowledge is a perfect match
- **9:** Every required covered; 1 preferred skill gap (minor, non-central)
- **8:** All required covered; 2+ preferred skill gaps (still strong coverage)
- **7:** Strong foundational coverage; 1 domain-specific required skill missing (closeable gap, strong adjacent)
- **6:** Required skills mostly covered; 1-2 meaningful gaps in central tools or domain knowledge
- **5:** Foundational overlap; 2-3 significant skill gaps in tools/domain
- **4:** Adjacent stack; can demonstrate transferable skills but core tools missing
- **3:** Weak overlap; foundational skills present but most domain skills absent
- **2:** Minimal overlap; only generic skills match; would need retraining
- **1:** Wrong stack entirely; no meaningful skill overlap

**Per-step anchors — Ease of Entry:**
- **10:** Perfectly designed for this profile; exact persona, no meaningful competition
- **9:** Strong persona match; minimal competition (niche role or language filter narrows pool)
- **8:** Good persona match; moderate competition; standard entry-level at mid-tier brand
- **7:** Persona match with 1 minor gap (e.g. 1 preferred year); some brand competition
- **6:** Reasonable fit; some preferred-background signaling; moderate competition at top brand
- **5:** Borderline; 1 year experience preferred; top-brand competition pool applies
- **4:** Stretch; 1-2 years experience required; top-brand OR preferred-background wall
- **3:** Hard stretch; 2-3 years required; multiple background requirements; hyper-competitive brand
- **2:** Experience wall (3+ years); hyper-competitive brand + preferred-background wall; near-impossible today
- **1:** Out of range; senior/specialist role; multiple years + credentials; not realistic for this profile

**Per-step anchors — Strategic/Analytical Fit:**
- **10:** Pure analytical work; every day is data analysis, modeling, insights delivery
- **9:** Predominantly analytical; minor coordination/stakeholder mgmt (≤10% of time)
- **8:** Clearly analytical; some project mgmt or client-facing (~20%)
- **7:** Analytical core with meaningful operational component (~30%)
- **6:** Equal analytical and operational work; title says analyst, reality is mixed
- **5:** More operational than analytical; analytics is a support function, not the core
- **4:** Mostly execution/coordination with some data work
- **3:** Mostly operational; data work is incidental or reporting-only
- **2:** Execution-only with analytical framing in the title; analytics is cosmetic
- **1:** No meaningful analytical work; pure ops/sales/support; analytical title is misleading

**Rollup:**
```
Current Fit = (Skills Match + Ease of Entry + Strategic/Analytical Fit) / 3
```

### Aspirational Fit dimensions (roll up into Aspirational Fit, 1-10)

These answer: *Is this the type of role I want to grow into?*

| Dimension | What it measures | 10 = | 1 = |
|-----------|------------------|------|-----|
| **Growth/Mobility** | Does this role lead somewhere, or is it a dead end? | Explicit multi-level promotion track; internal mobility to multiple functions; mentorship program; LDP | Explicitly capped; no promotion, no mobility, no scope expansion |
| **Optionality/Exit** | How good is this as a stepping stone for future moves? | Skills + brand transfer to top destinations immediately; opens FAANG, MBB, top unicorns | Role locks you into one company's processes; actively harms future options |
| **Brand Value** | Does this company / role carry weight on a CV? | Global top-tier brand (Google, McKinsey, Goldman); instantly recognized everywhere | No brand recognition outside one local market |
| **Sales-Trap Risk** | Risk of getting pigeonholed into pure sales / account management rather than strategy/analytics work. **Higher score = LOWER risk** (good). | Clearly strategic / analytical role; no quota, no cold-calling | Title is analyst but JD is 80%+ pipeline generation and quota carrying |

**Per-step anchors — Growth/Mobility:**
- **10:** Explicit multi-level promotion track documented; internal mobility to multiple functions; structured mentorship; LDP/rotational
- **9:** Clear promotion ladder with named next roles; strong internal mobility across teams/geos
- **8:** Good growth signals; mentor assigned; structured program (grad scheme, rotational)
- **7:** Growth possible but less structured; company growing; scope can expand with performance
- **6:** Growth possible but depends on individual performance + team fit; no formal path
- **5:** Some growth but narrow scope; functional mobility limited; role-type stays the same
- **4:** Capped function; growth means staying in same role-type for years
- **3:** Dead-end role type; function doesn't grow beyond 2 years
- **2:** No growth indicators; role is execution-only; no ladder visible
- **1:** Explicitly capped; no promotion, no mobility, no scope expansion stated or implied

**Per-step anchors — Optionality/Exit:**
- **10:** Skills + brand transfer to top destinations immediately; opens FAANG, MBB, top unicorns on day one
- **9:** Very transferable skills; brand recognized globally; opens top-tier next moves in 2-3 years
- **8:** Good exit options; skills portable to multiple sectors; recognized brand in target markets
- **7:** Portable skills with some niche exposure; opens good roles in adjacent sectors
- **6:** Moderately transferable; well-known in one region or sector but not globally
- **5:** Useful stepping stone but limited portability; skills somewhat niche
- **4:** Skills mostly company-specific; exit options narrow without retraining
- **3:** Very niche skill set; limited portability outside one company or sector
- **2:** Role locks you into one company's processes; little market value externally
- **1:** Dead-end exit; skills not transferable; role actively harms future options

**Per-step anchors — Brand Value:**
- **10:** Global top-tier (Google, McKinsey, Goldman Sachs); instantly recognized everywhere, every sector
- **9:** Near-global tier (Amazon, Meta, Stripe, Salesforce, BCG, Bain); top-tier in most markets
- **8:** Strong European/global tech brand (Celonis, Datadog, Revolut, Spotify, EY, Booking.com); recognized by most tech recruiters
- **7:** Known tech company or regional leader (SumUp, Glovo, Qonto, PwC national office); solid signal in target markets
- **6:** Solid mid-market brand; known in sector but not immediately signaling prestige
- **5:** Smaller/regional company; known within specific market or vertical
- **4:** Startup or early-stage company; brand value depends on future outcomes
- **3:** Unknown outside immediate market; minimal brand signal to external recruiters
- **2:** No meaningful brand recognition; name means nothing without context
- **1:** Brand recognition is zero or actively negative

**Per-step anchors — Sales-Trap Risk (higher = lower risk = better):**
- **10:** Zero sales exposure; pure analytical/strategy/engineering role; no quota, no pipeline targets
- **9:** Predominantly analytical; minor commercial awareness required but no quota
- **8:** Client-facing but consultative/advisory; no quota; analytical work clearly dominates
- **7:** Some account management or client coordination; secondary to analytical work; no quota
- **6:** Mixed role; some commercial exposure but analytical work still primary
- **5:** Equal sales and analytical elements; risk of drifting toward quota-carrying exists
- **4:** Sales-adjacent; analytical framing but significant commercial pressure likely
- **3:** Pre-sales or SDR-adjacent; quota light but pipeline-building expected
- **2:** BDR/SDR with analytical branding; cold outreach is real and significant part of the job
- **1:** Pure sales/BDR role; outbound, quota, pipeline generation; analytical title is misleading

**Note on Sales-Trap Risk:** This dimension is inverted from intuition — *high score means low risk*. A "10" means the role is well-protected from sales-pigeonholing. A "1" means high risk of becoming a pure salesperson. This keeps all dimensions in the same "high = good" direction.

**Sales-Trap Risk is NOT included in the Aspirational Fit rollup.** It is always scored and displayed in the dimensional table as a decision-support signal, but it does not enter the AF average. This prevents it from inflating AF on non-sales roles (where it's always 8-10) or masking structural issues on sales roles (where a low score should be a red flag the user sees, not something diluted into an average).

**Rollup:**
```
Aspirational Fit = (Growth/Mobility + Optionality/Exit + Brand Value) / 3
```

### Overall

```
Overall = Current Fit × {CF_weight} + Aspirational Fit × {AF_weight}
        + context modifiers (see below)
```

**Phase-aware weights** (set in `user/_profile.md` → Scoring Weights):
- **scouting mode → 70/30** (CF=0.70, AF=0.30): landscape mapping; reachability is the primary question
- **applying mode → 60/40** (CF=0.60, AF=0.40): choosing between live offers; ambition weighs more

**Context modifiers** (applied after the weighted rollup):
- Salary Adj for City ≤ 4 → **−0.4** to Overall (poverty-wage or well below local market)
- Salary Adj for City ≥ 9 → **+0.2** to Overall (notably above local market rate)
- Work-Life Balance ≤ 4 → **−0.2** to Overall (poor WLB reputation, sweatshop signals)

Context modifiers can stack (e.g., low salary + poor WLB = −0.6). When a modifier fires, show it explicitly in the Overall line:
```
**Overall** | **X.X/10** | CF × 0.70 + AF × 0.30 − 0.4 (Salary Adj=3) − 0.2 (WLB=4) |
```

### Context dimensions (do NOT roll up — except via modifiers above)

These appear in every report for situational awareness. The Salary and WLB dimensions can apply small modifiers to Overall (see above). Best Cities and Best-fit Roles remain purely informational.

| Dimension | Type | What it measures |
|-----------|------|------------------|
| **Best Cities** | 1-10 numeric | Does the role's location match the user's preferred-cities list from `_profile.md`? 10 = top preferred, 1 = unworkable / requires relocation outside acceptable EU set |
| **Salary Adj for City** | 1-10 numeric | Is the likely compensation reasonable for that city's cost of living? See Salary Adj anchor table below. |
| **Work-Life Balance** | 1-10 numeric | Company reputation for WLB (Glassdoor / Blind / known culture). 10 = healthy ~40h, 1 = sweatshop / known burnout culture |
| **Best-fit Early-career Roles** | text (list) | What specific roles at this company would actually suit the user best — even if they differ from the role being evaluated. Free-form list of 1-4 alternatives. |

#### Salary Adj for City — anchor table

The user's `_profile.md` → City-Specific Salary Bands defines a "good = 8" threshold per city (intern €/mo or full-time €K/yr). Score against THAT threshold for the city the role is in — never against a global average.

| Disclosed comp vs. city threshold | Score |
|----------------------------------|-------|
| ≥ +25% above threshold (clearly top of market for level/city) | **10** |
| +10% to +25% above threshold | **9** |
| At threshold (±5%) | **8** |
| 0% to −10% (within bottom of band) | **7** |
| −10% to −25% below threshold | **5** |
| −25% to −50% below threshold | **3** |
| > 50% below threshold OR poverty-wage | **1** |

**Operational rules:**
1. **Salary disclosed as a range** → score the **midpoint**, not "uncertain → 5". A €45–55K Dublin posting (threshold €40K = 8) → midpoint €50K = +25% → **10**.
2. **Salary disclosed as single figure** → score directly against the threshold.
3. **Salary undisclosed** → consult the comp cache (next subsection). If the cache resolves it, treat the cached midpoint as disclosed. If it doesn't, score **5** AND prepend `[undisclosed]` to the reasoning. 5 is the default ONLY when the JD is silent AND the cache misses.
4. **Range crosses the threshold** → still take the midpoint. "Within reach OR above" is not "uncertain".
5. **Fall back to global table** in `_profile.md` (`€45K+ = 10`, `€35–44K = 8`, etc.) only when the city is not in the city-specific table.
6. **"Top of target range"**, "competitive for the city", "premium brand" are NOT reasons to mark down. Score the number, not the framing.

#### Comp cache (`data/comp-cache.tsv`)

When a JD doesn't disclose salary, look up `(company, role_archetype, city)` in `data/comp-cache.tsv` BEFORE scoring 5. The cache is the system's persistent memory of comp data — populated at evaluation time, reused for ~60 days, then refreshed.

**Schema (TSV with header row):**

```
company	role_archetype	city	currency	min	max	source	confidence	last_updated
Datadog	Strategy & Ops Analyst	Dublin	EUR	45000	58000	glassdoor	high	2026-04-28
Stripe	Solutions Engineer	Dublin	EUR	68000	85000	levels.fyi	high	2026-04-28
SumUp	Revenue Planning Intern	Berlin	EUR	2000	2500	jd	high	2026-04-28
```

- `role_archetype` = canonical archetype string (Strategy & Ops, Data Analyst, Solutions Engineer, etc.) — not the verbose JD title. Roles within the same archetype share a band.
- `currency` = ISO 4217 code (EUR, GBP, USD, DKK, …). Internships use the same field; values are €/mo for interns and €/yr for full-time. Distinguish by context (intern roles have small numbers; full-time has 5-figure+).
- `source` = `glassdoor` | `levels.fyi` | `blind` | `payscale` | `jd` (when the JD itself disclosed it and we're caching for next time) | `manual` (user-edited).
- `confidence` = `high` (multiple data points agree, ≥10 reports on source) | `medium` (single source, fewer reports) | `low` (extrapolated from adjacent role / city).
- `last_updated` = ISO date the row was written.

**Lookup flow (do this in order, stop at first hit):**

1. **Exact match:** `company` + `role_archetype` + `city` AND `last_updated` is within 60 days. Use these min/max as if disclosed.
2. **Cross-city same role:** `company` + `role_archetype` in a peer city (Berlin↔Munich, Dublin↔Amsterdam) within 60 days. Adjust ±10% by relative city threshold from `_profile.md`. Mark reasoning *(cached, cross-city adjusted)*.
3. **Same company, peer archetype:** `company` + adjacent role_archetype (e.g. "Data Analyst" → "Business Analyst") in same city within 60 days. Mark reasoning *(cached, peer-archetype proxy)*.
4. **Cache miss or stale (> 60 days)** — branch by mode:
   - **`oferta` mode** (active application, user committed to this listing): run a **WebSearch** in this priority order — **Levels.fyi → Glassdoor → Blind → Payscale**. Aim for 2 sources to cross-check. Take the median of the entry-level / target-level band. Then **append a row to `data/comp-cache.tsv`** with `source` = whichever site won, `confidence` = `high` (multiple sources agree) / `medium` (single source) / `low` (had to extrapolate). This is how the cache grows organically — every oferta evaluation feeds it.
   - **`scouting` mode** (landscape mapping, cheap): do NOT run a WebSearch. Score from the JD's disclosed figure or the city-band default. If undisclosed, score 5 with `[undisclosed]` reasoning. The cache fills via oferta runs — scouting reads from it but doesn't pay the WebSearch cost.
5. **WebSearch returned nothing useful:** score **5** with `[undisclosed]` reasoning. Do NOT fabricate a band.

**Refresh rules:**

- Rows older than 60 days are stale. When a stale row is consulted, run WebSearch as in step 4 and **overwrite** the row (don't append a duplicate). Update `last_updated` to today.
- The user can manually edit a row at any time and set `source = manual` — that pins the row and bypasses the 60-day refresh until the user touches it again.
- The cache is gitignored-or-not at the user's discretion. The TSV format is robust to manual editing.

**Tier-1 only?** No. Even mid-tier brands accumulate Glassdoor / Blind data over time. Cache populates organically — start by lookup-on-evaluation; over a few weeks the file grows to cover the user's actual target list.

### Reasoning column quality bar

The Reasoning column in the dimensional table is the load-bearing artifact for trust. A row that says `Ease of Entry | 7/10 | competitive but designed for new grads` is worse than no row at all — it lets a generous score coast unchallenged. Every evaluation has been seen in production with this shape; every evaluation in this shape has been wrong.

**Each reasoning cell MUST cite at least one of:**
1. **A JD-quoted requirement** verbatim or near-verbatim — e.g., `JD lists: "previous internship at top-tier IB/PE/strategy consulting/fast-growing tech"`.
2. **A named adjustment from the calibration tables** — e.g., `Brand-competition penalty (-3, top-100 SaaS unicorn)` or `Internship cohort bonus (+1)`.
3. **A specific number** — disclosed comp figure, stated YoE bar, named language requirement.
4. An explicit `[no gate stated]` or `[undisclosed]` token when none of the above applies. This is acceptable but rare — most JDs at top-100 brands have *something*.

Generic platitudes — "competitive but reachable", "good growth trajectory", "strong brand", "structured onboarding" — are NOT sufficient on their own. They may *follow* the evidence, but they cannot *replace* it.

**Per-dimension floors:**

| Dimension | Required evidence in reasoning |
|-----------|-------------------------------|
| Skills Match | Walk the JD's required-skills list. Name 1-2 the user has (cite CV section) + 1 the user lacks, OR explicitly say "all listed skills covered". |
| Ease of Entry | Quote the JD's hardest gate (YoE, prior background, language, citizenship) OR `[no explicit gate stated]`. Then name the brand-tier adjustment from the calibration table if applicable (`-2 to -4` for top-100 / unicorn / Big-4). |
| Strategic/Analytical Fit | Name 1-2 specific responsibilities from the JD that map to the user's archetype. |
| Growth/Mobility | Cite the structural growth signal (graduate scheme size, rotation length, named promotion path). Generic "team is growing" is insufficient. |
| Optionality/Exit | Name 2 concrete next-move destinations the brand + skill set unlocks. |
| Brand Value | Use the brand-tier table directly (10/9/8/7/6/...). Reasoning = which named tier the company sits in. |
| Sales-Trap Risk | Cite the JD's quota/pipeline/outbound language verbatim if any. If the JD is silent, say so. |
| Best Cities | Name the city + its position in `_profile.md`'s preferred-cities list. |
| Salary Adj for City | Cite the disclosed figure OR `[undisclosed]`. State the city threshold from `_profile.md` being scored against. Generic "mid-range" is insufficient. |
| Work-Life Balance | Cite Glassdoor / Blind / known reputation signal. Generic "structured onboarding" is insufficient. |

**Worked example — Ease of Entry, Revolut Rev-celerator Graduate Programme:**

```
| Ease of Entry | 4/10 | JD lists hard gate: "previous working experience or internship at
  top-tier investment banking, PE, strategy consultancy, or fast-growing tech." User has
  AP Consulting (2mo, small boutique) — does not satisfy "top-tier" bar. Brand-competition
  penalty (-3, recognized European fintech unicorn). Net 4/10. |
```

Note: the row contains (a) a verbatim JD quote, (b) the user-side fact that fails it, (c) the named calibration adjustment, (d) the arithmetic. ~50 tokens. This is the depth bar — not a paragraph, not a single platitude.

**For agents running in parallel:** the JD audit (see scouting.md § Pre-scoring JD audit) feeds these reasoning cells. Run the audit first; the cells write themselves from its output.

### Calibration & special rules

These rules tighten the rubric and the rollup math. They apply to BOTH `scouting` mode and `oferta` Block H.

#### Skills Match sharpening — skills only, not experience

Skills Match measures **"does the candidate's skill list cover the JD's listed skills"** — and ONLY that. Experience requirements ("3+ years in X", "prior consulting background", "1-2 years in Sales Ops") are NOT skills; they belong to **Ease of Entry**.

The two questions to ask:
1. **For Skills Match:** Walk the JD's listed required + preferred skills line by line. Tick each one against `user/cv.md` Technical Skills + Education + Projects. The score reflects coverage, not the candidate's overall readiness.
2. **For Ease of Entry:** Look at YoE bars, prior-role expectations, preferred backgrounds, and competition (see calibration below).

**Why this matters:** without the split, a JD that lists "Python, SQL, Excel" as required (which the candidate has) but expects "3 years prior in fintech analytics" gets conflated into one mediocre score. With the split, Skills Match = 9 (all listed skills met) and Ease of Entry = 4 (YoE wall + prior-role expectation). The dimensional fingerprint then *clearly* tells the user "you have the skills, you don't have the experience" — which is the actionable read.

**Domain-specific skills count as skills, not experience.** A JD that requires "Google Ads ecosystem (Search, Display, YouTube, Performance Max)" or "NLP/LLM models" or "Salesforce administration" is listing *skills the candidate either has or doesn't* — these are not YoE requirements. When the candidate has a strong analytical foundation (Python, R, SQL, statistical modeling) but lacks the domain-specific skills that define the role's day-to-day work, Skills Match should reflect the gap honestly. Use the per-step anchors above — "strong foundational coverage, 1 domain-specific required skill missing" = 7, not 8.

#### Ease of Entry calibration

Ease of Entry asks "how realistically can someone at *my level* land this role *today*?" — competition and preferred-background signaling matter as much as the persona description.

Adjust the score from a "matches the persona" baseline using these factors:

| Factor | Adjustment | Why |
|--------|------------|-----|
| **Brand competition tier:** top-100 SaaS, top consulting, NASDAQ-listed tech, recognized European unicorns (Datadog, Celonis, Stripe, Revolut, etc.) | −2 to −4 | These brands draw thousands of applicants for 1-3 spots even at the entry level |
| **Preferred-background signaling:** the JD's preferred experience names MBB / IB / PE / top enterprise sales / Big Tech alums and the candidate has none | −2 | Other applicants WILL have these; the cut goes to them at competitive brands |
| **Internship vs full-time:** structured internship at the same brand | +1 | Internships have larger cohorts (5-20 spots) and lower stakes than full-time hires |
| **Class size signal:** rotational programs, graduate schemes, LDPs (10-20+ spots/year) | +1 | More spots = lower per-applicant odds matter less than per-cohort selection |
| **Language-restricted role:** the JD requires a language the candidate has natively that filters most applicants out | +1 to +2 | Italian-only or Portuguese-only filters remove ~60-80% of the EU applicant pool |

The "10 = perfectly designed for this profile" bar is reserved for roles where the persona description matches AND the brand isn't drawing thousands of applicants. **A top-tier brand internship that the user is an exact persona match for typically lands at 7-8, not 10.**

#### Ease of Entry is point-in-time

Unlike Skills Match (which moves only when the candidate gains new skills) or Brand Value (which is a property of the company), **Ease of Entry shifts as the candidate's overall profile grows**. The same role evaluated 6 months apart may have very different Ease of Entry scores: as the candidate finishes their degree, completes capstone projects, gains internship experience, builds portfolio pieces, etc., what was a "stretch" becomes "standard early-career".

This is why every scouting and oferta evaluation logs Ease of Entry to `data/score-history.tsv` with a date and archetype. The `positioning` mode reads per-dimension trajectories and can surface: *"Ease of Entry for Value Engineering archetype: April 2026 = 6.0 → August 2026 = 8.0 — you became more competitive for these roles, here's what changed."*

**Ease of Entry is the most important trajectory canary** — when it trends upward across an archetype, the candidate is closing the gap to "applyable today". When it stays flat despite effort, the gap-closing strategy isn't working.

#### Bottom-range penalty (for both rollups)

A score of **1–2** on any dimension is the strongest possible negative signal — it means "this dimension is fundamentally broken for this role". Averaging dilutes that signal across the 6-7 other dimensions, which can let a structurally bad role coast into Tier 2.

**Rule:** For each dimension scored **1 or 2** in a rollup, subtract **0.30** from that rollup's average. The penalty compounds: two bottom-range scores in the same rollup → −0.60, three → −0.90.

```
Current Fit       = (Skills Match + Ease of Entry + Strategic/Analytical Fit) / 3 − 0.30 × (count of 1-2 scores in CF dims)
Aspirational Fit  = (Growth/Mobility + Optionality/Exit + Brand Value) / 3 − 0.30 × (count of 1-2 scores in those 3 AF dims)
Overall           = Current Fit × {CF_weight} + Aspirational Fit × {AF_weight} + context modifiers
```

Note: Sales-Trap Risk bottom-range scores do NOT trigger the penalty since Sales-Trap Risk is excluded from the AF rollup. However, a Sales-Trap Risk of 1-2 should still be flagged prominently in the report as a red flag for the user's attention.

The penalty is intentionally modest — about half a tier boundary — so it nudges borderline cases without auto-skipping a role. The user still sees the dimensional table and decides themselves whether the bottom-range score is a deal-breaker.

**Display rule:** when a penalty is applied, show rollups to 2 decimals so the user can see exactly what happened (e.g., `Current Fit: 7.03/10 (raw 7.33 − 0.30 penalty for Strategic/Analytical Fit = 2)`). Otherwise, 1 decimal is enough.

#### Ease of Entry hard gate (experience wall)

Ease of Entry ≤ 4 means the candidate faces a hard experience wall — multi-year YoE requirements, hyper-competitive pipelines, or credentials they don't have. This gate **fires for all tiers** — it can demote T2 to T3 as well as T1 to T3.

**Rule:** If Ease of Entry ≤ 4, the role's tier is **capped at T3** (growth target) regardless of the CF rollup. The CF/AF/Overall scores are still computed normally — the gate only affects tier assignment. This ensures that roles with hard experience walls are surfaced as growth targets with gap-closing roadmaps, not as "worth noting" T2 entries that imply near-term actionability.

**Why this fires for T2 as well:** A role where the user has good skills (Skills Match 8) and the work is analytical (Strategic Fit 8) but faces a 2-year experience wall (EoE 4) would naturally land in T2 — yet the T2 "short summary" format implies the user should consider applying now. A T3 Gap & Growth report with a concrete "revisit when" trigger is more honest and more useful.

**Display rule:** When the gate fires, note it in the tier line: `**Tier:** T3 (EoE gate — CF/Overall would place T2 but Ease of Entry ≤ 4)`.

#### Language-barrier exception: force Tier 4 skip

When the binding gap on a role is a **foreign-language requirement** (the JD asks for fluency in language X, the candidate doesn't have X on their CV and isn't learning it), **force Tier 4 (skip) regardless of other dimensions**. Do NOT produce a Tier 3 Gap & Growth Report for the role. Do NOT write a stepping-stone roadmap.

**Why:** Tier 3 Gap & Growth reports assume the gap closes on a 6-12 month horizon. Foreign-language acquisition to JD-fluency level is a 2-5 year relocation/lifestyle decision, not a job-specific skill build. Producing a detailed "here's how to close this gap" report for a language wall wastes tokens and gives misleading "here's the plan" framing to a gap that is structurally unbridgeable in the relevant timeframe.

**How to apply:**
1. Detect the language requirement: JD says "fluent German", "native French", "C1 Spanish", "business-level Japanese", etc., AND `user/cv.md` / `user/profile.yml` show the candidate does NOT have that language at that level.
2. Skip the Tier 3 template. Do NOT write a `reports/tier-3/scout-...md` file for the role.
3. Log the row to `data/score-history.tsv` with `tier=skip`.
4. Write the scouting tracker TSV with `tier=T4`, `report=—`, and a note starting with `T4 skip (language wall): requires {X}, not on CV`.

**Scope:** this only applies when the ONLY significant blocker is language. If the role also has a YoE wall, stack mismatch, etc., those are normal Tier 3 gaps and the standard tier rules apply — language is just one of the gaps in that case. But when the dimensional fingerprint would otherwise produce T3 (AF ≥ 8.0) purely because of an unreachable language requirement, force T4 instead.

#### Tier 1 override: uniformly strong fingerprint

A role qualifies for **Tier 1** (full scouting report) under either of two conditions:

1. **Standard:** `Current Fit ≥ 9.0`
2. **Override:** all **6 rollup scoring dimensions** score ≥ 8 **AND** both rollups (CF and AF) ≥ 8.0 (Sales-Trap Risk is not considered for this override since it's not in the rollups)

**Reasoning:** a role with a uniformly strong fingerprint (no dimension below 8) is substantively as strong as a CF=9.0+ role even if the rollup average doesn't quite cross the threshold. The override catches borderline-strong matches that miss Tier 1 by a rounding margin but are clearly worth the full analytical write-up.

The override is harder to game than just lowering the cutoff — it rewards consistency across the dimensional fingerprint, not a high average that hides a bad dimension.

**Important:** Tier 1 in scouting mode means a **full markdown report only** — `scouting` never auto-generates PDFs at any tier. CV / PDF generation is a separate, manual operation via `/career-ops pdf` or part of the full `/career-ops oferta` flow. See `modes/scouting.md` § "Scouting never auto-generates PDFs" for the rule.

#### T2 verdict scaling

Tier 2 spans CF=7.0–8.9 — a wide range with meaningfully different actionability. The tier column itself stays a single value (`T2`), but the verdict line in the report scales by Current Fit:

- **CF 8.0–8.9 — "apply with prep":** strong match; promotion hint `MONITOR` in the tracker.
- **CF 7.0–7.9 — "apply if pipeline thin":** decent match; revisit post-graduation. No promotion hint.

Both render the same dimensional table; only the verdict phrasing differs. There is **no T2-high sub-tier** — never write `T2-high` to the tier column of `scouting.md` or `score-history.tsv`. See `modes/scouting.md` for the template.

### Standard report block format

Both `scouting` reports and `oferta` Block H render the dimensions as a single table:

```markdown
| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Skills Match | X/10 | One sentence anchored in CV evidence or JD requirement |
| Ease of Entry | X/10 | One sentence on YoE / level / credentials gap |
| Strategic/Analytical Fit | X/10 | One sentence on whether the work is actually analytical |
| **Current Fit (rollup)** | **X.X/10** | Average of the three above [− penalty if any bottom-range scores] |
| Growth/Mobility | X/10 | One sentence on ladder / scope expansion |
| Optionality/Exit | X/10 | One sentence on transferability of skills + brand |
| Brand Value | X/10 | One sentence on company name recognition |
| Sales-Trap Risk (signal) | X/10 | One sentence on how protected the role is from pure sales (10 = well protected). *Not in AF rollup — displayed for decision-support only.* |
| **Aspirational Fit (rollup)** | **X.X/10** | Average of the three above (Growth + Optionality + Brand) [− penalty if any bottom-range scores] |
| **Overall** | **X.X/10** | CF × 0.70 + AF × 0.30 [+ context modifiers if any] |
| Best Cities (context) | X/10 | One sentence on location vs preferred cities |
| Salary Adj for City (context) | X/10 | One sentence on comp vs local cost-of-living band |
| Work-Life Balance (context) | X/10 | One sentence on company WLB reputation |
| Best-fit Early-career Roles (context) | — | Comma-separated list of 1-4 alternative roles at this company |
```

Note: the Overall line weight shown (0.70/0.30) is for scouting mode. In applying mode use 0.60/0.40. Always show the actual weights used.

### Comparative Rank Block

**Immediately after the dimensional table**, append a rank block comparing this role against same-archetype peers already in `data/score-history.tsv`.

**Step 1 — Compute primary archetype segment.**
Split the detected archetype string on the first ` + ` (space-plus-space). The part before ` + ` is the **primary segment**; if no ` + ` is present, the whole string is the primary segment. Convention: `+` separates hybrid archetypes; `/` stays inside compound names.

Examples:
- `Technology Consulting + AI Transformation` → primary `Technology Consulting`
- `Value Engineering / AI Solutions Architect` → primary is the whole string (no `+`; `/` stays inside the compound name)
- `Strategy & Operations` → primary is the whole string

**Step 2 — Pre-flight drift gate.**
Drift = the same hybrid written both ways in `data/score-history.tsv` (e.g., `X + Y` and `X / Y` both appear). List distinct archetype strings:
```
cut -f2 data/score-history.tsv | tail -n +2 | sort -u
```
For each pair of distinct archetype strings, check whether one becomes the other by substituting ` + ` ↔ ` / `. If such a pair exists:
- **If either string in the pair would be matched by the awk filter in Step 3 for the current primary** (i.e., the drift affects this rank block's pool), **halt the rank block** and emit this note instead (verbatim):
  > *(Rank block skipped — archetype string drift involving primary segment `{PRIMARY}` in `data/score-history.tsv`. Variants: `{X + Y}` and `{X / Y}`. Normalize affected rows to a single canonical form before re-running.)*
- **Otherwise** (drift is in unrelated archetypes), log a warning at the end of the report under a `## Notes` section (create if absent) and **proceed** with the rank block:
  > *Note: archetype string drift detected elsewhere in `data/score-history.tsv` (variants: `{X + Y}` and `{X / Y}`). Does not affect this rank block but should be cleaned up.*

**Step 3 — Read pre-step (filtered slice).**
Pre-filter `data/score-history.tsv` to same-primary rows before reading. Run:
```
awk -F'\t' -v p="$PRIMARY" 'NR==1 || $2 ~ "^"p"($| |\\+)"' data/score-history.tsv > /tmp/rank-slice.tsv
```
where `$PRIMARY` is the primary segment from Step 1. The boundary `($| |\\+)` matches end-of-field, space, or `+` after the primary — so a row archetyped exactly `X` matches when current primary is `X`, a row `X + Y` matches, a row `X / Y` (compound-name extension) matches, but a row `Z + X` does NOT match. The `$` end-of-string anchor is required because `awk -F'\t'` strips the tab from `$2`, so solo-archetype rows have no trailing char to match against.

Then read `/tmp/rank-slice.tsv` (header + primary-archetype rows) instead of the full `score-history.tsv`.

**Step 4 — Conditions:**
- The slice is already pre-filtered by primary archetype. Apply the remaining filter: exclude rows where `overall` is `0`, blank, or `—`.
- **Only produce this block if ≥ 5 qualifying rows exist.** If fewer, append a single line: *"(Not enough archetype peers yet — rank block available after 5+ evaluations)"* and stop.

**Compute:**
1. `overall_pct` — what percentile this role's Overall score falls at among the peer pool (e.g., 80th percentile = better than 80% of peers). Round to nearest 5%.
2. Per-dimension delta vs peer average — compute avg for each of the 6 rollup dimensions. Show only **outlier dimensions** (≥ 1.5 points above or below the peer avg). Positive outliers first, then negative.
3. Closest comparables — the 3 roles in the peer pool with Overall score closest to this role's Overall. Show company name + Overall score.

**Render format** (append directly below the dimensional table, no header):

```
---
**Rank vs [Archetype] peers:** X.X/10 — top N% of M roles evaluated
**Dimension outliers:** Skills Match +X.X above avg · Ease of Entry −X.X below avg
**Closest comparables:** [Company A] (X.X) · [Company B] (X.X) · [Company C] (X.X)
```

If no outlier dimensions (all within ±1.5 of avg): write `**Dimension outliers:** profile close to archetype average` instead.

This block appears in **both scouting and oferta reports**. It is purely informational — it does not affect tier assignment or the Overall score.

### Per-entry trackers are split by mode

**`scouting` and `oferta` write to different per-entry trackers.** This keeps landscape-mapping inventory (scouting) out of the active-application flow (oferta).

| Mode | Per-entry tracker | Merge script | TSV drop folder | Columns |
|------|-------------------|--------------|-----------------|---------|
| `scouting` | `data/scouting.md` | `scripts/merge-scouting.mjs` | `batch/scouting-additions/` | `# \| Date \| Company \| Role \| Score \| Tier \| CF/AF \| Report \| Deadline \| Promotion Hint \| Notes` |
| `oferta` | `data/applications.md` | `scripts/merge-tracker.mjs` | `batch/tracker-additions/` | `# \| Date \| Company \| Role \| Score \| Status \| PDF \| Deadline \| Report \| Notes` |

Scouting entries are NEVER written with status `Scouted` to `data/applications.md` — that column doesn't apply to them. Tier 1 scouting hits flagged `READY` can be promoted to `data/applications.md` via `node scripts/promote-to-applications.mjs <num>`, at which point they enter the application flow with status `Evaluated`.

`data/score-history.tsv` (below) stays **unified** across both modes — it's the trajectory log, not a per-entry tracker.

### Logging to `data/score-history.tsv`

Every scouting evaluation AND every oferta evaluation appends a row to `data/score-history.tsv`. The TSV columns are (in order):

```
date	archetype	skills_match	ease_of_entry	strategic_fit	current_fit	growth_mobility	optionality_exit	brand_value	sales_trap_risk	aspirational_fit	overall	best_cities	salary_adj_city	work_life_balance	best_fit_roles	mode	company	role	tier	source	location	employment_type	duration	salary_raw	url
```

**Column definitions:**
- All numeric dimensions are decimals on the 1-10 scale (e.g., `8.0`, `7.33`).
- `current_fit`, `aspirational_fit`, `overall` are the computed rollups (bake them in at write time — do not let the reader recompute later).
- `best_fit_roles` is a free-text field; separate multiple roles with `; ` (semicolons). Never use literal tabs inside this field.
- `mode` is `scouting` or `oferta`. This lets `positioning` distinguish the source when needed.
- `tier` for scouting is `full` | `short-high` | `short` | `growth` | `skip`. For oferta, use `oferta`.
- `source` is `url` | `paste` | `scan` | `pipeline` | `batch`. (This is the workflow source — where the listing entered the system from. NOT the listing URL itself.)
- `location` — city name as stated in the JD (e.g., `Madrid`, `Amsterdam`, `Remote-EU`, `Barcelona (hybrid)`). Use `n/d` if not stated.
- `employment_type` — `internship` | `full-time` | `working-student` | `graduate-program` | `contract` | `n/d`.
- `duration` — free text from the JD (e.g., `6mo`, `12mo`, `permanent`, `n/d`). Use `permanent` for standard full-time with no stated end date.
- `salary_raw` — exact figure or range as stated in the JD (e.g., `€1,500/mo`, `€35–45K`, `competitive`). Use `n/d` if not disclosed.
- `url` — the listing URL from the JD page (`https://...`). This is the **stable join key** used by the frontend cache to bind a score-history row to its `reports/...md` file. Always write it. Use `n/d` only when the source is a paste with no URL.

**Rows written before 2026-04-26** have 21 columns (no metadata columns). Readers must handle variable column counts — pad short rows with empty strings rather than skipping them.

**Rows written between 2026-04-26 and 2026-04-29** have 25 columns (no `url`). The frontend cache backfills `url` for these rows by reading the matching report's `**URL:**` header.

If the file does not exist, create it with the 26-column header row exactly as above. Append-only; never rewrite.

## Posting Legitimacy (Block G)

Block G assesses whether a posting is likely a real, active opening. It does NOT affect the 1-10 global score -- it is a separate qualitative assessment.

**Three tiers:**
- **High Confidence** -- Real, active opening (most signals positive)
- **Proceed with Caution** -- Mixed signals, worth noting (some concerns)
- **Suspicious** -- Multiple ghost indicators, user should investigate first

**Key signals (weighted by reliability):**

| Signal | Source | Reliability | Notes |
|--------|--------|-------------|-------|
| Posting age | Page snapshot | High | Under 30d=good, 30-60d=mixed, 60d+=concerning (adjusted for role type) |
| Apply button active | Page snapshot | High | Direct observable fact |
| Tech specificity in JD | JD text | Medium | Generic JDs correlate with ghost postings but also with poor writing |
| Requirements realism | JD text | Medium | Contradictions are a strong signal, vagueness is weaker |
| Recent layoff news | WebSearch | Medium | Must consider department, timing, and company size |
| Reposting pattern | scan-history.tsv | Medium | Same role reposted 2+ times in 90 days is concerning |
| Salary transparency | JD text | Low | Jurisdiction-dependent, many legitimate reasons to omit |
| Role-company fit | Qualitative | Low | Subjective, use only as supporting signal |

**Ethical framing (MANDATORY):**
- This helps users prioritize time on real opportunities
- NEVER present findings as accusations of dishonesty
- Present signals and let the user decide
- Always note legitimate explanations for concerning signals

## Archetype Detection

Classify every offer into one of these types (or hybrid of 2):

| Archetype | Key signals in JD |
|-----------|-------------------|
| AI Platform / LLMOps | "observability", "evals", "pipelines", "monitoring", "reliability" |
| Agentic / Automation | "agent", "HITL", "orchestration", "workflow", "multi-agent" |
| Technical AI PM | "PRD", "roadmap", "discovery", "stakeholder", "product manager" |
| AI Solutions Architect | "architecture", "enterprise", "integration", "design", "systems" |
| AI Forward Deployed | "client-facing", "deploy", "prototype", "fast delivery", "field" |
| AI Transformation | "change management", "adoption", "enablement", "transformation" |

After detecting archetype, read `user/_profile.md` for the user's specific framing and proof points for that archetype.

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
3. Cite exact lines from CV when matching
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

# Career-Ops -- AI Job Search Pipeline

AI-powered job search automation built on Claude Code: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing.

The system is **designed to be made yours**. You (AI Agent) can edit the user's files. When the user asks to change archetypes, scoring, negotiation scripts, etc., do it directly. That's the whole point.

## Data Contract (CRITICAL)

Two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `user/cv.md`, `user/profile.yml`, `user/_profile.md`, `user/article-digest.md`, `user/portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/*`, `CLAUDE.md`, `*.mjs` scripts, `templates/*`, `batch/*`, `frontend/*`

**THE RULE:** When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `user/_profile.md` or `user/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content. This ensures system updates don't overwrite their customizations.

### System Layer Hygiene — No Hardcoded User Data

The Data Contract above is necessary but not sufficient. The system layer leaks user data through *examples and defaults* even when no one set out to write user-specific content. Before committing any change to `modes/*`, `scripts/*`, `templates/*`, `frontend/*`, or `CLAUDE.md`, run this checklist:

**Anti-patterns to refuse:**
- **Worked examples that name the user's actual schools, projects, or proof points.** *"Your Esade MSc + CEMS dual-degree + Sabadell capstone read as 'top-tier academic equivalent'"* hardcodes one user's CV into every agent's reasoning template. Use generic placeholders ("your top-school MSc", "your main capstone project") and tell the agent to substitute from `user/cv.md` at evaluation time.
- **Hardcoded default lists in scripts.** `const DEFAULT_X = ['McKinsey', 'BCG', ...]` ships one user's preferences as the silent fallback for everyone. Default to `[]` (fail-closed) and require the caller to pass calibration data; document the expected source in `user/profile.yml` or `user/_profile.md`.
- **Hardcoded conditional logic against a specific company.** `if (company === 'Google') value += 1.0` bakes one user's dream-company override into system code. Express it as data (`extra_brand_bonuses: [{company, bonus, reason}]`) and let the data live in `user/profile.yml`.
- **Examples that name a specific city/country/nationality as the canonical case.** Frontend placeholders ("Barcelona, Spain") and rule examples ("for an EU citizen…") read as "the system assumes this profile". Use `City, Country` placeholders; describe rules in terms of the candidate's `visa_status` / `preferred_cities` / etc., not in terms of one user's specific values.
- **Hardcoded specific dates or timelines.** *"Your CEMS Master starts Sep 2026"* in a system mode example dates the file. Use generic phrasing ("your next degree program starts before this role's start window") and let the actual dates flow from `user/cv.md`.
- **Listing companies/schools/archetypes inline as if they're system defaults.** A reference table in a system file is fine ONLY if it covers the universal landscape (e.g., the school-region map covers ~20 European business schools), not if it lists one user's targets.

**What stays in system layer (legitimate references):**
- Generic reference data (full school-region tables, full city→country mappings, the canonical CEMS Corporate Partner list).
- Test fixtures with concrete inputs (`base: 30000, city: "Barcelona"` in test-all.mjs is fine — it's exercising the rubric, not setting a default).
- Mode prose that talks ABOUT user data (`"read user/cv.md § Education"`) rather than embedding it.
- Backward-compat aliases when renaming a calibration field, so existing user data still flows.

**When in doubt:** ask "would another user with a different background, country, school, or set of dream companies get a wrong answer or surprising behavior from this code/example?" If yes, the data belongs in `user/*`, not in the system layer.

**When the system layer NEEDS a concrete example,** prefer fictional/illustrative cases ("a candidate with X background applying to Y") over the current user's actual case. The agent's worked examples are templates — they should model the *pattern*, not the *person*.

## Profiles (multiple switchable searches)

The repo can host several **search profiles** (e.g. a main career search and a local student-job search). Real files live under `profiles/<slug>/{user,data,reports}/` (gitignored, user layer); **exactly one profile is active at a time, globally** — `profiles/active` names it. Under this layout, 18 canonical paths are **symlinks into the active profile**, managed by `scripts/profile.mjs`: the 3 config files (`user/profile.yml`, `user/portals.yml`, `user/_profile.md`), 9 data files (`data/scouting.md`, `data/applications.md`, `data/pipeline.md`, `data/scan-history.tsv`, `data/score-history.tsv`, `data/dedup-index.tsv`, `data/discarded.tsv`, `data/report-summaries.tsv`, `data/filter-audit-state.json`), and the 6 `reports/` content subdirs (`tier-1..4`, `positioning`, `briefs`). Everything else (`user/cv.md`, `data/network.md`, `data/outreach.md`, caches, `interview-prep/`, `batch/`…) stays shared.

**RULES:**
- **Never write into an inactive profile directly** (`profiles/<slug>/…`). Always read/write the canonical paths — they resolve to the active profile.
- **Never replace a canonical symlink with a real file.** Plain writes (`writeFileSync`, `>` redirection) follow symlinks and are fine; write-temp-then-`rename` onto a canonical path would clobber the link — resolve `fs.realpathSync(target)` first if you must rename.
- **Agent tools (Write/Edit) refuse symlinked file paths by design.** If editing e.g. `data/applications.md` is refused with "Refusing to write through symlink", resolve the link (`readlink data/applications.md` or `cat profiles/active`) and edit the real target `profiles/<active>/…` instead. This is the ONE case where writing a `profiles/` path directly is correct — and only ever for the *active* profile. Reads through symlinks work normally.
- Switching is CLI-only: `npm run profile -- list` · `switch <slug> [--force]` · `create <slug> [--from <slug>] [--label "…"] [--switch]` · `init [<slug>]` (one-time migration) · `eject` (rollback to plain files). Switch/init/eject refuse while unmerged eval TSVs, in-flight batch workers, or unmerged JobSpy staging exist.
- When `profiles/` doesn't exist, the repo is a plain single-profile layout and everything above is dormant. `npm run doctor` validates whichever layout is present.

## Frontend Design System (MANDATORY)

**Before creating a new UI component, modifying styling, picking colors, or adjusting layout in `frontend/`, read `DESIGN-meta.md`.** It is the single source of truth for the design language — palette, typography, spacing, component patterns, motion, and do's-and-don'ts.

- Use the existing tokens — Tailwind classes from `frontend/tailwind.config.ts` and CSS variables / utility classes from `frontend/src/app/globals.css`.
- **Don't introduce new colors, shadows, radii, or type sizes** unless `DESIGN-meta.md` is being updated in the same change.
- If a design decision isn't covered by `DESIGN-meta.md` (a new pattern, a missing token, an edge case), raise it with the user before implementing rather than improvising — the design system stays single-sourced when every gap goes through the doc.

## Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Active applications tracker — entries the user has decided to apply to |
| `data/scouting.md` | Landscape inventory tracker — every evaluation lands here by default |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `data/score-history.tsv` | Per-archetype score log written by every evaluation (feeds `positioning`) |
| `user/portals.yml` | Query and company config for `scan` |
| `user/article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `interview-prep/{Company} - {Role}.md` | Per-listing application prep (interview intel + STAR mapping) |
| `templates/cv-template.html` | HTML template for CVs |
| `reports/tier-{1..4}/{Company} - {Role}.md` | Evaluation reports — **banded depth** (every report keeps the universal header + `## Dimensional scoring` table + `## Why this score`; T1 adds the full prose sections — Role summary + Gaps + Comp + Recommendation + Career path impact; T2 a short Fit/gaps + Verdict + Path forward; T3 a compact Gap & Growth roadmap; T4 writes **no file** — scores still land in score-history + scouting). See `modes/scouting.md` § Output Behavior |

Key scripts (all under `scripts/`): `scan.mjs` (zero-token portal scanner — Greenhouse/Ashby/Lever APIs), `jobspy/scan.py` (zero-token aggregator scanner — Indeed/Google via [JobSpy](https://github.com/speedyapply/JobSpy); writes to staging files; setup once via `scripts/jobspy/setup.sh`), `merge-scan-staging.mjs` (merges JobSpy staging into canonical scan-history.tsv + pipeline.md after both scrapers exit), `generate-pdf.mjs` (Playwright HTML→PDF), `merge-tracker.mjs` / `merge-scouting.mjs` (TSV → markdown merge), `promote-to-applications.mjs` (T1 scouting → applications), `verify-pipeline.mjs` / `dedup-tracker.mjs` / `normalize-statuses.mjs` (health), `check-liveness.mjs` (posting liveness), `analyze-patterns.mjs` / `followup-cadence.mjs` (analysis), `daily-brief.mjs` (read-only "what should I do now?" digest bundling followup + deadlines + patterns + the inbox-triage top slice + the top untouched warm-outreach paths — warm-direct/warm-intro picks vetted by the outreach-plan decision ladder over `data/network.md` + `data/outreach.md`, never a re-touch of an exhausted contact or a parallel first touch beside a live thread — into one artifact, plus a cross-profile "Other searches" footer (one read-only summary line per non-active profile when `profiles/` holds ≥2 profiles); `npm run brief`), `whats-new.mjs` (digest of listings new since last scan; `npm run whats-new`), `triage-pipeline.mjs` (zero-token pre-eval triage — ranks `data/pipeline.md` Pending URLs by scan relevance + freshness + dream/affinity company + title level + dedup hits, recommends the top slice for deep evaluation, and with `--emit-batch` fills `batch/batch-input.tsv`; `npm run triage`), `calibration-advisor.mjs` (scoring-calibration feedback — surfaces mis-weighted dims without mutating data; `npm run calibrate`), `cv-gap.mjs` (CV vs. landscape gap — aggregates keyword demand across all reports; `npm run cv-gap`), `ats-coverage.mjs` (CV keyword coverage vs. a single JD; `npm run ats-coverage`), `doctor.mjs` (setup validation checklist; `npm run doctor`), `cv-sync-check.mjs` (consistency check across cv.md / profile.yml; `npm run sync-check`), `check-story-bank.mjs` (STAR+R story-bank health + competency-coverage report; `npm run story-bank`), `compare-offers.mjs` (offer comparison CLI; `npm run compare-offers`), `company-research.mjs` (locate and validate deep-research artifacts under `data/companies/`; `npm run research`), `outreach-cadence.mjs` (parse outreach log + classify contact cadence; used by `contacto` mode), `outreach-plan.mjs` (zero-token pre-flight for `contacto` — for one target company, merges warm referral paths from `data/network.md`, prior outreach threads + cadence state from `data/outreach.md`, research freshness, the scouting report, and story-bank proof ammo into one dossier and recommends the play: reply-handoff / nudge / warm-direct / warm-intro / wait / cold-search; `npm run outreach-plan -- "Company" --summary`), `respond-plan.mjs` (I/O wrapper for the `respond` recruiter-reply mode), `training-roi.mjs` (ROI evaluator for the `training` mode), `peer-rank.mjs` (compute comparative peer-rank block for a listing's score vs. same-archetype history), `positioning-intel.mjs` (corpus-level archetype fingerprints + cheapest-lever analysis for the `positioning` mode), `apply-kit.mjs` (read-only application-readiness checklist — inspects on-disk artifacts for a target listing and reports what's missing + the exact next action; `npm run apply-kit`), `mock-interview.mjs` (predict likely interview questions for a company+role, map each to the candidate's best-fit STAR+R story, flag competency gaps; `npm run mock-interview`), `network.mjs` (referral/warm-intro finder — reads `data/network.md` against the active pipeline and surfaces referral paths, coverage gaps, and latent leads; `npm run network`), `score-trend.mjs` (re-evaluation trajectory — adds the time axis to `data/score-history.tsv`, showing per-listing score movement across re-evaluations and whether landscape targeting is sharpening; `npm run score-trend`), `deadlines.mjs` (closing-date urgency tracker — ranks active + T1/T2 scouting entries by deadline into act-today / this-week / watch buckets; exits 1 if anything is urgent; `npm run deadlines`), `comp-bench.mjs` (compensation benchmarking — mines the evaluated landscape for salary-proxy and disclosed-comp anchors by archetype/city, then flags where the user's stated target band sits vs. that landscape; `npm run comp-bench`), `probe-ats.mjs` (ATS discovery — probes Greenhouse/Ashby/Lever/SmartRecruiters APIs for a list of companies and outputs TSV of which ATS each uses, so they can be added to `user/portals.yml`; no npm alias — run via `node scripts/probe-ats.mjs`), `rebuild-dedup-index.mjs` (safety-net rebuild of `data/dedup-index.tsv` from scratch after any out-of-band manual edit to scouting.md or applications.md; no npm alias — run via `node scripts/rebuild-dedup-index.mjs`), `cv-summary.mjs` (compact CV summary for eval workers — deterministically derives gitignored `batch/cv-summary.md` from `user/cv.md` + `user/profile.yml` so per-listing eval spawns ingest a trimmed proof-point summary instead of the full CV; mtime-gated via `--if-stale`; refreshed automatically by `batch/batch-runner.sh` and the frontend's eval buttons before spawning workers, and `batch/batch-prompt.md` documents the fallback to `user/cv.md` when the artifact is missing; `npm run cv-summary`), `agent-log.mjs` (agent issue log — eval workers and mode sessions self-report operational problems (schema mismatches, unparseable data, dead-URL patterns, rubric ambiguity) to `data/agent-log.tsv` instead of silently working around them; `log` / `list [--unresolved]` / `counts` (the repeat-flag view) / `resolve <id>`; `npm run agent-log`), `session-handoff.mjs` (cross-session thread state — the data files hold facts, `data/session-handoff.md` holds the *thread*; `write --slug … --message …` when a session leaves something unresolved, `read` / `show <id>` when a later conversation reaches backwards; `npm run handoff`).

**Scoring analytics are governed by a statistical contract.** Every surface derived from `data/score-history.tsv` — `peer-rank.mjs`, `score-trend.mjs`, `calibration-advisor.mjs`, and `positioning`'s trajectory section — obeys `docs/scoring-statistical-design.md`: a 0.30 Overall noise floor (sub-floor deltas are "flat within noise", never a direction), per-surface minimum-information gates (peers ≥5, ≥10 evals per trend window, per-claim calibration minimums), and confidence tiers stated with every claim's `n`. The thresholds live in `scripts/lib/scoring-stats.mjs` — never re-derive or restate them inline; when adding a new score-derived analytic, declare its gates in the doc first.

**Eval spawns use the compact bundle.** Both the batch runner and the frontend's per-listing evaluation spawns (Filter to Database, inbox Evaluate, Add Listing, Generate top 5 reports) load `batch/batch-prompt.md` via `claude -p --append-system-prompt-file` instead of routing through the `/career-ops` slash command — workers get the full scoring rubric without re-reading `CLAUDE.md` + `modes/*` on every eval (token-cost lever 3 in `TODO.md`). The frontend side lives in `frontend/src/lib/evalSpawn.ts` (`claudeEvalArgs` + shared task-prompt builders); structural parity of the bundle with `modes/_shared.md` stays pinned by `scripts/batch-prompt-parity.test.mjs`. Per-listing *follow-up* actions (Tailor CV / Draft Application / Prep Application) and `positioning` are different modes and still use their slash commands.

**Aggregator scraper (`scripts/jobspy/`):** runs in parallel with `scan.mjs` from both Full Scan and API Only buttons. Indeed + Google only (LinkedIn excluded — account/IP/ToS risk). Mirrors `scan.mjs`'s 4-pass filter (title pos/neg, lang blocklist, EU location allowlist, URL dedup) plus a `MAX_NEW_ROWS_PER_RUN=100` ceiling. The title/language/location matching is **word-boundary aware and kept in lockstep with `scan-core.mjs`** (same allowlist, same `compileKeyword` boundary semantics) — so a negative like `Lead` no longer drops `Leadership Analyst` and a positive like `Ops` no longer keeps `Synopsys`; both scanners give the same verdict for the same `portals.yml`. Keep `scripts/jobspy/scan.py`'s `keyword_matches` and `scan-core.mjs`'s `compileKeyword` in sync if you touch either; parity is pinned by `scripts/jobspy/test_filters.py` + `scripts/scan-core.test.mjs`. Both scanners also read each role's **true posting date** from the ATS payload (`scan-core.mjs` › `parsePostingDate`, `scan.py` › `normalize_posting_date`) so relevance freshness reflects when a role was *posted*, not when the scanner first saw it — genuinely-new roles outrank long-open reposts (which are demoted via the `staleRepost` weight). Writes to `data/scan-history.jobspy.tsv` and `data/pipeline.jobspy.md`; `merge-scan-staging.mjs` appends those into the canonical files and archives the staging to `batch/jobspy-merged/`. The merge dedups in two layers — exact URL first, then normalized **(company, role)** (same key scheme as `scripts/lib/dedup-index.mjs`) — so the same aggregator posting surfaced under several different URLs (Google redirect, Indeed `job_url`, employer `job_url_direct`) lands once, not three times. Merge math is pure and unit-tested in `scripts/lib/merge-staging-core.mjs`. The **live ATS scanner (`scan.mjs`) shares that same canonical dedup** via `seedScanSeen` + `classifyScanOffer` (also in `merge-staging-core.mjs`): it canonicalizes URLs (tracking params / redirect wrappers) and (company, role) titles (`(m/f/d)`, trailing location/req-id boilerplate) and seeds its seen-set from `scan-history.tsv` too — so a role already discovered under a slightly different URL or title variant no longer re-enters the pipeline on the next scan.

## First Run — Onboarding

**Before doing ANYTHING else, check that all of these exist:**
1. `user/cv.md`
2. `user/profile.yml`
3. `user/_profile.md`
4. `user/portals.yml`

**If ANY is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place.

- **CV missing** → ask for paste / LinkedIn URL / verbal description; create clean markdown with Summary, Experience, Projects, Education, Skills.
- **profile.yml missing** → copy `config/profile.example.yml` → `user/profile.yml`; ask for name, email, location, target roles, salary range.
- **_profile.md missing** → create from scratch from the user's profile and goals. This is the user's customization file (archetypes, narrative, negotiation scripts), never overwritten by updates.
- **portals.yml missing** → create with target-role keywords; the scanner uses this for Greenhouse/Ashby/Lever queries.
- **applications.md missing** → create with header `| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |` (10 columns — the Deadline cell between PDF and Report is what `merge-tracker.mjs` writes for every row).

**After basics are set, proactively get to know the user** — superpower / what excites or drains them / deal-breakers / best achievement / published work. Store insights in `user/profile.yml`, `user/_profile.md`, or `user/article-digest.md`. The system gets smarter with every interaction.

**After every evaluation, learn.** If the user corrects a score or notes missing context, update `user/_profile.md` / `user/profile.yml` / `user/article-digest.md`. Never put personalization into system-layer files.

**Once set up,** offer automation: use `/loop` or `/schedule` (if available) for recurring `/career-ops scan`; otherwise suggest cron or periodic manual runs.

## Personalization

This system is designed to be customized by you (AI Agent). Common requests:

- *"Change the archetypes to [X] roles"* → edit `user/_profile.md` or `user/profile.yml`
- *"Add these companies to my portals"* → edit `user/portals.yml`
- *"Update my profile"* → edit `user/profile.yml`
- *"Change the CV template design"* → edit `templates/cv-template.html`
- *"Adjust the scoring weights"* → edit `user/_profile.md` for user-specific weighting; only edit `modes/_shared.md` and `batch/batch-prompt.md` when changing system defaults for everyone.

## Skill Modes

There is **one evaluation mode** (`scouting`). Per-listing follow-up actions (Tailor CV, Prep Application, Draft Application) are separate skills the user triggers when they want them. CF/AF rollup weights are fixed at 70/30.

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL, or asks to evaluate a listing | `scouting` — produces a scored report (Header + Dimensional table + Role summary + Gaps + Comp + Recommendation + Career path impact) |
| Wants a holistic career review across all data | `positioning` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| A recruiter replied (screening Qs, comp/availability ask, take-home, scheduling, soft rejection) and wants a drafted reply | `respond` (drafts a grounded reply; always stops before send) |
| Asks for company research | `deep` |
| Preps for interview / drafts application content for a specific role | `interview-prep` (writes `interview-prep/{Company} - {Role}.md`) |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or application cadence | `followup` |
| Asks about deadlines, closing dates, what's urgent | `deadlines` |
| Wants to browse/filter all evaluated offers as a table | `db` |
| Wants to rehearse / predict likely interview questions for a role | `mock-interview` |
| Wants to find a referral / warm-intro path into a target company | `network` |
| Asks whether an application is ready to send / what's still missing | `apply-kit` |
| Wants to benchmark comp for their target roles vs the evaluated landscape | `comp-bench` |
| Wants scoring feedback — are calibration weights producing reliable results? | `calibrate` — reads `data/score-history.tsv` + `user/profile.yml`; surfaces mis-calibrated weights as read-only advisory (no score edits) |
| Wants to know what the CV is missing vs. the roles being evaluated | `cv-gap` — aggregates keyword demand across all scouting reports and flags systematic CV gaps |

## Operational Feedback Loops

Two small logs close loops that used to vanish into spawn output (both gitignored, shared across profiles):

- **Agent issue log** (`data/agent-log.tsv`): when any agent — batch eval worker, mode session, chat — hits a schema mismatch, an unparseable data file, a URL pattern that consistently fails verification, or a rubric ambiguity, it logs it (`node scripts/agent-log.mjs log --category <schema|data|url|rubric|other> --subject "…" "…"`) instead of silently working around it. **When starting maintenance or system work, check `node scripts/agent-log.mjs list --unresolved` first** and `resolve` entries whose cause you fix; `counts` surfaces repeat offenders.
- **Session handoff** (`data/session-handoff.md`): the data files hold facts; this holds the *thread*. End a session that leaves something unresolved (a half-drafted outreach, a pending apply decision, an investigation mid-flight) with `npm run handoff -- write --slug <topic> --message "…"`. Read it (`npm run handoff -- read`) when the user's message reaches backwards ("where did we get to", "you said last time") or before a broad review.

## CV Source of Truth

- `user/cv.md` is canonical
- `user/article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** — read them from these files at evaluation time

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** Help the user find roles where there is a genuine match — not spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs — but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If the global Score is below 7.0/10, explicitly recommend against applying (see `modes/_shared.md` § Score interpretation). Only proceed if the user has a specific reason to override.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---

## Stack and Conventions

- Node.js (`.mjs` modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV)
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report naming: `{Company} - {Role}.md` (human-readable, no sequential numbering in filenames)
- **Frontend (Electron app):** the desktop app under `frontend/` is branded **starpath** (the project itself stays `career-ops`; the GUI app is just one consumer). Its top-level cockpit is two primary tabs that reflect *workflow stage*, NOT mode:
  - **Scouting** — landscape inventory view. Scan + Generate Reports buttons; activity panel streams live spawn output. Reads from `data/scouting.md`.
  - **Applying** — active applications view. Per-listing actions: Tailor CV (`modes/pdf.md`), Draft Application (`modes/apply.md`), Prep Application (`modes/interview-prep.md`). Reads from `data/applications.md`.

  **Chat** (primary tab, above Scouting) is the conversational surface: the app spawns the local `claude` CLI (cwd = repo root, `--append-system-prompt-file modes/chat.md`, `--resume` for continuity across turns) and streams the reply into a persistent transcript. Sessions + the live runtime snapshot persist as JSON under `{userData}/chat/` — never in the SQLite cache, which must stay fully derivable from Markdown/TSV. The main-process glue is `frontend/electron/chat.ts`; the pure runtime/session/args logic is `frontend/src/lib/chat/` (tested). `modes/chat.md` is generic system-layer prompt — user facts stay in the data files it reads. Chat never writes tracker files directly: it emits **proposal fences** (` ```starpath:apply ` / ` ```starpath:status ` — contract in `modes/chat.md` § Proposals) that render as Confirm/Dismiss cards in the transcript; Confirm applies through the same `applicationsDoc.ts` mutators as the Apply button (refresh-in-place on existing company+role, canonical statuses only), and decisions persist on the session so a card never re-offers.

  Below those, secondary tabs (Offers, Database, Reports, Trends, Pipeline, Activity) are read-only data lenses + the workflow Kanban; three former standalone tabs now live as sub-tabs (shared `ViewTabs` strip): **Network** under Outreach, **Score Trend** under Trends, and the Configuration editor (Identity / Target Roles / Portals) under Settings. **Network** is the warm-outreach lens — the roster from `data/network.md`, per-company recommended plays (the `outreach-plan` decision ladder), cadence on open `data/outreach.md` threads, and apply-worthy coverage gaps, all derived in the Electron main process by the same pure cores the CLIs use (`scripts/lib/network-lens-core.mjs`). **Database** is the universal lens with a `liveness` filter (active <14d / stale 14–90d / closed >90d) derived from `data/scan-history.tsv`. **Pipeline** is the application-status Kanban + Inbox. Cross-linking spine: every entity is keyed by `company + role`; clicking a Database row opens an action popover (View report · Apply · Tailor CV · Prep Application · Open URL · Mark not interested), and the Reports slide-over has two tabs (Scouting report / Application prep) — greyed out when the corresponding file isn't on disk.

  **Apply / Status writebacks.** The Apply button (in the popover and slide-over) and the inline status dropdown both write directly to `data/applications.md` from the renderer — appending a new row on first Apply, then rewriting the matching row's `Status` cell on each status change. The chokidar watcher resyncs the SQLite cache automatically.

- **Frontend cache:** the Electron app mirrors `data/*` and `reports/**` into a SQLite cache at `{userData}/cache.db` for fast queries. It is fully derived from the Markdown/TSV files and rebuilds on launch via mtime comparison + a chokidar watcher. Markdown/TSV remain canonical; backend modes (Claude) never read or write the cache. See `frontend/ARCHITECTURE.md`.

- **RULE: After each batch of evaluations, run `node scripts/merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE for backend modes: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry. (The frontend Apply button enforces the same rule — `upsertApplicationRow` in `frontend/src/lib/applicationsDoc.ts` refreshes an existing (company, role) row in place instead of appending a duplicate.)

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 10 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/10\t{pdf_emoji}\t{deadline}\t[{num}](reports/tier-{N}/{num}-{slug}-{date}.md)\t{note}
```

**Column order (status BEFORE score in TSV):** `num`, `date`, `company`, `role`, `status` (canonical, e.g. `Evaluated`), `score` (`X.X/10`), `pdf` (`✅`/`❌`), `deadline` (`2026-06-30` | `Rolling` | `n/d`), `report` (markdown link to `reports/tier-{N}/...` where `N` is the tier assigned by `scripts/score-listing.mjs` — CF/AF-based band rules in `modes/_shared.md` § Score interpretation, never re-derived by hand), `notes`.

In `applications.md`, score comes BEFORE status — `scripts/merge-tracker.mjs` swaps columns automatically and rewrites flat `reports/...md` paths into the correct tier subfolder if the writer leaves the tier off. The canonical TSV form is the tiered path.

For scouting (separate flow), see `modes/scouting.md` § "Tracker Entry" — scouting writes 11-column TSVs to `batch/scouting-additions/`.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** — write TSV in `batch/tracker-additions/` and `scripts/merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node scripts/verify-pipeline.mjs` · normalize: `node scripts/normalize-statuses.mjs` · dedup: `node scripts/dedup-tracker.mjs`

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Evaluation report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:** No markdown bold (`**`) in status field. No dates in status field (use the date column). No extra text (use the notes column).

**Scouting observations** are NOT in this table — they live in `data/scouting.md` with a **Tier** column (`T1`-`T4`) instead of a status. Write scouting TSVs to `batch/scouting-additions/` and run `node scripts/merge-scouting.mjs`. Promote Tier 1 hits to active applications via `node scripts/promote-to-applications.mjs <num>`.

## Agent Orchestration

When running as a top-tier model on multi-workstream tasks, default to orchestrating rather than typing: delegate spec'd, machine-verifiable work (tests/typecheck as the acceptance gate) to cheaper subagents, and spend own tokens on spec, judgment, review, and integration. Work inline when the task is small, single-surface, and already located — orchestration ceremony costs more than the work there.

Rules that are never optional:

1. **Strictly disjoint file surfaces per parallel agent.** Every dispatch names its complete owned-file list; two live agents never share a file. Sequence agents that need the same surface.
2. **Verify a spawn actually launched (and what it changed) before re-dispatching.** Never assume a lost agent did nothing.
3. **Single owner per change for shared contract surfaces:** `CLAUDE.md`/`AGENTS.md` · the IPC contract (`frontend/electron/preload.ts` + `frontend/src/lib/ipc.ts` + the `frontend/electron/main.ts` handler registrations) · nav wiring (`frontend/src/store/nav.ts` + Sidebar/AppShell) · `batch/batch-prompt.md` + `modes/_shared.md` (parity-pinned by `scripts/batch-prompt-parity.test.mjs`) · root `package.json` · the profile symlink layout in `scripts/profile.mjs`. One agent (or the orchestrator) owns each of these per round; everyone else treats them as read-only.
4. **Concurrent sessions share this checkout.** Do agent work in isolated git worktrees and merge to local main; never leave the main tree dirty with generated work, and check `git status` for another session's uncommitted files before merging anything that touches the same paths.

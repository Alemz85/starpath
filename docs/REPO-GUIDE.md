# Repo Guide — reference for agents

`CLAUDE.md` (and its Codex mirror `AGENTS.md`) holds the rules every session needs. This file holds the reference detail behind them: where things live, what each script does, how the scanners and the desktop app work. Read the section for the area you are about to touch; there is no need to load all of it up front.

- [Private root and overrides](#private-root-and-overrides)
- [Leak gate](#leak-gate)
- [Demo dataset](#demo-dataset)
- [File map](#file-map)
- [Script catalog](#script-catalog)
- [Scanners](#scanners)
- [Evaluation spawns](#evaluation-spawns)
- [Frontend app (starpath)](#frontend-app-starpath)
- [Tracker TSV](#tracker-tsv)
- [System layer hygiene](#system-layer-hygiene)
- [Conventions](#conventions)

## Private root and overrides

**Layout.** Everything personal lives in `private/` (gitignored, its own git repo; `DATA_CONTRACT.md` has the full table). The repo-root `user/ data/ reports/ interview-prep/ output/ jds/` and `batch/{tracker-additions,scouting-additions,logs,jobspy-merged}` are relative directory links into it; `batch/{batch-state.tsv,batch-input.tsv,cv-summary.md}` are file links. That is why every repo-relative path in modes, prompts and scripts still works. Search behaves as before: `rg term data/` follows the link, a repo-wide search skips it because it is ignored.

**Resolution in code.** `scripts/lib/data-root.mjs` is the single source of truth:
- `resolveDataRoot({ repoRoot, configured, env, allowDemo })`: the app's saved choice (`config.json` → `dataPath`, e.g. `'demo'`), then `$STARPATH_DATA` (absolute, repo-relative, `demo` or `private`), then `<repo>/private`, then (app only) `<repo>/demo`.
- `dataRootFor(repoRoot)`: the same for CLI scripts, falling back to the repo root on an un-migrated checkout. Scripts the app runs on the demo (`daily-brief`, `followup-cadence`, `analyze-patterns`) read through it; the rest use repo-relative paths and work through the links.
- `isPersonalPath(rel)`: which repo-relative paths are personal (the linked paths and `profiles/`). The Electron main process maps those to the data root in `resolveRepoPath`, so renderer call sites keep passing `data/applications.md`.
- `LINKED_PATHS`: the link list `npm run private -- init` creates and `npm run doctor` checks.

**Commands.** `npm run private -- init [--dry-run]` (create `private/`, move legacy folders in by rename, link, verify a sha256 manifest, `git init`, first commit) · `npm run private -- status` · `npm run private -- link` (repair links) · `npm run backup` (commit + push `private/`) · `npm run doctor` (layout, links, ignore rule, remote, last backup, hooks, overrides drift).

**Private repo guard.** `private/.githooks/pre-commit` refuses code files (`*.mjs`, `*.ts`, `package.json`…), so app code never lands in the private repo.

**Overrides.** `scripts/lib/overrides.mjs`: `private/overrides/<path>` replaces a system file; `private/overrides/<path minus .md>.append.md` is appended (after a marker comment). Overridable: `modes/*.md`, `batch/batch-prompt.md`, `templates/**`, `config/profile.example.yml`, `.claude/skills/career-ops*/SKILL.md`. Consumers:
- Claude sessions: the `career-ops` router and CLAUDE.md tell the agent to read overrides first; the SessionStart hook in `.claude/settings.json` prints `node scripts/overrides.mjs --brief` (nothing when there are none).
- Spawned workers: `materializeSystemFile()` returns the path to hand to `--append-system-prompt-file` (writing the composed text to `private/.cache/prompts/<path>` when there is an append file). The app calls it through the `prompt:resolve` IPC (`evalSpawn.ts`, chat); `batch-runner.sh` through `node scripts/overrides.mjs resolve batch/batch-prompt.md`.
- `npm run overrides` lists overrides and flags drift (the repo default changed after your override was last edited).

## Leak gate

Three layers keep personal data out of the public repo:
1. **Git hooks** in `.githooks/` (tracked; `npm run hooks` sets `core.hooksPath`; doctor warns when missing): `pre-commit` refuses staged personal paths and scans the staged diff, `commit-msg` scans the message, `pre-push` scans every added line and commit message in the push range and blocks the push. A blocked push means fix the commits (amend/rebase), never `--no-verify`.
2. **The scanner** is `scripts/lib/hygiene-guard.mjs` (`npm run leak-check` scans all tracked files; `--staged`, `--range a..b`, `--message <file>`, `--generic-only`, `--json`). Terms are derived at run time from the data root, never stored in the repo: identity (name, email, phone) from `user/profile.yml`, schools / employers / projects from `user/cv.md`, people from `data/network.md`, companies and roles from the trackers and report filenames, plus `private/leak-terms.txt` (one term per line, `#` comments, `!term` to allow one). From a linked worktree it finds the main checkout's `private/`. Output is `file:line  [category]  masked-term`, never the line. World-famous brand names on their own only warn (they appear in rubric tables); full role strings and company+role pairs block. Lines with `hygiene-guard:allow` are skipped.
3. **CI backup net**: `.github/workflows/leak-scan.yml` runs the generic patterns (emails, phone numbers, `/Users/<name>` paths, API keys; salary-looking figures as warnings) on every push and PR. It runs after the push, so the hook is the real protection.

To protect a term the gate can't infer (a contact's name, an address, a company you only discussed in chat), add it to `private/leak-terms.txt`.

## Demo dataset

`demo/` is a fictional workspace with the private layout (persona, CV, trackers, reports, prep, network), generated by `scripts/demo/build-demo.mjs` from `scripts/demo/seed.mjs` through the real `score-listing.mjs` engine, so every score and tier matches the current rubric. Rebuild with `npm run demo:build` after a rubric or format change; `scripts/demo/build-demo.test.mjs` checks it reproduces byte-for-byte, parses with the project's own parsers and contains no real-brand or private-derived term. The app shows it read-only when the user picks "Explore the demo" at onboarding or turns on Settings › General › Show demo data.

## File map

| File | Function |
|------|----------|
| `private/` | The private root: every personal file below lives here; the repo-root paths are links into it ([Private root and overrides](#private-root-and-overrides)) |
| `demo/` | Fictional workspace for the app's demo mode ([Demo dataset](#demo-dataset)) |
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
| `reports/tier-{1..4}/{Company} - {Role}.md` | Evaluation reports — **banded depth** (every report keeps the universal header + `## Eligibility` + `## Dimensional scoring` table + a closing `Salary math:` line; T1 adds the full prose sections — Role summary + Gaps + Comp + Recommendation + Career path impact; T2 a short Fit/gaps + Verdict + Path forward; T3 a compact Gap & Growth roadmap; T4 writes **no file** — scores still land in score-history + scouting). See `modes/scouting.md` § Output Behavior |

## Script catalog

All under `scripts/`. `docs/SCRIPTS.md` has usage detail for the older maintenance scripts.

**Scanning and inbox**
- `scan.mjs` — zero-token portal scanner (Greenhouse/Ashby/Lever APIs).
- `jobspy/scan.py` — zero-token aggregator scanner (Indeed/Google via [JobSpy](https://github.com/speedyapply/JobSpy)); writes to staging files; set up once via `scripts/jobspy/setup.sh`. See [Scanners](#scanners).
- `merge-scan-staging.mjs` — merges JobSpy staging into canonical `scan-history.tsv` + `pipeline.md` after both scrapers exit.
- `whats-new.mjs` — digest of listings new since last scan (`npm run whats-new`).
- `triage-pipeline.mjs` — zero-token pre-eval triage: ranks `data/pipeline.md` Pending URLs by scan relevance + freshness + dream/affinity company + title level + dedup hits, recommends the top slice for deep evaluation, and with `--emit-batch` fills `batch/batch-input.tsv` (`npm run triage`).
- `probe-ats.mjs` — ATS discovery: probes Greenhouse/Ashby/Lever/SmartRecruiters APIs for a list of companies and outputs TSV of which ATS each uses, so they can be added to `user/portals.yml` (no npm alias: `node scripts/probe-ats.mjs`).
- `check-liveness.mjs` — posting liveness.

**Trackers and health**
- `merge-tracker.mjs` / `merge-scouting.mjs` — TSV → markdown merge.
- `promote-to-applications.mjs` — T1 scouting → applications.
- `verify-pipeline.mjs` / `dedup-tracker.mjs` / `normalize-statuses.mjs` — health.
- `rebuild-dedup-index.mjs` — safety-net rebuild of `data/dedup-index.tsv` from scratch after any out-of-band manual edit to scouting.md or applications.md (no npm alias: `node scripts/rebuild-dedup-index.mjs`).
- `doctor.mjs` — setup validation checklist (`npm run doctor`).
- `cv-sync-check.mjs` — consistency check across cv.md / profile.yml (`npm run sync-check`).
- `generate-pdf.mjs` — Playwright HTML→PDF.

**Daily use and analysis**
- `daily-brief.mjs` — read-only "what should I do now?" digest bundling followup + deadlines + patterns + the inbox-triage top slice + the top untouched warm-outreach paths (warm-direct/warm-intro picks vetted by the outreach-plan decision ladder over `data/network.md` + `data/outreach.md`, never a re-touch of an exhausted contact or a parallel first touch beside a live thread) into one artifact, plus a cross-profile "Other searches" footer (one read-only summary line per non-active profile when `profiles/` holds ≥2 profiles) (`npm run brief`).
- `deadlines.mjs` — closing-date urgency tracker: ranks active + T1/T2 scouting entries by deadline into act-today / this-week / watch buckets; exits 1 if anything is urgent (`npm run deadlines`).
- `analyze-patterns.mjs` / `followup-cadence.mjs` — analysis.
- `calibration-advisor.mjs` — scoring-calibration feedback; surfaces mis-weighted dims without mutating data (`npm run calibrate`).
- `score-trend.mjs` — re-evaluation trajectory: adds the time axis to `data/score-history.tsv`, showing per-listing score movement across re-evaluations and whether landscape targeting is sharpening (`npm run score-trend`).
- `peer-rank.mjs` — comparative peer-rank block for a listing's score vs. same-archetype history.
- `positioning-intel.mjs` — corpus-level archetype fingerprints + cheapest-lever analysis for the `positioning` mode.
- `comp-bench.mjs` — compensation benchmarking: mines the evaluated landscape for salary-proxy and disclosed-comp anchors by archetype/city, then flags where the user's stated target band sits vs. that landscape (`npm run comp-bench`).
- `cv-gap.mjs` — CV vs. landscape gap; aggregates keyword demand across all reports (`npm run cv-gap`).
- `ats-coverage.mjs` — CV keyword coverage vs. a single JD (`npm run ats-coverage`).

**Applying, interviews, outreach**
- `apply-kit.mjs` — read-only application-readiness checklist: inspects on-disk artifacts for a target listing and reports what's missing + the exact next action (`npm run apply-kit`).
- `mock-interview.mjs` — predicts likely interview questions for a company+role, maps each to the candidate's best-fit STAR+R story, flags competency gaps (`npm run mock-interview`).
- `check-story-bank.mjs` — STAR+R story-bank health + competency-coverage report (`npm run story-bank`).
- `compare-offers.mjs` — offer comparison CLI (`npm run compare-offers`).
- `company-research.mjs` — locate and validate deep-research artifacts under `data/companies/` (`npm run research`).
- `network.mjs` — referral/warm-intro finder: reads `data/network.md` against the active pipeline and surfaces referral paths, coverage gaps, and latent leads (`npm run network`).
- `outreach-cadence.mjs` — parses the outreach log + classifies contact cadence; used by `contacto` mode.
- `outreach-plan.mjs` — zero-token pre-flight for `contacto`: for one target company, merges warm referral paths from `data/network.md`, prior outreach threads + cadence state from `data/outreach.md`, research freshness, the scouting report, and story-bank proof ammo into one dossier and recommends the play: reply-handoff / nudge / warm-direct / warm-intro / wait / cold-search (`npm run outreach-plan -- "Company" --summary`).
- `respond-plan.mjs` — I/O wrapper for the `respond` recruiter-reply mode.
- `training-roi.mjs` — ROI evaluator for the `training` mode.

**Agent plumbing**
- `cv-summary.mjs` — compact CV summary for eval workers: deterministically derives gitignored `batch/cv-summary.md` from `user/cv.md` + `user/profile.yml` so per-listing eval spawns ingest a trimmed proof-point summary instead of the full CV; mtime-gated via `--if-stale`; refreshed automatically by `batch/batch-runner.sh` and the frontend's eval buttons before spawning workers; `batch/batch-prompt.md` documents the fallback to `user/cv.md` when the artifact is missing (`npm run cv-summary`).
- `agent-log.mjs` — agent issue log (`data/agent-log.tsv`): `log` / `list [--unresolved]` / `counts` (the repeat-flag view) / `resolve <id>` (`npm run agent-log`).
- `session-handoff.mjs` — cross-session thread state (`data/session-handoff.md`): `write --slug … --message …`, `read`, `show <id>` (`npm run handoff`).

## Scanners

The aggregator scraper (`scripts/jobspy/`) runs in parallel with `scan.mjs` from both the Full Scan and API Only buttons. Indeed + Google only (LinkedIn excluded — account/IP/ToS risk). It mirrors `scan.mjs`'s 4-pass filter (title pos/neg, lang blocklist, EU location allowlist, URL dedup) plus a `MAX_NEW_ROWS_PER_RUN=100` ceiling.

- **Matching is word-boundary aware and kept in lockstep with `scan-core.mjs`** (same allowlist, same `compileKeyword` boundary semantics), so a negative like `Lead` no longer drops `Leadership Analyst` and a positive like `Ops` no longer keeps `Synopsys`; both scanners give the same verdict for the same `portals.yml`. Keep `scripts/jobspy/scan.py`'s `keyword_matches` and `scan-core.mjs`'s `compileKeyword` in sync if you touch either; parity is pinned by `scripts/jobspy/test_filters.py` + `scripts/scan-core.test.mjs`.
- **True posting dates.** Both scanners read each role's posting date from the ATS payload (`scan-core.mjs` › `parsePostingDate`, `scan.py` › `normalize_posting_date`), so relevance freshness reflects when a role was *posted*, not when the scanner first saw it. Genuinely new roles outrank long-open reposts (demoted via the `staleRepost` weight).
- **Staging and merge.** JobSpy writes to `data/scan-history.jobspy.tsv` and `data/pipeline.jobspy.md`; `merge-scan-staging.mjs` appends those into the canonical files and archives the staging to `batch/jobspy-merged/`. The merge dedups in two layers — exact URL first, then normalized **(company, role)** (same key scheme as `scripts/lib/dedup-index.mjs`) — so the same posting surfaced under several URLs (Google redirect, Indeed `job_url`, employer `job_url_direct`) lands once. Merge math is pure and unit-tested in `scripts/lib/merge-staging-core.mjs`.
- **Shared dedup in the live scanner.** `scan.mjs` uses the same canonical dedup via `seedScanSeen` + `classifyScanOffer` (also in `merge-staging-core.mjs`): it canonicalizes URLs (tracking params / redirect wrappers) and (company, role) titles (`(m/f/d)`, trailing location/req-id boilerplate) and seeds its seen-set from `scan-history.tsv` too, so a role already discovered under a slightly different URL or title variant doesn't re-enter the pipeline.

## Evaluation spawns

Both the batch runner and the frontend's per-listing evaluation spawns (Filter to Database, inbox Evaluate, Add Listing, Generate top 5 reports) load `batch/batch-prompt.md` via `claude -p --append-system-prompt-file` instead of routing through the `/career-ops` slash command. Workers get the full scoring rubric without re-reading `CLAUDE.md` + `modes/*` on every eval (a token-cost lever).

- The frontend side lives in `frontend/src/lib/evalSpawn.ts` (`claudeEvalArgs` + shared task-prompt builders).
- Structural parity of the bundle with `modes/_shared.md` is pinned by `scripts/batch-prompt-parity.test.mjs`: change one, change the other.
- Per-listing *follow-up* actions (Tailor CV / Draft Application / Prep Application) and `positioning` are different modes and still use their slash commands.
- Batch workers can't run Playwright, so they verify postings with WebFetch and mark the report header `**Verification:** unconfirmed (batch mode)`.

## Frontend app (starpath)

The desktop app under `frontend/` is branded **starpath** (the project itself stays `career-ops`; the GUI app is just one consumer). Design rules: `DESIGN-meta.md`. Architecture: `frontend/ARCHITECTURE.md`.

**Primary tabs** reflect *workflow stage*, not mode:
- **Chat** (above Scout) — the conversational surface. The app spawns the local `claude` CLI (cwd = repo root, `--append-system-prompt-file modes/chat.md`, `--resume` for continuity across turns) and streams the reply into a persistent transcript. Sessions + the live runtime snapshot persist as JSON under `private/chat/` (backed up with the rest of the private root; `{userData}/chat-demo/` in demo mode) — never in the SQLite cache. The main-process glue is `frontend/electron/chat.ts`; the pure runtime/session/args logic is `frontend/src/lib/chat/` (tested). `modes/chat.md` is a generic system-layer prompt — user facts stay in the data files it reads. Chat never writes tracker files directly: it emits **proposal fences** (` ```starpath:apply ` / ` ```starpath:status ` — contract in `modes/chat.md` § Proposals) that render as Confirm/Dismiss cards; Confirm applies through the same `applicationsDoc.ts` mutators as the Apply button (refresh-in-place on existing company+role, canonical statuses only), and decisions persist on the session so a card never re-offers.
- **Scout** — the home cockpit (the former Scouting and Today tabs merged): a "Where things stand" overview (pipeline funnel + what needs the user today), the scan action row (Full scan / API only / Filtered scan picker / Filter to Database / Add listing), the daily brief, and the deadline list. Reads `data/scouting.md`, `data/pipeline.md` and `data/applications.md`. The `today` view id still resolves here.
- **Applying** — active applications. Per-listing actions: Tailor CV (`modes/pdf.md`), Draft Application (`modes/apply.md`), Prep Application (`modes/interview-prep.md`). Reads `data/applications.md`.

**Secondary tabs** (Offers, Database, Reports, Trends, Pipeline, Activity) are read-only data lenses + the workflow Kanban. Former standalone tabs now live as sub-tabs (shared `ViewTabs` strip): **Network** under Outreach, **Score Trend** under Trends, and the Configuration editor (Identity / Target Roles / Portals) under Settings.
- **Network** — the warm-outreach lens: the roster from `data/network.md`, per-company recommended plays (the `outreach-plan` decision ladder), cadence on open `data/outreach.md` threads, and apply-worthy coverage gaps, all derived in the Electron main process by the same pure cores the CLIs use (`scripts/lib/network-lens-core.mjs`).
- **Database** — the universal lens, with a `liveness` filter (active <14d / stale 14–90d / closed >90d) derived from `data/scan-history.tsv`.
- **Pipeline** — the application-status Kanban + Inbox.

**Cross-linking.** Every entity is keyed by `company + role`. Clicking a Database row opens an action popover (View report · Apply · Tailor CV · Prep Application · Open URL · Mark not interested); the Reports slide-over has two tabs (Scouting report / Application prep), greyed out when the file isn't on disk.

**Apply / Status writebacks.** The Apply button (popover and slide-over) and the inline status dropdown write directly to `data/applications.md` from the renderer — appending a row on first Apply, then rewriting the matching row's `Status` cell on each change. `upsertApplicationRow` in `frontend/src/lib/applicationsDoc.ts` refreshes an existing (company, role) row in place instead of appending a duplicate. The chokidar watcher resyncs the cache automatically.

**Themes.** The app ships switchable colour themes (Settings › General › Appearance; default Blue hour). How it fits together:
- `frontend/src/app/themes.css` holds every colour value: one `[data-palette="<id>"]` block per theme, each defining the same role tokens (`--c-accent`, `--c-text-3`, `--c-nav-bg` …) as sRGB triplets. The default theme's block also matches `:root`.
- `frontend/tailwind.config.ts` maps each role to a class (`rgb(var(--c-accent) / <alpha-value>)`) and replaces Tailwind's default palette, so `bg-gray-100` and friends do not exist. `frontend/src/lib/themes.ts` is the registry (`PALETTES`, the token lists, `themeColor()`); `lib/tier.ts` builds the score/tier colours on it.
- `app/layout.tsx` runs `PALETTE_BOOT_SCRIPT` in `<head>` to set `data-palette` on `<html>` from `localStorage['starpath.palette']` before first paint; `store/palette.ts` changes it. Onboarding pins `data-palette="galaxy"` locally.
- Guards in `npm test`: `src/lib/themes.test.ts` (every theme defines exactly the token set, contrast pairs pass) and `src/lib/colorLiterals.test.ts` (no raw colours or off-scale opacity modifiers outside `themes.css` and a short allowlist).
- **Adding a theme:** copy a block in `themes.css` and change its values; add `{ id, name, description, swatches }` to `PALETTES`; run `npm test` (fails until every token is set and readable); screenshot Scout, Database, Applying and Settings in the new theme. **Adding a colour role:** add it to every block, to `CHANNEL_TOKENS` (or `FULL_TOKENS`) and to `tailwind.config.ts`, and document it in DESIGN-meta.md § 2.

**Cache.** The app mirrors `data/*` and `reports/**` (resolved through the data root) into a SQLite cache at `{userData}/cache-<profile>.db` (`cache-default.db` without profiles, `cache-demo.db` for the demo). It is fully derived from the Markdown/TSV files and rebuilds on launch via mtime comparison + a chokidar watcher. Markdown/TSV remain canonical; backend modes never read or write the cache.

## Tracker TSV

One file per evaluation at `batch/tracker-additions/{num}-{company-slug}.tsv`, a single line of 10 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\tW{want} E{ease}\t{pdf_emoji}\t{deadline}\t[{num}](reports/tier-{N}/{num}-{slug}-{date}.md)\t{note}
```

Column order (**status before score** in the TSV): `num`, `date`, `company`, `role`, `status` (canonical, e.g. `Evaluated`), `score` (`W8.3 E5.6`; legacy `X.X/10` cells on old rows stay valid), `pdf` (`✅`/`❌`), `deadline` (`2026-06-30` | `Rolling` | `n/d`), `report` (markdown link to `reports/tier-{N}/...`, where `N` is the tier assigned by `scripts/score-listing.mjs` — from the Want × Ease verdict grid in `docs/scoring-v2.md` § 4, never re-derived by hand), `notes`.

In `applications.md` score comes BEFORE status: `scripts/merge-tracker.mjs` swaps the columns and rewrites flat `reports/...md` paths into the right tier subfolder if the writer left the tier off. The canonical TSV form is the tiered path.

Scouting writes 12-column TSVs to `batch/scouting-additions/` instead — see `modes/scouting.md` § Tracker Entry.

## System layer hygiene

This checklist is for **public** files. Anything specific to the user belongs in `private/` instead: data in `user/profile.yml`, wording in `private/overrides/`, notes in `private/docs/`, so no personal content ever needs to be rewritten into a generic example. The Data Contract is necessary but not sufficient. Public files leak user data through *examples and defaults* even when no one set out to write user-specific content. Before committing any change to `modes/*`, `scripts/*`, `templates/*`, `frontend/*`, or `CLAUDE.md`/`AGENTS.md`, run this checklist. (`scripts/lib/hygiene-guard.mjs` catches part of it automatically.)

**Anti-patterns to refuse:**
- **Worked examples that name the user's actual schools, projects, or proof points.** *"Your Northfield MSc + dual-degree + Acme Bank capstone read as 'top-tier academic equivalent'"* (fictional names standing in for a real CV) hardcodes one user's CV into every agent's reasoning template. Use generic placeholders ("your top-school MSc", "your main capstone project") and tell the agent to substitute from `user/cv.md` at evaluation time.
- **Hardcoded default lists in scripts.** `const DEFAULT_X = ['McKinsey', 'BCG', ...]` ships one user's preferences as the silent fallback for everyone. Default to `[]` (fail-closed) and require the caller to pass calibration data; document the expected source in `user/profile.yml` or `user/_profile.md`.
- **Hardcoded conditional logic against a specific company.** `if (company === 'Google') value += 1.0` bakes one user's dream-company override into system code. Express it as data (`extra_brand_bonuses: [{company, bonus, reason}]`) and let the data live in `user/profile.yml`.
- **Examples that name a specific city/country/nationality as the canonical case.** Frontend placeholders ("Barcelona, Spain") and rule examples ("for an EU citizen…") read as "the system assumes this profile". Use `City, Country` placeholders; describe rules in terms of the candidate's `visa_status` / `preferred_cities` / etc., not in terms of one user's specific values.
- **Hardcoded specific dates or timelines.** *"Your Northfield Master starts Sep 2031"* in a system mode example dates the file. Use generic phrasing ("your next degree program starts before this role's start window") and let the actual dates flow from `user/cv.md`.
- **Listing companies/schools/archetypes inline as if they're system defaults.** A reference table in a system file is fine ONLY if it covers the universal landscape (e.g., the school-region map covers ~20 European business schools), not if it lists one user's targets.

**What stays in the system layer (legitimate references):**
- Generic reference data (full school-region tables, full city→country mappings, the canonical CEMS Corporate Partner list).
- Test fixtures with concrete inputs (`base: 30000, city: "Barcelona"` in test-all.mjs is fine — it's exercising the rubric, not setting a default).
- Mode prose that talks ABOUT user data (`"read user/cv.md § Education"`) rather than embedding it.
- Backward-compat aliases when renaming a calibration field, so existing user data still flows.

**When the system layer NEEDS a concrete example,** prefer fictional/illustrative cases ("a candidate with X background applying to Y") over the current user's actual case. Worked examples are templates — they should model the *pattern*, not the *person*.

## Conventions

- Stack: Node.js (`.mjs` modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV).
- Output in `output/` (gitignored); reports in `reports/tier-{N}/`; JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md); batch work in `batch/` (gitignored except scripts and prompt).
- Report naming: `{Company} - {Role}.md` (human-readable, no sequential numbering in filenames).
- Canonical status meanings (`templates/states.yml` is the source of truth): `Evaluated` report done, pending decision · `Applied` sent · `Responded` company responded · `Interview` in process · `Offer` received · `Rejected` by company · `Discarded` by candidate or offer closed · `SKIP` doesn't fit, don't apply.

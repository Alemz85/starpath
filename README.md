# Starpath

A local-first AI job-search workspace — a desktop app, a markdown-driven evaluation engine, and a small fleet of Claude Code skills working together.

You scan job portals, score every listing across ten dimensions, get tier-bucketed reports, track applications across a kanban, reach out to contacts, and watch your trajectory in dimensional trends — all running on your own laptop, against your own data, with your own Claude account doing the heavy lifting.

> Started as a fork of [`santifer/career-ops`](https://github.com/santifer/career-ops); now an independent project that's diverged in scope and direction.

---

## What it does

- **Scout the market.** Hit Greenhouse / Ashby / Lever / SmartRecruiters / Workday APIs across companies you care about, plus Indeed and Google Jobs via a [JobSpy](https://github.com/speedyapply/JobSpy) aggregator that runs in parallel. Everything gets filtered by your title rules and triaged into Tier 1–4 against a calibrated dimensional rubric.
- **Score honestly.** Every listing gets a 1–10 score across 10 dimensions (Skills, Ease of Entry, Strategic Fit, Growth, Optionality, Brand, WLB, Salary, etc.) with JD-grounded reasoning you can audit.
- **Generate tailored CVs and applications.** When you decide to apply, the same workspace tailors a CV to the JD and drafts the application form answers from your CV + profile.
- **Track applications.** Drag-and-drop kanban (Evaluated → Applied → Responded → Interview → Offer) with persisted writebacks to `data/applications.md`.
- **Manage outreach.** Draft referral and LinkedIn messages, track sent threads, and get nudge reminders when a thread goes cold.
- **Know what to do next.** The Today cockpit aggregates deadlines, due follow-ups, outreach nudges, and fresh high-fit hits into one ranked action list — no tab scanning needed.
- **See your trajectory.** Time-series of how your scores trend per dimension. Top companies (with logos), top locations (with country flags), top archetypes — at a glance.
- **Calibrate continuously.** The calibration advisor checks whether your scoring rubric (dream companies, comp targets, brand bonuses) still matches the evidence in your data, and suggests concrete edits to your profile.
- **Stay in control.** Quality over quantity is wired into the system: a relevance gate filters off-archetype listings *before* scoring, the rubric demands JD-quoted evidence, and the app never auto-submits an application.

---

## How it works

There are three pieces:

| Piece | What it is | Where it lives |
|------|-----------|----------------|
| **Markdown data layer** | Your CV, profile, target roles, scored evaluations, full reports — plain markdown / TSV. Human-editable, gitignored. | `user/`, `data/`, `reports/` |
| **Claude Code engine** | A set of skills (`modes/scouting.md`, `modes/apply.md`, `modes/interview-prep.md`, etc.) that read the data layer and write back. Spawned via the `claude` CLI. | `modes/`, `.claude/skills/`, `scripts/` |
| **Starpath desktop app** | Electron + Next.js GUI. Reads the markdown for display, kicks off Claude runs, watches files via chokidar, mirrors them into a fast SQLite cache for filtering and trends. | the DMG in [Releases](../../releases) (and `frontend/` for source) |

The markdown files are the source of truth. The app is a fancy reader and a thin scribe. Claude Code is the brain.

---

## Quick start

Prerequisites:

- **Mac with Apple Silicon (M1+)** — the DMG is arm64-only. Intel Mac is not shipped; if you're on an Intel Mac you can rebuild locally from source (`cd frontend && npm install && npm run package`).
- **[Claude Code](https://claude.ai/download)** installed and logged in (`claude login`). The desktop app shells out to the `claude` CLI for every AI run; without it, nothing runs.
- **A free folder** somewhere on disk to put the workspace.

### 1 — Get the workspace

```bash
git clone https://github.com/Alemz85/starpath.git
cd starpath
```

That's it. Don't run `npm install` here — you don't need to.

### 2 — Get the app

Download from the [Releases page](../../releases):

- **`starpath-AppleSilicon-Mac.dmg`** — for M1 / M2 / M3 / M4 Macs (2020 onward)

Intel Mac is not shipped — rebuild locally if needed (`cd frontend && npm install && npm run package`).

Open the DMG, drag **starpath** to Applications. First launch: right-click → Open (the build is unsigned, so Gatekeeper warns you the first time only).

### 3 — Point the app at the workspace

On first run, click **Choose folder** and pick the folder you cloned in step 1 (the one containing `CLAUDE.md`, NOT the `frontend/` subfolder).

You can put the cloned repo anywhere — Desktop, Documents, `~/code`, wherever. The app remembers the path across launches and you can change it from Settings → Repository.

The onboarding wizard walks you through:

1. Pasting your **CV** (or a LinkedIn URL if you'd rather)
2. Filling in your **profile** (name, target roles, comp range, languages, dream companies)
3. Configuring **portals** (which companies to scan, which keywords to filter on)

When the wizard finishes it runs the `career-ops-setup` skill once — Claude reads your CV + profile and generates personalized title-filter keywords + a candidate-context file (`user/_profile.md`) that downstream evaluations draw from. Takes a couple of minutes the first time.

### 4 — Use it

The sidebar is split into three tiers — primary (workflow stage), secondary (read-only data lenses), and bottom (your config):

**Primary**
- **Today** — a single ranked action list: deadlines coming up, follow-ups due, outreach nudges, and fresh high-fit hits from the last scan. The quickest answer to "what should I work on now?" Badge shows the number of critical/high items.
- **Scouting** — landscape inventory. *Filter to Database* scores every URL in the inbox. *Top Reports* generates full prose reports for the top 8. Full Scan and API Only buttons fire the JobSpy aggregator (Indeed + Google) in parallel alongside the ATS scanner.
- **Applying** — kanban for active applications. Drag cards across columns (Applied → Responded → Interview → Offer) to update status. Paste new URLs into the Inbox to fast-track them.
- **Outreach** — manage referral and LinkedIn threads. Track sent messages, log replies, and see at a glance which contacts are due a nudge.

**Secondary**
- **Database** — every scored listing in one filterable, searchable table. Filterable by tier, liveness (active / stale / closed), archetype, location, min score. Click any row for the action menu (View report / Apply / Tailor CV / Prep interview / Open URL / Discard). Includes a **Fixability** column: near-miss listings show the cheapest lever to push their score to the next tier.
- **Reports** — every full prose report. Sortable by score, date, tier, or fixability. Click any to open the slide-over with the dimensional table + Fit/gaps + Verdict + Path forward. Reports are decorated with a fixability badge when a score upgrade is within reach.
- **Trends** — time-series of your dimensional scores + top companies / locations / archetypes panels.
- **Activity** — the live log for every Claude run happening anywhere in the app (scans, evaluations, tailoring, company research, etc.).

**Bottom**
- **Profile** — read-only career-constellation view of your CV, archetypes, and proof points.
- **Configuration** — edit identity, comp, languages, target roles, portals.
- **Settings** — repository path, model picks, and other app-level toggles.

---

## Skill modes

Claude Code skills are the evaluation and action engine. Each maps to a markdown file under `modes/` loaded as a Claude skill.

| What you want to do | Mode | Notes |
|---------------------|------|-------|
| Evaluate a listing (paste JD or URL) | `scouting` | Tier 1–4 report: header + dimensional table + role summary + gaps + comp + recommendation + career path impact |
| Holistic career review across all data | `positioning` | Mines `data/score-history.tsv`; produces targeting intelligence |
| Compare 2+ live offers | `ofertas` | End-of-funnel decision engine; reuses the same scoring math as scouting |
| Draft outreach (referral / LinkedIn) | `contacto` | Find the right contact, draft a message worth reading, log the thread |
| Draft a reply to a recruiter message | `respond` | Grounds the reply in your CV, profile, and negotiation scripts; always stops before send |
| Deep-dive on a company | `deep` | Produces `data/companies/{slug}.md` — a structured artifact consumed by interview-prep and contacto |
| Prep for interview / draft application content | `interview-prep` | Writes `interview-prep/{Company} - {Role}.md`; mines and extends the STAR story bank |
| Generate tailored CV / PDF | `pdf` | Tailors `templates/cv-template.html` to the JD; renders via Playwright |
| Evaluate a course or certification | `training` | ROI verdict grounded in your measured dimension drag; not in the abstract |
| Evaluate a portfolio project | `project` | Maps the project to your target archetypes and proof-point gaps |
| Check application status | `tracker` | Reads `data/applications.md` |
| Fill out an application form | `apply` | Always stops before submit |
| Scan for new listings | `scan` | Runs ATS + JobSpy scrapers; zero token cost |
| Process the pending URL inbox | `pipeline` | Scores every URL in `data/pipeline.md` |
| Batch-evaluate many listings | `batch` | `claude -p` workers; headless |
| Diagnose rejection patterns / improve targeting | `patterns` | Mines `data/score-history.tsv` and `data/applications.md` |
| Review follow-up cadence | `followup` | Which threads need action |
| Check deadlines and urgency | `deadlines` | Which open roles are closing soon |
| Browse all evaluated offers as a table | `db` | CLI query interface to the scored landscape |
| CV vs. target-landscape gap analysis | `cv-gap` | Compares `user/cv.md` against the recurring demand across all evaluated roles |
| Scoring calibration check | `calibrate` | Are your dream-company bonuses, comp targets, and scoring weights still accurate? |

---

## npm run scripts

All scripts are in `scripts/`. Run them from the repo root:

| Command | What it does |
|---------|-------------|
| `npm run doctor` | End-to-end health check: file presence, YAML validity, pipeline consistency |
| `npm run verify` | Verify `data/applications.md` — status consistency, missing URLs, canonical states |
| `npm run normalize` | Normalize non-canonical status values in `data/applications.md` |
| `npm run dedup` | Deduplicate `data/applications.md` by company + role |
| `npm run merge` | Merge pending `batch/tracker-additions/*.tsv` into `data/applications.md` |
| `npm run pdf` | Generate a PDF from the tailored HTML CV (`output/cv.html` → `output/cv.pdf`) |
| `npm run ats-coverage` | Check CV keyword coverage against a single JD |
| `npm run sync-check` | Check CV sync state: are all proof points in `user/cv.md` reflected in evaluated reports? |
| `npm run cv-gap` | CV vs. landscape gap analysis (keyword gaps, weak proof points, dimension drag) |
| `npm run story-bank` | Audit `interview-prep/story-bank.md` — coverage across archetypes and dimensions |
| `npm run liveness` | Check which tracked listings are still live (Playwright-based) |
| `npm run research` | Company research CLI: `check`, `path`, `list --stale` (wraps `scripts/lib/company-research-core.mjs`) |
| `npm run scan` | Run the ATS portal scanner (Greenhouse / Ashby / Lever / SmartRecruiters / Workday) |
| `npm run compare-offers` | Compare two or more offers side-by-side (CLI wrapper for `modes/ofertas`) |
| `npm run calibrate` | Run the scoring-calibration advisor |
| `npm run whats-new` | Fresh-hit digest: what's new and worth your time since the last scan |
| `npm run brief` | Daily "what should I do now?" brief (deadlines + follow-ups + outreach + fresh hits) |
| `npm test` | Unit tests for all `scripts/**/*.test.mjs` files |
| `npm run test:all` | Full test suite including integration fixtures |

---

## What the DMG contains vs. what the repo contains

Worth understanding once so the layout makes sense:

- **The repo** has the source code for everything: the modes (`modes/*.md`), the scan/merge scripts (`scripts/*.mjs`), the GUI source (`frontend/src/`), and the empty templates for `user/` and `data/`.
- **The DMG** has the compiled and bundled version of the GUI (about 160MB — most of which is an embedded Chromium runtime). It does NOT contain the modes or scripts; those live in the cloned repo.

When the app launches it reads `modes/`, `scripts/`, and `.claude/skills/` directly from the folder you pointed it at. Every Claude run is a `claude -p '@<your-folder>/.claude/skills/...'` spawn against your repo. Both pieces are needed: the repo for the brain, the DMG for the GUI.

The `frontend/` folder in the repo only matters if you want to modify the GUI itself. Day-to-day users never touch it.

---

## Updating

```bash
cd starpath
git pull
```

Picks up new modes, scripts, and rubric tweaks. **It will not touch your `user/` or `data/` files** — those are gitignored.

When a new app build ships, download the new DMG from Releases and drag it over the old one in Applications.

---

## For developers

If you want to modify the GUI and rebuild the DMG, see [`frontend/README.md`](frontend/README.md).

If you want to modify the evaluation modes, edit the markdown files under `modes/`. They're loaded by name as Claude skills — no rebuild needed unless you're also touching the frontend.

Other technical READMEs:

- [`frontend/README.md`](frontend/README.md) — Electron + Next.js setup, dev/build commands, app architecture
- [`batch/README.md`](batch/README.md) — parallel batch processing via `claude -p` workers
- [`templates/README.md`](templates/README.md) — system-layer templates (CV HTML template, example configs)
- [`templates/user-examples/README.md`](templates/user-examples/README.md) — blank `user/*` files for filling in manually with Claude chat (instead of the desktop app's onboarding wizard)

For the data contract (what's user-layer, what's system-layer, what's safe to auto-update), see [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

---

## Acknowledgements

starpath started as a fork of [`santifer/career-ops`](https://github.com/santifer/career-ops). The mode-driven evaluation pattern, the data contract concept, and the original scoring rubric all originate there. The project has since diverged substantially — the desktop GUI, the hybrid scoring engine, the entity model, the parallel JobSpy aggregator, the SQLite cache, and most recent direction are starpath's. Upstream is no longer tracked.

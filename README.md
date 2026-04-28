# Starpath

A local-first AI job-search workspace — a desktop app, a markdown-driven evaluation engine, and a small fleet of Claude Code skills working together.

You scan job portals, score every listing across ten dimensions, get tier-bucketed reports, track applications across a kanban, and watch your trajectory in dimensional trends — all running on your own laptop, against your own data, with your own Claude account doing the heavy lifting.

> Built on top of [`career-ops`](https://github.com/santifer/career-ops) by [santifer](https://santifer.io). Same data contract, same modes, with a desktop GUI on top.

---

## What it does

- **Scout the market.** Hit Greenhouse / Ashby / Lever / SmartRecruiters / Workday APIs across companies you care about, filter by your title rules, and triage the candidates into Tier 1–4 based on a calibrated dimensional rubric.
- **Score honestly.** Every listing gets a 1–10 score across 10 dimensions (Skills, Ease of Entry, Strategic Fit, Growth, Optionality, Brand, WLB, Salary, etc.) with JD-grounded reasoning you can audit.
- **Generate tailored CVs and applications.** When you decide to apply, the same workspace tailors a CV to the JD and drafts the application form answers from your CV + profile.
- **Track applications.** Drag-and-drop kanban (Evaluated → Applied → Responded → Interview → Offer) with persisted writebacks to `data/applications.md`.
- **See your trajectory.** Time-series of how your scores trend per dimension. Top companies (with logos), top locations (with country flags), top archetypes — at a glance.
- **Stay in control.** Quality over quantity is wired into the system: a relevance gate filters off-archetype listings *before* scoring, the rubric demands JD-quoted evidence, and the app never auto-submits an application.

---

## How it works

There are three pieces:

| Piece | What it is | Where it lives |
|------|-----------|----------------|
| **Markdown data layer** | Your CV, profile, target roles, scored evaluations, full reports — plain markdown / TSV. Human-editable, gitignored. | `user/`, `data/`, `reports/` |
| **Claude Code engine** | A set of skills (`modes/scouting.md`, `modes/oferta.md`, etc.) that read the data layer and write back. Spawned via the `claude` CLI. | `modes/`, `.claude/skills/`, `scripts/` |
| **Starpath desktop app** | Electron + Next.js GUI. Reads the markdown for display, kicks off Claude runs, watches files via chokidar, mirrors them into a fast SQLite cache for filtering and trends. | the DMG in [Releases](../../releases) (and `frontend/` for source) |

The markdown files are the source of truth. The app is a fancy reader and a thin scribe. Claude Code is the brain.

---

## Quick start

Prerequisites:

- **Mac with Apple Silicon (M1+)** — the DMG is arm64-only. Intel Mac users need to rebuild from source (see `frontend/README.md`).
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
- **`starpath-Intel-Mac.dmg`** — for older Intel Macs

Not sure which you have? Apple menu → About This Mac. "Chip: Apple M…" means Apple Silicon; "Processor: Intel…" means Intel.

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

- **Scouting tab** — *Filter to Database* scores every URL in the inbox. *Top Reports* also generates full prose reports for the top 8.
- **Database tab** — every scored listing in one filterable table. Click any row for the action menu (View report / Apply / Tailor CV / Prep interview / Open URL / Discard).
- **Reports tab** — every full prose report. Click any to open the slide-over with the dimensional table + Fit/gaps + Verdict + Path forward.
- **Applying tab** — kanban for active applications. Drag cards across columns to update status. Inbox at the top for pasting new URLs.
- **Trends tab** — time-series of your dimensional scores + top companies / locations / archetypes panels.
- **Configuration tab** — edit identity, comp, languages, target roles, portals.
- **Activity tab** — the live log for every Claude run happening anywhere in the app.

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

Built on [`santifer/career-ops`](https://github.com/santifer/career-ops). The mode files, scoring framework, and data contract are upstream's. Starpath adds the desktop GUI and a few of its own opinions about how an honest scoring system should work.

Pull upstream changes:

```bash
git remote add upstream https://github.com/santifer/career-ops.git   # one-time
git fetch upstream
git merge upstream/main
```

# Data Contract

Three layers. The public repo holds the first two; the third never enters it.

| Layer | Where | Public? | Who changes it |
|-------|-------|---------|----------------|
| **System** | `modes/`, `scripts/`, `templates/`, `batch/` prompt + runner, `frontend/`, `docs/`, `CLAUDE.md`, `AGENTS.md` | yes, generic | releases / anyone changing the default for everyone |
| **Demo** | `demo/` | yes, fictional | `npm run demo:build` (generated, never hand-edited) |
| **Private** | `private/` | **never** | you and your agents |

## Private layer — `private/`

Everything personal lives in one folder at the repo root. The public repo ignores it fail-closed (`.gitignore`: `/private/` plus every link path, no `!` re-includes). It is **its own git repository** with its own private remote, so it gets history and backup without touching the public repo: `npm run backup` commits and pushes it. `npm run private -- init` creates it and moves an existing checkout's personal folders in; `npm run private -- status` and `npm run doctor` check it.

The repo-root paths below are **links into `private/`**, so every path in the modes, scripts and app keeps working, and anything written to them lands in `private/`.

| Path (link at the repo root) | Lives at | What |
|------|---------|------|
| `user/` | `private/user/` | `cv.md`, `profile.yml` (identity, targets, eligibility, scoring weights, calibration), `_profile.md` (archetypes, narrative, negotiation scripts), `portals.yml`, `article-digest.md` |
| `data/` | `private/data/` | trackers (`applications.md`, `scouting.md`, `pipeline.md`), histories (`scan-history.tsv`, `score-history.tsv`), `dedup-index.tsv`, `report-summaries.tsv`, `network.md`, `outreach.md`, `follow-ups.md`, `companies/` dossiers, the location caches (`col-cache.tsv`, `tax-cache.tsv`, `comp-cache.tsv`), `career-memory.md`, `agent-log.tsv`, `session-handoff.md`, `agent-messages.jsonl` (agent → user Messages), archives |
| `reports/` | `private/reports/` | evaluation reports (`tier-1..4/`), `positioning/`, `briefs/` |
| `interview-prep/` | `private/interview-prep/` | `story-bank.md`, per-listing prep |
| `output/` | `private/output/` | generated CVs and PDFs |
| `jds/` | `private/jds/` | saved job descriptions |
| `batch/tracker-additions/`, `batch/scouting-additions/`, `batch/logs/`, `batch/jobspy-merged/`, `batch/batch-state.tsv`, `batch/batch-input.tsv`, `batch/cv-summary.md` | `private/batch/…` | batch and evaluation working state |

Only inside `private/` (no repo-root link):

| Path | What |
|------|------|
| `private/profiles/` | multi-profile store when initialised (`profiles/<slug>/…`, `profiles/active`); see CLAUDE.md § Profiles |
| `private/chat/` | the desktop app's chat sessions |
| `private/overrides/` | your versions of system files (below) |
| `private/docs/` | personal docs and notes about your search |
| `private/leak-terms.txt` | extra terms for the leak gate (people, addresses…), one per line |
| `private/.cache/` | derived files (composed prompts, migration manifests); not committed |

Local-only files outside `private/`: to-do notes of any name (`TODO.md`, `*todo*.md`) are gitignored where they are. The app's SQLite cache and logo cache live in the OS app-data folder and are fully derived.

## Overrides — specific instead of generalised

A file at `private/overrides/<repo path>` **replaces** the repo default; `private/overrides/<path minus .md>.append.md` is **added after** the default (or after the replacement). Overridable: `modes/*.md` (incl. `_shared.md` and `chat.md`), `batch/batch-prompt.md`, `templates/*`, `config/profile.example.yml`, `.claude/skills/career-ops*/SKILL.md`.

Claude sessions read overrides first (the `career-ops` router and CLAUDE.md say so; a SessionStart hook lists the active ones), the app and the batch runner pass the composed prompt to spawned workers, and scripts resolve system files through `scripts/lib/overrides.mjs`. `npm run overrides` lists them and warns when a repo default changed after your copy.

## System layer

Generic, auto-updatable, safe to replace with the latest upstream version. No personal values in any file, example, fixture or commit message (CLAUDE.md § Public Repo). Key files:

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/*.md` | One file per mode (scouting, positioning, pdf, scan, batch, apply, contacto, deep, ofertas, pipeline, project, tracker, training, patterns, followup, chat, …) |
| `batch/batch-prompt.md`, `batch/batch-runner.sh` | Batch worker prompt and orchestrator |
| `scripts/*.mjs`, `scripts/lib/*` | Utility scripts and their pure cores |
| `templates/*` | CV template, canonical states, user-file examples |
| `config/profile.example.yml` | Profile template copied at onboarding |
| `frontend/*` | The starpath desktop app |
| `.claude/skills/*`, `.claude/settings.json` | Skill definitions; SessionStart hook |
| `.githooks/*` | Leak gate hooks (`npm run hooks`) |
| `docs/*`, `CLAUDE.md`, `AGENTS.md`, `DATA_CONTRACT.md` | Documentation and agent rules |

## Demo layer

`demo/` mirrors the private layout with a fictional persona, fictional companies and neutral cities, generated by `scripts/demo/build-demo.mjs` through the real scoring engine. The app shows it read-only when you pick "Explore the demo" at onboarding or switch it on in Settings. Tests check it parses and contains no term derived from `private/`.

## The rules

- **No update process reads, modifies or deletes anything in `private/`.**
- **System and demo files can be replaced with the latest upstream version at any time.**
- **Nothing from `private/` is ever copied into a system or demo file.** The leak gate enforces it on every commit and push.

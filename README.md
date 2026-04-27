# Starpath

Private career operations system. Built on [career-ops](https://github.com/santifer/career-ops).

## What this is

AI-powered job search pipeline: offer evaluation, CV generation, portal scanning, application tracking, and workspace auto-tuning — all running locally through Claude Code.

## Stack

- **Modes** (`modes/`) — Claude skills for evaluating offers, scouting, pipeline, CV generation, and more
- **Scripts** (`scripts/scan.mjs`, `scripts/generate-pdf.mjs`, etc.) — zero-token scanners and automation
- **Frontend** (`frontend/`) — Electron + Next.js desktop app
- **User data** (`user/`) — CV, profile, portals config — gitignored, never committed

## Setup

1. Clone and install: `cd frontend && npm install`
2. Run dev: `npm run dev` (in one terminal) + `npm run electron` (in another)
3. Package: `npm run package` → outputs to `frontend/dist/`

## User files (gitignored)

These live locally only and are never pushed:

| File | Purpose |
|------|---------|
| `user/cv.md` | Source CV |
| `user/profile.yml` | Target roles, comp, location |
| `user/portals.yml` | Companies and keyword filters for scanning |
| `user/_profile.md` | Extended candidate context for Claude |
| `data/applications.md` | Active application tracker |
| `data/pipeline.md` | Pending URL inbox |

## Upstream

Based on [santifer/career-ops](https://github.com/santifer/career-ops). Pull upstream changes with:

```bash
git fetch upstream
git merge upstream/main
```

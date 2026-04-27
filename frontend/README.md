# starpath

The desktop GUI for [career-ops](../README.md). Electron + Next.js. Reads and lightly writes the Markdown/TSV files in the repo — Claude Code modes are canonical, this app is a viewer and minor scribe.

## Prerequisites

- A career-ops repo cloned locally (this one)
- [Claude Code](https://claude.ai/download) installed and logged in (`claude login`)
- Node.js 18+, Apple Silicon Mac (arm64-only build)

## Development

```bash
cd frontend
npm install        # postinstall rebuilds better-sqlite3 against Electron
npm run dev        # Next dev server + Electron pointed at it
```

If you ever hit a `mach-o ... incompatible architecture` error from `better-sqlite3`, your Node was running under Rosetta. Force arm64:

```bash
arch -arm64 npx electron-rebuild -f -w better-sqlite3
```

## Build

```bash
npm run package
```

Outputs `dist/starpath-0.1.0-arm64.dmg` (~163MB). The build is **arm64-only** by design — drop `x64` from `package.json → build.mac.target` if you ever need Intel.

To regenerate the app icon and DMG background from `assets/starpath_logo.svg`:

```bash
# from repo root
npx playwright install chromium  # one-time, populates root node_modules
node frontend/build-icon.mjs
```

## Install

1. Open `dist/starpath-0.1.0-arm64.dmg`
2. Drag **starpath** → Applications
3. Right-click → Open to bypass Gatekeeper (build is unsigned)
4. On first launch: click **Choose folder** and select your career-ops repo root (the folder containing `CLAUDE.md` — not `frontend/`). If the repo is already populated (cv.md, profile.yml, portals.yml present), the wizard auto-skips.

## App shape

Sidebar is split into a **primary** tier and a **secondary** tier separated by a divider:

| Tier | Tab | Purpose |
|------|-----|---------|
| Primary | **Scouting** | Cockpit for landscape mapping. Full Scan / API Only / Generate Reports buttons → spawn `claude -p '/career-ops <mode>'`. Activity panel streams live output. Sets `current_mode: scouting` in `user/profile.yml`. |
| Primary | **Applying** | Cockpit for active applications. Stats, active-application list with per-row Tailor CV / Draft / Prep / Report buttons + `FilesStrip` artifact indicators + status dropdown. Sets `current_mode: applying`. |
| Secondary | **Database** | Universal lens over `data/score-history.tsv`. Score-dial column, listing card with logo + role, relative dates, liveness facet (active <14d / stale 14–90d / closed) derived from `data/scan-history.tsv`. Row click → action popover. |
| Secondary | **Pipeline** | Application Kanban (Evaluated → Applied → Responded → Interview → Offer) + URL Inbox. Each card has the same per-listing actions as Applying. |
| Secondary | **Reports** | Browse `reports/tier-*/*.md`. Slide-over has `Apply` / `View in Database` / `Open URL` pills + `FilesStrip`. |
| Secondary | **Trends** | Recharts dimensional time-series across all evaluations. |
| Secondary | **Scan** | Same cockpit as Scouting's scan section, dedicated route. The sidebar Scan tab shows a spinner whenever any spawn is running anywhere in the app. |

Cross-linking spine: every entity is keyed by `company + role`. The same `<ApplyAction>` (a button → status-dropdown morph) lives in the Database popover, the Reports slide-over header, and the Applying rows. The same `<FilesStrip>` (CV / Prep doc icons) lives wherever a listing is shown.

## Stack

| Layer | Library |
|-------|---------|
| Shell | Electron 29 |
| UI | Next.js 14 (static export) + Tailwind |
| State | Zustand (`store/app.ts`, `store/data.ts`, `store/spawns.ts`, `store/nav.ts`) |
| Cache | better-sqlite3 (see `frontend/ARCHITECTURE.md`) |
| Watcher | chokidar (resyncs cache on file changes) |
| Tables | TanStack Table v8 |
| Charts | Recharts |
| Markdown | react-markdown + remark-gfm |
| Animations | Framer Motion + canvas-confetti |
| IPC | contextBridge + ipcRenderer |

## Project structure

```
frontend/
├── electron/
│   ├── main.ts                # Main process — window, IPC, spawn manager, db sync
│   ├── preload.ts              # Context bridge → typed API to renderer
│   └── db/                     # SQLite cache (schema + sync per source)
├── src/
│   ├── app/                    # Next.js routes (one page per top-level view)
│   ├── components/
│   │   ├── command-center/     # Scouting cockpit (CommandCenter.tsx, also re-exports
│   │   │                       # ActionButton / ActivityPanel / HoverDescriptionRow / pickVisible)
│   │   ├── applying/           # ApplyingView (active-applications list)
│   │   ├── pipeline/           # PipelineView (Kanban + Inbox)
│   │   ├── database/           # DatabaseView, OffersTable, FilterBar
│   │   ├── reports/            # ReportsView, ReportSlideOver
│   │   ├── trends/, scan/, settings/, profile/
│   │   ├── onboarding/         # Gate + 5-step wizard + TailoringScreen
│   │   ├── layout/             # AppShell, Sidebar
│   │   └── shared/             # ApplyAction, FilesStrip, RowActionPopover, Logos,
│   │                           # FacetSidebar, CompanyLogo, CmdK
│   ├── lib/                    # ipc.ts, parsers (yaml, tsv, markdown), utils
│   └── store/                  # Zustand stores
├── assets/                     # icon.icns, dmg-background.png, starpath_logo.svg, claude-ai-icon.svg
├── build-icon.mjs              # Icon + DMG background generator (Playwright + sips/iconutil)
└── package.json
```

## Data ownership

The app reads and writes directly to the repo folder you point it at. Nothing lives inside the app bundle. Files the app touches:

| File | App reads | App writes |
|------|-----------|------------|
| `user/cv.md`, `user/profile.yml`, `user/portals.yml` | yes | only via the onboarding wizard |
| `user/profile.yml → current_mode` | yes | yes — flipped when you click Scouting / Applying tabs (`scouting` ↔ `applying`) |
| `data/applications.md` | yes | yes — appends a new row on Apply, rewrites the Status cell on dropdown change |
| `data/pipeline.md` | yes | yes — Inbox panel appends URLs |
| `data/scouting.md`, `data/score-history.tsv`, `data/scan-history.tsv` | yes | no — Claude modes own these |
| `reports/**/*.md` | yes (read in slide-over) | no |

The chokidar watcher resyncs the SQLite cache on every change, so external edits (Claude modes, manual hand-edits) appear in the UI within a few hundred ms. See `ARCHITECTURE.md` for cache schema and sync details.

## Spawning Claude / scripts

The app spawns `claude -p '/career-ops <mode>'` for Claude-driven actions and `node scripts/scan.mjs` for the zero-token API scan. All spawns flow through the global registry in `store/spawns.ts`:

- Output buffers persist across view navigation — start a Full Scan, switch to Database, come back, and the stream is still filling.
- The Scan sidebar tab shows a spinner whenever anything is running.
- The Activity panel header shows the Claude logo when the running spawn's `tool === 'claude'` (a goofy loading-message overlay also pulses the Claude mark while output is empty).

stdin is closed (`stdio: ['ignore', 'pipe', 'pipe']`) so `claude -p` never waits on it.

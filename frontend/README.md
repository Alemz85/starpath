# career-ops desktop

Electron + Next.js desktop app for [career-ops](../README.md). Provides a GUI over the career-ops data files — pipeline tracking, offer database, reports, trends, portal scanning, and settings.

## Prerequisites

- [career-ops repo](https://github.com/santifer/career-ops) cloned locally
- [Claude Code](https://claude.ai/download) installed and logged in (`claude login`)
- Node.js 18+

## Development

```bash
npm install
npm run dev
```

Opens Next.js on `localhost:3000` and launches Electron pointing at it.

## Build

```bash
npm run package
```

Outputs `dist/career-ops-0.1.0-arm64.dmg` (Apple Silicon) and `dist/career-ops-0.1.0.dmg` (Intel).

To regenerate the app icon and DMG background (requires Playwright):

```bash
# from repo root
npx playwright install chromium
node frontend/build-icon.mjs
```

## Install

1. Open the `.dmg` for your Mac (arm64 = Apple Silicon, the other = Intel)
2. Drag career-ops → Applications
3. Right-click → Open to bypass Gatekeeper (unsigned app)
4. On first launch: click **Choose folder** and select your career-ops repo root (the folder containing `CLAUDE.md` — not the `frontend/` subfolder)

## Stack

| Layer | Library |
|-------|---------|
| Shell | Electron 29 |
| UI | Next.js 14 (static export) + Tailwind |
| State | Zustand |
| Tables | TanStack Table v8 |
| Charts | Recharts |
| Animations | Framer Motion |
| IPC | contextBridge + ipcRenderer |

## Project structure

```
frontend/
├── electron/
│   ├── main.ts        # Main process — window, IPC handlers, shell
│   └── preload.ts     # Context bridge — exposes typed API to renderer
├── src/
│   ├── app/           # Next.js pages (one per route)
│   ├── components/    # Views and UI components
│   ├── lib/           # ipc.ts, parsers, utils
│   └── store/         # Zustand stores (app state, data)
├── assets/            # icon.icns, dmg-background.png
├── build-icon.mjs     # Icon + DMG background generator
└── package.json
```

## Data

The app reads and writes directly to the career-ops repo folder you point it at. Nothing is stored inside the app bundle. All data lives in the repo:

- `data/applications.md` — pipeline tracker
- `data/score-history.tsv` — offer database
- `reports/` — evaluation reports
- `user/profile.yml` — your profile
- `user/portals.yml` — scan configuration

# career-ops — Engineering Context

For a new Claude instance picking up engineering work on this project. Pairs with `CLAUDE.md` (operating rules), `DATA_CONTRACT.md` (file layer split), `STRUCTURE.md` (directory tree), `DESIGN-meta.md` (frontend design system), and `frontend/ARCHITECTURE.md` (cache + IPC deep-dive). Read those first if anything below is ambiguous.

---

## What this project is

**career-ops** is an AI-powered job-search automation system built on Claude Code. Two layers:

1. **Backend.** Markdown / YAML / Node.js (`.mjs`) files that Claude Code reads and writes via the modes in `modes/*.md`. Data lives in `data/`, `reports/`, `user/`, `interview-prep/`. Scripts live in `scripts/`.
2. **Desktop frontend (`frontend/`).** An Electron app branded **starpath** that reads (and lightly writes back to) the same files. Next.js 14 renderer, Electron 29 shell, SQLite cache mirror at `{userData}/cache.db`. Markdown/TSV remain canonical — the cache is fully derived.

Originally a fork of [`santifer/career-ops`](https://github.com/santifer/career-ops); now an independent project. Root `package.json` declares `starpath` v1.0.0 (workspace tooling — not released anywhere); `frontend/package.json` declares `starpath-desktop` (the released Electron app — see that file for the current version, which drives the GitHub Releases tag).

For the directory tree, see **STRUCTURE.md**.

---

## Verification commands

Run these to verify a change before considering it done. **Working directory matters** — most frontend commands run inside `frontend/`, most backend checks run from the repo root.

| What | Command | CWD |
|------|---------|-----|
| Frontend dev (hot reload) | `npm run dev` | `frontend/` |
| Frontend production build | `npm run build` | `frontend/` |
| Frontend full package (DMG) | `npm run package` | `frontend/` |
| Renderer typecheck | `npx tsc --noEmit -p tsconfig.json` | `frontend/` |
| Electron typecheck | `npx tsc --noEmit -p tsconfig.electron.json` | `frontend/` |
| Frontend lint | `npm run lint` | `frontend/` |
| Backend test suite (60+ checks) | `node scripts/test-all.mjs` | repo root |
| Pipeline health | `node scripts/verify-pipeline.mjs` | repo root |
| Status normalize | `node scripts/normalize-statuses.mjs` | repo root |
| CV/profile sanity | `node scripts/cv-sync-check.mjs` | repo root |

`npm run dev` in `frontend/` runs Next.js dev server on `:3000` plus Electron concurrently via `concurrently`. After cloning, `npm install` triggers `electron-rebuild` for `better-sqlite3` (native addon) — re-run it manually if you switch Electron versions.

There is no separate frontend test runner. `next build` typechecks the renderer as a side effect; the electron typecheck is independent.

---

## Frontend stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 29 |
| UI framework | Next.js 14 App Router (static export to `out/`) |
| Production loader | `electron-serve` reading from `out/` |
| Language | TypeScript |
| Styling | Tailwind CSS — tokens in `frontend/tailwind.config.ts`, globals in `frontend/src/app/globals.css` |
| State | Zustand (multiple small stores under `frontend/src/store/`) |
| Tables | `@tanstack/react-table` |
| Charts | `recharts` (TrendsView), pure SVG (ProfileView sparkline) |
| Markdown | `react-markdown` + `remark-gfm` |
| Command palette | `cmdk` |
| Icons | `lucide-react` |
| Cache | `better-sqlite3` (native, `electron-rebuild`-bound) + `chokidar` watcher |
| Build | `electron-builder` → macOS DMG (arm64) + NSIS Windows installer |

### Security model

- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `sandbox: false`
- Renderer has zero direct Node.js access — every privileged operation goes through `electron/preload.ts` → `contextBridge` → `ipcMain` handlers in `electron/main.ts`.
- CSP injected via `session.defaultSession.webRequest.onHeadersReceived`. In production, `connect-src 'none'` (all network egress is the main process). Logo image fetches whitelist Clearbit, unavatar.io, Google favicons.

### App-level config

- Per-user state lives at `{userData}/config.json` (macOS: `~/Library/Application Support/starpath`).
- Stored fields: `repoPath`, `windowBounds`, `onboardingComplete`, `tailoringComplete`, `models` (per-action model preferences: `pipeline`, `tailorCv`, `draftApp`, `interviewPrep`, `generateReport`).
- Logo cache: `{userData}/logo-cache/{domain}.b64` — base64 data URLs, one file per domain, permanent.
- SQLite cache: `{userData}/cache.db` — schema in `frontend/electron/db/schema.ts`. Schema bumps drop and rebuild (safe — fully derivable from disk).

---

## IPC layer

```
Component → ipc (lib/ipc.ts) → window.electron.{method}() → preload.ts contextBridge → ipcRenderer.invoke(channel) → ipcMain.handle(channel) → main.ts
```

Every channel is invokable only from renderer to main. The two events that flow main → renderer are listener-style (`onSpawnOutput`, `onSpawnDone`, `onDbChanged`).

| Channel | Purpose |
|---------|---------|
| `app:get-config` | Returns `AppConfig` |
| `app:set-repo-path` | Persist `repoPath` |
| `app:set-onboarding-complete` | Toggle `onboardingComplete` flag |
| `app:set-tailoring-complete` | Toggle `tailoringComplete` flag |
| `app:set-models` | Persist per-action `ModelPrefs` |
| `app:select-folder` | macOS folder picker (returns `{ path, valid }` — `valid` = contains `CLAUDE.md`) |
| `app:select-cv-pdf` | macOS file picker (PDF only) for onboarding CV upload |
| `app:validate-path` | Path → `{ path, valid }` |
| `app:open-external` | Open URL in system browser |
| `app:reveal-file` | Reveal a file in macOS Finder |
| `app:check-claude` | Is the `claude` CLI installed |
| `app:check-claude-auth` | Are credentials present and valid |
| `app:run-claude-login` | Spawn `claude login` (opens OAuth browser) |
| `fs:read` | Read file relative to `repoPath` |
| `fs:write` | Write file relative to `repoPath` |
| `fs:exists` | Existence check |
| `fs:list` | `readdirSync` |
| `fs:list-recursive` | Recursive walk filtered by extension |
| `logo:fetch` | Fetch + cache logo, return base64 data URL |
| `db:applications` | Filtered application rows |
| `db:scouting` | Filtered scouting rows |
| `db:score-history` | Filtered score history |
| `db:pipeline` | All pipeline URLs |
| `db:reports` | Reports listing left-joined with score |
| `db:applications-with-scores` | Applications joined with score history |
| `db:trends` | Pre-aggregated buckets for TrendsView |
| `db:resync` | Force a full sync from disk |
| `db:rebuild` | Drop `cache.db` and rebuild |
| `db:changed` (event, M→R) | Emitted after a watcher-driven sync |
| `shell:run` | One-shot `exec` in `repoPath` |
| `shell:spawn` | Streaming `spawn`; output streams as `shell:output` events; exit as `shell:done` |
| `shell:kill` | Kill a spawned process by ID |
| `shell:output` (event, M→R) | One stdout/stderr chunk |
| `shell:done` (event, M→R) | Spawn exit code |

Logo cascade (in `logo:fetch`): Clearbit → unavatar.io → Google favicons (sz=128). First success is written to disk; `null` only if all sources fail.

---

## Data layer

Authoritative description: **`frontend/ARCHITECTURE.md`**. Summary:

- **SQLite cache** (`{userData}/cache.db`) mirrors the canonical Markdown/TSV files. Boot syncs by mtime; `chokidar` watches for in-session changes; bursts coalesce over 200ms.
- **Renderer never touches the DB directly** — only through `db:*` IPC.
- **`useDataStore` (`src/store/data.ts`)** populates from `db:*` calls on mount, then re-pulls when `db:changed` fires. `refresh()` is in-flight-coalesced; pass `{ resync: true }` to force a full rebuild from disk.
- **Two views bypass the store**: `TrendsView` calls `db.trends()`, `ReportsView` calls `db.reports()`. Everything else reads from the store.

Application writebacks are renderer → file: `useDataStore.promoteToApplication()` and `setApplicationStatus()` rewrite `data/applications.md` directly via `fs:write`, then trust the watcher to resync the DB. The bulk of state changes are still authored by Claude Code modes writing to disk.

### Stores (`frontend/src/store/`)

| Store | Role |
|-------|------|
| `app.ts` | `repoPath`, `isOnboarded`, `tailoringComplete`, `phase`, `models`, Claude install/auth status. `init()` reads `config.json` + `profile.yml`; `setPhase()` writes `phase` to `user/profile.yml` line-by-line (and migrates the legacy `current_mode` key in the process). |
| `data.ts` | All view-model data: applications, scouting, scoreHistory, pipeline, reports, liveness, scansThisMonth. Also holds `discarded: Set<string>` (keys from `data/discarded.tsv`). `discardListing()` appends to the tombstone file; views filter their rows through the set so discarded listings disappear without deleting score-history records. |
| `nav.ts` | Current `ViewId` + `databaseFilter`. Has unsaved-changes gating: when `useConfigDirty.isAnyDirty()` and the user tries to leave Configuration or Profile, the nav is captured as `pendingView` and AppShell renders `UnsavedChangesModal`. **Intentionally minimal** — see Constraints. |
| `spawns.ts` | Tracks every running spawn (scan, filter, tailor, prep) so the Activity tab can show them all. |
| `addListing.ts` | Toggles the global Add Listing modal (`open`, `prefillUrl`). Mounted at AppShell level so the Scouting CTA and CmdK can both trigger it without prop drilling. |
| `configDirty.ts`, `databaseFilters.ts`, `scanFilter.ts` | Per-view ephemeral state — keep view-local concerns out of `app.ts`. |

### Parsers (`frontend/src/lib/parsers/`)

These are pure string-in/object-out functions. They feed both the renderer (legacy paths like `parseProfileYaml`) and the electron sync layer (compiled into `dist-electron/src/lib/parsers/` via `tsconfig.electron.json`).

- `markdown.ts` — `parseMarkdownTable`, `parseScouting`, `parseApplications`, `parsePipeline`, `parseReportPath`
- `tsv.ts` — `parseScoreHistory` (full dimensional fields)
- `yaml.ts` — regex-based parser for `profile.yml`. `getPhase` / `setPhase` / `hasLegacyMode` rewrite a single key while preserving comments (also handles the legacy `current_mode` key for one-shot migration on launch). **Deliberately not js-yaml** — see Constraints.

### Core types (`frontend/src/types/index.ts`)

`ModelAlias`, `ModelPrefs`, `DEFAULT_MODEL_PREFS`, `AppConfig`, `ScoreEntry`, `ScoutingEntry`, `ApplicationEntry`, `PipelineUrl`, `ReportFile`, `ProfileConfig`, `AppStatus`, `ScoutingTier = 'T1' | 'T2-high' | 'T2' | 'T3' | 'T4'`, `TierKey`, `ENGAGED_STATUSES`, `TIER_LABELS`, `TIER_COLORS`, `STATUS_COLORS`.

T2-high is collapsed to T2 at the renderer boundary (`toScoutingEntry`, `toScoreEntry`) — backend math may use it, but the UI never sees it as a distinct tier.

---

## Views

`AppShell.tsx` mounts the data store and renders one of twelve views based on `useNavStore.view`. Sidebar groups them as **Primary** (mode-driving), **Secondary** (data lenses), and **Bottom** (settings).

| View ID | Component | Group | Purpose |
|---------|-----------|-------|---------|
| `today` | `today/TodayView` | Primary — highest-leverage next actions |
| `scouting` | `command-center/CommandCenter` | Primary — landscape mapping cockpit |
| `applying` | `applying/ApplyingView` | Primary — active-application Kanban |
| `outreach` | `outreach/OutreachView` | Primary — referral/contact tracker |
| `database` | `database/DatabaseView` | Secondary — universal table lens |
| `reports` | `reports/ReportsView` | Secondary — report grid + slide-over |
| `trends` | `trends/TrendsView` | Secondary — Recharts |
| `scan` | `scan/ScanView` | Secondary — Activity (running spawns log; legacy ID, user label is "Activity") |
| `config` | `configuration/ConfigurationView` | Bottom — pipeline / portals / modes |
| `settings` | `settings/SettingsView` | Bottom — candidate, target roles, models |
| `profile` | `profile/ProfileView` | Bottom — stats dashboard |
| `company` | `company/CompanyView` | Detail — per-company dossier, no sidebar tab |

**Primary tabs** (Today, Scouting, Applying, Outreach) reflect *workflow stage*. They do NOT change scoring behavior — that's controlled by `phase` in `user/profile.yml` and toggled separately via Settings or CmdK. Sidebar collapses 220px ↔ 56px.

The sidebar's `PRIMARY_NAV` array defines the four primary tabs; `SECONDARY_NAV` covers Database, Reports, Trends, Activity; `BOTTOM_ITEMS` covers Profile, Configuration, Settings. The sidebar computes per-tab badge counts inline: `today` shows the `actionable` count from `buildCockpitFeed`; `outreach` shows the `nudge` count from `buildOutreachBoard` (both read without the store — the outreach log is not in the SQLite cache).

**Today view** (`TodayView`) aggregates a single ranked action feed across the whole pipeline. It reads applications + scouting from the store, and `data/outreach.md` directly via `ipc.readFile` (the outreach log isn't in the SQLite cache). The pure synthesis logic lives in `lib/todayCockpit.ts`, which classifies items into four kinds (`deadline`, `followup`, `outreach`, `scouting`) and ranks by `urgencyScore`.

**Outreach view** (`OutreachView`) is the contact tracker cockpit. It reads `data/outreach.md` directly (same read path as Today). The pure parse + cadence classify lives in `lib/outreachLog.ts` (re-used by Today). The write path — appending a new touch row, amending an outcome — lives in `lib/outreachDoc.ts`. Both libs are pure string→string/data, unit-tested; the view owns I/O via `ipc.readFile` / `ipc.writeFile`.

**Applying view** (`ApplyingView`) is a Kanban. Pure bucketing (`groupByStatus`) and ordering (`compareByDeadline`) live in `lib/applyingBoard.ts`. Rejected + Discarded rows live outside the five active columns in `ClosedApplicationsPanel` (collapsible strip at the bottom).

**Add Listing modal** (`components/scouting/AddListingModal`) is a global modal mounted at AppShell level, controlled by `useAddListingStore`. It accepts a pasted URL and either queues it in `data/pipeline.md` (Inbox) or fires an evaluate-now spawn. URL normalization and dedup logic live in `lib/listingUrl.ts`.

`company` is a **detail view**, not a sidebar destination: opened by clicking a `CompanyLink` (the company logo in the Database table) or a CmdK "Companies" entry, both of which call `navigate('company', '', slug)`. The slug rides on `useNavStore.companySlug`; `companyReturnView` records where the user came from so CompanyView's "← {origin}" back button returns there. The pure per-company stat aggregation lives in `lib/companyStats.ts`. A static `app/company/page.tsx` route also exists for deep links, but in-app navigation never hits it.

`ReportSlideOver` (720px panel) animates open via `requestAnimationFrame` after a one-tick mount (`translate-x-6 opacity-0` → `translate-x-0 opacity-100`, 260ms). On close, animation runs first, then `onClose` after the timeout.

View display labels live in one place — `VIEW_LABELS` in `store/nav.ts` (consumed by AppShell's nav-guard modal, the error-boundary, and the Company back button).

---

## Frontend pure-logic libraries (`frontend/src/lib/`)

Each of these is a pure string-in / object-out module with no React, no IPC, no zustand — allowing unit testing in isolation. The view owns the I/O and wires these to the store.

| Module | Purpose |
|--------|---------|
| `todayCockpit.ts` | Aggregate the Today feed: classifies pipeline events into `deadline / followup / outreach / scouting` items, ranks by `urgencyScore`. Injectable clock. |
| `outreachLog.ts` | Parse `data/outreach.md` markdown table → per-contact cadence classify (`nudge / waiting / done / cold`). Read-only; used by Today sidebar badge + Today view. |
| `outreachDoc.ts` | Parse + write path for `data/outreach.md`. Appends touch rows and amends outcomes — mirrors the pure/tested approach of `applicationsDoc.ts`. Used by OutreachView's writeback. |
| `applicationsDoc.ts` | `upsertApplicationRow` / `updateApplicationStatus` — pure `data/applications.md` mutations. Extracted so the mutators are testable without the store. |
| `applyingBoard.ts` | Kanban bucketing (`groupByStatus`) + deadline-aware ordering (`compareByDeadline`). Injectable clock. |
| `scanHistory.ts` | `deriveLiveness`, `countScansThisMonth`, `parseDiscarded` — pure functions over `data/scan-history.tsv` + `data/discarded.tsv`. Injectable clock. |
| `entityId.ts` | Deterministic `entityId` slug builder for the unified evaluation model — stable primary key across scouting, dedup-index, and SQLite. `parseCities` for city alias normalization. |
| `tierLevers.ts` | Renderer-side fixability engine — mirrors `scripts/lib/score-bands.mjs` + `explain-score.mjs`. Computes the cheapest single-dim raise to the next tier. `filterNearUpgrades` powers the Database "Near upgrade" filter. |
| `databaseQuery.ts` | Free-text + token query parser + row predicate (`matchesTokenQuery`). Single definition used by both the visible-row pipeline and the facet-count path in DatabaseView. |
| `databaseRows.ts` | Dedupe → filter → group → faceted-count pipeline behind DatabaseView. Pure; depends on `databaseQuery`, `entityId`, `scanHistory`, `archetype`. |
| `archetype.ts` | Canonical bucket mapping: verbose archetype strings → short stable labels for Database grouping. |
| `companyStats.ts` | Aggregate per-company stats for CompanyView (eval count, best/avg score, role count). Pure over score-history rows. |
| `companyDomain.ts` | `guessDomain()` — company name → domain heuristic (exact override map → word-boundary prefix → fallback). Consumed by `CompanyLogo`. |
| `profileStats.ts` | Activity heatmap, streak, badges, highlights for ProfileView. Injectable clock. |
| `trendsAnalytics.ts` | Time-window filter + distribution aggregations for TrendsView. Extracted from the component; pure + injectable clock. |
| `reportMarkdown.ts` | Parse a `reports/tier-*/{Company} - {Role}.md` file into header metadata + dimensional table — used by `ReportSlideOver`. |
| `reportsList.ts` | Score-band classification, search/band filter, multi-key sort, facet counts, report→score-entry matcher for ReportsView. |
| `listingUrl.ts` | URL validation, normalization (dedup key), company-name hint extraction — used by AddListingModal. |
| `export.ts` | CSV/TSV export for the Database lens. Pure; download via Blob + synthetic anchor. |
| `spawnFormat.ts` | `claudeArgs()` builder + stream-json humanizer for spawned Claude processes. Extracted from `store/spawns.ts` for testability. |
| `shortcuts.ts` | Go-to navigation chords (`g`+letter) — single source for both the runtime matcher and the cheatsheet. |
| `tier.ts` | Tier color/hex helpers. |
| `utils.ts` | Shared utilities: `cn`, `slugify`, `parseDeadline`, `deadlineUrgency`, `deadlineTime`. |

---

## Design system

The renderer follows the design tokens defined in `frontend/tailwind.config.ts` and `frontend/src/app/globals.css`. **Read `DESIGN-meta.md` before adding UI** — it owns the design language (palette, typography, components, motion). Never introduce new colors/shadows/radii/type sizes outside what those two files expose; if the token you need doesn't exist, raise it before improvising.

Quick orientation:

- **Surface**: white (`bg-base #FFFFFF`) primary, soft-gray panels (`bg-panel #F1F4F7`), elevated cards (`bg-elevated #F7F8FA`), web-wash chrome (`bg-chrome #F0F2F5`).
- **Text**: dark charcoal hierarchy — `text-1 #050505`, `text-2 #1C2B33`, `text-3 #5D6C7B`, `text-4 #8595A4`.
- **Accent**: galaxy violet `accent #7C5CFF` with `accent-hover #5B3FE8`, `accent-press #4A2FC8`, `accent-soft rgba(124,92,255,0.12)`.
- **Tier palette**: `tier-1 #3D2BB5` (deep indigo, strongest) → `tier-2 #7C5CFF` → `tier-3 #A89CD9` (muted lavender) → `tier-4 #94A3B8` (faded slate).
- **Semantic**: `success #007D1E`, `warning #F7B928`, `danger #C80A28`, `info #7C5CFF`.
- **Galaxy surfaces** for dark immersive moments (onboarding splash, brand wordmark): `galaxy-deep #0A0820`, `galaxy-matte #1F1B36`, `galaxy-matte-2 #2A2548`. CSS classes `.galaxy-bg`, `.galaxy-immersive`, `.galaxy-text`, `.galaxy-border`.
- **Type scale**: `page` 22/500, `section` 16/500, `body` 13/400, `cell` 13/400, `label` 12/400, `micro` 11/600.
- **Special CSS classes** (`globals.css`): `.titlebar-drag` / `.titlebar-no-drag`, `.title-bar` (single-source-of-truth for title-row height — pt-10 clears macOS hiddenInset traffic-lights), `.shimmer`, `.suggestion-chip` (chip-appear keyframe), `.prose-report` (markdown body in slide-over), `.btn-pill`, `.btn-pill-outline`, `.frosted`, `.score-bar-track` / `.score-bar-fill`, `.range-overlay` (dual-handle slider for the database score-range facet).

---

## Build process

```bash
# Development (hot reload)
cd frontend && npm run dev
# next dev :3000 + tsc -p tsconfig.electron.json + electron .

# Production build (just compile)
cd frontend && npm run build
# next build (static export to out/) + tsc (electron main)

# Full installer
cd frontend && npm run package
# build + electron-builder → dist/ (.dmg arm64 on macOS, .exe NSIS on Windows)
```

`electron-builder` config is inline in `frontend/package.json`:

- `appId`: `com.starpath.desktop`, `productName`: `starpath`
- macOS DMG, arm64 only (Apple Silicon target)
- Windows NSIS, x64
- `asarUnpack` includes `better-sqlite3` so the native `.node` binary is available at runtime
- `files`: `dist-electron/**`, `out/**`, `assets/**`, `package.json`

---

## Company logo system

`lib/companyDomain.ts → guessDomain()` (pure + unit-tested; consumed by `shared/CompanyLogo.tsx`) does the company name → domain heuristic:

1. Exact override against a ~60-entry `OVERRIDES` map (Amazon, Google, Klarna, Revolut, Celonis, …).
2. **Word-boundary** prefix match against the same map ("Google Cloud" → google.com). The boundary guard matters: a bare letter-prefix must NOT match, or short keys hijack unrelated names ("Xero" → x.com, "Amdocs" → amd.com); those fall through to step 3 instead.
3. Fallback: strip Inc/LLC/Ltd/Corp/GmbH/AG, remove non-alphanumeric, append `.com`.

The actual fetch happens in the main process (`logo:fetch`) so no CSP applies. Cascade: Clearbit → unavatar.io → Google favicons (sz=128). Cached permanently on disk.

`CompanyLogo` UI states:
- `dataUrl === null` → loading (initials placeholder, gradient background)
- `dataUrl === ''` → permanent failure (stays on initials)
- `dataUrl = "data:..."` → renders `<img>`

The initials fallback uses a 7-color gradient palette deterministically picked by hashing the company name.

---

## Backend scripts and libs

### `scripts/lib/` — pure-logic cores

All modules are pure (no I/O, no mutation, no globals) and have paired `.test.mjs` files. The I/O wrapper (the top-level script in `scripts/`) owns file reads and calls these.

| Module | Purpose |
|--------|---------|
| `score-bands.mjs` | Canonical scoring engine: `rollupCurrentFit` / `rollupAspirationalFit` / `rollupOverall` / `assignTier`. The single source of truth for band math. |
| `calibration.mjs` | Reads calibration from `user/profile.yml` + `user/_profile.md` and applies it deterministically (brand bonuses, dream-company floors, comp adjustments). |
| `explain-score.mjs` | Scoring explainability: binding constraints, per-dim drivers, and the cheapest single-dim lever to the next tier (re-runs canonical band math, can't drift from it). |
| `scouting-core.mjs` | Parse + normalization for `data/scouting.md` (11-column format, deadline column detection). Used by merge-scouting + promote-to-applications. |
| `tracker-core.mjs` | Parse + normalization for `data/applications.md`. |
| `dedup-index.mjs` | Normalized `(company, role)` dedup key builder — same scheme used by scan.mjs and merge-scan-staging.mjs. |
| `merge-staging-core.mjs` | Pure merge math for JobSpy staging → canonical files: two-layer dedup (exact URL first, then normalized company+role). |
| `targeting-core.mjs` | Corpus-level targeting intelligence: per-archetype dimensional fingerprints, dimension drag, archetype performance. |
| `positioning-core.mjs` | Portfolio positioning synthesis: calls targeting-core + explain-score to produce per-archetype levers and the systemic binding constraint. |
| `whats-new-core.mjs` | "What's new since last scan" digest: joins scan-history with score-history to rank genuinely-new postings by fit signal. |
| `daily-brief-core.mjs` | Assembles the "what should I do now?" brief: normalizes outputs from whats-new-core + followup-cadence + outreach-core + positioning-core into one ranked markdown brief. |
| `outreach-core.mjs` | Cadence logic for `data/outreach.md`: state machine (replied/pending/timed_out) per contact, nudge-due classification. |
| `calibration-advisor.mjs` | Calibration feedback: mines score-history + applications to surface where stated calibration diverges from evidence (inert brand bonuses, misdirected floors, comp-target drift). |
| `cv-gap.mjs` | CV vs. target-landscape gap analysis: cross-JD keyword demand aggregation, weak-proof-point detection. |
| `story-bank.mjs` | Parse + selection helpers for `interview-prep/story-bank.md` (STAR+R stories). Used by interview-prep + apply modes. |
| `training-roi.mjs` | ROI math for the `training` mode: dimension-drag alignment, archetype mapping, cost vs. net-comp delta. |
| `offer-compare.mjs` | Pure offer comparison math for the `ofertas` mode. |
| `ats-keywords.mjs` | ATS keyword extraction + coverage scoring. |
| `company-research-core.mjs` | Parse + freshness check for `data/companies/{slug}.md` research artifacts (YAML frontmatter + fixed `##` sections). |
| `respond-core.mjs` | Classify recruiter-reply asks (screening Qs, comp, scheduling, take-home, soft reject) + comp/availability framing math. Used by `modes/respond.md`. |
| `scan-core.mjs` | Pure filter funnel for the portal scanner (title pos/neg, language blocklist, EU location allowlist, URL dedup). |
| `score-bands.mjs`, `cache-tsv.mjs`, `col-cache.mjs`, `comp-cache.mjs`, `tax-cache.mjs` | Scoring engine + tax/comp cache helpers. |
| `liveness-core.mjs` | Liveness classification logic (mirrors `lib/scanHistory.ts` thresholds). |

### `scripts/` — top-level CLI wrappers

Scripts with a paired `scripts/lib/` core are thin I/O wrappers (read files, call the pure core, write output). New ones since the initial doc:

| Script | Purpose |
|--------|---------|
| `daily-brief.mjs` | Assemble + emit the dated "what should I do now?" brief (composes whats-new-core + followup-cadence + outreach-core + positioning-core). |
| `whats-new.mjs` | "What's new & worth my time since last scan" digest (read-only). |
| `outreach-cadence.mjs` | I/O wrapper for outreach cadence: parse `data/outreach.md`, classify contacts, emit JSON or `--summary`. |
| `outreach-core.mjs` | (In `scripts/`, not `scripts/lib/`) — actually the I/O wrapper for outreach-core; the pure core is in `scripts/lib/outreach-core.mjs`. |
| `calibration-advisor.mjs` | Calibration feedback advisor (read-only). |
| `cv-gap.mjs` | CV vs. target-landscape gap report (read-only). |
| `company-research.mjs` | Locate + validate deep-research artifacts at `data/companies/{slug}.md`. |
| `peer-rank.mjs` | Comparative rank block: rank percentile + dimensional outliers + 3 closest comparables from score-history. |
| `score-listing.mjs` | Deterministic scoring entry point: comp computation + tax/city normalization → band assignment. |
| `ats-coverage.mjs` | Measure CV keyword coverage against a JD. |
| `probe-ats.mjs` | Probe public ATS APIs for a company list (Greenhouse/Ashby/Lever/SmartRecruiters) to identify API-trackable targets. |
| `positioning-intel.mjs` | I/O wrapper for positioning-core — corpus positioning synthesis for the `positioning` mode. |
| `respond-core.mjs` | I/O wrapper for `scripts/lib/respond-core.mjs`. |
| `respond-plan.mjs` | Builds a structured reply plan from a classified recruiter message. |
| `scan-core.mjs` | (In `scripts/`) I/O wrapper for scan-core filter logic. |
| `check-story-bank.mjs` | Health check + competency-coverage report for `interview-prep/story-bank.md`. |
| `migrate-to-entity-model.mjs` | Dry-run + apply migration to the entity model (adds `entity_id` to existing rows). |
| `rebuild-dedup-index.mjs` | Rebuild `data/dedup-index.tsv` from `data/scouting.md` + `data/applications.md`. |
| `doctor.mjs` | Setup validation — checks all prerequisites and prints a pass/fail checklist. |

---

## Modes (`modes/`)

The full mode list in `CLAUDE.md` § Skill Modes is canonical. Modes added since the initial doc:

| Mode | Purpose |
|------|---------|
| `respond.md` | Draft a recruiter/screening reply. Classifies the asks via `respond-core.mjs`, drafts grounded answers, stops before send. |
| `calibrate.md` | Scoring-calibration advisor. Mines score-history + outcomes; surfaces inert/misdirected calibration; suggests edits to `user/*` (read-only feedback, never auto-applies). |
| `cv-gap.md` | CV vs. target-landscape gap analysis. Cross-JD keyword demand + weak-proof-point audit; writes a gap report. |

---

## Data artifacts

Canonical data files are `data/`, `reports/`, `interview-prep/`, `user/`. New artifacts since the initial doc:

| File | Producer | Consumer |
|------|----------|----------|
| `data/outreach.md` | `contacto` mode (appends touch rows) + `OutreachView` (amends outcomes via `outreachDoc.ts`) | `OutreachView`, `TodayView`, sidebar badge, `outreach-cadence.mjs`, `daily-brief.mjs` |
| `data/discarded.tsv` | `useDataStore.discardListing()` (renderer writeback) | `useDataStore` (parsed on load into `discarded: Set<string>`) — views filter against this set |
| `data/companies/{slug}.md` | `modes/deep.md` (deep-research artifact) | `modes/interview-prep.md`, `modes/contacto.md`, `company-research.mjs` |
| `data/col-cache.tsv` | `col-cache.mjs` (compensation baseline cache) | `score-listing.mjs` |
| `data/tax-cache.tsv` | `tax-cache.mjs` (country tax rate cache) | `score-listing.mjs` |

---

## How to make changes

Recipes for the common change patterns. Each one lists every file you must touch — follow the list end-to-end.

### Adding a new view

1. Create the component: `frontend/src/components/{view}/{ViewName}.tsx` (use an existing view as a starting template — most views are a single file or a small directory).
2. Add the ID to the `ViewId` union in `frontend/src/store/nav.ts`.
3. Add the display label to `VIEW_LABELS` in `frontend/src/store/nav.ts`.
4. Add a `NavItem` to the appropriate group (`PRIMARY_NAV`, `SECONDARY_NAV`, or `BOTTOM_ITEMS`) in `frontend/src/components/layout/Sidebar.tsx`. Tabs are pure navigation; they do NOT change scoring behavior (that's `phase`, toggled separately).
5. Import and add the conditional render in `frontend/src/components/layout/AppShell.tsx`'s view switcher — there's one `{view === '...' && <View />}` line per view ID, and missing one means a blank canvas with no error.
6. (Optional) Add `frontend/src/app/{view}/page.tsx` re-exporting the component, so the static export includes a deep-linkable route. Most views skip this — `useNavStore` drives in-app navigation.

### Adding a new IPC channel

Five files, in this order, top of stack to bottom:

1. **Handler** in `frontend/electron/main.ts` — `ipcMain.handle('namespace:name', (_e, arg1, arg2) => …)`. Validate every input (see existing `validateString` pattern); resolve paths through `resolveRepoPath()` for any fs operation.
2. **contextBridge exposure** in `frontend/electron/preload.ts` — add a method to the `electronAPI` object: `myMethod: (a) => ipcRenderer.invoke('namespace:name', a)`.
3. **Typed wrapper** in `frontend/src/lib/ipc.ts` — wrap `api().myMethod()` with a typed return cast.
4. **Type augmentation** flows automatically from `ElectronAPI = typeof electronAPI` in preload — no manual sync, but verify the new method shows up in renderer typecheck.
5. **Caller** — use `ipc.myMethod(...)` in components/stores. Don't call `window.electron.*` directly; always go through the `ipc` wrapper so SSR stubs apply.

For event-style channels (main → renderer), follow the `shell:output` / `db:changed` pattern: `mainWindow.webContents.send(channel, …)` from main, `ipcRenderer.on(channel, listener)` returning an unsubscribe in preload, and an `onSomething` accessor in `ipc.ts`.

### Adding a new data file

The cache layer (`frontend/electron/db/`) is the heavy lift. For a new file `data/foo.{md,tsv}`:

1. **Type** in `frontend/src/types/index.ts` — `FooEntry` interface, plus any UI helpers (label maps, color maps).
2. **Parser** in `frontend/src/lib/parsers/{markdown,tsv}.ts` — pure string → object[] function. Same shape conventions as existing parsers.
3. **SQLite schema** in `frontend/electron/db/schema.ts` — new `CREATE TABLE foo`, indices, bump `SCHEMA_VERSION` so existing installs drop-and-rebuild on next launch.
4. **Sync function** in `frontend/electron/db/sync.ts` — read the file, run the parser, transactional `INSERT OR REPLACE`, mtime-keyed against `_meta` so it skips when unchanged.
5. **Query helper** in `frontend/electron/db/index.ts` — `queryFoo(filters)` that returns rows.
6. **chokidar watch glob** — extend the watcher pattern in `electron/main.ts` (or wherever `startWatcher` is called) so changes trigger incremental sync.
7. **IPC channel** — `db:foo` handler in `main.ts`, exposure in `preload.ts`, wrapper in `lib/ipc.ts` (under `ipc.db.foo`).
8. **DB row type** in `lib/ipc.ts` — `DbFooRow` interface mirroring SQL columns.
9. **Store integration** — add a `foo: FooEntry[]` field to `useDataStore`, pull it in `loadAll()`, write a `toFooEntry(row)` mapper.

If the file doesn't need joins or filtered queries, a simpler path is to skip the cache and read it directly via `ipc.readFile('data/foo.md')` (see how `data/outreach.md` and `data/discarded.tsv` are handled — read raw off disk, derive in-memory, no SQLite involvement).

### Adding a new mode

Modes are flat markdown files under `modes/*.md` consumed by the `career-ops` skill in `.claude/skills/career-ops/`.

1. **Mode file** at `modes/{name}.md` — start from a similar existing mode (`scouting.md`, `interview-prep.md`, `pdf.md`).
2. **Skill index** — check `.claude/skills/career-ops/SKILL.md` for any explicit list of modes; update the routing table in `CLAUDE.md` § "Skill Modes".
3. **DATA_CONTRACT.md** — add the new mode to the System Layer table.
4. **Frontend cockpit (optional)** — if the mode is invoked from a UI button, wire it via `ipc.spawn` in the relevant view (see `ApplyingView` / `ScanView` for the spawn pattern).

There are **no `modes/de/`, `modes/fr/`, `modes/ja/` directories on disk today** despite mentions in older docs. Multi-language output is handled inside the modes themselves: `modes/_shared.md` instructs Claude to "Generate content in the language of the JD (EN default)". Don't create parallel-translation directories without first confirming the routing approach with the user.

### Adding a new top-level `.mjs` script

1. **Script file** at `scripts/{name}.mjs` — Node ESM (`import` not `require`), `#!/usr/bin/env node` shebang at top, exit codes via `process.exit(N)` for CI. If the script has testable pure logic, extract it to `scripts/lib/{name}-core.mjs` with a paired `{name}-core.test.mjs`.
2. **Reference from a mode** — modes invoke scripts via the Bash tool with `node scripts/{name}.mjs ...` (see `_shared.md` § "Tools" tables for the form). Update the relevant mode file.
3. **`package.json` scripts (optional)** — add an `npm run` alias for human-friendly invocation (existing aliases: `doctor`, `verify`, `normalize`, `dedup`, `merge`, `pdf`, `sync-check`, `update*`, `liveness`, `scan`).
4. **`CLAUDE.md` "Key scripts" line** — append the new script to the inline list under "Main Files" so future Claude instances know it exists.
5. **Test coverage** — `scripts/test-all.mjs` is the project's CI surface; add a check there if the script affects pipeline integrity.

---

## Constraints / Don'ts

Implicit rules that aren't obvious from reading the code. Some come from `DATA_CONTRACT.md` and `CLAUDE.md`; others are conventions enforced by the architecture.

- **Don't import js-yaml in the renderer bundle.** The dep is in `frontend/package.json` for write-path use only; YAML parsing is deliberately regex-based (`lib/parsers/yaml.ts`) to keep the renderer bundle small. If you need full YAML round-tripping, dynamic-import it inside the function that needs it — never a top-level `import yaml from 'js-yaml'` in renderer code.
- **Don't bypass the IPC layer.** The renderer has no Node.js access (`nodeIntegration: false`). Anything that touches the filesystem, spawns a process, fetches a remote URL, or reads/writes config must go through an `ipcMain.handle` channel exposed via `preload.ts`. Don't reach for `window.require`, `process`, or `node:fs` from renderer code.
- **Don't write to user-layer files from automated/system code.** `user/`, `data/`, `reports/`, `output/`, `interview-prep/`, `jds/` are user-owned per `DATA_CONTRACT.md`. The frontend writes to a small allow-list (`data/applications.md` rows on Apply, `user/profile.yml` mode/settings fields, `data/discarded.tsv` tombstone) via well-defined helpers. Don't add new write surfaces without thinking through the contract — and never have system updates touch them.
- **Don't put user personalization in system-layer files.** `modes/_shared.md`, `modes/*.md`, `templates/*` are auto-updatable. Archetypes, narrative, negotiation scripts, scoring overrides go in `user/_profile.md` or `user/profile.yml`. See `CLAUDE.md` § "THE RULE".
- **Don't add unrelated state to `useNavStore`.** It owns `view`, `databaseFilter`, `companySlug`, `companyReturnView`, and the unsaved-changes pending-nav mechanism. View-specific state belongs in its own store (`databaseFilters`, `scanFilter`, `configDirty`) or component state.
- **Don't introduce new design tokens.** Use the colors / shadows / radii / font sizes already defined in `frontend/tailwind.config.ts` and `frontend/src/app/globals.css`. If you genuinely need a new one, update `DESIGN-meta.md` in the same change so the design language stays single-sourced.
- **Don't add SQLite-only data.** The cache is fully derivable from Markdown/TSV — schema bumps drop and rebuild. If you store something in SQLite that doesn't exist on disk, the next schema bump silently deletes it. Either add it to a canonical file or feature-flag the cache. Exception: `data/outreach.md` and `data/discarded.tsv` are read directly off disk by the renderer (not through SQLite) because they don't need joins or the filtered query layer.
- **Don't ADD entries to `data/applications.md` from a backend mode.** Write a TSV in `batch/tracker-additions/` and let `scripts/merge-tracker.mjs` merge it. Mode files may UPDATE existing rows (status, notes); the renderer's `setApplicationStatus` does the same. (Frontend Apply currently appends without dedup — see `CLAUDE.md` for the known same-role-re-eval gap.)
- **Don't trust WebSearch/WebFetch for offer liveness.** Use Playwright (`browser_navigate` + `browser_snapshot`). Batch workers in headless `claude -p` mode are exempt — they fall back to WebFetch and mark the report `**Verification:** unconfirmed (batch mode)`.
- **Don't submit applications autonomously.** Fill forms, draft answers, generate PDFs — but stop before Submit/Send/Apply. The user approves the final action.
- **Don't recommend low-fit applications.** Score < 7.0 → recommend against applying (per `modes/_shared.md` § Score interpretation). Quality over volume.
- **Don't `--no-verify` or `--no-gpg-sign` on commits.** Git safety rule from `CLAUDE.md`.

---

## Known issues / things to watch

- **Clearbit reliability.** Post-HubSpot acquisition, Clearbit returns 404 for many domains. The `logo:fetch` cascade handles it gracefully (unavatar.io / Google favicons), but some logos surface as initials.
- **Streak counter alignment.** `ProfileView` counts consecutive days in `scoreHistory` — if evaluations span midnight the day boundary may not match calendar days exactly.
- **YAML write fidelity.** `SettingsView` writes are line-by-line regex (preserves comments), not a YAML round-trip. Works for current fields but unusual formatting (multi-line scalars, anchors) could break.
- **Same-role re-evaluation.** Frontend Apply button appends a new `applications.md` row without checking for an existing `(company, role)` pair. Backend modes do dedupe; if you re-evaluate via the GUI a year later you may need manual cleanup. Tracked in `CLAUDE.md`.
- **Historical data drift.** ~35 reports predate `score-history.tsv`; scoring scale migrated 1–5 → 1–10; role-string drift causes orphan joins between `score_history` and `reports_index`. Not a bug — see auto-memory `project_data_drift.md`.
- **`data/outreach.md` and `data/discarded.tsv` not in SQLite.** These are read directly via `ipc.readFile` by the views that need them. The chokidar watcher still fires `db:changed` on any `data/*` write (it watches the whole directory), so the store's `loaded` bump triggers re-reads in the affected views. If either file grows large enough to be a rendering concern, add a `db:outreach` / `db:discarded` channel following the "Adding a new data file" recipe above.

# Frontend architecture

Electron app with a Next.js (App Router) renderer. The desktop app's job is to read, browse, and lightly edit data the user's Claude Code modes maintain in the parent repo. Claude Code is canonical; this app is a viewer and minor scribe.

## Source of truth

The Markdown/TSV files (`data/applications.md`, `data/scouting.md`, `data/pipeline.md`, `data/score-history.tsv`, `reports/**/*.md`) are canonical. Claude Code modes read and write them per the contract in the project root `CLAUDE.md`. The frontend never moves them or invents new ones. They live in the **data root** (below), not in the public tree.

## Data root

Everything personal lives in one folder, the data root: `<repo>/private/` by default (gitignored, its own private git repo), the fictional `<repo>/demo/` when the user chose the demo, or a folder named by `$STARPATH_DATA`. The repo-root `user/ data/ reports/ …` are links into `private/`, so Claude Code modes and scripts keep their repo-relative paths. The app does not rely on those links: it resolves the root itself.

**Resolution.** Main imports the repo's own `scripts/lib/data-root.mjs` at runtime (`electron/dataRoot.ts` → `importRepoModule`, the same dynamic-import pattern as the network lens; no TypeScript twin) and calls `resolveDataRoot({ repoRoot, configured: config.dataPath ?? null, env: process.env, allowDemo: false })`. First hit wins:

1. `config.json` → `dataPath` (`'demo'` while the user explores the demo; absent otherwise),
2. `$STARPATH_DATA` (absolute, repo-relative, `demo` or `private`),
3. `<repo>/private` when it exists,
4. kind `none`: no private root yet. The app then behaves as before the split (everything repo-relative), so un-migrated checkouts keep working. A repo whose scripts predate `data-root.mjs` also lands here.

A saved `'demo'` whose `demo/` folder is gone is ignored. The result is cached in main (`getDataRoot`) and recomputed after `app:set-repo-path`, `app:set-data-path` and `private:init`. When the root moved, `applyDataRoot` re-points chat, opens the right cache file, force-resyncs it, restarts the watcher, and sends `db:changed` (all sources) plus `data-root:changed` (the new `DataRootInfo`). The renderer remounts the app shell on that event (`layout.tsx` keys `<AppShell>` on kind + root), so every view re-reads its files.

**Path mapping.** Renderer call sites keep passing repo-relative paths (`data/applications.md`, `reports/tier-1/…`, `user/profile.yml`). Every `fs:*` handler, `app:reveal-file` and `app:open-file` goes through `resolveAppPath` (`src/lib/dataRootMain.ts`, unit-tested): when `isPersonalPath(rel)` (from `data-root.mjs`: the linked paths plus `profiles/`) the path resolves under the data root, otherwise under the repo, and either way it is confined to its base (`..` escapes and foreign absolute paths are refused). `fs:list-recursive` returns paths relative to that same base, i.e. the `reports/tier-N/…` form the renderer reads back. With kind `none` personal paths stay repo-relative. In demo mode `private/…` is unreachable by name.

**Everything else main reads** uses the same root: the SQLite sync sources and the chokidar globs (`data/*`, `reports/**/*.md` under the data root), `profiles/active`, the profile CLI (`--root <data root>`), and the network lens reads.

**Demo is read-only.** With kind `demo`, `fs:write` refuses personal paths (and `demo/…`, `private/…` by name) with an error whose message starts with `demo-read-only` (`isDemoReadOnlyError` recognises it through Electron's wrapper). `shell:spawn` and `chat:send` refuse too (a spawn reports the refusal through `shell:output` + `shell:done`), `shell:run` only runs the read-only digests (`daily-brief`, `followup-cadence`, `analyze-patterns`), `profile:list` is empty and `profile:switch`/`create` are refused. The renderer mirrors it with one gate, `useWriteGate()` / `canWriteNow()` (`store/dataRoot.ts` over `writeGate()` in `lib/dataRoot.ts`): every control that writes or spawns work is disabled with the tooltip "Demo data is read-only", and the data store writers, the profiles store and the spawn registry no-op (the registry records a failed run) as a backstop. Reading every view works as usual.

**Spawn env.** `shell:run`, `shell:spawn`, chat and the profile CLI get `STARPATH_DATA=<data root>` when the kind is `demo` or `external` (`spawnEnvFor`); scripts read through `dataRootFor`. The private root needs nothing: the links lead there.

**System prompts.** Spawns pass `--append-system-prompt-file` the file `materializeSystemFile()` (`scripts/lib/overrides.mjs`) returns: the repo default, the user's `private/overrides/<path>` replacement, or a composed copy when an `.append.md` exists. Eval spawns ask through `prompt:resolve` (`claudeEvalArgsResolved` in `lib/evalSpawn.ts`); chat resolves `modes/chat.md` the same way inside main. Any failure falls back to the repo-relative default.

**Chat storage** follows the root (`chatDirFor`): `<data root>/chat/` for private and external roots (backed up with the rest of it), `{userData}/chat-demo/` in demo mode, `{userData}/chat/` with kind `none`. The first time a real data root exists, a legacy `{userData}/chat/` holding `sessions.json` is moved into `<data root>/chat/` once (never over an existing folder; logged). Files keep mode 0600. A reply still running when the root moves is stopped and recorded as interrupted in its own folder.

**Dev default repo.** With no `repoPath` configured and an unpackaged app, main adopts the checkout it runs from (walks up from `__dirname` / `app.getAppPath()` to a folder with `CLAUDE.md` and `scripts/`) and saves it. Packaged builds keep the folder picker.

**Onboarding.** The first screen offers "Explore the demo" (sets `dataPath: 'demo'`; demo mode never requires onboarding or tailoring) and "Set up my own search" (the wizard; on kind `none` it first runs `node scripts/private.mjs init --json` through `private:init` and shows its errors). The choice is hidden when the checkout has no `demo/`. In demo mode the sidebar shows a "Demo data · read-only" badge with "Use my own data" (back to own data when there is some, else the setup wizard); Settings › General › Data shows the folder and kind and a "Show demo data" switch.

## SQLite cache layer

A SQLite database at `{userData}/cache-<slug>.db` mirrors the tabular data for fast queries, joins, and aggregations — one file per search profile (`slug` is the active profile from `<data root>/profiles/active`, `default` without `profiles/`, and `demo` for the demo dataset: `cache-demo.db`). **It is fully derived from the Markdown/TSV files** — delete it, relaunch, and it rebuilds from scratch.

On a profile switch (the `profile:switch` IPC shells out to `scripts/profile.mjs --root <data root>`, which re-points the canonical symlinks inside the data root), main closes the current cache, opens the target profile's cache file, runs the normal mtime resync, and **restarts the chokidar watcher** — the watched paths are unchanged strings, but chokidar resolved the old symlink targets at watch time. It then broadcasts `db:changed` (existing reload path) plus `profile:changed` (profile surfaces). `ensureDbReady` re-derives the slug from `profiles/active` on every query, so even an out-of-band CLI switch converges on the right cache at the next call.

Layout:

```
electron/db/
├── schema.ts   # Tables, indexes, version-bump-drops-and-rebuilds
├── sync.ts     # Per-source sync functions (mtime-keyed, transactional)
└── index.ts    # Open/close, watcher, query helpers
```

Tables:

| Table           | Source                          | Notes |
|-----------------|---------------------------------|-------|
| `applications`  | `data/applications.md`          | `tier` derived from score range (≥9.0 → T1, 7.0–8.9 → T2, <7.0 → T3, status=SKIP → T4) |
| `scouting`      | `data/scouting.md`              | `score_num` extracted as REAL for sorting |
| `score_history` | `data/score-history.tsv`        | All scoring dimensions as REAL columns |
| `pipeline`      | `data/pipeline.md`              | `url` is PRIMARY KEY (dedup) |
| `reports_index` | filesystem walk of `reports/**` | Stores `(path, company, role, tier, mtime)` only — bodies read on demand |
| `_meta`         | —                               | `schema_version` + per-source mtime tracking |

### Sync triggers

1. App boot calls `ensureSynced(<data folder>)` once (the data root, or the repo with kind `none`). Each source's mtime is compared against `_meta.{table}_mtime`; unchanged sources are skipped.
2. A `chokidar` watcher on the data folder's `data/*.md`, `data/*.tsv`, and `reports/**/*.md` triggers incremental sync when files change mid-session (e.g. Claude Code finishing an evaluation). Bursts are coalesced over a 200ms window. A data-root change restarts it on the new folder.
3. After a successful sync, main broadcasts `db:changed` to the renderer so the data store can re-pull silently.

### Schema migrations

For v1, version mismatch drops and rebuilds. This is safe because the cache is fully derivable. **Do not** add migration logic until there's data only stored in SQLite — there isn't, and there shouldn't be. If a column is added: bump `SCHEMA_VERSION` and let the next launch resync.

### Native module bundling

`better-sqlite3` is a native addon. After `npm install`, `electron-rebuild` runs via `postinstall` to compile against Electron's Node ABI (different from the system Node ABI). `electron-builder.asarUnpack` includes `better-sqlite3` so the `.node` binary is available at runtime in packaged builds.

## IPC layer

The renderer never touches the database directly. `electron/preload.ts` exposes a typed `electron.db*` surface; `src/lib/ipc.ts` wraps it as `ipc.db.*`. No raw SQL crosses the boundary — only higher-level queries.

| Channel                       | Returns |
|-------------------------------|---------|
| `db:applications`             | Filtered application rows |
| `db:scouting`                 | Filtered scouting rows |
| `db:score-history`            | Filtered score history (since/until/company/tier) |
| `db:pipeline`                 | All pipeline URLs |
| `db:reports`                  | Reports listing left-joined with their score |
| `db:applications-with-scores` | Applications joined with score history |
| `db:trends`                   | Pre-aggregated buckets (byDate, byArchetype, tierDistribution) |
| `db:resync`                   | Force a full resync from disk |
| `db:rebuild`                  | Drop the current `cache-<slug>.db` and rebuild |
| `db:changed` (event)          | Emitted by main after a watcher-driven sync |
| `network:overview`            | Whole-network overview (roster × pipeline × outreach cadence) — see below |
| `profile:list`                | Profiles + active flag + row counts (via `scripts/profile.mjs list --json`; `{ active: null, profiles: [] }` pre-migration, without spawning) |
| `profile:active`              | Active slug, read straight from `profiles/active` |
| `profile:switch`              | Guarded switch via the CLI; on success swaps the per-profile cache + watcher (see above) |
| `profile:create`              | Scaffold a new profile via the CLI (never switches) |
| `profile:changed` (event)     | Emitted after a successful switch, once cache + watcher are swapped |
| `app:data-root`               | `DataRootInfo`: `{ root, kind, source, repoPath, demoAvailable, privateExists, ownDataAvailable }` (see Data root) |
| `app:set-data-path`           | `'demo'` or `null`; saves config `dataPath`, recomputes, returns the new `DataRootInfo` |
| `data-root:changed` (event)   | The new `DataRootInfo`, after cache, watcher and chat moved |
| `private:init`                | Runs `node scripts/private.mjs init --json`, relays its JSON, then re-resolves the root |
| `prompt:resolve`              | Absolute system-prompt file for a repo-relative one (overrides applied) |
| `app:open-file`               | Opens a repo-relative file (through the data root) with the default app |

### The network lens (`network:overview`)

`data/network.md` and `data/outreach.md` are not mirrored into SQLite (they're
mode artifacts, not tabular pipeline state). The Network view's overview is
instead derived on demand in the **main process** by dynamically importing the
repo's own pure cores — `scripts/lib/network-lens-core.mjs`, which composes
`network-core` (roster × pipeline matching), `outreach-core` (cadence), and
`outreach-plan-core` (the per-company decision ladder). This keeps the app, the
daily brief, and `npm run network` in verdict-for-verdict agreement without a
renderer re-implementation. The cores are ESM and the compiled main is CJS, so
the import goes through a `new Function('s', 'return import(s)')` indirection.
Any failure (older repo without the module, unreadable file) returns `null` and
the view renders a specific one-line explanation — never a crash. Nothing is
persisted; markdown stays canonical.

## Renderer data flow

`src/store/data.ts` (Zustand) holds the canonical view-model arrays the rest of the renderer consumes (`applications`, `scouting`, `scoreHistory`, `pipeline`, `reports`). It populates from `db:*` calls on mount and again when `db:changed` fires.

Three views bypass the store and hit IPC directly:

- **TrendsView** uses `db.trends()` for pre-aggregated chart buckets.
- **ReportsView** uses `db.reports()` for the list (each row already carries its overall score from a SQL left-join). The slide-over still looks up the full `ScoreEntry` from the store on click.
- **The Outreach view's Network sub-tab** (`NetworkPanel`) uses `ipc.network.overview()` (the `network:overview` channel above), re-fetching whenever the store's applications/scouting arrays change — the watcher bumps those on any `data/*` write, which is the cue the network/outreach logs may have changed too.

One cockpit surface delegates its math to the repo's scripts instead of the cache: **CommandCenter's DailyBriefPanel** runs `node scripts/daily-brief.mjs --json` through the one-shot `shell:run` channel (main process, cwd = repoPath, `STARPATH_DATA` set for the demo) and parses the result via the pure `lib/dailyBrief.ts` bridge — the ranking/"do this first" logic stays single-sourced in `scripts/lib/daily-brief-core.mjs`, never re-implemented in the renderer. It re-runs (debounced) whenever the data store re-mirrors disk, and renders nothing when the brief is empty.

All other views (`DatabaseView`, `ProfileView`, `PipelineView`, `CommandCenter`, `ScanView`, `SettingsView`) consume the store. ProfileView's heatmap/streak/badges run in-memory over a few dozen rows and don't currently warrant a per-feature SQL endpoint; if `score_history` grows past a few thousand rows, replace `buildHeatmap`/`computeStreak`/`badges` with a `db:profile-stats` query that returns `{ heatmap, streak, badges }` pre-computed.

`refresh()` is in-flight-coalesced so rapid clicks (and chokidar bursts) don't stack. Pass `{ resync: true }` to force a full SQL rebuild from disk — wired to shift-click on the Settings → Refresh data button for debugging cache divergence.

## TypeScript build

Two configs:

- `tsconfig.json` — Next.js renderer, `noEmit`, ESM, `@/*` paths.
- `tsconfig.electron.json` — Main process, CommonJS output to `dist-electron/`, `rootDir: "."` so it can compile both `electron/**/*` and the shared pure modules under `src/lib/` (the parsers, `chat/`, `dataRoot.ts`, `dataRootMain.ts`; the sync layer reuses them instead of duplicating logic). Type-only imports of `@/types` are erased at emit, so the path alias only matters at compile time; value imports from `electron/` into `src/` stay relative (`src/lib/electronAliasGuard.test.ts`).

Output structure:

```
dist-electron/
├── electron/
│   ├── main.js
│   ├── preload.js
│   └── db/{schema,sync,index}.js
└── src/lib/parsers/{markdown,tsv,yaml}.js
```

`package.json:main` points to `dist-electron/electron/main.js`.

## Testing

The renderer's **pure logic layer** has a unit suite that runs with **zero extra dependencies** — Node's built-in `node:test` plus its native TypeScript type-stripping.

- **Run:** `npm test` (or `npm run test:watch`). Requires **Node ≥ 23.5** (the runner uses `module.registerHooks`; type-stripping is on by default from 23.6).
- **What's covered:** the string→string functions that are pure and high-blast-radius — `lib/applicationsDoc.ts` (the `applications.md` mutators), `lib/entityId.ts`, `lib/archetype.ts`, `lib/tier.ts`, `lib/export.ts`, `lib/companyStats.ts`, and the three `lib/parsers/*`. Tests live next to their module as `*.test.ts`.
- **Alias shim:** `test/alias.mjs` (loaded via `--import`) registers a synchronous resolve hook that teaches the bare Node runner the `@/*` path alias and extensionless relative TS imports. It's test-only — Next/Webpack handle both at build time.
- **What's deliberately *not* tested here:** anything that needs zustand/ipc/DOM (the store actions, IPC wrappers, React components). The pure logic is extracted *out* of those so it's testable in isolation — e.g. the `applications.md` table transforms were pulled from `store/data.ts` into `lib/applicationsDoc.ts`, which `store/data.ts` re-exports for API stability while owning only the file I/O around them.
- **Boundaries:** test files are co-located under `src/` and typecheck under the strict app `tsconfig.json`, but they're never imported by a route so they never reach a bundle (`next build` confirms: no test chunk, unchanged sizes). Test fixtures live in `src/test-utils/`.

CI (`.github/workflows/ci.yml`) runs the renderer typecheck, this suite, and the repo-root gate (`node scripts/test-all.mjs`, whose section 4 also invokes `npm test`) on every push and PR.

# Frontend architecture

Electron app with a Next.js (App Router) renderer. The desktop app's job is to read, browse, and lightly edit data the user's Claude Code modes maintain in the parent repo. Claude Code is canonical; this app is a viewer and minor scribe.

## Source of truth

The Markdown/TSV files in the repo (`data/applications.md`, `data/scouting.md`, `data/pipeline.md`, `data/score-history.tsv`, `reports/**/*.md`) are canonical. Claude Code modes read and write them per the contract in the project root `CLAUDE.md`. The frontend never moves them or invents new ones.

## SQLite cache layer

A SQLite database at `{userData}/cache-<slug>.db` mirrors the tabular data for fast queries, joins, and aggregations — one file per search profile (`slug` is the active profile from `profiles/active`, or `default` on a repo without `profiles/`). **It is fully derived from the Markdown/TSV files** — delete it, relaunch, and it rebuilds from scratch.

On a profile switch (the `profile:switch` IPC shells out to `scripts/profile.mjs`, which re-points the repo's canonical symlinks), main closes the current cache, opens the target profile's cache file, runs the normal mtime resync, and **restarts the chokidar watcher** — the watched paths are unchanged strings, but chokidar resolved the old symlink targets at watch time. It then broadcasts `db:changed` (existing reload path) plus `profile:changed` (profile surfaces). `ensureDbReady` re-derives the slug from `profiles/active` on every query, so even an out-of-band CLI switch converges on the right cache at the next call.

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

1. App boot calls `ensureSynced(repoPath)` once. Each source's mtime is compared against `_meta.{table}_mtime`; unchanged sources are skipped.
2. A `chokidar` watcher on `data/*.md`, `data/*.tsv`, and `reports/**/*.md` triggers incremental sync when files change mid-session (e.g. Claude Code finishing an evaluation). Bursts are coalesced over a 200ms window.
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
| `db:rebuild`                  | Drop `cache.db` and rebuild |
| `db:changed` (event)          | Emitted by main after a watcher-driven sync |
| `network:overview`            | Whole-network overview (roster × pipeline × outreach cadence) — see below |
| `profile:list`                | Profiles + active flag + row counts (via `scripts/profile.mjs list --json`; `{ active: null, profiles: [] }` pre-migration, without spawning) |
| `profile:active`              | Active slug, read straight from `profiles/active` |
| `profile:switch`              | Guarded switch via the CLI; on success swaps the per-profile cache + watcher (see above) |
| `profile:create`              | Scaffold a new profile via the CLI (never switches) |
| `profile:changed` (event)     | Emitted after a successful switch, once cache + watcher are swapped |

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
- **NetworkView** uses `ipc.network.overview()` (the `network:overview` channel above), re-fetching whenever the store's applications/scouting arrays change — the watcher bumps those on any `data/*` write, which is the cue the network/outreach logs may have changed too.

One cockpit surface delegates its math to the repo's scripts instead of the cache: **CommandCenter's DailyBriefPanel** runs `node scripts/daily-brief.mjs --json` through the one-shot `shell:run` channel (main process, cwd = repoPath) and parses the result via the pure `lib/dailyBrief.ts` bridge — the ranking/"do this first" logic stays single-sourced in `scripts/lib/daily-brief-core.mjs`, never re-implemented in the renderer. It re-runs (debounced) whenever the data store re-mirrors disk, and renders nothing when the brief is empty.

All other views (`DatabaseView`, `ProfileView`, `PipelineView`, `CommandCenter`, `ScanView`, `SettingsView`) consume the store. ProfileView's heatmap/streak/badges run in-memory over a few dozen rows and don't currently warrant a per-feature SQL endpoint; if `score_history` grows past a few thousand rows, replace `buildHeatmap`/`computeStreak`/`badges` with a `db:profile-stats` query that returns `{ heatmap, streak, badges }` pre-computed.

`refresh()` is in-flight-coalesced so rapid clicks (and chokidar bursts) don't stack. Pass `{ resync: true }` to force a full SQL rebuild from disk — wired to shift-click on the Settings → Refresh data button for debugging cache divergence.

## TypeScript build

Two configs:

- `tsconfig.json` — Next.js renderer, `noEmit`, ESM, `@/*` paths.
- `tsconfig.electron.json` — Main process, CommonJS output to `dist-electron/`, `rootDir: "."` so it can compile both `electron/**/*` and the parsers under `src/lib/parsers/**/*` (which are pure functions on strings, used by the sync layer to avoid duplicating parsing logic). Type-only imports of `@/types` are erased at emit, so the path alias only matters at compile time.

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

# Frontend architecture

Electron app with a Next.js (App Router) renderer. The desktop app's job is to read, browse, and lightly edit data the user's Claude Code modes maintain in the parent repo. Claude Code is canonical; this app is a viewer and minor scribe.

## Source of truth

The Markdown/TSV files in the repo (`data/applications.md`, `data/scouting.md`, `data/pipeline.md`, `data/score-history.tsv`, `reports/**/*.md`) are canonical. Claude Code modes read and write them per the contract in the project root `CLAUDE.md`. The frontend never moves them or invents new ones.

## SQLite cache layer

A SQLite database at `{userData}/cache.db` mirrors the tabular data for fast queries, joins, and aggregations. **It is fully derived from the Markdown/TSV files** — delete it, relaunch, and it rebuilds from scratch.

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

## Renderer data flow

`src/store/data.ts` (Zustand) holds the canonical view-model arrays the rest of the renderer consumes (`applications`, `scouting`, `scoreHistory`, `pipeline`, `reports`). It populates from `db:*` calls on mount and again when `db:changed` fires.

Two views bypass the store and hit IPC directly:

- **TrendsView** uses `db.trends()` for pre-aggregated chart buckets.
- **ReportsView** uses `db.reports()` for the list (each row already carries its overall score from a SQL left-join). The slide-over still looks up the full `ScoreEntry` from the store on click.

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

import type Database from 'better-sqlite3'

// v4: pipeline table gains company/title/relevance columns parsed from the
// scanner-written pending lines (the Inbox ranks on them). Any version bump
// drops + rebuilds every table from the canonical markdown/TSV on next launch.
// v5: no shape change — parsePipeline now excludes checked-off ("- [x]")
// entries, and existing caches hold stale pending rows stamped with the
// current file mtime, so only a forced rebuild reparses them.
// v6: no shape change — parseApplications now maps cells by width (handling
// applications.md's optional Deadline column) instead of by header name, so a
// cache built before the fix can hold rows with Report/Notes shifted one cell;
// force a rebuild since those mtime stamps are current-yet-stale.
// v7: no shape change — the design-system v2 redesign forced a rebuild.
// v8: scoring v2 (docs/scoring-v2.md §8). score_history drops the v1 rollups
// (current_fit / aspirational_fit / overall / ease_of_entry / strategic_fit /
// sales_trap_risk) for experience_bar / competition / ease / role_content /
// match / priority / eligibility / eligibility_flags / verdict, and every
// numeric column is a NULLABLE REAL (blocked rows carry no scores). scouting
// swaps score/cfaf for match / ease / eligibility; applications swaps score_num
// for match / ease / legacy_score parsed from the Score cell (§8.3).
// v9: no shape change — the multi-city location parsing changed (one listing,
// several places), so caches built before it hold stale `cities` cells under
// current mtimes; force a rebuild.
// v10: no shape change — reports_index now takes company/role from the
// report's title when it names the same listing as the file name (so a role
// like "… (Lyon)" keeps its parentheses); rows cached under current mtimes
// hold the old file-name spelling, so force a rebuild.
// v11: the Want axis is renamed Match everywhere (score_history, scouting and
// applications: `want` → `match`), so a cache built before it has the old
// column name; rebuild.
export const SCHEMA_VERSION = 11

const TABLES = [
  `CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS applications (
    num         INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,
    company     TEXT NOT NULL,
    role        TEXT NOT NULL,
    score_raw   TEXT NOT NULL,
    -- Parsed from score_raw (spec §8.3): 'M8.3 E5.6' → match/ease; a legacy
    -- '7.4/10' cell → legacy_score. NULL when the cell doesn't carry it.
    match         REAL,
    ease         REAL,
    legacy_score REAL,
    status      TEXT NOT NULL,
    pdf         INTEGER NOT NULL DEFAULT 0,
    deadline    TEXT NOT NULL DEFAULT '',
    report      TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    tier        TEXT NOT NULL DEFAULT '',
    -- entity_id and cities are derived at sync time from
    -- (company, role, location) via lib/entityId.ts. cities is a
    -- JSON-encoded string array; the empty array '[]' means
    -- single-city (use the row's location field).
    entity_id   TEXT NOT NULL DEFAULT '',
    cities      TEXT NOT NULL DEFAULT '[]'
  )`,

  `CREATE TABLE IF NOT EXISTS scouting (
    num            INTEGER PRIMARY KEY,
    date           TEXT NOT NULL,
    company        TEXT NOT NULL,
    role           TEXT NOT NULL,
    match           REAL,
    ease           REAL,
    tier           TEXT NOT NULL,
    eligibility    TEXT,
    eligibility_reason TEXT NOT NULL DEFAULT '',
    report         TEXT NOT NULL DEFAULT '',
    deadline       TEXT NOT NULL DEFAULT '',
    promotion_hint TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    entity_id      TEXT NOT NULL DEFAULT '',
    cities         TEXT NOT NULL DEFAULT '[]'
  )`,

  `CREATE TABLE IF NOT EXISTS score_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    date              TEXT NOT NULL,
    archetype         TEXT NOT NULL DEFAULT '',
    skills_match      REAL,
    experience_bar    REAL,
    competition       REAL,
    ease              REAL,
    growth_mobility   REAL,
    optionality_exit  REAL,
    brand_value       REAL,
    role_content      REAL,
    best_cities       REAL,
    salary_adj_city   REAL,
    work_life_balance REAL,
    match              REAL,
    priority          REAL,
    eligibility       TEXT,
    eligibility_flags TEXT NOT NULL DEFAULT '',
    verdict           TEXT,
    best_fit_roles    TEXT NOT NULL DEFAULT '',
    mode              TEXT NOT NULL DEFAULT 'scouting',
    company           TEXT NOT NULL,
    role              TEXT NOT NULL,
    tier              TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    location          TEXT NOT NULL DEFAULT '',
    employment_type   TEXT NOT NULL DEFAULT '',
    duration          TEXT NOT NULL DEFAULT '',
    salary_raw        TEXT NOT NULL DEFAULT '',
    url               TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS pipeline (
    url            TEXT PRIMARY KEY,
    added_date     TEXT,
    is_stale       INTEGER NOT NULL DEFAULT 0,
    company        TEXT,
    title          TEXT,
    relevance      REAL,
    relevance_note TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS reports_index (
    path    TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    role    TEXT NOT NULL,
    tier    TEXT NOT NULL,
    url     TEXT NOT NULL DEFAULT '',
    mtime   INTEGER NOT NULL
  )`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_apps_company_role ON applications(company, role)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_status       ON applications(status)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_tier         ON applications(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_entity       ON applications(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scouting_tier     ON scouting(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_scouting_entity   ON scouting(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_score_company_role ON score_history(company, role)`,
  `CREATE INDEX IF NOT EXISTS idx_score_date        ON score_history(date)`,
  `CREATE INDEX IF NOT EXISTS idx_score_tier        ON score_history(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_score_archetype   ON score_history(archetype)`,
  `CREATE INDEX IF NOT EXISTS idx_score_verdict     ON score_history(verdict)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_tier      ON reports_index(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_company_role ON reports_index(company, role)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_url       ON reports_index(url)`,
  `CREATE INDEX IF NOT EXISTS idx_score_url         ON score_history(url)`,
]

const TABLE_NAMES = ['applications', 'scouting', 'score_history', 'pipeline', 'reports_index', '_meta']

export function initSchema(db: Database.Database): void {
  // Schema versioning: cache is fully derivable from Markdown/TSV, so on
  // version mismatch we drop and rebuild rather than migrate. This is
  // intentional for v1 — adding a column is a schema bump that triggers a
  // full resync, which is cheap at current data volume.
  const currentVersion = (() => {
    try {
      const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
      return row ? parseInt(row.value, 10) : 0
    } catch {
      return 0
    }
  })()

  if (currentVersion !== SCHEMA_VERSION) {
    for (const name of TABLE_NAMES) {
      db.exec(`DROP TABLE IF EXISTS ${name}`)
    }
  }

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  for (const stmt of TABLES) db.exec(stmt)
  for (const stmt of INDEXES) db.exec(stmt)

  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION))
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(key, value)
}

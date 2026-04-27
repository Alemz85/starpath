import type Database from 'better-sqlite3'

export const SCHEMA_VERSION = 1

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
    score_num   REAL,
    status      TEXT NOT NULL,
    pdf         INTEGER NOT NULL DEFAULT 0,
    deadline    TEXT NOT NULL DEFAULT '',
    report      TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    tier        TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS scouting (
    num            INTEGER PRIMARY KEY,
    date           TEXT NOT NULL,
    company        TEXT NOT NULL,
    role           TEXT NOT NULL,
    score_raw      TEXT NOT NULL,
    score_num      REAL,
    tier           TEXT NOT NULL,
    cfaf           TEXT NOT NULL DEFAULT '',
    report         TEXT NOT NULL DEFAULT '',
    deadline       TEXT NOT NULL DEFAULT '',
    promotion_hint TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS score_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    date              TEXT NOT NULL,
    archetype         TEXT NOT NULL DEFAULT '',
    skills_match      REAL NOT NULL DEFAULT 0,
    ease_of_entry     REAL NOT NULL DEFAULT 0,
    strategic_fit     REAL NOT NULL DEFAULT 0,
    current_fit       REAL NOT NULL DEFAULT 0,
    growth_mobility   REAL NOT NULL DEFAULT 0,
    optionality_exit  REAL NOT NULL DEFAULT 0,
    brand_value       REAL NOT NULL DEFAULT 0,
    sales_trap_risk   REAL NOT NULL DEFAULT 0,
    aspirational_fit  REAL NOT NULL DEFAULT 0,
    overall           REAL NOT NULL DEFAULT 0,
    best_cities       REAL NOT NULL DEFAULT 0,
    salary_adj_city   REAL NOT NULL DEFAULT 0,
    work_life_balance REAL NOT NULL DEFAULT 0,
    best_fit_roles    TEXT NOT NULL DEFAULT '',
    mode              TEXT NOT NULL DEFAULT 'scouting',
    company           TEXT NOT NULL,
    role              TEXT NOT NULL,
    tier              TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    location          TEXT NOT NULL DEFAULT '',
    employment_type   TEXT NOT NULL DEFAULT '',
    duration          TEXT NOT NULL DEFAULT '',
    salary_raw        TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS pipeline (
    url        TEXT PRIMARY KEY,
    added_date TEXT,
    is_stale   INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS reports_index (
    path    TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    role    TEXT NOT NULL,
    tier    TEXT NOT NULL,
    mtime   INTEGER NOT NULL
  )`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_apps_company_role ON applications(company, role)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_status       ON applications(status)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_tier         ON applications(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_scouting_tier     ON scouting(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_score_company_role ON score_history(company, role)`,
  `CREATE INDEX IF NOT EXISTS idx_score_date        ON score_history(date)`,
  `CREATE INDEX IF NOT EXISTS idx_score_tier        ON score_history(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_score_archetype   ON score_history(archetype)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_tier      ON reports_index(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_company_role ON reports_index(company, role)`,
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

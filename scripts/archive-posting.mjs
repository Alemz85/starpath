#!/usr/bin/env node
/**
 * archive-posting.mjs — save the job description of reports that have none.
 *
 *   node scripts/archive-posting.mjs --report=12 [--dry-run]
 *   node scripts/archive-posting.mjs --missing  [--dry-run]
 *
 * Fetches the report's `**URL:**` — the ATS API for Greenhouse / Lever / Ashby /
 * SmartRecruiters listings, the page itself otherwise — through
 * scripts/lib/http.mjs (https only, no redirects, no private addresses) and
 * writes `jds/<num>-<company>-<role>.md` (format: lib/jd-archive-core.mjs).
 * It never overwrites an archive and writes nothing when the posting is gone:
 * those are logged in `jds/.unrecoverable.tsv` so they are not retried, and
 * `check-jd-archive.mjs` counts them separately. A network failure is only
 * reported (nothing logged), so it is retried next run.
 *
 * --dry-run prints the route per report (API or page) without fetching or
 * writing anything. T4 has no report file, hence nothing to archive.
 *
 * Paths resolve through the data root (CAREER_OPS_ROOT, then STARPATH_DATA /
 * private/ / this checkout).
 */

import { fileURLToPath } from 'node:url'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { http } from './lib/http.mjs'
import { loadAudit, writeArchiveFile, logUnrecoverable } from './lib/jd-archive-fs.mjs'
import { unrecoverableKey } from './lib/jd-archive-core.mjs'
import { archiveRow } from './lib/jd-backfill.mjs'

/** Rows to work on for the given flags; `{ rows }` or `{ error }`. */
export function selectRows(audit, { report, missing }) {
  if (report != null) {
    const n = Number(report)
    const rows = audit.rows.filter((r) => r.num === n)
    return rows.length ? { rows } : { error: `No T1–T3 report with number ${report} (T4 listings have no report to archive).` }
  }
  if (missing) return { rows: audit.rows.filter((r) => r.status === 'missing') }
  return { error: 'Usage: archive-posting.mjs --report=N | --missing  [--dry-run]' }
}

export async function run({ root, argv, httpClient = http, today = new Date().toISOString().slice(0, 10), out = console.log }) {
  const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? null
  const dryRun = argv.includes('--dry-run')
  const audit = loadAudit(root)
  const picked = selectRows(audit, { report: flag('report'), missing: argv.includes('--missing') })
  if (picked.error) { out(picked.error); return 2 }

  const tally = {}
  for (const row of picked.rows) {
    const label = `${row.num != null ? `#${row.num} ` : ''}${row.company || row.path} — ${row.role}`
    const result = await archiveRow(row, {
      http: httpClient, today, dryRun,
      key: unrecoverableKey({ num: row.num, path: row.path }),
      write: (name, content) => writeArchiveFile(root, name, content),
      logUnrecoverable: (entry) => logUnrecoverable(root, entry),
    })
    tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
    const detail = result.outcome === 'would-archive' ? `via ${result.via} → ${result.file}`
      : result.outcome === 'archived' ? `${result.file} (${result.source})`
        : result.reason ?? result.file ?? ''
    out(`${result.outcome.padEnd(13)} ${label}${detail ? ` — ${detail}` : ''}`)
  }
  out(`\n${picked.rows.length} report${picked.rows.length === 1 ? '' : 's'}: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.env.CAREER_OPS_ROOT || dataRootFor(repoRootFrom(import.meta.url))
  process.exit(await run({ root, argv: process.argv.slice(2) }))
}

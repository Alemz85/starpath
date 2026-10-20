#!/usr/bin/env node
/**
 * check-jd-archive.mjs — which reports have no saved job description?
 *
 * Read-only. Every report in tiers T1–T3 should have `jds/<num>-<company>-<role>.md`
 * (T4 writes no report, so it needs none). Lists the ones that do not, and
 * separates the postings the backfill already found gone (`jds/.unrecoverable.tsv`).
 *
 *   node scripts/check-jd-archive.mjs [--json] [--strict]
 *
 * --strict exits 1 when any report is missing its archive (the default exit is
 * 0: verify-pipeline reports it as a warning). Fix with
 * `node scripts/archive-posting.mjs --missing`.
 *
 * Paths resolve through the data root (CAREER_OPS_ROOT, then STARPATH_DATA /
 * private/ / this checkout).
 */

import { fileURLToPath } from 'node:url'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { loadAudit } from './lib/jd-archive-fs.mjs'

export function rootDir() {
  return process.env.CAREER_OPS_ROOT || dataRootFor(repoRootFrom(import.meta.url))
}

/** One line per problem report, for a human. */
export function describeMissing(audit) {
  return audit.rows
    .filter((r) => r.status === 'missing')
    .map((r) => `${r.num != null ? `#${r.num} ` : ''}${r.company || r.path} — ${r.role} (${r.path})${r.url ? '' : ' [no URL]'}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const audit = loadAudit(rootDir())
  const { counts } = audit
  if (argv.includes('--json')) {
    console.log(JSON.stringify(audit, null, 2))
  } else {
    console.log(`JD archive: ${counts.archived}/${counts.total} reports archived`
      + (counts.unrecoverable ? `, ${counts.unrecoverable} posting${counts.unrecoverable === 1 ? '' : 's'} gone (unrecoverable)` : '')
      + (counts.missing ? `, ${counts.missing} missing` : ''))
    for (const line of describeMissing(audit)) console.log(`  missing: ${line}`)
    if (counts.missing) console.log('Backfill: node scripts/archive-posting.mjs --missing   (add --dry-run to preview)')
  }
  process.exit(argv.includes('--strict') && counts.missing > 0 ? 1 : 0)
}

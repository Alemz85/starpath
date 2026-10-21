#!/usr/bin/env node
/**
 * migrate-workday-urls.mjs — add the career-site segment back to the Workday
 * links older scans stored (`…/job/…` → `…/{site}/job/…`).
 *
 *   node scripts/migrate-workday-urls.mjs           # report only (default)
 *   node scripts/migrate-workday-urls.mjs --apply   # rewrite the files
 *
 * Touches data/scan-history.tsv (url column) and data/pipeline.md (leading URL
 * of each checkbox line). Safe to repeat; dedup identity is unchanged (see
 * lib/workday-url-migrate.mjs). Sites come from user/portals.yml; rows whose
 * site can't be told are left alone and counted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { writeFileAtomic } from './lib/write-file-atomic.mjs';
import { makeSiteResolver, migrateHistoryText, migratePipelineText } from './lib/workday-url-migrate.mjs';

const TARGETS = [
  { path: 'data/scan-history.tsv', migrate: migrateHistoryText },
  { path: 'data/pipeline.md', migrate: migratePipelineText },
];

/** Run the migration in the current directory. Returns per-file stats. */
export function runMigration({ apply = false, log = console.log } = {}) {
  const portals = 'user/portals.yml';
  const config = existsSync(portals) ? yaml.load(readFileSync(portals, 'utf-8')) : {};
  const resolve = makeSiteResolver(config);
  const results = [];
  for (const { path, migrate } of TARGETS) {
    if (!existsSync(path)) { results.push({ path, rewritten: 0, unresolved: 0, missing: true }); continue; }
    const before = readFileSync(path, 'utf-8');
    const { text, rewritten, unresolved } = migrate(before, resolve);
    if (apply && rewritten > 0) writeFileAtomic(path, text);
    results.push({ path, rewritten, unresolved });
    log(`${path}: ${rewritten} link${rewritten === 1 ? '' : 's'} ${apply ? 'rewritten' : 'to rewrite'}${unresolved ? `, ${unresolved} left as is (site unknown — add the company to user/portals.yml)` : ''}`);
  }
  if (!apply && results.some((r) => r.rewritten > 0)) log('\n(report only — run with --apply to rewrite)');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigration({ apply: process.argv.includes('--apply') });
}

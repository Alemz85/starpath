#!/usr/bin/env node
/**
 * migrate-match-rename.mjs — carry the workspace's data over the rename of the
 * first scoring axis from "Want" to "Match" (docs/scoring-v2.md).
 *
 *   node scripts/migrate-match-rename.mjs                  # report only (default)
 *   node scripts/migrate-match-rename.mjs --apply          # rewrite the files
 *   node scripts/migrate-match-rename.mjs --check          # exit 1 when anything is left
 *   node scripts/migrate-match-rename.mjs --all-profiles   # also every profile under private/profiles/
 *
 * Touches the score-history header, the scouting.md header, the score cells of
 * applications.md / pipeline.md / pending tracker additions, report headers and
 * dimension tags under reports/, and the scoring key and wording in
 * user/profile.yml and user/_profile.md (lib/match-rename-migrate.mjs says
 * exactly what). Safe to repeat: migrated text is left as it is. Writes are
 * atomic, through the profile links, under each file's lock.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lockPathFor, withLockSync } from './lib/dir-lock.mjs'
import { writeFileAtomic } from './lib/write-file-atomic.mjs'
import { TRANSFORMS } from './lib/match-rename-migrate.mjs'

/** Every .md under a folder, following folder links (reports/ is one). */
function markdownUnder(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...markdownUnder(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

/** The files of one workspace layout rooted at `base` ('' = the canonical paths). */
function targetsIn(base) {
  const at = (p) => (base ? join(base, p) : p)
  const list = [
    { path: at('data/score-history.tsv'), kind: 'score-history' },
    { path: at('data/scouting.md'), kind: 'scouting' },
    { path: at('data/applications.md'), kind: 'score-cells' },
    { path: at('data/pipeline.md'), kind: 'score-cells' },
    { path: at('user/profile.yml'), kind: 'profile-yml' },
    { path: at('user/_profile.md'), kind: 'profile-md' },
    ...markdownUnder(at('reports')).map((path) => ({ path, kind: 'report' })),
  ]
  if (!base) {
    const additions = 'batch/tracker-additions'
    if (existsSync(additions)) {
      for (const name of readdirSync(additions).sort()) {
        if (name.endsWith('.tsv')) list.push({ path: join(additions, name), kind: 'tsv-score-cells' })
      }
    }
  }
  return list
}

/** Canonical targets, plus every profile's own files when asked. Deduped by real path. */
export function collectTargets({ allProfiles = false } = {}) {
  const all = targetsIn('')
  const profilesDir = 'private/profiles'
  if (allProfiles && existsSync(profilesDir)) {
    for (const slug of readdirSync(profilesDir).sort()) {
      const dir = join(profilesDir, slug)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      all.push(...targetsIn(dir))
    }
  }
  const seen = new Set()
  return all.filter(({ path }) => {
    if (!existsSync(path)) return false
    const real = realpathSync(path)
    if (seen.has(real)) return false
    seen.add(real)
    return true
  })
}

/** Run the migration in the current directory. Returns per-file results. */
export function runMigration({ apply = false, allProfiles = false, log = console.log } = {}) {
  const results = []
  for (const { path, kind } of collectTargets({ allProfiles })) {
    const migrateOne = () => {
      const before = readFileSync(path, 'utf-8')
      const { text, changes } = TRANSFORMS[kind](before)
      if (apply && changes > 0 && text !== before) writeFileAtomic(path, text)
      return changes
    }
    const changes = apply ? withLockSync(lockPathFor(path), migrateOne, { label: 'migrate-match-rename' }) : migrateOne()
    if (changes > 0) {
      results.push({ path, kind, changes })
      log(`${path}: ${changes} change${changes === 1 ? '' : 's'} ${apply ? 'made' : 'to make'}`)
    }
  }
  if (!results.length) log('Nothing to migrate: every file already uses Match.')
  else if (!apply) log('\n(report only — run with --apply to rewrite)')
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const results = runMigration({ apply: args.includes('--apply') && !check, allProfiles: args.includes('--all-profiles') })
  if (check && results.length) process.exitCode = 1
}

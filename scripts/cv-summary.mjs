#!/usr/bin/env node

/**
 * cv-summary.mjs — generate the compact CV summary eval workers read.
 *
 * Derives `batch/cv-summary.md` deterministically from `user/cv.md` +
 * `user/profile.yml` (pure logic in scripts/lib/cv-summary-core.mjs), so a
 * per-listing eval spawn ingests a trimmed proof-point summary instead of
 * the full CV on every run (token-cost lever 3, TODO.md).
 *
 * The artifact is DERIVED USER DATA: it lives in gitignored batch/ and is
 * regenerated on demand — never edit it by hand, never commit it.
 * Consumers (batch/batch-prompt.md) fall back to reading the full
 * `user/cv.md` when the artifact is missing, so failures here are never
 * fatal to an eval run.
 *
 * Usage:
 *   node scripts/cv-summary.mjs             # always (re)generate
 *   node scripts/cv-summary.mjs --if-stale  # only if missing or older than either source
 *   node scripts/cv-summary.mjs --check     # print fresh|stale, exit 1 when stale
 */

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderCvSummary, profileStampMatches } from './lib/cv-summary-core.mjs'
import { ACTIVE_POINTER, parseActive } from './lib/profile-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CV_PATH = join(ROOT, 'user/cv.md')
const PROFILE_PATH = join(ROOT, 'user/profile.yml')
const OUT_PATH = join(ROOT, 'batch/cv-summary.md')
const OUT_REL = 'batch/cv-summary.md'
const ACTIVE_PATH = join(ROOT, ACTIVE_POINTER)

const args = process.argv.slice(2)
const ifStale = args.includes('--if-stale')
const checkOnly = args.includes('--check')

if (!existsSync(CV_PATH)) {
  // No CV → nothing to summarize. Remove any stale artifact so workers
  // can't read a summary of a CV that no longer exists.
  if (existsSync(OUT_PATH)) {
    unlinkSync(OUT_PATH)
    console.log(`cv-summary: user/cv.md missing — removed stale ${OUT_REL}`)
  } else {
    console.log('cv-summary: user/cv.md missing — nothing to summarize (workers fall back to user/cv.md)')
  }
  process.exit(0)
}

const sourceMtime = Math.max(
  statSync(CV_PATH).mtimeMs,
  existsSync(PROFILE_PATH) ? statSync(PROFILE_PATH).mtimeMs : 0,
)

// Active profile slug (multi-profile layout only). user/profile.yml is a
// per-profile symlink, so after a profile switch the mtime gate alone can be
// wrong (the other profile's yml may be older than the summary). The
// generated artifact is stamped with the slug it was built under; a stamp
// mismatch forces regeneration. No profiles/ or no stamp ⇒ mtime-only
// (pre-migration compat) — see profileStampMatches.
const activeSlug = existsSync(ACTIVE_PATH) ? parseActive(readFileSync(ACTIVE_PATH, 'utf8')) : null
const outText = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null
const mtimeFresh = existsSync(OUT_PATH) && statSync(OUT_PATH).mtimeMs >= sourceMtime
const slugFresh = profileStampMatches(outText ?? '', activeSlug)
const fresh = mtimeFresh && slugFresh

if (checkOnly) {
  console.log(
    fresh
      ? `cv-summary: ${OUT_REL} is fresh`
      : `cv-summary: ${OUT_REL} is ${mtimeFresh && !slugFresh ? 'from another profile' : 'stale or missing'}`,
  )
  process.exit(fresh ? 0 : 1)
}

if (ifStale && fresh) {
  console.log(`cv-summary: ${OUT_REL} is fresh — skipped`)
  process.exit(0)
}

const cvText = readFileSync(CV_PATH, 'utf8')
const profileText = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, 'utf8') : ''
const output = renderCvSummary({ cvText, profileText, profileSlug: activeSlug })

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, output, 'utf8')

const srcLines = cvText.split('\n').length
const outLines = output.split('\n').length
console.log(
  `cv-summary: wrote ${OUT_REL} (${outLines} lines from ${srcLines} CV lines` +
  `${profileText ? ' + profile facts' : ''})`,
)

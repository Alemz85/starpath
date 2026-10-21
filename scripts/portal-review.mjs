#!/usr/bin/env node
/**
 * portal-review.mjs — suggest, through the app's Messages, which tracked
 * companies to keep, pause or add. It only SUGGESTS: user/portals.yml is never
 * edited.
 *
 * Usage:
 *   node scripts/portal-review.mjs              review and post the new suggestions
 *   node scripts/portal-review.mjs --dry-run    print what it would post; write nothing
 *   node scripts/portal-review.mjs --json       machine-readable result
 *   node scripts/portal-review.mjs --today YYYY-MM-DD   pretend it is that day (tests, backfills)
 *
 * The weekly scheduled run calls it after the scan. Rules, thresholds and the
 * `scanner.portal_review` keys in user/profile.yml: scripts/lib/portal-review-core.mjs
 * and docs/REPO-GUIDE.md § Scanners. A suggestion is posted once per
 * company + action (stable `--key portal-review:<action>:<company>`): a message
 * that is open, dismissed or resolved is never posted again. At most
 * `max_per_run` (default 8) are posted per run, the strongest first.
 *
 * Data root: CAREER_OPS_ROOT, else STARPATH_DATA / private/ / this checkout
 * (same as messages.mjs).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { parseBlacklist, blacklistReason } from './lib/admission-gate.mjs'
import { parseHistoryFile, getCell } from './lib/scan-history.mjs'
import { parseHealth } from './lib/portal-health.mjs'
import { MESSAGES_REL, postMessage, readMessages } from './lib/messages-store.mjs'
import { loadProviders, detectProvider } from './lib/provider-registry.mjs'
import { triageOptsFromConfig } from './lib/triage-config.mjs'
import {
  parseProbation, postFromReview, readReviewConfig, reviewPortals, selectToPost,
} from './lib/portal-review-core.mjs'

const readText = (path) => {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}
const loadYaml = (text) => {
  if (!text) return null
  try { return yaml.load(text) ?? null } catch { return null }
}

/** scan-history.tsv text → rows with the fields the review reads. */
export function historyRows(text) {
  const { columns, rows } = parseHistoryFile(text)
  return rows.map((r) => ({
    url: getCell(r, columns, 'url'),
    first_seen: getCell(r, columns, 'first_seen'),
    portal: getCell(r, columns, 'portal'),
    title: getCell(r, columns, 'title'),
    company: getCell(r, columns, 'company'),
    status: getCell(r, columns, 'status'),
    scan_dates: getCell(r, columns, 'scan_dates').split('|').map((d) => d.trim()).filter(Boolean),
  }))
}

/** score-history.tsv text → { company, role, verdict, date } rows (header-named). */
export function scoreRows(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const cols = lines[0].split('\t')
  const at = (name) => cols.indexOf(name)
  const [ci, ri, vi, di] = [at('company'), at('role'), at('verdict'), at('date')]
  if (ci < 0 || vi < 0) return []
  return lines.slice(1).map((l) => {
    const c = l.split('\t')
    return { company: c[ci] || '', role: ri >= 0 ? c[ri] || '' : '', verdict: c[vi] || '', date: di >= 0 ? c[di] || '' : '' }
  })
}

const names = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean)

/** Dream, lower-tier-dream and brand-affinity company names: never suggested for pausing. */
export function protectedCompanies({ profile, portals }) {
  const opts = triageOptsFromConfig({ profile, portals })
  return [
    ...names(opts.dreamCompanies),
    ...names(opts.affinityCompanies),
    ...names(profile?.calibration?.dream_companies),
    ...names(profile?.calibration?.lower_tier_dream_companies),
  ]
}

/**
 * Run the review over the files under `root` and, unless `dryRun`, post the
 * new suggestions. Returns { enabled, suggestions, posted, skipped }.
 */
export async function runReview({ root, today = new Date().toISOString().slice(0, 10), dryRun = false, now = new Date(), providers } = {}) {
  const profile = loadYaml(readText(join(root, 'user/profile.yml')))
  const config = readReviewConfig(profile)
  if (!config.enabled) return { enabled: false, suggestions: [], posted: [], skipped: [] }

  const portalsText = readText(join(root, 'user/portals.yml'))
  const portals = loadYaml(portalsText)
  const tracked = Array.isArray(portals?.tracked_companies) ? portals.tracked_companies : []
  const blacklist = parseBlacklist(readText(join(root, 'data/blacklist.md')))
  const health = parseHealth(readText(join(root, 'data/portal-health.tsv')))

  let apiCovered = null
  try {
    const loaded = providers ?? (await loadProviders()).providers
    if (loaded.length) apiCovered = tracked.filter((c) => c?.name && detectProvider(c, loaded)).map((c) => c.name)
  } catch { /* unknown coverage: judge every company */ }

  const suggestions = reviewPortals({
    today,
    config,
    tracked,
    probation: parseProbation(portalsText),
    history: historyRows(readText(join(root, 'data/scan-history.tsv'))),
    scores: scoreRows(readText(join(root, 'data/score-history.tsv'))),
    failing: [...health.values()],
    protectedCompanies: protectedCompanies({ profile, portals }),
    apiCovered,
    isBlacklisted: (company) => Boolean(blacklistReason(blacklist, { company, url: '' })),
  })

  const file = join(root, MESSAGES_REL)
  const toPost = selectToPost(suggestions, readMessages(file), config.maxPerRun)
  const posted = []
  if (!dryRun) {
    for (const s of toPost) {
      const r = postMessage(file, postFromReview(s), { now })
      if (r.posted) posted.push(s)
    }
  }
  const postedKeys = new Set((dryRun ? toPost : posted).map((s) => s.key))
  return { enabled: true, suggestions, posted: dryRun ? toPost : posted, skipped: suggestions.filter((s) => !postedKeys.has(s.key)) }
}

async function main(argv = process.argv.slice(2)) {
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
  const root = process.env.CAREER_OPS_ROOT || dataRootFor(repoRootFrom(import.meta.url))
  const dryRun = argv.includes('--dry-run')
  const today = flag('--today')
  const result = await runReview({ root, dryRun, ...(today ? { today } : {}) })
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, suggestions: result.suggestions.map(({ body, ...s }) => s), posted: result.posted.map((s) => s.key), skipped: result.skipped.map((s) => s.key) }))
    return 0
  }
  if (!result.enabled) { console.log('portal review: off (scanner.portal_review.enabled: false)'); return 0 }
  const verb = dryRun ? 'would post' : 'posted'
  if (!result.posted.length) {
    console.log(`portal review: nothing new to suggest (${result.suggestions.length} already posted or below thresholds)`)
    return 0
  }
  console.log(`portal review: ${verb} ${result.posted.length} suggestion${result.posted.length === 1 ? '' : 's'} to Messages`)
  for (const s of result.posted) console.log(`  ${s.action.padEnd(5)} ${s.title}`)
  const rest = result.suggestions.length - result.posted.length
  if (rest > 0) console.log(`  (${rest} more already posted or waiting for the next run)`)
  return 0
}

const isEntry = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
})()
if (isEntry) {
  main().then((code) => process.exit(code), (e) => { console.error(`portal review: ${e.message}`); process.exit(1) })
}

#!/usr/bin/env node
/**
 * portal-health.mjs — CLI for the portal health log (data/portal-health.tsv).
 *
 * The API scanner records a row per company on every run by itself; the Full
 * scan agent records the WebSearch companies with `record`. `review` turns the
 * log into suggestions (fix an endpoint, pause a board with no fit for a
 * while, track a company that keeps turning up) — it prints them and never
 * edits user/portals.yml. The daily brief shows the same suggestions under
 * Heads-up. Rules and thresholds: scripts/lib/portal-health-core.mjs.
 *
 * Usage:
 *   node scripts/portal-health.mjs record --company "<name>" --source <websearch|greenhouse-api|…> \
 *        --outcome <ok|error|unreachable> [--jobs N] [--kept N] [--date YYYY-MM-DD] [--note "…"]
 *   node scripts/portal-health.mjs review [--json]
 *   node scripts/portal-health.mjs list [--company "<name>"] [--json]
 *   npm run portal-health -- review
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OUTCOMES, renderReview, reviewIsEmpty } from './lib/portal-health-core.mjs'
import { appendHealthRows, readHealthRows, reviewFromFiles, PORTAL_HEALTH_PATH } from './lib/portal-health-io.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HEALTH_FILE = join(ROOT, PORTAL_HEALTH_PATH)

const rawArgs = process.argv.slice(2)
const command = rawArgs[0]
const args = rawArgs.slice(1)
const JSON_MODE = args.includes('--json')

function argValue(flag) {
  const i = args.indexOf(flag)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null
}

function usageFail(message) {
  console.error(`error: ${message}`)
  console.error('usage:')
  console.error('  node scripts/portal-health.mjs record --company "<name>" --source <source> --outcome <ok|error|unreachable> [--jobs N] [--kept N] [--date YYYY-MM-DD] [--note "…"]')
  console.error('  node scripts/portal-health.mjs review [--json]')
  console.error('  node scripts/portal-health.mjs list [--company "<name>"] [--json]')
  process.exit(1)
}

function cmdRecord() {
  const company = argValue('--company')
  const source = argValue('--source')
  const outcome = argValue('--outcome')
  if (!company) usageFail('--company is required')
  if (!source) usageFail('--source is required (websearch, greenhouse-api, …)')
  if (!outcome || !OUTCOMES.includes(outcome)) usageFail(`--outcome must be one of ${OUTCOMES.join('|')}`)
  const record = {
    date: argValue('--date') || new Date().toISOString().slice(0, 10),
    company, source, outcome,
    jobs: argValue('--jobs') || 0,
    kept: argValue('--kept') || 0,
    note: argValue('--note') || '',
  }
  try {
    appendHealthRows([record], HEALTH_FILE)
  } catch (err) {
    usageFail(err.message)
  }
  if (JSON_MODE) console.log(JSON.stringify(record))
  else console.log(`recorded ${record.company} · ${record.outcome} · ${record.jobs} jobs · ${record.kept} kept`)
}

function cmdReview() {
  process.chdir(ROOT)
  const review = reviewFromFiles({ healthPath: HEALTH_FILE })
  if (JSON_MODE) { console.log(JSON.stringify(review, null, 2)); return }
  if (reviewIsEmpty(review)) { console.log('Portal health: nothing to suggest.'); return }
  console.log(renderReview(review))
}

function cmdList() {
  const company = (argValue('--company') || '').trim().toLowerCase()
  let rows = readHealthRows(HEALTH_FILE)
  if (company) rows = rows.filter((r) => r.company.toLowerCase() === company)
  if (JSON_MODE) { console.log(JSON.stringify(rows, null, 2)); return }
  if (rows.length === 0) { console.log('(no records)'); return }
  for (const r of rows) {
    console.log(`${r.date}  ${r.company.padEnd(24)}  ${r.source.padEnd(18)}  ${r.outcome.padEnd(11)}  ${String(r.jobs).padStart(5)} jobs  ${String(r.kept).padStart(3)} kept${r.note ? `  ${r.note}` : ''}`)
  }
}

switch (command) {
  case 'record': cmdRecord(); break
  case 'review': cmdReview(); break
  case 'list': cmdList(); break
  default: usageFail(command ? `unknown command "${command}"` : 'a command is required')
}

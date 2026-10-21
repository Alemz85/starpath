#!/usr/bin/env node

/**
 * triage-pipeline.mjs — zero-token pre-eval triage of the pipeline inbox.
 *
 * Ranks the Pending URLs in data/pipeline.md with deterministic signals
 * (scan relevance, posting freshness, dream/affinity companies, the brand
 * gate from user/portals.yml, title level, already-evaluated dedup hits)
 * and recommends the top slice for deep
 * evaluation. This is TODO.md's biggest token lever: deep-evaluate ~15
 * listings, not 300.
 *
 * Read-only by default. With --emit-batch it merges the deep-eval bucket
 * into batch/batch-input.tsv (idempotent — existing rows and URLs are kept),
 * ready for batch/batch-runner.sh.
 *
 * Usage:
 *   node scripts/triage-pipeline.mjs               # print the plan
 *   node scripts/triage-pipeline.mjs --top 10      # smaller deep-eval slice
 *   node scripts/triage-pipeline.mjs --json        # machine-readable output
 *   node scripts/triage-pipeline.mjs --emit-batch  # also write batch-input.tsv
 *   npm run triage                                  # alias for the default
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import yaml from 'js-yaml'

import {
  parsePendingEntries,
  buildScanIndex,
  buildDedupKeySet,
  triagePending,
  renderTriagePlan,
  emitBatchInput,
} from './lib/triage-core.mjs'
import { triageOptsFromConfig } from './lib/triage-config.mjs'

const PIPELINE_PATH = 'data/pipeline.md'
const SCAN_HISTORY_PATH = 'data/scan-history.tsv'
const DEDUP_INDEX_PATH = 'data/dedup-index.tsv'
const PROFILE_PATH = 'user/profile.yml'
const PORTALS_PATH = 'user/portals.yml'
const BATCH_INPUT_PATH = 'batch/batch-input.tsv'

const args = process.argv.slice(2)
const emitBatch = args.includes('--emit-batch')
const asJson = args.includes('--json')
const topIdx = args.indexOf('--top')
const topN = topIdx !== -1 ? Number(args[topIdx + 1]) : 15
if (!Number.isFinite(topN) || topN < 1) {
  process.stderr.write('triage: --top expects a positive number\n')
  process.exit(1)
}

function readSafe(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

const pipelineText = readSafe(PIPELINE_PATH)
if (!pipelineText) {
  process.stderr.write(`triage: ${PIPELINE_PATH} not found — run a scan first\n`)
  process.exit(1)
}

// User calibration data — read at run time, never hardcoded (Data Contract).
function loadYaml(path) {
  const raw = readSafe(path)
  if (!raw) return null
  try { return yaml.load(raw) ?? null } catch (e) {
    process.stderr.write(`triage: warning — could not parse ${path} (${e.message}); continuing without it\n`)
    return null
  }
}
const companyOpts = triageOptsFromConfig({ profile: loadYaml(PROFILE_PATH), portals: loadYaml(PORTALS_PATH) })
for (const w of companyOpts.warnings) process.stderr.write(`triage: warning — ${w}\n`)

const entries = parsePendingEntries(pipelineText)
const ranked = triagePending(entries, {
  topN,
  today: new Date().toISOString().slice(0, 10),
  scanIndex: buildScanIndex(readSafe(SCAN_HISTORY_PATH)),
  dedupKeys: buildDedupKeySet(readSafe(DEDUP_INDEX_PATH)),
  ...companyOpts,
})

if (asJson) {
  process.stdout.write(JSON.stringify({ topN, total: ranked.length, entries: ranked }, null, 2) + '\n')
} else {
  process.stdout.write(renderTriagePlan(ranked, { topN }) + '\n')
}

if (emitBatch) {
  const deep = ranked.filter(e => e.bucket === 'deep-eval')
  const existing = existsSync(BATCH_INPUT_PATH) ? readFileSync(BATCH_INPUT_PATH, 'utf8') : ''
  const { content, added, skipped } = emitBatchInput(deep, existing)
  writeFileSync(BATCH_INPUT_PATH, content, 'utf8')
  process.stderr.write(`\ntriage: ${BATCH_INPUT_PATH} updated — ${added} added, ${skipped} already present. Next: ./batch/batch-runner.sh --dry-run\n`)
}

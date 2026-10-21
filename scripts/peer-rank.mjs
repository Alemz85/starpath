#!/usr/bin/env node

/**
 * peer-rank.mjs — Comparative Rank Block computation (scoring v2).
 *
 * For a given listing's primary archetype + Match / Ease (+ dims), find peers
 * in data/score-history.tsv with the same primary archetype and compute:
 *   - rank percentile of this listing's Priority among peers (spec
 *     docs/scoring-v2.md §5: peer percentile is a sanctioned use of Priority;
 *     Priority itself is never rendered as a headline score)
 *   - where the listing's Match and its Ease each sit among the same peers —
 *     two separate claims, never combined
 *   - dimensional outliers over the ten v2 dims (|Δ| ≥ 1.5 from peer mean)
 *   - 3 closest comparables (by Priority delta, excluding the same company)
 *
 * Peers are same-archetype, NON-BLOCKED rows with a finite Priority. Blocked
 * rows (eligibility red) have empty score cells and never enter a peer pool.
 *
 * Returns null when peers < minPeers (default GATES.peerMinPeers = 5) — the
 * peer block is OMITTED entirely below the threshold, never rendered with a
 * "not enough data yet" placeholder. A blocked target listing also returns
 * null (it has no Match / Ease to rank). `peerRankDetailed()` returns the same
 * block plus the reason it was omitted.
 *
 * Statistical honesty (docs/scoring-statistical-design.md § 3.2): above the
 * gate every rendered claim states its n and carries a confidence tier, so a
 * rank computed from 5 peers can't be read like one computed from 40.
 *
 * INPUT (JSON on stdin, or the first argument of peerRank()):
 *
 *   {
 *     "archetype":   "Strategy & Operations",   // required; compound "A + B" ranks on "A"
 *     "company":     "Fabrikam Labs",            // excluded from comparables
 *     "match":        8.25,                       // number, or the score-listing.mjs
 *     "ease":        5.6,                        //   object form { "score": 8.25, ... }
 *     "priority":    6.8,                        // optional; else √(match·ease)
 *     "dims":        { "skills_match": 8, ... }, // optional; any of the 10 v2 dims
 *     "eligibility": "green" | "amber" | "red",  // optional; red → blocked → null
 *     "verdict":     "stretch"                   // optional; "blocked" → null
 *   }
 *
 *   `this_dims` is accepted as an alias of `dims`. When `match` / `ease` are
 *   missing but `dims` holds every Match / Ease dimension, they are derived
 *   with the engine's rollupMatch / rollupEase at default weights (no dream
 *   floor, no amber penalty unless `amber_count` is given) — pass the stored
 *   numbers whenever you have them; `score_source` says which was used.
 *
 * Usage as script:
 *
 *   echo '{ "archetype": "Strategy & Operations", "company": "Fabrikam Labs",
 *           "match": 8.25, "ease": 5.6, "dims": {...} }' | node scripts/peer-rank.mjs
 *
 *   Prints the block as JSON, or `null` (with the reason on stderr).
 *
 * Usage as library:
 *
 *   import { peerRank } from './peer-rank.mjs'
 *   const block = await peerRank({ archetype, company, match, ease, dims })
 *
 *   Options: { minPeers, rows (pre-parsed score-history rows), historyPath }.
 *   By default the history is read from data/score-history.tsv relative to
 *   the current working directory, at call time.
 */

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { GATES, confidenceTier } from './lib/scoring-stats.mjs'
import {
  parseScoreHistory, isScored, normalizeArchetype, DIMENSIONS,
} from './lib/targeting-core.mjs'
import {
  computePriority, rollupMatch, rollupEase, MATCH_DIMS, EASE_DIMS,
} from './lib/score-bands.mjs'

const SCORE_HISTORY_PATH = 'data/score-history.tsv'
const OUTLIER_THRESHOLD = 1.5

const round2 = (n) => Math.round(n * 100) / 100
const fmt = (n) => Number(n).toFixed(2)

/** A number from a plain value or a rollup object ({ score }); null otherwise. */
function scoreOf(v) {
  const x = v != null && typeof v === 'object' ? v.score : v
  if (x == null || x === '') return null
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function primarySegment(archetype) {
  return normalizeArchetype(archetype ?? '').split(' + ')[0].trim()
}

/** Normalize the v2 input. @returns {{ match, ease, priority, dims, blocked, scoreSource }} */
export function normalizeTarget(input = {}) {
  const dims = {}
  const rawDims = input.dims ?? input.this_dims ?? {}
  for (const { key } of DIMENSIONS) {
    const n = scoreOf(rawDims[key])
    if (n != null) dims[key] = n
  }
  const blocked = String(input.eligibility ?? '').toLowerCase() === 'red'
    || String(input.verdict ?? '').toLowerCase() === 'blocked'
  let match = scoreOf(input.match)
  let ease = scoreOf(input.ease)
  let scoreSource = 'input'
  if (!blocked && (match == null || ease == null)) {
    const haveMatch = MATCH_DIMS.every(k => dims[k] != null)
    const haveEase = EASE_DIMS.every(k => dims[k] != null)
    if (match == null && haveMatch) { match = rollupMatch(dims).score; scoreSource = 'dims' }
    if (ease == null && haveEase) {
      ease = rollupEase(dims, { amber_count: Number(input.amber_count) || 0 }).score
      scoreSource = 'dims'
    }
  }
  let priority = scoreOf(input.priority)
  if (priority == null) priority = computePriority(match, ease)
  return { match, ease, priority, dims, blocked, scoreSource }
}

/** Percentile + bucket of `value` among `values` (share of peers it beats). */
function placement(value, values, minPeers) {
  const n = values.length
  const beats = values.filter(s => s < value).length
  const percentile = Math.round((beats / n) * 100)
  const rank_position = n - beats // 1 = top
  return {
    percentile,
    rank_position,
    rank: rankLabel(percentile, rank_position, n),
    peer_n: n,
    confidence: confidenceTier(n, minPeers),
  }
}

/**
 * The full computation, with the reason when the block is omitted.
 *
 * @returns {Promise<{ block: null | PeerBlock, reason: null | 'no-archetype' | 'blocked' | 'no-score' | 'below-gate', message: string | null }>}
 *
 * PeerBlock = {
 *   archetype, n_peers, min_peers, confidence,          // n + tier (g = minPeers)
 *   priority, rank, rank_position, percentile,           // Priority placement (sort key only)
 *   match: { value, peer_avg, percentile, rank, rank_position, peer_n, confidence } | null,
 *   ease: { value, peer_avg, percentile, rank, rank_position, peer_n, confidence } | null,
 *   score_source: 'input' | 'dims',
 *   outliers: Array<{ dim, label, group, rollup, peer_avg, delta, peer_n, confidence }>,
 *   comparables: Array<{ company, role, match, ease, verdict, priority, delta }>,
 *   formatted: string  // ready-to-paste 3-line markdown
 * }
 */
export async function peerRankDetailed(input = {}, {
  minPeers = GATES.peerMinPeers,
  rows,
  historyPath = SCORE_HISTORY_PATH,
} = {}) {
  const omit = (reason, message) => ({ block: null, reason, message })
  const { archetype, company } = input
  const primarySeg = primarySegment(archetype)
  if (!primarySeg || primarySeg === 'Unknown') return omit('no-archetype', 'No archetype given.')

  const target = normalizeTarget(input)
  if (target.blocked) {
    return omit('blocked', 'The listing is Blocked (eligibility red): it has no Match / Ease to rank against peers.')
  }
  if (target.priority == null) {
    return omit('no-score', 'Need match + ease (or priority, or every Match / Ease dimension) to rank the listing.')
  }

  const history = rows ?? await loadHistory(historyPath)
  const peers = history.filter(r =>
    isScored(r)
    && Number.isFinite(r.priority)
    && primarySegment(r.archetype).toLowerCase() === primarySeg.toLowerCase(),
  )

  if (peers.length < minPeers) {
    return omit('below-gate', `${peers.length} scored ${primarySeg} peer(s); the block needs ${minPeers}.`)
  }

  // Priority rank: how many peers' Priority does this listing beat?
  const prio = placement(target.priority, peers.map(r => r.priority), minPeers)

  // Confidence tier over the peer count (docs § 3.1, gate = minPeers). At the
  // gate one peer is 20 percentile points, so only the top-half / bottom-half
  // split is meaningful; at 4× the gate one peer is ≤5 points.
  const confidence = confidenceTier(peers.length, minPeers)

  // Match and Ease, each placed among the same peers — separate claims.
  const metricPlacement = (metric) => {
    const value = target[metric]
    if (value == null) return null
    const vals = peers.map(r => r[metric]).filter(Number.isFinite)
    if (vals.length === 0) return null
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    return { value: round2(value), peer_avg: round2(avg), ...placement(value, vals, minPeers) }
  }
  const match = metricPlacement('match')
  const ease = metricPlacement('ease')

  // Outliers — dim-by-dim Δ from peer mean over the ten v2 dims, ≥ threshold.
  // Each outlier carries its OWN n (peers that scored that dimension).
  const outliers = []
  for (const { key, label, group, rollup } of DIMENSIONS) {
    const own = target.dims[key]
    if (own == null) continue
    const peerVals = peers.map(r => r[key]).filter(Number.isFinite)
    if (peerVals.length === 0) continue
    const peerAvg = peerVals.reduce((a, b) => a + b, 0) / peerVals.length
    const delta = own - peerAvg
    if (Math.abs(delta) >= OUTLIER_THRESHOLD) {
      outliers.push({
        dim: key,
        label,
        group,
        rollup,
        peer_avg: Number(peerAvg.toFixed(2)),
        delta: Number(delta.toFixed(1)),
        peer_n: peerVals.length,
        confidence: confidenceTier(peerVals.length, minPeers),
      })
    }
  }
  outliers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // 3 closest comparables by Priority, excluding the listing's own company.
  const comparables = peers
    .filter(r => !sameCompany(r.company, company))
    .map(r => ({
      company: r.company,
      role: r.role,
      match: round2(r.match),
      ease: round2(r.ease),
      verdict: r.verdict,
      priority: round2(r.priority),
      delta: round2(Math.abs(r.priority - target.priority)),
    }))
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3)

  // Pre-formatted markdown block — paste verbatim into reports.
  //
  // Kept at exactly THREE bold lines: the report parsers (and the desktop
  // app's static-block carve) key off this shape. The n and the confidence
  // tier ride inside line 1 rather than becoming a fourth line.
  const lowNote = confidence === 'low'
    ? ' — at this sample read the half, not the quartile'
    : ''
  const scorePart = match && ease
    ? `Match ${fmt(match.value)} · Ease ${fmt(ease.value)} — `
    : ''
  const placements = [
    match ? `Match ${match.rank}` : null,
    ease ? `Ease ${ease.rank}` : null,
  ].filter(Boolean)
  const formatted = [
    `**Rank vs ${primarySeg} peers:** ${scorePart}${prio.rank} of ${peers.length} peers evaluated by priority${placements.length ? ` (${placements.join(', ')})` : ''} · ${confidence} confidence (n=${peers.length})${lowNote}`,
    `**Dimension outliers:** ${
      outliers.length === 0
        ? 'none ≥ ±1.5 from peer average'
        : outliers.map(o => `${o.label} ${o.delta >= 0 ? '+' : ''}${o.delta.toFixed(1)} ${o.delta >= 0 ? 'above' : 'below'} avg (n=${o.peer_n})`).join(' · ')
    }`,
    `**Closest comparables:** ${
      comparables.length === 0
        ? 'none in archetype'
        : comparables.map(c => `${c.company} (M${fmt(c.match)} · E${fmt(c.ease)})`).join(' · ')
    }`,
  ].join('\n')

  return {
    block: {
      archetype: primarySeg,
      n_peers: peers.length,
      min_peers: minPeers,
      confidence,
      priority: round2(target.priority),
      rank: prio.rank,
      rank_position: prio.rank_position,
      percentile: prio.percentile,
      match,
      ease,
      score_source: target.scoreSource,
      outliers,
      comparables,
      formatted,
    },
    reason: null,
    message: null,
  }
}

/** The peer block, or null when omitted (below the gate, blocked, no score). */
export async function peerRank(input, opts) {
  return (await peerRankDetailed(input, opts)).block
}

async function loadHistory(relativePath) {
  const path = resolve(process.cwd(), relativePath)
  if (!existsSync(path)) return []
  return parseScoreHistory(await readFile(path, 'utf8'))
}

function rankLabel(percentile, position, total) {
  if (percentile >= 95) return `top 5%`
  if (percentile >= 90) return `top 10%`
  if (percentile >= 75) return `top quartile`
  if (percentile >= 50) return `top half`
  return `bottom half (#${position} of ${total})`
}

function sameCompany(a, b) {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/* ───── CLI entry ──────────────────────────────────────────────── */

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const HELP = `Usage: echo '<json>' | node scripts/peer-rank.mjs

Comparative Rank Block for one listing against same-archetype, non-blocked
peers in data/score-history.tsv (read from the current directory).

Input JSON: { "archetype", "company", "match", "ease", "priority"?, "dims"?,
              "eligibility"?, "verdict"? }
Prints the block as JSON, or null (reason on stderr) below ${GATES.peerMinPeers} peers or
for a blocked listing.`

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP + '\n')
    return
  }
  const raw = await readStdin()
  if (!raw.trim()) {
    process.stderr.write('peer-rank: empty stdin — pipe a JSON input (see --help)\n')
    process.exit(1)
  }
  const input = JSON.parse(raw)
  const { block, message } = await peerRankDetailed(input)
  if (block == null && message) process.stderr.write(`peer-rank: block omitted — ${message}\n`)
  process.stdout.write(block == null ? 'null\n' : JSON.stringify(block, null, 2) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`peer-rank: ${err.stack ?? err.message ?? err}\n`)
    process.exit(2)
  })
}

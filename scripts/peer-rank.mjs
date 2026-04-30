#!/usr/bin/env node

/**
 * peer-rank.mjs — Comparative Rank Block computation.
 *
 * For a given listing's primary archetype + dim scores, find peers in
 * data/score-history.tsv with the same primary archetype, compute:
 *   - rank percentile of this listing's overall score among peers
 *   - dimensional outliers (this listing ±X above/below peer avg, |Δ| ≥ 1.5)
 *   - 3 closest comparables (by overall score delta, excluding self)
 *
 * Returns null when peers < minPeers (default 5) — per
 * modes/scouting.md, the peer block is OMITTED entirely below the
 * threshold, never rendered with a "not enough data yet" placeholder.
 *
 * Usage as script:
 *
 *   echo '{ "archetype": "Strategy & Operations", "company": "Microsoft",
 *           "this_overall": 7.8, "this_dims": {...} }' | node scripts/peer-rank.mjs
 *
 * Usage as library:
 *
 *   import { peerRank } from './peer-rank.mjs'
 *   const block = await peerRank({ archetype, company, this_overall, this_dims })
 */

import { readTsv } from './lib/cache-tsv.mjs'

const SCORE_HISTORY_PATH = 'data/score-history.tsv'
const DIM_KEYS = [
  'skills_match', 'ease_of_entry', 'strategic_fit',
  'growth_mobility', 'optionality_exit', 'brand_value',
]
const DIM_LABELS = {
  skills_match:     'Skills Match',
  ease_of_entry:    'Ease of Entry',
  strategic_fit:    'Strategic Fit',
  growth_mobility:  'Growth/Mobility',
  optionality_exit: 'Optionality/Exit',
  brand_value:      'Brand Value',
}
const OUTLIER_THRESHOLD = 1.5

/**
 * @returns {Promise<null | {
 *   archetype, n_peers, rank, rank_position, percentile,
 *   outliers: Array<{ dim, label, peer_avg, delta }>,
 *   comparables: Array<{ company, role, overall, delta }>,
 *   formatted: string  // ready-to-paste 3-line markdown
 * }>}
 */
export async function peerRank(
  { archetype, company, this_overall, this_dims },
  { minPeers = 5 } = {},
) {
  const { rows } = await readTsv(SCORE_HISTORY_PATH)
  const primarySeg = (archetype ?? '').split(' + ')[0].trim()
  if (!primarySeg) return null

  const peers = rows.filter(r => {
    const peerSeg = (r.archetype ?? '').split(' + ')[0].trim()
    return peerSeg.toLowerCase() === primarySeg.toLowerCase()
      && Number.isFinite(Number(r.overall))
  })

  if (peers.length < minPeers) return null

  // Rank: how many peers' overall scores does this listing beat or tie?
  const peerOveralls = peers.map(r => Number(r.overall))
  const beats = peerOveralls.filter(s => s < this_overall).length
  const percentile = Math.round((beats / peers.length) * 100)
  const rank_position = peers.length - beats   // 1 = top
  const rank = rankLabel(percentile, rank_position, peers.length)

  // Outliers — dim-by-dim Δ from peer mean, ≥ OUTLIER_THRESHOLD
  const outliers = []
  for (const dim of DIM_KEYS) {
    if (this_dims[dim] == null) continue
    const peerVals = peers.map(r => Number(r[dim])).filter(Number.isFinite)
    if (peerVals.length === 0) continue
    const peerAvg = peerVals.reduce((a, b) => a + b, 0) / peerVals.length
    const delta = this_dims[dim] - peerAvg
    if (Math.abs(delta) >= OUTLIER_THRESHOLD) {
      outliers.push({
        dim,
        label:    DIM_LABELS[dim] ?? dim,
        peer_avg: Number(peerAvg.toFixed(2)),
        delta:    Number(delta.toFixed(1)),
      })
    }
  }
  outliers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // 3 closest comparables by overall, excluding self
  const comparables = peers
    .filter(r => !sameCompany(r.company, company))
    .map(r => ({
      company: r.company,
      role:    r.role,
      overall: Number(r.overall),
      delta:   Math.abs(Number(r.overall) - this_overall),
    }))
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3)
    .map(c => ({ ...c, overall: Number(c.overall.toFixed(2)) }))

  // Pre-formatted markdown block — paste verbatim into reports
  const formatted = [
    `**Rank vs ${primarySeg} peers:** ${this_overall.toFixed(1)}/10 — ${rank} of ${peers.length} roles evaluated`,
    `**Dimension outliers:** ${
      outliers.length === 0
        ? 'none ≥ ±1.5 from peer average'
        : outliers.map(o => `${o.label} ${o.delta >= 0 ? '+' : ''}${o.delta.toFixed(1)} ${o.delta >= 0 ? 'above' : 'below'} avg`).join(' · ')
    }`,
    `**Closest comparables:** ${
      comparables.length === 0
        ? 'none in archetype'
        : comparables.map(c => `${c.company} (${c.overall.toFixed(2)})`).join(' · ')
    }`,
  ].join('\n')

  return {
    archetype: primarySeg,
    n_peers:   peers.length,
    rank,
    rank_position,
    percentile,
    outliers,
    comparables,
    formatted,
  }
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

async function main() {
  const raw = await readStdin()
  if (!raw.trim()) {
    process.stderr.write('peer-rank: empty stdin — pipe a JSON input\n')
    process.exit(1)
  }
  const input = JSON.parse(raw)
  const result = await peerRank(input)
  process.stdout.write((result == null ? 'null\n' : JSON.stringify(result, null, 2) + '\n'))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`peer-rank: ${err.stack ?? err.message ?? err}\n`)
    process.exit(2)
  })
}

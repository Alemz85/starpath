// offerDrafts.ts — pure helpers that turn the evaluation corpus into prefilled
// offer drafts for the cockpit Offer-comparison view.
//
// The view holds an array of editable "drafts" (a label + the six 1-10 factor
// scores). Three of those factors are exactly the dimensions a scouting
// evaluation already produced, so when the user picks an evaluated role we
// prefill from it instead of making them re-key numbers the system already
// knows:
//
//   fit    ← the role's Overall (already CF×0.70 + AF×0.30)
//   growth ← Growth/Mobility dimension
//   brand  ← Brand Value dimension
//   comp   ← Salary-Adj-for-city dimension (the savings-power band score)
//
// location + risk are NOT prefilled — per modes/ofertas.md they're candidate-
// preference / employer-stability judgments the evaluation doesn't capture, so
// they start neutral (5) for the user to set. Nothing here hardcodes a
// candidate's cities, companies, or comp targets; it only reshapes whatever the
// user's own score-history already holds.

import type { Factor, FactorScores } from '@/lib/offerCompare'
import type { ScoreEntry } from '@/types'

export interface OfferDraft {
  /** Stable client id so React keys survive reorder/delete. */
  id: string
  /** Human-readable identifier, e.g. "Stripe — Analyst". Must be unique among
   *  drafts before a comparison runs (compareOffers enforces it). */
  label: string
  scores: FactorScores
  /** entityId (or company::role) this draft was prefilled from, if any — lets
   *  the view mark a source role as "already added" in the picker. */
  sourceKey?: string
}

export const NEUTRAL_FACTOR = 5

export function neutralScores(): FactorScores {
  return { comp: NEUTRAL_FACTOR, fit: NEUTRAL_FACTOR, growth: NEUTRAL_FACTOR, brand: NEUTRAL_FACTOR, location: NEUTRAL_FACTOR, risk: NEUTRAL_FACTOR }
}

// Clamp + round any number into the valid 1-10 integer factor range. Scores in
// score-history are already 1-10 but may be fractional (the Overall rollup) or,
// for legacy rows, missing/0 — guard so a draft never carries an out-of-range
// value into compareOffers (which would throw).
export function clampFactor(n: number | undefined | null): number {
  if (!Number.isFinite(n as number)) return NEUTRAL_FACTOR
  return Math.max(1, Math.min(10, Math.round(n as number)))
}

let counter = 0
function nextId(): string {
  counter += 1
  return `offer-${Date.now().toString(36)}-${counter}`
}

// A short label for a score entry, "Company — Role", trimmed so the comparison
// table stays readable. Falls back gracefully when role is empty.
export function offerLabel(company: string, role: string): string {
  const c = (company || '').trim()
  const r = (role || '').trim()
  if (c && r) return `${c} — ${r}`
  return c || r || 'Offer'
}

/**
 * Build a prefilled draft from one evaluated role. fit/growth/brand/comp come
 * from the evaluation; location/risk start neutral. The `overall` is used for
 * fit directly (it already encodes the CF/AF rollup) — we don't re-derive.
 */
export function draftFromScoreEntry(e: ScoreEntry): OfferDraft {
  return {
    id: nextId(),
    label: offerLabel(e.company, e.role),
    sourceKey: scoreEntryKey(e),
    scores: {
      comp: clampFactor(e.salary_adj_city),
      fit: clampFactor(e.overall),
      growth: clampFactor(e.growth_mobility),
      brand: clampFactor(e.brand_value),
      location: NEUTRAL_FACTOR,
      risk: NEUTRAL_FACTOR,
    },
  }
}

/** A blank, hand-entered draft. Caller supplies a starting label. */
export function blankDraft(label = ''): OfferDraft {
  return { id: nextId(), label, scores: neutralScores() }
}

// Identity for an evaluated role — prefer the entity URL (stable join key in
// score-history), else company|role lowercased. Used to dedup the picker and
// mark already-added roles.
export function scoreEntryKey(e: ScoreEntry): string {
  if (e.url) return `url:${e.url.trim().toLowerCase()}`
  return `cr:${(e.company || '').trim().toLowerCase()}|${(e.role || '').trim().toLowerCase()}`
}

export interface PickableRole {
  key: string
  company: string
  role: string
  overall: number
  date: string
  tier: string
}

/**
 * Reduce the score-history corpus to a deduped, ranked list of roles the user
 * can prefill an offer from. Latest evaluation per (company,role) wins;
 * highest-Overall first so the strongest matches are easiest to pick. Rows with
 * no company are dropped. Pure — the view memoizes over `scoreHistory`.
 */
export function pickableRoles(scoreHistory: ScoreEntry[]): PickableRole[] {
  const byKey = new Map<string, ScoreEntry>()
  for (const e of scoreHistory) {
    if (!e.company?.trim()) continue
    const key = scoreEntryKey(e)
    const prev = byKey.get(key)
    // Keep the most recent evaluation for the entity (date is YYYY-MM-DD, so a
    // lexical compare is a chronological compare).
    if (!prev || (e.date ?? '') >= (prev.date ?? '')) byKey.set(key, e)
  }
  return [...byKey.values()]
    .map((e) => ({
      key: scoreEntryKey(e),
      company: e.company,
      role: e.role,
      overall: e.overall,
      date: e.date,
      tier: typeof e.tier === 'string' ? e.tier : 'T4',
    }))
    .sort((a, b) => b.overall - a.overall || a.company.localeCompare(b.company))
}

// Are these drafts ready to compare? Need ≥2 with unique, non-empty labels —
// the same preconditions compareOffers enforces, surfaced early so the view can
// disable/explain rather than letting the engine throw.
export interface DraftReadiness {
  ready: boolean
  reason?: 'need-two' | 'blank-label' | 'duplicate-label'
}

export function draftsReadiness(drafts: OfferDraft[]): DraftReadiness {
  if (drafts.length < 2) return { ready: false, reason: 'need-two' }
  const labels = drafts.map((d) => d.label.trim())
  if (labels.some((l) => l.length === 0)) return { ready: false, reason: 'blank-label' }
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
    return { ready: false, reason: 'duplicate-label' }
  }
  return { ready: true }
}

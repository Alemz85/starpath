'use client'

// Offers — the cockpit's end-of-funnel offer-comparison view.
//
// When the user has 2+ live offers, this view produces the same weighted
// ranking + tradeoffs + recommendation the backend `compare-offers` engine
// would (modes/ofertas.md), computed entirely in-renderer via the tested
// `@/lib/offerCompare` port — no shell-out, no IPC round-trip.
//
// Data flow: the view holds an array of editable drafts (label + six 1-10
// factor scores) and a weights object. Drafts can be prefilled from any
// evaluated role in score-history (fit/growth/brand/comp come from the
// evaluation; location/risk start neutral for the user to judge) or entered
// blank. Every keystroke re-runs compareOffers and the result re-renders live.
// Nothing is written to disk — this is a decision aid, and offers live at the
// very end of the funnel where the call is the user's to make.

import { useMemo, useState } from 'react'
import { Scale, Info, RotateCcw } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  compareOffers,
  DEFAULT_WEIGHTS,
  type Factor,
  type FactorScores,
  type ComparisonResult as Result,
} from '@/lib/offerCompare'
import {
  blankDraft,
  draftFromScoreEntry,
  draftsReadiness,
  pickableRoles,
  type OfferDraft,
  type PickableRole,
} from '@/lib/offerDrafts'
import type { ScoreEntry } from '@/types'
import { OfferCard } from './OfferCard'
import { WeightsPanel } from './WeightsPanel'
import { ComparisonResult } from './ComparisonResult'
import { AddOfferMenu } from './AddOfferMenu'

const MIN_OFFERS = 2

export function OffersView() {
  const loaded = useDataStore((s) => s.loaded)
  const scoreHistory = useDataStore((s) => s.scoreHistory)

  const [drafts, setDrafts] = useState<OfferDraft[]>([])
  const [weights, setWeights] = useState<FactorScores>({ ...DEFAULT_WEIGHTS })

  // The evaluated-role corpus, deduped + ranked, for the prefill picker.
  const roles = useMemo(() => pickableRoles(scoreHistory), [scoreHistory])
  const scoreByKey = useMemo(() => {
    const m = new Map<string, ScoreEntry>()
    for (const e of scoreHistory) {
      const key = e.url ? `url:${e.url.trim().toLowerCase()}` : `cr:${e.company.trim().toLowerCase()}|${e.role.trim().toLowerCase()}`
      if (!m.has(key) || (e.date ?? '') >= (m.get(key)!.date ?? '')) m.set(key, e)
    }
    return m
  }, [scoreHistory])

  const usedKeys = useMemo(
    () => new Set(drafts.map((d) => d.sourceKey).filter((k): k is string => !!k)),
    [drafts],
  )

  const readiness = draftsReadiness(drafts)

  // Duplicate-label set (case-insensitive) so each offending card can flag itself.
  const dupLabels = useMemo(() => {
    const seen = new Map<string, number>()
    for (const d of drafts) {
      const k = d.label.trim().toLowerCase()
      if (!k) continue
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  }, [drafts])

  // The live comparison. Only computed when the drafts satisfy the engine's
  // preconditions (≥2, unique non-empty labels) — otherwise null and the view
  // shows guidance instead of a crashed table.
  const result: Result | null = useMemo(() => {
    if (!readiness.ready) return null
    try {
      return compareOffers(
        drafts.map((d) => ({ label: d.label.trim(), scores: d.scores })),
        weights,
      )
    } catch {
      return null
    }
  }, [drafts, weights, readiness.ready])

  // Map label → rank/total so each card can show its standing inline.
  const standings = useMemo(() => {
    const m = new Map<string, { rank: number; total: number; isWinner: boolean }>()
    if (result) for (const r of result.ranking) m.set(r.label.trim(), { rank: r.rank, total: r.total, isWinner: r.rank === 1 })
    return m
  }, [result])

  // ── Mutators ──
  const addRole = (r: PickableRole) => {
    const entry = scoreByKey.get(r.key)
    if (!entry) return
    setDrafts((ds) => [...ds, draftFromScoreEntry(entry)])
  }
  const addBlank = () => setDrafts((ds) => [...ds, blankDraft('')])
  const removeDraft = (id: string) => setDrafts((ds) => ds.filter((d) => d.id !== id))
  const setLabel = (id: string, label: string) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, label } : d)))
  const setScore = (id: string, factor: Factor, value: number) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, scores: { ...d.scores, [factor]: value } } : d)))
  const setWeight = (factor: Factor, value: number) => setWeights((w) => ({ ...w, [factor]: value }))
  const resetWeights = () => setWeights({ ...DEFAULT_WEIGHTS })
  const clearAll = () => setDrafts([])

  const hasDrafts = drafts.length > 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Title bar */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <div className="flex items-center gap-2">
          <Scale size={15} className="text-accent" />
          <h1 className="text-body text-text-1 font-medium">Offers</h1>
        </div>
        {hasDrafts && (
          <span className="text-label text-text-4 font-mono">
            {drafts.length} {drafts.length === 1 ? 'offer' : 'offers'}
          </span>
        )}
        <div className="flex-1" />
        <div className="titlebar-no-drag flex items-center gap-2">
          {hasDrafts && (
            <button
              onClick={clearAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
              title="Clear all offers"
            >
              <RotateCcw size={12} />
              Clear
            </button>
          )}
          <AddOfferMenu roles={roles} usedKeys={usedKeys} onPickRole={addRole} onAddBlank={addBlank} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Getting-started state — no offers yet. */}
        {!hasDrafts ? (
          <div className="h-full flex items-center justify-center p-8">
            <div className="max-w-[560px] w-full text-center flex flex-col items-center gap-5">
              <EmptyState
                title="Weigh two or more offers side by side"
                hint={
                  loaded && roles.length > 0
                    ? 'Add an offer to start. Prefill from a role you already evaluated — its fit, growth, brand and comp scores carry over — or enter one by hand. Then set how much each factor matters to you and the ranking updates live.'
                    : 'Add offers to compare them on the same six-factor model the evaluation engine uses — compensation, fit, growth, brand, location and risk — weighted by what you care about.'
                }
              />
              <div className="flex items-center gap-2.5">
                <AddOfferMenu roles={roles} usedKeys={usedKeys} onPickRole={addRole} onAddBlank={addBlank} />
              </div>
              <p className="text-[11px] text-text-4 max-w-[44ch] leading-snug">
                The same weighted-ranking math as the backend <span className="font-mono">compare-offers</span> engine.
                Nothing here is saved — it&apos;s a decision aid; the call is yours.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-4 max-w-[1100px] mx-auto">
            {/* Result, or the "not ready yet" nudge. */}
            {result ? (
              <ComparisonResult result={result} />
            ) : (
              <NotReadyHint reason={readiness.reason} />
            )}

            <WeightsPanel weights={weights} onChange={setWeight} onReset={resetWeights} />

            {/* Offer cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {drafts.map((d) => {
                const standing = standings.get(d.label.trim())
                return (
                  <OfferCard
                    key={d.id}
                    draft={d}
                    rank={standing?.rank}
                    total={standing?.total}
                    isWinner={standing?.isWinner}
                    duplicateLabel={dupLabels.has(d.label.trim().toLowerCase())}
                    onLabelChange={(label) => setLabel(d.id, label)}
                    onScoreChange={(f, v) => setScore(d.id, f, v)}
                    onRemove={() => removeDraft(d.id)}
                    canRemove={drafts.length > MIN_OFFERS || !result}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function NotReadyHint({ reason }: { reason?: 'need-two' | 'blank-label' | 'duplicate-label' }) {
  const text =
    reason === 'blank-label'
      ? 'Give every offer a name to run the comparison.'
      : reason === 'duplicate-label'
        ? 'Two offers share a name — make each label unique.'
        : 'Add at least one more offer to compare.'
  return (
    <div className="rounded-2xl border border-dashed border-border-strong bg-bg-panel/50 px-5 py-4 flex items-center gap-3">
      <Info size={15} className="text-text-4 shrink-0" />
      <p className="text-body text-text-3">{text}</p>
    </div>
  )
}

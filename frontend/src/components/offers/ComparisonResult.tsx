'use client'

// The verdict surface — renders a ComparisonResult from offerCompare.ts:
//   1. Recommendation (winner, close-call vs clear-pick, decisive factor)
//   2. Tradeoffs — what the winner wins on, what it concedes (the honest part)
//   3. Ranking matrix — every offer × six factors, weighted total, best first
//
// All numbers come straight from the engine; this component only lays them out.
// The winner's name is the page's one larger title; everything else stays in
// the dense workhorse scale.

import { Scale } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FACTORS,
  FACTOR_LABELS,
  type ComparisonResult as Result,
  type Factor,
} from '@/lib/offerCompare'
import { Chip, Panel, ScoreNumber, SectionHeading } from '@/components/ui'

interface ComparisonResultProps {
  result: Result
}

export function ComparisonResult({ result }: ComparisonResultProps) {
  const { ranking, winner, runnerUp, margin, isCloseCall, tradeoffs, weights } = result

  return (
    <div className="flex flex-col gap-3">
      {/* ── Recommendation ── */}
      <section className="card p-4">
        <div className="flex items-center gap-2">
          <span className="label">{isCloseCall ? 'Close call' : 'Recommendation'}</span>
          <Chip
            tone={isCloseCall ? 'warning' : 'accent'}
            size="sm"
            title="Weighted-total margin over the runner-up"
          >
            {isCloseCall ? 'Margin ' : '+'}{margin.toFixed(2)}
          </Chip>
        </div>
        <h2 className="mt-1.5 text-page text-text-1">{winner.label}</h2>
        <p className="mt-1.5 text-body text-text-2 max-w-[68ch]">{result.recommendation}</p>
        {tradeoffs.decisiveFactor && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-label text-text-3">
            <Scale size={12} className="text-text-4" aria-hidden />
            Decided mainly on{' '}
            <span className="text-text-1 font-medium">{tradeoffs.decisiveFactor.label}</span>
          </div>
        )}
      </section>

      {/* ── Tradeoffs — winner wins vs concedes ── */}
      {(tradeoffs.winnerWins.length > 0 || tradeoffs.runnerUpWins.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TradeoffColumn
            kind="wins"
            heading={`${winner.label} wins on`}
            entries={tradeoffs.winnerWins}
          />
          <TradeoffColumn
            kind="concedes"
            heading={`Concedes to ${runnerUp.label}`}
            entries={tradeoffs.runnerUpWins}
          />
        </div>
      )}

      {/* ── Ranking matrix ── */}
      <section className="card overflow-hidden">
        <SectionHeading className="px-4 pt-3 mb-0" title="Ranking" meta="Same six-factor model as the backend engine" />
        <div className="overflow-x-auto">
          <table className="w-full text-body border-collapse">
            <thead>
              <tr className="bg-bg-elevated/60 border-b border-border-default">
                <th className="th text-left px-4 h-9 sticky left-0 bg-bg-elevated/60">Offer</th>
                {FACTORS.map((f: Factor) => (
                  <th key={f} className="th text-center px-2 h-9" title={FACTOR_LABELS[f]}>
                    {shortFactor(f)}
                    <span className="ml-1 font-normal text-text-4">{Math.round(weights[f] * 100)}%</span>
                  </th>
                ))}
                <th className="th text-right px-4 h-9">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {ranking.map((o) => (
                <tr key={o.label} className="group h-10 hover:bg-bg-elevated transition-colors duration-150">
                  <td className="px-4 sticky left-0 bg-bg-base group-hover:bg-bg-elevated transition-colors duration-150">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 w-4 text-label text-text-4 tabular-nums">{o.rank}</span>
                      <span className={cn('truncate', o.rank === 1 ? 'text-text-1 font-medium' : 'text-text-2')}>
                        {o.label}
                      </span>
                    </div>
                  </td>
                  {FACTORS.map((f: Factor) => (
                    <td key={f} className="px-2 text-center">
                      <ScoreNumber
                        value={o.scores[f]}
                        size="sm"
                        decimals={0}
                        title={`Score ${o.scores[f]} · contributes ${o.contributions[f].toFixed(2)} to the total`}
                      />
                    </td>
                  ))}
                  <td className="px-4 text-right">
                    <ScoreNumber value={o.total} size="sm" decimals={2} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function TradeoffColumn({
  kind,
  heading,
  entries,
}: {
  kind: 'wins' | 'concedes'
  heading: string
  entries: Array<{ factor: Factor; label: string; winnerScore: number; runnerUpScore: number; gap: number }>
}) {
  const accent = kind === 'wins'
  return (
    <Panel title={heading}>
      {entries.length === 0 ? (
        <p className="text-label text-text-4">
          {accent ? 'No material lead on any single factor.' : 'Concedes nothing material.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li key={e.factor} className="flex items-center justify-between gap-2 text-label">
              <span className="text-text-2 truncate">{e.label}</span>
              <span className="tabular-nums text-text-3 shrink-0">
                {/* For "wins" show winner→runnerUp; for "concedes" show the runner-up's lead. */}
                {accent ? (
                  <>
                    <ScoreNumber value={e.winnerScore} size="sm" decimals={0} />
                    <span className="text-text-4"> vs {e.runnerUpScore}</span>
                  </>
                ) : (
                  <>
                    <ScoreNumber value={e.runnerUpScore} size="sm" decimals={0} />
                    <span className="text-text-4"> vs {e.winnerScore}</span>
                  </>
                )}
                <span className={accent ? 'text-success' : 'text-text-4'}> · +{e.gap}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// Tight column headers for the matrix — the full label is in the title attr.
function shortFactor(f: Factor): string {
  const map: Record<Factor, string> = {
    comp: 'Comp',
    fit: 'Fit',
    growth: 'Growth',
    brand: 'Brand',
    location: 'Loc',
    risk: 'Risk',
  }
  return map[f]
}

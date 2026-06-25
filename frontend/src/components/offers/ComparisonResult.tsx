'use client'

// The verdict surface — renders a ComparisonResult from offerCompare.ts:
//   1. Recommendation banner (winner, close-call vs clear-pick, decisive factor)
//   2. Tradeoffs — what the winner wins on, what it concedes (the honest part)
//   3. Ranking matrix — every offer × six factors, weighted total, best first
//
// All numbers come straight from the engine; this component only lays them out.
// It carries one display moment (the winner banner) per the product doctrine —
// everything else stays in the dense workhorse scale.

import { Trophy, ArrowUp, ArrowDown, Scale } from 'lucide-react'
import { cn } from '@/lib/utils'
import { scoreColor } from '@/lib/tier'
import {
  FACTORS,
  FACTOR_LABELS,
  type ComparisonResult as Result,
  type Factor,
} from '@/lib/offerCompare'

interface ComparisonResultProps {
  result: Result
}

export function ComparisonResult({ result }: ComparisonResultProps) {
  const { ranking, winner, runnerUp, margin, isCloseCall, tradeoffs, weights } = result
  const winnerColor = scoreColor(winner.total)

  return (
    <div className="flex flex-col gap-4">
      {/* ── Recommendation banner — the single display moment ── */}
      <div className="relative overflow-hidden rounded-2xl galaxy-bg border border-border-default shadow-cosmos">
        <div
          className="h-1.5 shrink-0"
          aria-hidden
          style={{ background: `linear-gradient(90deg, ${winnerColor} 0%, ${winnerColor}55 60%, transparent 100%)` }}
        />
        <div className="px-5 py-4 flex items-start gap-4">
          <div
            className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center mt-0.5"
            style={{ background: `${winnerColor}1F`, border: `1px solid ${winnerColor}40` }}
            aria-hidden
          >
            <Trophy size={18} style={{ color: winnerColor }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-micro text-text-4 uppercase tracking-[0.08em]">
                {isCloseCall ? 'Close call' : 'Recommendation'}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono tabular-nums',
                  isCloseCall ? 'bg-warning/15 text-warning' : 'bg-accent/15 text-accent',
                )}
                title="Weighted-total margin over the runner-up"
              >
                {isCloseCall ? 'margin' : '+'}{margin.toFixed(2)}
              </span>
            </div>
            <h2 className="text-display-2 leading-[1.1] tracking-[-0.01em] text-text-1">
              {winner.label}
            </h2>
            <p className="text-body text-text-2 leading-snug mt-1.5 max-w-[68ch]">
              {result.recommendation}
            </p>
            {tradeoffs.decisiveFactor && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-label text-text-3">
                <Scale size={12} className="text-text-4" />
                Decided mainly on{' '}
                <span className="text-text-1 font-medium">{tradeoffs.decisiveFactor.label}</span>
              </div>
            )}
          </div>
        </div>
      </div>

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
      <div className="rounded-2xl border border-border-default bg-bg-base overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border-default flex items-center gap-2">
          <h3 className="text-section text-text-1">Weighted ranking</h3>
          <span className="text-label text-text-4">— same six-factor model as the backend engine</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body border-collapse">
            <thead>
              <tr className="text-micro text-text-4 uppercase">
                <th className="text-left font-medium px-4 py-2 sticky left-0 bg-bg-base">Offer</th>
                {FACTORS.map((f: Factor) => (
                  <th key={f} className="text-center font-medium px-2 py-2 whitespace-nowrap" title={FACTOR_LABELS[f]}>
                    <span className="inline-flex flex-col items-center leading-tight">
                      <span>{shortFactor(f)}</span>
                      <span className="text-[8px] text-text-4 normal-case">{Math.round(weights[f] * 100)}%</span>
                    </span>
                  </th>
                ))}
                <th className="text-right font-medium px-4 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((o) => (
                <tr
                  key={o.label}
                  className={cn(
                    'border-t border-border-default/70',
                    o.rank === 1 ? 'bg-accent/[0.04]' : 'hover:bg-bg-elevated/50',
                  )}
                >
                  <td className="px-4 py-2.5 sticky left-0 bg-inherit">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono tabular-nums"
                        style={
                          o.rank === 1
                            ? { background: '#7C5CFF', color: '#fff' }
                            : { background: 'var(--dolly-bg-grey)', color: 'var(--dolly-text-secondary)' }
                        }
                      >
                        {o.rank}
                      </span>
                      <span className={cn('truncate', o.rank === 1 ? 'text-text-1 font-medium' : 'text-text-2')}>
                        {o.label}
                      </span>
                    </div>
                  </td>
                  {FACTORS.map((f: Factor) => (
                    <td key={f} className="px-2 py-2.5 text-center">
                      <span
                        className="text-label font-mono tabular-nums"
                        style={{ color: scoreColor(o.scores[f]) }}
                        title={`Score ${o.scores[f]} · contributes ${o.contributions[f].toFixed(2)} to the total`}
                      >
                        {o.scores[f]}
                      </span>
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right">
                    <span
                      className="text-section font-mono tabular-nums font-medium"
                      style={{ color: scoreColor(o.total) }}
                    >
                      {o.total.toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
    <div className="rounded-xl border border-border-default bg-bg-panel/60 p-3.5">
      <div className="flex items-center gap-1.5 mb-2">
        {accent ? (
          <ArrowUp size={13} className="text-success" />
        ) : (
          <ArrowDown size={13} className="text-text-4" />
        )}
        <span className="text-label font-medium text-text-2 truncate">{heading}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-label text-text-4">
          {accent ? 'No material lead on any single factor.' : 'Concedes nothing material.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li key={e.factor} className="flex items-center justify-between gap-2 text-label">
              <span className="text-text-2 truncate">{e.label}</span>
              <span className="font-mono tabular-nums text-text-3 shrink-0">
                {/* For "wins" show winner→runnerUp; for "concedes" show the runner-up's lead. */}
                {accent ? (
                  <>
                    <span style={{ color: scoreColor(e.winnerScore) }}>{e.winnerScore}</span>
                    <span className="text-text-4"> vs {e.runnerUpScore}</span>
                  </>
                ) : (
                  <>
                    <span style={{ color: scoreColor(e.runnerUpScore) }}>{e.runnerUpScore}</span>
                    <span className="text-text-4"> vs {e.winnerScore}</span>
                  </>
                )}
                <span className="text-text-4"> · +{e.gap}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

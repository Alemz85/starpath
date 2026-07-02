'use client'

// Daily brief — the backend's "what should I do now?" digest, rendered
// natively in the Scouting cockpit.
//
// The math is 100% owned by `scripts/daily-brief.mjs` (--json mode) and its
// pure core `scripts/lib/daily-brief-core.mjs`: cross-section globalPriority,
// the single "do this first" pick, per-section ranking. This component runs
// that script through the existing one-shot shell IPC (main process executes
// it with cwd = repoPath — the same pattern the API Scan button uses for
// `node scripts/scan.mjs`), parses the JSON via the pure `lib/dailyBrief`
// bridge, and lays the result out. It re-runs whenever the data store
// re-mirrors disk (chokidar → db:changed → fresh store arrays), so the brief
// tracks scans, evaluations, and status writebacks without a manual refresh.
//
// Empty world → nothing at all. No skeleton, no placeholder copy — the panel
// only exists when the brief has something genuinely worth saying.

import { useEffect, useRef, useState } from 'react'
import { Sunrise, ArrowRight, ArrowUpRight } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import {
  parseBriefJson, buildBriefDisplay, briefItemTarget, briefTargetLabel,
  type BriefDisplay, type BriefSectionId, type BriefItem, type BriefTarget,
} from '@/lib/dailyBrief'

// Per-section dot tone — the same semantic ladder the Today feed uses:
// obligations escalate danger → warning → accent; prospective opportunities
// (fresh hits, triage picks) stay muted so the eye lands on what decays.
const SECTION_DOT: Record<BriefSectionId, string> = {
  deadlines: 'bg-danger',
  followups: 'bg-warning',
  outreach:  'bg-accent',
  warmpaths: 'bg-accent',
  newhits:   'bg-text-4',
  triage:    'bg-text-4',
  headsup:   'bg-text-4',
  insight:   'bg-text-4',
}

export function DailyBriefPanel() {
  const repoPath = useAppStore(s => s.repoPath)
  const loaded = useDataStore(s => s.loaded)
  // Store arrays are replaced wholesale on every disk mirror (db:changed /
  // refresh), so depending on them re-runs the brief exactly when the
  // underlying data moved.
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)
  const pipeline = useDataStore(s => s.pipeline)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const navigate = useNavStore(s => s.navigate)

  const [display, setDisplay] = useState<BriefDisplay | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!repoPath || !loaded) return
    const mySeq = ++seq.current
    // Small debounce: chokidar bursts refresh the store several times in a
    // row; one brief run at the end is enough.
    const t = setTimeout(() => {
      void (async () => {
        const res = await ipc.run('node', ['scripts/daily-brief.mjs', '--json'])
        if (seq.current !== mySeq) return // a newer run superseded this one
        if (!res || res.code !== 0) { setDisplay(null); return }
        const brief = parseBriefJson(res.stdout)
        setDisplay(brief ? buildBriefDisplay(brief) : null)
      })()
    }, 400)
    return () => clearTimeout(t)
  }, [repoPath, loaded, applications, scouting, pipeline, scoreHistory])

  if (!display || display.isEmpty) return null

  const act = (target: BriefTarget | null) => {
    if (!target) return
    if (target.type === 'url') void ipc.openExternal(target.url)
    else navigate(target.view, target.view === 'database' ? (target.filter ?? '') : '')
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col pt-4">
      <section
        aria-label="Daily brief"
        className="max-h-full overflow-hidden flex flex-col rounded-xl border border-border-default bg-bg-panel/80"
      >
        {/* Header strip — icon tile + title + date, action count right. */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border-default/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center shrink-0">
              <Sunrise size={13} className="text-accent" aria-hidden />
            </div>
            <span className="text-[13px] font-semibold text-text-1">Today&apos;s brief</span>
            {display.asOf && (
              <span className="text-[11px] font-mono tabular-nums text-text-4">{display.asOf}</span>
            )}
          </div>
          {display.totalActions > 0 && (
            <span className="text-label text-text-3 shrink-0">
              {display.totalActions} action{display.totalActions === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-3.5 space-y-4" style={{ scrollbarWidth: 'thin' }}>
          {/* The single "do this first" pick — cross-section, time-criticality
              ranked by the core. One accent plate, one CTA. */}
          {display.topAction && (
            <TopActionPlate
              sectionId={display.topAction.section}
              sectionTitle={display.topAction.sectionTitle}
              item={display.topAction.item}
              onAct={act}
            />
          )}

          {/* Per-section top slices. Only non-empty sections exist here. */}
          {display.sections.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-3.5">
              {display.sections.map(s => (
                <div key={s.id} className="min-w-0">
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="text-micro text-text-4">{s.title}</h3>
                    {s.hiddenCount > 0 && (
                      <span className="text-[10.5px] text-text-4">+{s.hiddenCount} more</span>
                    )}
                  </div>
                  <ul className="list-none p-0 m-0 space-y-0.5">
                    {s.items.map(it => (
                      <li key={it.key}>
                        <BriefItemRow sectionId={s.id} item={it} onAct={act} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* Insight notes — quiet prose, never actions. */}
          {display.insights.length > 0 && (
            <div className={cn(
              'space-y-1.5',
              (display.topAction || display.sections.length > 0) && 'pt-3 border-t border-border-default/60',
            )}>
              {display.insights.map(({ sectionId, item }) => (
                <p key={`${sectionId}|${item.key}`} className="text-[11.5px] text-text-3 leading-snug">
                  <span className="font-medium text-text-2">{item.label}.</span>{' '}
                  {item.sub}
                </p>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ─── Top action plate ─────────────────────────────────────────────────────────

function TopActionPlate({
  sectionId, sectionTitle, item, onAct,
}: {
  sectionId: BriefSectionId
  sectionTitle: string
  item: BriefItem
  onAct: (t: BriefTarget | null) => void
}) {
  const target = briefItemTarget(sectionId, item)
  const cta = briefTargetLabel(target)
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-3.5 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-micro text-accent-text">Do this first</span>
          {sectionTitle && <span className="text-[10.5px] text-text-4">{sectionTitle}</span>}
        </div>
        <p className="text-[13px] font-medium text-text-1 leading-tight mt-0.5 truncate">{item.label}</p>
        {item.sub && <p className="text-[11.5px] text-text-3 leading-snug mt-0.5 line-clamp-1">{item.sub}</p>}
      </div>
      {cta && (
        <button
          onClick={() => onAct(target)}
          aria-label={`${cta}: ${item.label}`}
          className="shrink-0 inline-flex items-center gap-1.5 pl-3.5 pr-3 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12px] font-medium transition-all shadow-pill hover:shadow-pill-hover"
        >
          {cta}
          <ArrowRight size={13} aria-hidden />
        </button>
      )}
    </div>
  )
}

// ─── Section item row ─────────────────────────────────────────────────────────

function BriefItemRow({
  sectionId, item, onAct,
}: {
  sectionId: BriefSectionId
  item: BriefItem
  onAct: (t: BriefTarget | null) => void
}) {
  const target = briefItemTarget(sectionId, item)
  const dot = SECTION_DOT[sectionId] ?? 'bg-text-4'

  const body = (
    <>
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-text-1 leading-tight truncate">{item.label}</span>
        {item.sub && (
          <span className="block text-[10.5px] text-text-4 leading-snug truncate">{item.sub}</span>
        )}
      </span>
    </>
  )

  if (!target) {
    return <div className="flex items-center gap-2 px-1.5 py-1">{body}</div>
  }

  const cta = briefTargetLabel(target)
  return (
    <button
      onClick={() => onAct(target)}
      title={cta ?? undefined}
      aria-label={`${cta}: ${item.label}`}
      className="group w-full flex items-center gap-2 px-1.5 py-1 rounded-md text-left transition-colors hover:bg-bg-elevated"
    >
      {body}
      <ArrowUpRight
        size={12}
        className="shrink-0 text-text-4 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-hidden
      />
    </button>
  )
}

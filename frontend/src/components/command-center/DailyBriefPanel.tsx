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
import { clsx } from 'clsx'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { ipc } from '@/lib/ipc'
import { Button, Chip, SectionHeading } from '@/components/ui'
import {
  parseBriefJson, buildBriefDisplay, briefItemTarget, briefTargetLabel,
  type BriefDisplay, type BriefSectionId, type BriefItem, type BriefTarget,
} from '@/lib/dailyBrief'

// Class strings are combined with `clsx`, not `cn` — tailwind-merge reads
// `text-body` / `text-label` as colours and would drop them.

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

export function DailyBriefPanel({ className }: { className?: string } = {}) {
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

  const meta = [
    display.asOf,
    display.totalActions > 0
      ? `${display.totalActions} action${display.totalActions === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean).join(' · ')

  return (
    <section
      aria-label="Daily brief"
      className={clsx('card p-4 flex flex-col min-h-0 overflow-hidden', className)}
    >
      <SectionHeading title="Daily brief" meta={meta} className="shrink-0" />

      {/* Scrolls inside the card when the brief outgrows its slot. The -mx-2
          bleed lets row hover fills reach 8px past the text edge while the
          text itself stays aligned with the heading. */}
      <div className="min-h-0 overflow-y-auto -mx-2 space-y-4" style={{ scrollbarWidth: 'thin' }}>
        {/* The single "do this first" pick — cross-section, time-criticality
            ranked by the core. */}
        {display.topAction && (
          <TopActionRow
            sectionId={display.topAction.section}
            sectionTitle={display.topAction.sectionTitle}
            item={display.topAction.item}
            onAct={act}
          />
        )}

        {/* Per-section top slices. Only non-empty sections exist here. */}
        {display.sections.length > 0 && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-3">
            {display.sections.map(s => (
              <div key={s.id} className="min-w-0">
                <div className="flex items-baseline gap-2 px-2 mb-0.5">
                  <h3 className="label">{s.title}</h3>
                  {s.hiddenCount > 0 && (
                    <span className="text-label text-text-4">+{s.hiddenCount} more</span>
                  )}
                </div>
                <ul className="list-none p-0 m-0">
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
          <div className={clsx(
            'space-y-1.5 px-2',
            (display.topAction || display.sections.length > 0) && 'pt-3 border-t border-border-default',
          )}>
            {display.insights.map(({ sectionId, item }) => (
              <p key={`${sectionId}|${item.key}`} className="text-label text-text-3">
                <span className="font-medium text-text-2">{item.label}.</span>{' '}
                {item.sub}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Top action row ───────────────────────────────────────────────────────────

function TopActionRow({
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
    <div className="flex items-center gap-2.5 h-9 px-2 rounded bg-bg-elevated">
      <Chip tone="accent" title="Do this first" className="shrink-0">First</Chip>
      <span className="text-body font-medium text-text-1 truncate min-w-0 shrink-0 max-w-[50%]">{item.label}</span>
      <span className="text-label text-text-3 truncate min-w-0 flex-1" title={item.sub || undefined}>{item.sub}</span>
      {sectionTitle && (
        <span className="text-label text-text-4 shrink-0 truncate max-w-[30%]">{sectionTitle}</span>
      )}
      {cta && (
        <Button
          tone="ghost"
          size="xs"
          onClick={() => onAct(target)}
          aria-label={`${cta}: ${item.label}`}
          className="shrink-0 -mr-1"
          trailing={<ArrowRight size={12} aria-hidden />}
        >
          {cta}
        </Button>
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
      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden />
      <span className="text-body text-text-1 truncate min-w-0 shrink-0 max-w-[60%]">{item.label}</span>
      <span className="text-label text-text-3 truncate min-w-0 flex-1">{item.sub}</span>
    </>
  )

  if (!target) {
    return <div className="flex items-center gap-2 h-9 px-2">{body}</div>
  }

  const cta = briefTargetLabel(target)
  return (
    <button
      type="button"
      onClick={() => onAct(target)}
      title={cta ?? undefined}
      aria-label={`${cta}: ${item.label}`}
      className="group w-full flex items-center gap-2 h-9 px-2 rounded text-left transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {body}
      <ArrowUpRight
        size={12}
        className="shrink-0 text-text-4 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
        aria-hidden
      />
    </button>
  )
}

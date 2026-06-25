'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock, MessageSquareReply, Users, Sparkles, ArrowRight, Sun, CheckCircle2,
} from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useAppStore } from '@/store/app'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { ipc } from '@/lib/ipc'
import { cn, slugify } from '@/lib/utils'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { RunningInScanFooter, HeroStatTile } from '@/components/command-center/CommandCenter'
import { classifyOutreachLog } from '@/lib/outreachLog'
import {
  buildCockpitFeed,
  type CockpitItem,
  type CockpitKind,
  type CockpitAction,
  type OutreachCadenceEntry,
} from '@/lib/todayCockpit'

// Per-kind presentation — icon + label + the accent the chip/border read as.
// All colours are DESIGN-meta tokens; the four kinds map onto the existing
// status/semantic ladder rather than introducing new hues:
//   deadline → danger (irreversible, time-critical)
//   followup → warning (a live thread cooling)
//   outreach → accent  (relationship-building, the brand action colour)
//   scouting → info/accent (a fresh lead — same family as Evaluated)
const KIND_META: Record<CockpitKind, { label: string; icon: React.ElementType }> = {
  deadline: { label: 'Deadline',  icon: CalendarClock },
  followup: { label: 'Follow-up', icon: MessageSquareReply },
  outreach: { label: 'Outreach',  icon: Users },
  scouting: { label: 'Fresh hit', icon: Sparkles },
}

// Severity → border/chip tone. Reuses the semantic tokens so a "critical"
// row reads the same red as an urgent deadline badge elsewhere in the app.
function severityTone(sev: CockpitItem['severity']): { ring: string; chip: string; dot: string } {
  switch (sev) {
    case 'critical': return { ring: 'border-danger/40',  chip: 'text-danger bg-danger/10 border-danger/30',   dot: 'bg-danger' }
    case 'high':     return { ring: 'border-warning/40', chip: 'text-warning bg-warning/10 border-warning/30', dot: 'bg-warning' }
    case 'medium':   return { ring: 'border-accent/30',  chip: 'text-accent bg-accent/10 border-accent/30',    dot: 'bg-accent' }
    default:         return { ring: 'border-border-default', chip: 'text-text-3 bg-bg-elevated border-border-default', dot: 'bg-text-4' }
  }
}

export function TodayView() {
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)
  const liveness = useDataStore(s => s.liveness)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const promote = useDataStore(s => s.promoteToApplication)

  const navigate = useNavStore(s => s.navigate)
  const models = useAppStore(s => s.models)
  const start = useSpawnsStore(s => s.start)
  const spawns = useSpawnsStore(s => s.spawns)

  // The outreach log isn't in the SQLite cache (it's a contacto-mode artifact),
  // so read it straight off disk and re-read whenever the store refreshes (the
  // chokidar watcher bumps `loaded`/data on any data/* change).
  const [outreach, setOutreach] = useState<OutreachCadenceEntry[]>([])
  useEffect(() => {
    let cancelled = false
    ipc.readFile('data/outreach.md')
      .then(raw => { if (!cancelled) setOutreach(classifyOutreachLog(raw)) })
      .catch(() => { if (!cancelled) setOutreach([]) })
    return () => { cancelled = true }
  }, [applications, scouting])

  const feed = useMemo(
    () => buildCockpitFeed({ applications, scouting, outreach, liveness }),
    [applications, scouting, outreach, liveness],
  )

  // ── Action wiring ──────────────────────────────────────────────────────────
  // Each CockpitAction translates to a navigation or a spawn. Spawns mirror the
  // ApplyingView launch pattern (slash command + model). Apply promotes the row
  // into applications.md then jumps to the Applying board so the user lands on
  // their new card.
  const launch = (id: string, label: string, slash: string, model: 'sonnet' | 'opus' | 'haiku') => {
    if (spawns[id]?.status === 'running') return
    start(id, label, 'claude', claudeArgs(slash, model))
    navigate('scan')   // Activity tab streams the live output
  }

  const runAction = async (action: CockpitAction) => {
    switch (action.type) {
      case 'apply': {
        await promote({ company: action.company, role: action.role, overall: 0, tier: 'T4' })
        navigate('applying')
        break
      }
      case 'viewReport':
        navigate('reports', `${action.company}|${action.role}`)
        break
      case 'draftFollowup': {
        const id = `today-followup-${slugify(action.company)}-${slugify(action.role)}`
        const slash = `/career-ops followup for ${action.company} — ${action.role}`
        launch(id, `Follow-up: ${action.company}`, slash, models.draftApp)
        break
      }
      case 'draftOutreach': {
        const id = `today-outreach-${slugify(action.company)}-${slugify(action.contact)}`
        const slash = `/career-ops contacto for ${action.company} — nudge ${action.contact}`
        launch(id, `Outreach: ${action.company}`, slash, models.draftApp)
        break
      }
    }
  }

  // Refresh the store when a follow-up / outreach spawn finishes so any tracker
  // writeback (outreach.md row, status change) flows back into the feed.
  const finishedTodaySpawns = useMemo(() =>
    Object.entries(spawns)
      .filter(([id, r]) => id.startsWith('today-') && (r.status === 'done' || r.status === 'error' || r.status === 'killed'))
      .map(([id]) => id).join(','),
  [spawns])
  useEffect(() => { if (finishedTodaySpawns) void refresh() }, [finishedTodaySpawns, refresh])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Today</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${feed.actionable} to act on` : '…'}
        </span>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-6 gap-5 overflow-hidden min-h-0">
        {/* Editorial hero — the single "what should I do next?" headline plus a
            four-column breakdown of the signal mix. Mirrors the Applying hero
            (galaxy-bg card, display title, divided funnel strip). */}
        <div className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos">
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            <h1 className="text-display-2 text-text-1">What's next</h1>
            {loaded && feed.actionable > 0 && (
              <span className="text-label text-danger font-medium">
                {feed.actionable} {feed.actionable === 1 ? 'action needs' : 'actions need'} you now
              </span>
            )}
          </div>

          {loaded ? (
            <div className="grid grid-cols-4 divide-x divide-border-default/50">
              <HeroStatTile
                value={feed.counts.deadline}
                label="Deadlines"
                sub="closing soon"
                accent={feed.counts.deadline > 0 ? 'text-danger' : undefined}
                highlightDot={feed.counts.deadline > 0 ? 'bg-danger' : undefined}
              />
              <HeroStatTile
                value={feed.counts.followup}
                label="Follow-ups"
                sub="gone quiet"
                accent={feed.counts.followup > 0 ? 'text-warning' : undefined}
                highlightDot={feed.counts.followup > 0 ? 'bg-warning' : undefined}
              />
              <HeroStatTile
                value={feed.counts.outreach}
                label="Outreach"
                sub="nudges due"
                accent={feed.counts.outreach > 0 ? 'text-accent' : undefined}
                highlightDot={feed.counts.outreach > 0 ? 'bg-accent' : undefined}
              />
              <HeroStatTile
                value={feed.counts.scouting}
                label="Fresh hits"
                sub="worth a look"
              />
            </div>
          ) : (
            <div className="h-14 shimmer rounded-lg" />
          )}
        </div>

        {/* The ranked feed — one scrolling column, highest-value action first. */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
          {!loaded ? (
            <div className="space-y-2">
              {[0, 1, 2].map(i => <div key={i} className="h-[68px] shimmer rounded-lg" />)}
            </div>
          ) : feed.items.length === 0 ? (
            <AllClear />
          ) : (
            <div className="space-y-2 max-w-3xl">
              {feed.items.map(item => (
                <ActionRow key={item.id} item={item} onAct={() => runAction(item.action)} />
              ))}
            </div>
          )}
        </div>

        <RunningInScanFooter />
      </div>
    </div>
  )
}

// ─── Action row ───────────────────────────────────────────────────────────────

function ActionRow({ item, onAct }: { item: CockpitItem; onAct: () => void }) {
  const tone = severityTone(item.severity)
  const KindIcon = KIND_META[item.kind].icon
  return (
    <div
      className={cn(
        'group flex items-center gap-3.5 rounded-lg bg-bg-base border px-4 py-3 transition-colors',
        'hover:border-border-strong',
        tone.ring,
      )}
    >
      <CompanyLogo company={item.company} size={32} className="shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-text-1 leading-tight">{item.title}</span>
          <span className={cn(
            'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full border',
            tone.chip,
          )}>
            <KindIcon size={9} />
            {KIND_META[item.kind].label}
          </span>
        </div>
        <div className="text-[12px] text-text-2 truncate mt-0.5">
          <span className="font-medium">{item.company}</span>
          <span className="text-text-4"> · </span>
          <span className="text-text-3">{item.subtitle}</span>
        </div>
        <p className="text-[11px] text-text-4 leading-snug mt-1 line-clamp-1">{item.detail}</p>
      </div>

      <button
        onClick={onAct}
        className="shrink-0 inline-flex items-center gap-1.5 pl-3.5 pr-3 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12px] font-medium transition-all shadow-pill hover:shadow-pill-hover"
      >
        {item.actionLabel}
        <ArrowRight size={13} />
      </button>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

// Shown when the pipeline is fully on-track: no closing deadlines, no quiet
// threads, no due nudges, no unpursued fresh hits. A genuine "you're caught up"
// rather than a "nothing here" — the cockpit's whole point is that an empty
// feed is a *good* outcome.
function AllClear() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center px-6">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-4">
          <CheckCircle2 size={20} className="text-success" />
        </span>
        <h3 className="text-[15px] font-semibold text-text-1">You're all caught up</h3>
        <p className="text-[12.5px] text-text-3 leading-relaxed mt-1.5">
          No closing deadlines, quiet applications, due nudges, or unpursued fresh hits right now.
          Run a scan or browse the database to keep the funnel fed.
        </p>
        <div className="flex items-center justify-center gap-2 mt-4">
          <Sun size={13} className="text-text-4" />
          <span className="text-[11px] text-text-4">The cockpit refreshes as your pipeline moves.</span>
        </div>
      </div>
    </div>
  )
}

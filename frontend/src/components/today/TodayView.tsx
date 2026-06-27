'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock, MessageSquareReply, Users, Sparkles, ArrowRight,
  Sun, CheckCircle2, Database, ScanSearch, Lightbulb, TrendingUp, AlertTriangle,
} from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore, type ViewId } from '@/store/nav'
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
import { buildOutcomesHeadsUp, type OutcomesHeadsUp } from '@/lib/outcomesHeadsUp'

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
  const scoreHistory = useDataStore(s => s.scoreHistory)
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

  // Backward-looking counterpart to the forward-looking feed: the one targeting
  // lesson the user's own decided outcomes (wins vs losses) are teaching. Pure
  // synthesis over data already in the store — no spawn, no backend. Returns
  // null (no banner) under the sample floor, so it never shows filler.
  const headsUp = useMemo(
    () => buildOutcomesHeadsUp({ applications, scoreHistory }),
    [applications, scoreHistory],
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
      {/* Title bar — landmark header for screen readers */}
      <header className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome" aria-label="Today cockpit">
        <h1 className="text-body text-text-1 font-medium">Today</h1>
        {/* Live region so screen readers announce the count when it updates */}
        <span
          className="text-label text-text-4 font-mono"
          aria-live="polite"
          aria-atomic="true"
        >
          {loaded ? `${feed.actionable} to act on` : '…'}
        </span>
      </header>

      <div
        className="flex-1 flex flex-col px-8 pt-8 pb-6 gap-5 overflow-hidden min-h-0"
        aria-busy={!loaded}
      >
        {/* Editorial hero — the single "what should I do next?" headline plus a
            four-column breakdown of the signal mix. Mirrors the Applying hero
            (galaxy-bg card, display title, divided funnel strip). */}
        <section
          className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos"
          aria-label="Pipeline summary"
        >
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            {/* h2 here so the page hierarchy is h1 (title bar) → h2 (section) */}
            <h2 className="text-display-2 text-text-1">What's next</h2>
            {loaded && feed.actionable > 0 && (
              <span
                className="text-label text-danger font-medium"
                aria-label={`${feed.actionable} ${feed.actionable === 1 ? 'action needs' : 'actions need'} you now`}
              >
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
            /* Skeleton — four columns matching the real stat strip layout */
            <div className="grid grid-cols-4 gap-4" aria-hidden="true">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="space-y-2 px-5 first:pl-0">
                  <div className="h-7 w-10 shimmer rounded" />
                  <div className="h-3.5 w-20 shimmer rounded" />
                  <div className="h-3 w-16 shimmer rounded" />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Outcomes heads-up — the one lesson the user's own wins/losses are
            teaching, sitting between the forward-looking hero and the action
            feed. Renders only when there's a real, floor-clearing lesson;
            otherwise nothing (no generic filler). */}
        {loaded && headsUp && <OutcomesHeadsUpBanner headsUp={headsUp} onReview={() => navigate('trends')} />}

        {/* The ranked feed — one scrolling column, highest-value action first. */}
        <main
          className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1"
          aria-label="Priority actions"
        >
          {!loaded ? (
            /* Loading skeletons at the real action-row height */
            <div className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map(i => <div key={i} className="h-[72px] shimmer rounded-lg" />)}
            </div>
          ) : feed.items.length === 0 ? (
            <AllClear onNavigate={navigate} />
          ) : (
            <ul
              className="space-y-2 max-w-3xl list-none p-0 m-0"
              role="feed"
              aria-label={`${feed.items.length} prioritised action${feed.items.length === 1 ? '' : 's'}`}
            >
              {feed.items.map(item => (
                <li key={item.id}>
                  <ActionRow item={item} onAct={() => runAction(item.action)} />
                </li>
              ))}
            </ul>
          )}
        </main>

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
      {/* Company logo — decorative; company name appears in the text below */}
      <CompanyLogo company={item.company} size={32} className="shrink-0" aria-hidden />

      <div className="min-w-0 flex-1">
        {/* Title + kind chip */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-text-1 leading-tight">{item.title}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full border',
              tone.chip,
            )}
            aria-label={KIND_META[item.kind].label}
          >
            <KindIcon size={9} aria-hidden />
            {KIND_META[item.kind].label}
          </span>
        </div>
        {/* Company · role/contact */}
        <p className="text-[12px] text-text-2 truncate mt-0.5">
          <span className="font-medium">{item.company}</span>
          <span className="text-text-4 mx-0.5" aria-hidden="true"> · </span>
          <span className="text-text-3">{item.subtitle}</span>
        </p>
        {/* Supporting detail */}
        <p className="text-[11px] text-text-4 leading-snug mt-1 line-clamp-1">{item.detail}</p>
      </div>

      {/* aria-label identifies company + action so the button is self-describing
          without relying on adjacent visual context */}
      <button
        onClick={onAct}
        aria-label={`${item.actionLabel}: ${item.company} — ${item.subtitle}`}
        className="shrink-0 inline-flex items-center gap-1.5 pl-3.5 pr-3 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12px] font-medium transition-all shadow-pill hover:shadow-pill-hover"
      >
        {item.actionLabel}
        <ArrowRight size={13} aria-hidden />
      </button>
    </div>
  )
}

// ─── Outcomes heads-up banner ─────────────────────────────────────────────────

// The cockpit's one backward-looking note: what the user's own decided
// outcomes (wins vs losses) are teaching about targeting. Quiet by design — a
// single full-width plate, tinted by the lesson's tone (success when the
// signal is positive, warning when it's corrective), with a "See trends" link
// out to the analytics that go deeper. It's a *note*, not an action, so it
// carries no primary CTA and never competes with the ranked feed below.
const HEADSUP_TONE: Record<OutcomesHeadsUp['tone'], { wrap: string; icon: string; eyebrow: string }> = {
  positive: { wrap: 'border-success/30 bg-success/[0.06]', icon: 'text-success', eyebrow: 'text-success' },
  caution:  { wrap: 'border-warning/40 bg-warning/[0.07]', icon: 'text-warning', eyebrow: 'text-warning' },
  neutral:  { wrap: 'border-accent/30 bg-accent/[0.05]',   icon: 'text-accent',  eyebrow: 'text-accent-text' },
}

function OutcomesHeadsUpBanner({ headsUp, onReview }: { headsUp: OutcomesHeadsUp; onReview: () => void }) {
  const tone = HEADSUP_TONE[headsUp.tone]
  // Win-streak / predictive-gap read as momentum; a corrective lesson reads as
  // a flag. The icon just reinforces the tone the tint already carries.
  const Icon =
    headsUp.tone === 'caution' ? AlertTriangle :
    headsUp.kind === 'win-streak' ? TrendingUp :
    Lightbulb
  return (
    <section
      className={cn('shrink-0 max-w-3xl rounded-lg border px-4 py-3 flex items-start gap-3', tone.wrap)}
      aria-label="Lesson from your outcomes"
    >
      <Icon size={16} className={cn('shrink-0 mt-0.5', tone.icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={cn('text-[10px] font-semibold uppercase tracking-[0.08em]', tone.eyebrow)}>
            From your outcomes
          </span>
          {/* Sample caption — keeps the lesson honest about how much it's
              built on, the way the Trends cards caption their n. */}
          <span className="text-[10px] font-mono tabular-nums text-text-4">
            {headsUp.wins} won · {headsUp.losses} lost
          </span>
        </div>
        <p className="text-[13px] font-medium text-text-1 leading-tight mt-1">{headsUp.title}</p>
        <p className="text-[11.5px] text-text-3 leading-snug mt-1">{headsUp.detail}</p>
      </div>
      {/* Quiet link out to the deeper analytics — a text affordance, not a
          pill, so it stays subordinate to the action feed's CTAs. */}
      <button
        onClick={onReview}
        className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-text-3 hover:text-accent-text transition-colors mt-0.5"
        aria-label="Open Trends to review your outcome analytics"
      >
        See trends
        <ArrowRight size={11} aria-hidden />
      </button>
    </section>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

// Shown when the pipeline is fully on-track: no closing deadlines, no quiet
// threads, no due nudges, no unpursued fresh hits. A genuine "you're caught up"
// rather than a "nothing here" — the cockpit's whole point is that an empty
// feed is a *good* outcome. Two shortcut buttons let the user keep momentum
// without having to manually navigate to another tab.
function AllClear({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  return (
    <div className="h-full flex items-center justify-center py-4">
      <div className="max-w-sm w-full px-6 text-center">
        {/* Success icon in a soft green wash */}
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-4"
          aria-hidden="true"
        >
          <CheckCircle2 size={22} className="text-success" />
        </span>

        <h2 className="text-[15px] font-semibold text-text-1">You're all caught up</h2>
        <p className="text-[12.5px] text-text-3 leading-relaxed mt-2">
          No closing deadlines, quiet applications, due nudges, or unpursued fresh hits — the
          pipeline is healthy right now.
        </p>

        {/* Shortcut buttons — secondary outlined pill per DESIGN-meta */}
        <div className="flex items-center justify-center gap-3 mt-5">
          <button
            onClick={() => onNavigate('scan')}
            aria-label="Go to Scan to run a new scan"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill border border-border-strong text-text-2 text-[12px] font-medium hover:bg-bg-elevated transition-colors"
          >
            <ScanSearch size={13} aria-hidden className="text-text-4" />
            Run a scan
          </button>
          <button
            onClick={() => onNavigate('database')}
            aria-label="Open the database to browse all evaluated listings"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill border border-border-strong text-text-2 text-[12px] font-medium hover:bg-bg-elevated transition-colors"
          >
            <Database size={13} aria-hidden className="text-text-4" />
            Browse database
          </button>
        </div>

        {/* Ambient refresh note — quiet, doesn't compete with the CTAs */}
        <div className="flex items-center justify-center gap-2 mt-5">
          <Sun size={12} className="text-text-4 shrink-0" aria-hidden />
          <span className="text-[11px] text-text-4">Refreshes automatically as your pipeline moves.</span>
        </div>
      </div>
    </div>
  )
}

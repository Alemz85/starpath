'use client'

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ipc } from '@/lib/ipc'
import { buildOutreachBoard } from '@/lib/outreachDoc'
import { useNavStore, type ViewId } from '@/store/nav'
import {
  Sun,
  MessageSquare,
  Map,
  Briefcase,
  Users,
  Database,
  FileText,
  TrendingUp,
  GitBranch,
  Scale,
  Search,
  Settings,
  ChevronLeft,
  ChevronRight,
  Activity,
  User,
  AlertTriangle,
} from 'lucide-react'
import { useSpawnsStore, isAnyRunning, unackedFailureCount } from '@/store/spawns'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { isViewEnabled } from '@/lib/features'
import { buildCockpitFeed } from '@/lib/todayCockpit'
import { StarpathLogo } from '@/components/shared/Logos'
import { OrbitalLoader } from '@/components/ui/orbital-loader'
import { ProfileSwitcher } from '@/components/layout/ProfileSwitcher'

interface NavItem {
  view: ViewId
  label: string
  icon: React.ElementType
}

// Primary tabs — workflow-stage entry points. Today = the cross-pipeline
// "what should I do next?" cockpit (deadlines, follow-ups, outreach nudges,
// fresh hits), Scouting = inventory of every evaluation, Applying = active
// applications. They sit above a subtle divider in the sidebar to read as the
// "command" tier.
//
// These tabs are about the user's data state, NOT about which evaluation
// runs. There's only one evaluation mode (`modes/scouting.md`); the
// CF/AF rollup weights are controlled by `phase` (Settings/CmdK), which
// is independent from this navigation.
const PRIMARY_NAV: NavItem[] = [
  { view: 'today',    label: 'Today',    icon: Sun        },
  { view: 'chat',     label: 'Chat',     icon: MessageSquare },
  { view: 'scouting', label: 'Scouting', icon: Map        },
  { view: 'applying', label: 'Applying', icon: Briefcase  },
  { view: 'outreach', label: 'Outreach', icon: Users      },
]

// Secondary tabs — supporting views (data, analytics, activity).
// Several former standalone tabs now live as sub-tabs inside these views:
// Network is Outreach › Network, Score Trend is Trends › Score Trend, and
// the Configuration editor is Settings › Identity/Target Roles/Portals.
// `view: 'scan'` is the internal key (legacy from when this tab actually
// triggered scans); user-facing label is "Activity" since it now hosts
// every running spawn — scans, filter runs, tailoring, company API probes.
const SECONDARY_NAV: NavItem[] = [
  { view: 'offers',   label: 'Offers',   icon: Scale      },
  { view: 'database', label: 'Database', icon: Database   },
  { view: 'reports',  label: 'Reports',  icon: FileText   },
  { view: 'trends',   label: 'Trends',   icon: TrendingUp },
  { view: 'pipeline', label: 'Pipeline', icon: GitBranch  },
  { view: 'scan',     label: 'Activity', icon: Activity   },
]

const BOTTOM_ITEMS: NavItem[] = [
  { view: 'profile',  label: 'Profile',  icon: User     },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const [expanded, setExpanded] = useState(true)
  const currentView = useNavStore(s => s.view)
  const navigate = useNavStore(s => s.navigate)
  // Deactivated feature tabs (Settings › General › Features) drop off the
  // rail entirely — same rows, one filter, no layout special-casing.
  const features = useAppStore(s => s.features)
  const primaryNav = PRIMARY_NAV.filter(item => isViewEnabled(item.view, features))
  const secondaryNav = SECONDARY_NAV.filter(item => isViewEnabled(item.view, features))
  const anyRunning = useSpawnsStore(isAnyRunning)
  const failedCount = useSpawnsStore(unackedFailureCount)

  // Live status counts for the nav badges. Each count has a single,
  // unambiguous source that matches what the destination view shows:
  //   Scouting → pending URLs awaiting a filter pass (data/pipeline.md)
  //   Applying → applications still in flight
  //   Reports  → prose report files on disk (same db:reports source the
  //              Reports view counts)
  // Database is deliberately unbadged — its view dedups score-history into
  // entities, so no raw store count matches the visible row total honestly.
  const loaded = useDataStore(s => s.loaded)
  const pipeline = useDataStore(s => s.pipeline)
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)
  const liveness = useDataStore(s => s.liveness)
  const reports = useDataStore(s => s.reports)

  const activeCount = applications.filter(a =>
    ['Applied', 'Responded', 'Interview', 'Offer'].includes(a.status)
  ).length

  // Today's badge = the number of "act now" (critical/high) items the cockpit
  // would surface. Computed from the same aggregation lib the view uses, minus
  // the outreach log (not loaded into the store) — so the rail count is a
  // floor; the Today view is the exact total. Outreach nudges are a small
  // share, so the rail still reads honestly as "you have N pressing things".
  const todayActionable = buildCockpitFeed({ applications, scouting, liveness }).actionable

  // Outreach's badge = contacts due a nudge. The log isn't in the SQLite cache
  // (it's a contacto-mode artifact), so read it off disk and recompute whenever
  // the store data shifts — the chokidar watcher bumps applications/scouting on
  // any data/* write, which is our cue the log may have changed too.
  const [outreachRaw, setOutreachRaw] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ipc.readFile('data/outreach.md')
      .then(raw => { if (!cancelled) setOutreachRaw(raw) })
      .catch(() => { if (!cancelled) setOutreachRaw(null) })
    return () => { cancelled = true }
  }, [applications, scouting])
  const outreachNudges = useMemo(
    () => buildOutreachBoard(outreachRaw).filter(c => c.action === 'nudge').length,
    [outreachRaw],
  )

  // Scouting's pending count carries accent emphasis — it's the only number
  // on the rail that means "act now" (mirrors the cockpit's pending dot)
  // rather than "inventory size". Today shares that accent — both mean "act".
  const badges: Partial<Record<ViewId, { count: number; accent?: boolean }>> = {
    today:    { count: todayActionable, accent: true },
    scouting: { count: pipeline.length, accent: true },
    applying: { count: activeCount },
    outreach: { count: outreachNudges, accent: true },
    reports:  { count: reports.length },
  }

  const handleNav = (item: NavItem) => {
    navigate(item.view)
  }

  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    const showRunning = item.view === 'scan' && anyRunning
    // Failure badge yields to the running indicator — once a run stops, any
    // unacknowledged failures surface here so a background death gets noticed.
    const showFailed = item.view === 'scan' && failedCount > 0 && !showRunning
    const badge = loaded ? badges[item.view] : undefined
    const showBadge = !!badge && badge.count > 0 && !showRunning
    return (
      <button
        key={item.view}
        onClick={() => handleNav(item)}
        aria-label={showBadge ? `${item.label}, ${badge!.count}` : item.label}
        aria-current={currentView === item.view ? 'page' : undefined}
        className={cn(
          'w-full flex items-center gap-3 px-2 py-2 rounded-md text-body',
          'transition-[background-color,color] duration-200 ease-quart',
          currentView === item.view
            ? 'bg-accent/15 text-text-1 font-medium'
            : 'text-text-3 hover:text-text-2 hover:bg-bg-elevated',
          !expanded && 'justify-center px-0',
        )}
        title={!expanded ? item.label : undefined}
      >
        <span className="relative shrink-0 inline-flex">
          <Icon size={15} className={cn('relative', showRunning && 'text-accent', showFailed && 'text-danger')} />
          {/* Running indicator — small two-ring orbital loader at the
              top-right corner of the icon. Replaces the prior box-shadow
              halo + Loader2 spinner combo, which read as the generic
              "AI app spinner" pattern. The rings tie back to the orbital
              language used in the Activity panel, ProfileView career
              constellation, and Onboarding finale. */}
          {showRunning && (
            <span className="absolute -top-1 -right-1.5 z-10">
              <OrbitalLoader size={14} rings={2} strokeClass="text-accent" />
            </span>
          )}
          {/* Failure badge — danger dot at the icon corner, mirroring the
              running indicator's placement. Shows the count when collapsed
              so the signal survives a narrowed sidebar. */}
          {showFailed && (
            <span className="absolute -top-1.5 -right-1.5 z-10 min-w-[14px] h-[14px] px-1 rounded-full bg-danger text-white text-[9px] font-mono font-medium leading-none flex items-center justify-center tabular-nums">
              {failedCount}
            </span>
          )}
          {/* Collapsed-state pending cue — when the rail is narrow there's
              no room for the count pill, so the accent (act-now) badge
              degrades to a small pulsing dot, matching the cockpit's
              pending indicator. Muted badges get no collapsed cue. */}
          {showBadge && badge!.accent && !expanded && (
            <span
              className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse z-10"
              aria-hidden
            />
          )}
        </span>
        {expanded && (
          <span className="flex-1 flex items-center justify-between gap-2">
            <span>{item.label}</span>
            {showRunning ? (
              <span className="text-[10px] font-mono text-accent">running</span>
            ) : showFailed ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-danger">
                <AlertTriangle size={10} />
                {failedCount} failed
              </span>
            ) : showBadge ? (
              <span className={cn(
                'shrink-0 min-w-[18px] text-center px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium tabular-nums leading-none',
                badge!.accent
                  ? 'bg-accent/15 text-accent'
                  : 'bg-bg-elevated text-text-4 border border-border-default',
              )}>
                {badge!.count}
              </span>
            ) : null}
          </span>
        )}
      </button>
    )
  }

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-bg-chrome border-r border-border-default transition-all duration-200 shrink-0',
        expanded ? 'w-[220px]' : 'w-14',
      )}
    >
      <div
        className={cn(
          'title-bar px-3',
          expanded ? 'justify-between' : 'justify-center',
        )}
      >
        {expanded && (
          <div className="titlebar-no-drag select-none flex items-center gap-1.5">
            <StarpathLogo size={18} />
            <span className="text-[20px] tracking-tight galaxy-text font-bold lowercase leading-none">
              starpath
            </span>
          </div>
        )}
        <button
          className="titlebar-no-drag p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {/* Workspace switcher — the active search profile. Renders nothing on
          pre-migration repos (no profiles/ dir). */}
      <ProfileSwitcher expanded={expanded} />

      {/* Search hint — visible at both widths so keyboard-shy users can still
          summon CmdK by clicking the icon when the sidebar is collapsed. */}
      <div className={cn('py-2', expanded ? 'px-3' : 'px-2 flex justify-center')}>
        <button
          className={cn(
            'flex items-center rounded-md bg-bg-base border border-border-default text-text-3 hover:text-text-2 transition-colors text-label',
            expanded ? 'w-full gap-2 px-2 py-1.5' : 'w-9 h-9 justify-center',
          )}
          onClick={() => {
            const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            document.dispatchEvent(event)
          }}
          title={!expanded ? 'Search (⌘K)' : undefined}
          aria-label="Search"
        >
          <Search size={expanded ? 12 : 14} />
          {expanded && <span className="flex-1 text-left">Search...</span>}
          {expanded && <kbd className="text-[10px] bg-bg-elevated border border-border-default rounded px-1">⌘K</kbd>}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 overflow-y-auto">
        <div className="space-y-0.5">
          {primaryNav.map(renderItem)}
        </div>
        <div className={cn('my-2 border-t border-border-default/60', !expanded && 'mx-1')} aria-hidden />
        <div className="space-y-0.5">
          {secondaryNav.map(renderItem)}
        </div>
      </nav>

      {/* Bottom */}
      <div className="p-2 border-t border-border-default space-y-0.5">
        {BOTTOM_ITEMS.map(renderItem)}
      </div>
    </aside>
  )
}

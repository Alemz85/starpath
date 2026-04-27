'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useNavStore, type ViewId } from '@/store/nav'
import {
  LayoutDashboard,
  Database,
  FileText,
  GitBranch,
  TrendingUp,
  Search,
  Settings,
  ChevronLeft,
  ChevronRight,
  Radar,
  User,
} from 'lucide-react'

const NAV_ITEMS: { view: ViewId; label: string; icon: React.ElementType }[] = [
  { view: 'home',     label: 'Command Center', icon: LayoutDashboard },
  { view: 'database', label: 'Database',        icon: Database },
  { view: 'reports',  label: 'Reports',         icon: FileText },
  { view: 'pipeline', label: 'Pipeline',        icon: GitBranch },
  { view: 'trends',   label: 'Trends',          icon: TrendingUp },
  { view: 'scan',     label: 'Scan',            icon: Radar },
]

const BOTTOM_ITEMS: { view: ViewId; label: string; icon: React.ElementType }[] = [
  { view: 'profile',  label: 'Profile',  icon: User     },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const [expanded, setExpanded] = useState(true)
  const { view: currentView, navigate } = useNavStore()

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-bg-chrome border-r border-border-default transition-all duration-200 shrink-0',
        expanded ? 'w-[220px]' : 'w-14',
      )}
    >
      {/* Header / wordmark — shares the .title-bar height with every main-pane title row.
          No border-b so the sidebar flows continuously through search and nav.
          The main pane's divider visually terminates at the sidebar/main seam. */}
      <div
        className={cn(
          'title-bar px-3',
          expanded ? 'justify-between' : 'justify-center',
        )}
      >
        {expanded && (
          <span className="text-micro tracking-widest uppercase text-text-3 titlebar-no-drag select-none">
            career-ops
          </span>
        )}
        <button
          className="titlebar-no-drag p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {/* Search hint */}
      {expanded && (
        <div className="px-3 py-2">
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-base border border-border-default text-text-3 hover:text-text-2 transition-colors text-label"
            onClick={() => {
              const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
              document.dispatchEvent(event)
            }}
          >
            <Search size={12} />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="text-[10px] bg-bg-elevated border border-border-default rounded px-1">⌘K</kbd>
          </button>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ view, label, icon: Icon }) => (
          <button
            key={view}
            onClick={() => navigate(view)}
            className={cn(
              'w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-body',
              currentView === view
                ? 'bg-accent/15 text-text-1 border-l-2 border-accent -ml-[1px] pl-[7px]'
                : 'text-text-3 hover:text-text-2 hover:bg-bg-elevated',
              !expanded && 'justify-center px-0',
            )}
            title={!expanded ? label : undefined}
          >
            <Icon size={15} className="shrink-0" />
            {expanded && <span>{label}</span>}
          </button>
        ))}
      </nav>

      {/* Bottom */}
      <div className="p-2 border-t border-border-default space-y-0.5">
        {BOTTOM_ITEMS.map(({ view, label, icon: Icon }) => (
          <button
            key={view}
            onClick={() => navigate(view)}
            className={cn(
              'w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-body',
              currentView === view
                ? 'bg-accent/15 text-text-1 border-l-2 border-accent -ml-[1px] pl-[7px]'
                : 'text-text-3 hover:text-text-2 hover:bg-bg-elevated',
              !expanded && 'justify-center px-0',
            )}
            title={!expanded ? label : undefined}
          >
            <Icon size={15} className="shrink-0" />
            {expanded && <span>{label}</span>}
          </button>
        ))}
      </div>
    </aside>
  )
}

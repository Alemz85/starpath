'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useNavStore, type ViewId } from '@/store/nav'
import { useAppStore } from '@/store/app'
import {
  Map,
  Briefcase,
  Database,
  FileText,
  TrendingUp,
  Search,
  Settings,
  ChevronLeft,
  ChevronRight,
  Radar,
  User,
  Loader2,
} from 'lucide-react'
import { useSpawnsStore, isAnyRunning } from '@/store/spawns'
import type { AppMode } from '@/types'

interface NavItem {
  view: ViewId
  label: string
  icon: React.ElementType
  /** If set, navigating to this tab also flips currentMode. */
  syncMode?: AppMode
}

const NAV_ITEMS: NavItem[] = [
  { view: 'scouting', label: 'Scouting', icon: Map,        syncMode: 'scouting' },
  { view: 'applying', label: 'Applying', icon: Briefcase,  syncMode: 'applying' },
  { view: 'database', label: 'Database', icon: Database  },
  { view: 'reports',  label: 'Reports',  icon: FileText  },
  { view: 'trends',   label: 'Trends',   icon: TrendingUp },
  { view: 'scan',     label: 'Scan',     icon: Radar     },
]

const BOTTOM_ITEMS: NavItem[] = [
  { view: 'profile',  label: 'Profile',  icon: User     },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const [expanded, setExpanded] = useState(true)
  const { view: currentView, navigate } = useNavStore()
  const setMode = useAppStore(s => s.setMode)
  const anyRunning = useSpawnsStore(isAnyRunning)

  const handleNav = (item: NavItem) => {
    navigate(item.view)
    if (item.syncMode) void setMode(item.syncMode)
  }

  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    const showRunning = item.view === 'scan' && anyRunning
    return (
      <button
        key={item.view}
        onClick={() => handleNav(item)}
        className={cn(
          'w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-body',
          currentView === item.view
            ? 'bg-accent/15 text-text-1 border-l-2 border-accent -ml-[1px] pl-[7px]'
            : 'text-text-3 hover:text-text-2 hover:bg-bg-elevated',
          !expanded && 'justify-center px-0',
        )}
        title={!expanded ? item.label : undefined}
      >
        <span className="relative shrink-0 inline-flex">
          <Icon size={15} />
          {showRunning && (
            <Loader2
              size={9}
              className="absolute -top-1 -right-1.5 animate-spin text-accent"
              strokeWidth={2.5}
            />
          )}
        </span>
        {expanded && (
          <span className="flex-1 flex items-center justify-between">
            <span>{item.label}</span>
            {showRunning && <span className="text-[10px] font-mono text-accent">running</span>}
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
        {expanded && <span className="w-6 shrink-0" aria-hidden />}
        {expanded && (
          <span className="text-[20px] tracking-tight galaxy-text titlebar-no-drag select-none font-bold lowercase leading-none">
            starpath
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
        {NAV_ITEMS.map(renderItem)}
      </nav>

      {/* Bottom */}
      <div className="p-2 border-t border-border-default space-y-0.5">
        {BOTTOM_ITEMS.map(renderItem)}
      </div>
    </aside>
  )
}

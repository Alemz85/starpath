'use client'

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatSessionMeta } from '@/lib/chat/types'
import { OrbitalLoader } from '@/components/ui/orbital-loader'

interface ChatSessionRailProps {
  sessions: ChatSessionMeta[]
  selectedId: string | null
  /** The conversation whose reply is currently generating, if any. */
  liveSessionId: string | null
  canCreate: boolean
  onSelect(id: string): void
  onCreate(): void
  onDelete(id: string): void
}

/** Conversation list — newest first, one live at a time. */
export function ChatSessionRail({
  sessions, selectedId, liveSessionId, canCreate, onSelect, onCreate, onDelete,
}: ChatSessionRailProps) {
  return (
    <aside
      className="w-[220px] shrink-0 flex flex-col border-r border-border-default bg-bg-chrome"
      aria-label="Conversations"
    >
      <div className="p-2 border-b border-border-default">
        <button
          type="button"
          onClick={onCreate}
          disabled={!canCreate}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-body',
            'transition-[background-color,color] duration-200 ease-quart',
            canCreate
              ? 'text-text-2 hover:text-text-1 hover:bg-bg-elevated'
              : 'text-text-4 cursor-not-allowed',
          )}
        >
          <Plus size={14} aria-hidden />
          New chat
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.map(session => {
          const active = session.id === selectedId
          return (
            <div
              key={session.id}
              className={cn(
                'group flex items-center gap-1.5 rounded-md pr-1',
                'transition-[background-color] duration-200 ease-quart',
                active ? 'bg-accent/15' : 'hover:bg-bg-elevated',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex-1 min-w-0 text-left px-2 py-2 text-body truncate',
                  active ? 'text-text-1 font-medium' : 'text-text-3',
                )}
                title={session.title}
              >
                {session.title || 'New chat'}
              </button>
              {session.id === liveSessionId ? (
                <span className="shrink-0 pr-1" aria-label="Reply in progress">
                  <OrbitalLoader size={12} rings={2} strokeClass="text-accent" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onDelete(session.id)}
                  aria-label={`Delete conversation ${session.title || 'New chat'}`}
                  className="shrink-0 p-1 rounded-sm text-text-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger transition-[opacity,color] duration-200 ease-quart"
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              )}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}

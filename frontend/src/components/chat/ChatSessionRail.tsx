'use client'

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatSessionMeta } from '@/lib/chat/types'
import { Button } from '@/components/ui'

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
      className="w-[220px] shrink-0 flex flex-col border-r border-border-default "
      aria-label="Conversations"
    >
      <div className="p-2 border-b border-border-default">
        <Button
          tone="ghost"
          size="sm"
          icon={<Plus size={14} aria-hidden />}
          onClick={onCreate}
          disabled={!canCreate}
          className="w-full justify-start"
        >
          New chat
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.map(session => {
          const active = session.id === selectedId
          const isLive = session.id === liveSessionId
          return (
            <div
              key={session.id}
              className={cn(
                'group flex items-center gap-1 h-9 rounded pr-1',
                'transition-colors duration-150 ease-quart',
                active ? 'bg-accent-soft' : 'hover:bg-bg-elevated',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={active ? 'true' : undefined}
                // Plain concatenation, not cn(): tailwind-merge would read the
                // custom `text-body` size and the `text-text-*` colour as one group.
                className={`flex-1 min-w-0 h-full flex items-center gap-2 text-left px-2 text-body rounded ${
                  active ? 'text-text-1 font-medium' : 'text-text-3 hover:text-text-1'
                }`}
                title={session.title}
              >
                <span className="truncate">{session.title || 'New chat'}</span>
              </button>
              {isLive ? (
                <span className="shrink-0 w-6 flex items-center justify-center" aria-label="Reply in progress">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
                </span>
              ) : (
                <Button
                  tone="ghost"
                  size="xs"
                  iconOnly
                  icon={<Trash2 size={12} aria-hidden />}
                  onClick={() => onDelete(session.id)}
                  aria-label={`Delete conversation ${session.title || 'New chat'}`}
                  className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
                />
              )}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}

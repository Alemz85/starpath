'use client'

import { useCallback, useRef } from 'react'
import { cn } from '@/lib/utils'

// Shared sub-navigation tablist for views that host more than one surface
// (Trends' landscape/re-evaluations, Outreach's board/network, Settings'
// sections). Generalized from the Configuration tablist so every merged
// view renders the identical bar: underline-accent tabs on a bg-chrome
// strip directly under the title bar, ARIA tablist semantics, arrow-key
// navigation, and an optional unsaved-changes dot per tab.
//
// Panels stay in the host view — wire them up with viewPanelId/viewTabId
// (role="tabpanel", aria-labelledby) so the pairing survives refactors.

export interface ViewTab<K extends string> {
  key: K
  label: string
  /** Optional count rendered after the label in the muted mono style. */
  count?: number
  /** Shows the accent unsaved-changes dot (Settings' dirty sections). */
  dirty?: boolean
}

export const viewTabId = (prefix: string, key: string) => `${prefix}-tab-${key}`
export const viewPanelId = (prefix: string, key: string) => `${prefix}-panel-${key}`

interface ViewTabsProps<K extends string> {
  tabs: readonly ViewTab<K>[]
  active: K
  /** Called with the clicked/keyed tab. The host decides whether to switch
   *  immediately or gate behind its own unsaved-changes modal. */
  onSelect: (key: K) => void
  ariaLabel: string
  /** Stable id prefix pairing this tablist with its panels. */
  idPrefix: string
}

export function ViewTabs<K extends string>({ tabs, active, onSelect, ariaLabel, idPrefix }: ViewTabsProps<K>) {
  const tabRefs = useRef<Partial<Record<K, HTMLButtonElement>>>({})

  // Arrow-key navigation within the tablist (ARIA authoring practices).
  const handleKeyDown = useCallback((e: React.KeyboardEvent, key: K) => {
    const idx = tabs.findIndex(t => t.key === key)
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = tabs.length - 1
    if (nextIdx !== null) {
      e.preventDefault()
      const nextKey = tabs[nextIdx].key
      tabRefs.current[nextKey]?.focus()
      onSelect(nextKey)
    }
  }, [tabs, onSelect])

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-center border-b border-border-default bg-bg-chrome shrink-0 px-2"
    >
      {tabs.map(({ key, label, count, dirty }) => {
        const isActive = active === key
        return (
          <button
            key={key}
            ref={el => { if (el) tabRefs.current[key] = el }}
            role="tab"
            aria-selected={isActive}
            aria-controls={viewPanelId(idPrefix, key)}
            id={viewTabId(idPrefix, key)}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(key)}
            onKeyDown={e => handleKeyDown(e, key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-label border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
              isActive
                ? 'border-accent text-text-1'
                : 'border-transparent text-text-4 hover:text-text-2',
            )}
          >
            {label}
            {typeof count === 'number' && count > 0 && (
              <span className={cn('text-micro font-mono tabular-nums', isActive ? 'text-text-3' : 'text-text-4')}>
                {count}
              </span>
            )}
            {dirty && (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className={cn(
                  'w-1.5 h-1.5 rounded-full bg-accent shrink-0',
                  // Dim slightly on inactive tabs so it reads as a passive
                  // indicator rather than a loud warning.
                  !isActive && 'opacity-60',
                )}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

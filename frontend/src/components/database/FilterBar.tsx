'use client'

import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const TOKEN_SUGGESTIONS = [
  { token: 'company:',   hint: 'filter by company name' },
  { token: 'tier:',      hint: 'T1, T2-high, T2, T3, T4' },
  { token: 'archetype:', hint: 'filter by role archetype' },
  { token: 'location:',  hint: 'filter by city/country' },
  { token: 'type:',      hint: 'full-time, contract...' },
  { token: 'min-score:', hint: 'minimum overall score (0-10)' },
]

interface FilterBarProps {
  value: string
  onChange: (v: string) => void
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  const [focused, setFocused] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const isEmpty = value.trim() === ''
  const showSuggestions = focused && isEmpty

  // Reset active index whenever dropdown opens/closes
  useEffect(() => {
    if (!showSuggestions) setActiveIdx(-1)
  }, [showSuggestions])

  const insertToken = (token: string) => {
    onChange(token)
    // Place cursor at end of inserted token so user can type value right away
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(token.length, token.length)
      }
    })
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onChange('')
      inputRef.current?.blur()
      return
    }

    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx(i => Math.min(i + 1, TOKEN_SUGGESTIONS.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx(i => Math.max(i - 1, 0))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && activeIdx >= 0) {
        e.preventDefault()
        insertToken(TOKEN_SUGGESTIONS[activeIdx].token)
        setActiveIdx(-1)
        return
      }
    }
  }

  // Global "/" shortcut: focus the search box from anywhere in the
  // Database view, so the <kbd>/</kbd> hint is truthful. Ignore it while a
  // modifier is held or the user is already typing in a field. FilterBar
  // unmounts with the Database view, so the cleanup scopes this to it.
  // (globalThis.KeyboardEvent — not the React synthetic type imported above.)
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-bg-elevated transition-colors duration-150',
          focused ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border-default hover:border-border-strong',
        )}
      >
        <Search size={14} className={cn('shrink-0 transition-colors', focused ? 'text-accent' : 'text-text-4')} />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={handleKey}
          placeholder="Search listings or type a token filter…"
          aria-label="Search and filter listings"
          aria-expanded={showSuggestions}
          aria-haspopup="listbox"
          aria-activedescendant={activeIdx >= 0 ? `token-suggestion-${activeIdx}` : undefined}
          role="combobox"
          className="flex-1 bg-transparent outline-none text-[13px] text-text-1 placeholder:text-text-4 min-w-0"
          spellCheck={false}
        />
        {!isEmpty && (
          <button
            onMouseDown={e => { e.preventDefault(); onChange('') }}
            className="text-text-4 hover:text-text-2 p-0.5 -m-0.5 rounded transition-colors"
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        )}
        {isEmpty && (
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-mono text-text-4 bg-bg-base border border-border-default">
            /
          </kbd>
        )}
      </div>

      {showSuggestions && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Token filter suggestions"
          className="absolute top-full left-0 right-0 mt-1.5 bg-bg-base border border-border-strong rounded-lg shadow-card z-20 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border-default flex items-center justify-between">
            <span className="text-micro text-text-4 uppercase tracking-wider">Token filters</span>
            <span className="text-[10px] text-text-4">↑↓ navigate · Enter to insert</span>
          </div>
          <div className="p-1.5">
            {TOKEN_SUGGESTIONS.map(({ token, hint }, idx) => {
              const isActive = idx === activeIdx
              return (
                <button
                  key={token}
                  id={`token-suggestion-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={e => { e.preventDefault(); insertToken(token) }}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={cn(
                    'w-full flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left group',
                    isActive ? 'bg-accent/[0.09]' : 'hover:bg-accent/[0.06]',
                  )}
                >
                  <span className={cn(
                    'text-[11.5px] font-mono w-24 shrink-0 transition-colors',
                    isActive ? 'text-accent-hover' : 'text-accent group-hover:text-accent-hover',
                  )}>
                    {token}
                  </span>
                  <span className="text-[11.5px] text-text-3 truncate">{hint}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

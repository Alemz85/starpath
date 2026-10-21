'use client'

import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { clsx } from 'clsx'

const TOKEN_SUGGESTIONS = [
  { token: 'company:',   hint: 'filter by company name' },
  { token: 'verdict:',   hint: 'go, stretch, solid, growth, thin, skip, blocked' },
  { token: 'eligibility:', hint: 'green, amber, red' },
  { token: 'tier:',      hint: 'T1, T2, T3, T4' },
  { token: 'archetype:', hint: 'filter by role archetype' },
  { token: 'location:',  hint: 'filter by city/country' },
  { token: 'type:',      hint: 'full-time, contract...' },
  { token: 'min-match:',  hint: 'minimum Match (1-10)' },
  { token: 'min-ease:',  hint: 'minimum Ease (1-10)' },
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
    <div className="relative w-full">
      <Search
        size={14}
        className={clsx(
          'absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none transition-colors duration-150',
          focused ? 'text-accent-text' : 'text-text-4',
        )}
        aria-hidden
      />
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
        className="input h-9 rounded-md pl-9 pr-9 text-[13.5px]"
        spellCheck={false}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
        {!isEmpty && (
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); onChange('') }}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors duration-150"
            aria-label="Clear search"
          >
            <X size={13} aria-hidden />
          </button>
        )}
        {isEmpty && <kbd className="kbd pointer-events-none">/</kbd>}
      </div>

      {showSuggestions && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Token filter suggestions"
          className="absolute top-full left-0 right-0 mt-1 bg-bg-base border border-border-default rounded-lg shadow-menu z-20 p-1"
        >
          <div className="flex items-center justify-between gap-3 px-2 pt-1.5 pb-2">
            <span className="label">Token filters</span>
            <span className="text-label text-text-4">↑↓ to navigate · Enter to insert</span>
          </div>
          {TOKEN_SUGGESTIONS.map(({ token, hint }, idx) => {
            const isActive = idx === activeIdx
            return (
              <button
                key={token}
                type="button"
                id={`token-suggestion-${idx}`}
                role="option"
                aria-selected={isActive}
                onMouseDown={e => { e.preventDefault(); insertToken(token) }}
                onMouseEnter={() => setActiveIdx(idx)}
                className={clsx(
                  'w-full h-8 flex items-center gap-3 px-2 rounded text-left transition-colors duration-150',
                  isActive ? 'bg-accent-soft' : 'hover:bg-bg-elevated',
                )}
              >
                <span className="text-body font-medium text-accent-text w-24 shrink-0">{token}</span>
                <span className="text-label text-text-3 truncate">{hint}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

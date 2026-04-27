'use client'

import { useRef, useState, KeyboardEvent } from 'react'
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
  const inputRef = useRef<HTMLInputElement>(null)

  const isEmpty = value.trim() === ''
  const showSuggestions = focused && isEmpty

  const insertToken = (token: string) => {
    onChange(token)
    inputRef.current?.focus()
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onChange('')
      inputRef.current?.blur()
    }
  }

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-bg-elevated transition-all duration-150',
          focused
            ? 'border-accent/50 shadow-[0_0_0_3px_rgba(124,92,255,0.10)]'
            : 'border-border-default hover:border-border-strong',
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
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-[13px] text-text-1 placeholder:text-text-4 min-w-0"
          spellCheck={false}
        />
        {!isEmpty && (
          <button
            onMouseDown={e => { e.preventDefault(); onChange('') }}
            className="text-text-4 hover:text-text-2 p-0.5 -m-0.5 rounded transition-colors"
            aria-label="Clear"
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
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-bg-base border border-border-strong rounded-lg shadow-card z-20 overflow-hidden">
          <div className="px-3 py-2 border-b border-border-default flex items-center justify-between">
            <span className="text-micro text-text-4 uppercase tracking-wider">Token filters</span>
            <span className="text-[10px] text-text-4">click to insert</span>
          </div>
          <div className="p-1.5">
            {TOKEN_SUGGESTIONS.map(({ token, hint }) => (
              <button
                key={token}
                onMouseDown={e => { e.preventDefault(); insertToken(token) }}
                className="w-full flex items-center gap-3 px-2.5 py-2 rounded-md hover:bg-accent/[0.06] transition-colors text-left group"
              >
                <span className="text-[11.5px] font-mono text-accent w-24 shrink-0 group-hover:text-accent-hover transition-colors">{token}</span>
                <span className="text-[11.5px] text-text-3 truncate">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

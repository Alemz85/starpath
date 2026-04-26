'use client'

import { useRef, useState, KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const TOKEN_SUGGESTIONS = [
  { token: 'company:', hint: 'filter by company name' },
  { token: 'tier:',    hint: 'T1, T2-high, T2, T3, T4' },
  { token: 'archetype:', hint: 'filter by role archetype' },
  { token: 'location:', hint: 'filter by city/country' },
  { token: 'type:',    hint: 'full-time, contract...' },
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
      <div className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors',
        focused
          ? 'border-accent/60 bg-bg-elevated'
          : 'border-border-default bg-bg-elevated hover:border-border-strong',
      )}>
        <Search size={13} className="text-text-4 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={handleKey}
          placeholder="Search… or type company:Stripe tier:T1"
          className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4 min-w-0"
          spellCheck={false}
        />
        {!isEmpty && (
          <button
            onMouseDown={e => { e.preventDefault(); onChange('') }}
            className="text-text-4 hover:text-text-2 transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-bg-panel border border-border-strong rounded-md shadow-xl z-20 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border-default">
            <span className="text-micro text-text-4 uppercase">Token filters</span>
          </div>
          <div className="p-1">
            {TOKEN_SUGGESTIONS.map(({ token, hint }) => (
              <button
                key={token}
                onMouseDown={e => { e.preventDefault(); insertToken(token) }}
                className="w-full flex items-center gap-3 px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors text-left"
              >
                <span className="text-label font-mono text-accent w-28 shrink-0">{token}</span>
                <span className="text-label text-text-4 truncate">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

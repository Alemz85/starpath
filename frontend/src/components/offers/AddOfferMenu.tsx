'use client'

// The "add an offer" affordance: a split control offering two paths —
//   • prefill from an evaluated role (searchable list of the score-history
//     corpus, ranked by Priority) — fit/growth/brand/comp come from the eval;
//   • a blank offer the user scores by hand.
// Roles already added to the current comparison are disabled in the list so the
// user can't double-add the same entity.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, FilePlus2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PickableRole } from '@/lib/offerDrafts'
import { WantEase } from '@/components/shared/WantEase'

interface AddOfferMenuProps {
  roles: PickableRole[]
  /** sourceKeys already present in the comparison — those rows are disabled. */
  usedKeys: Set<string>
  onPickRole: (role: PickableRole) => void
  onAddBlank: () => void
}

export function AddOfferMenu({ roles, usedKeys, onPickRole, onAddBlank }: AddOfferMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    setTimeout(() => inputRef.current?.focus(), 10)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? roles.filter((r) => `${r.company} ${r.role}`.toLowerCase().includes(q))
      : roles
    return list.slice(0, 50)
  }, [roles, query])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn btn-primary btn-sm titlebar-no-drag"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={13} aria-hidden />
        Add offer
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-[360px] z-30 card rounded-lg shadow-menu overflow-hidden text-left">
          {/* Blank-offer path */}
          <div className="p-1 border-b border-border-default">
            <button
              type="button"
              onClick={() => {
                onAddBlank()
                setOpen(false)
              }}
              className="w-full h-8 flex items-center gap-2 px-2 rounded text-left hover:bg-bg-elevated transition-colors duration-150 ease-quart"
            >
              <FilePlus2 size={14} className="text-text-3 shrink-0" aria-hidden />
              <span className="text-body text-text-1 shrink-0">Blank offer</span>
              <span className="text-label text-text-4 truncate">Score all six factors by hand</span>
            </button>
          </div>

          {roles.length > 0 && (
            <>
              <div className="flex items-center gap-2 h-9 px-3 border-b border-border-default">
                <Search size={14} className="text-text-3 shrink-0" aria-hidden />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Prefill from an evaluated role…"
                  className="flex-1 bg-transparent outline-none text-body text-text-1 placeholder:text-text-4"
                  spellCheck={false}
                />
              </div>
              <div className="max-h-72 overflow-y-auto p-1">
                {filtered.length === 0 ? (
                  <div className="px-3 py-4 text-center text-label text-text-4">No matching roles.</div>
                ) : (
                  filtered.map((r) => {
                    const used = usedKeys.has(r.key)
                    return (
                      <button
                        type="button"
                        key={r.key}
                        disabled={used}
                        onClick={() => {
                          onPickRole(r)
                          setOpen(false)
                        }}
                        className={cn(
                          'w-full h-8 flex items-center gap-2.5 px-2 rounded text-left transition-colors duration-150 ease-quart',
                          used ? 'opacity-50 cursor-not-allowed' : 'hover:bg-bg-elevated',
                        )}
                        title={used ? 'Already in this comparison' : `Prefill ${r.company} — ${r.role}`}
                      >
                        <WantEase want={r.want} ease={r.ease} size="sm" className="shrink-0" />
                        <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
                          <span className="text-body text-text-1 truncate shrink-0 max-w-[55%]">{r.company}</span>
                          <span className="text-label text-text-4 truncate">{r.role || '—'}</span>
                        </span>
                        {used && <Check size={13} className="text-success shrink-0" aria-hidden />}
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

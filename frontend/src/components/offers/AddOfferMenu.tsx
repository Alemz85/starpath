'use client'

// The "add an offer" affordance: a split control offering two paths —
//   • prefill from an evaluated role (searchable list of the score-history
//     corpus, ranked by Overall) — fit/growth/brand/comp come from the eval;
//   • a blank offer the user scores by hand.
// Roles already added to the current comparison are disabled in the list so the
// user can't double-add the same entity.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, FilePlus2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { scoreColor } from '@/lib/tier'
import type { PickableRole } from '@/lib/offerDrafts'

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
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-colors shadow-sm"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={14} />
        Add offer
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[340px] z-30 rounded-xl border border-border-strong bg-bg-base shadow-cosmos-lift overflow-hidden">
          {/* Blank-offer path */}
          <button
            onClick={() => {
              onAddBlank()
              setOpen(false)
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left border-b border-border-default hover:bg-bg-elevated transition-colors"
          >
            <FilePlus2 size={15} className="text-accent shrink-0" />
            <div className="min-w-0">
              <div className="text-body text-text-1">Blank offer</div>
              <div className="text-[11px] text-text-4">Enter all six factor scores by hand</div>
            </div>
          </button>

          {roles.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border-default">
                <Search size={13} className="text-text-4 shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Prefill from an evaluated role…"
                  className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4"
                  spellCheck={false}
                />
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <div className="px-3.5 py-4 text-center text-label text-text-4">No matching roles.</div>
                ) : (
                  filtered.map((r) => {
                    const used = usedKeys.has(r.key)
                    return (
                      <button
                        key={r.key}
                        disabled={used}
                        onClick={() => {
                          onPickRole(r)
                          setOpen(false)
                        }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-3.5 py-2 text-left transition-colors',
                          used ? 'opacity-50 cursor-not-allowed' : 'hover:bg-bg-elevated',
                        )}
                        title={used ? 'Already in this comparison' : `Prefill ${r.company} — ${r.role}`}
                      >
                        <span
                          className="shrink-0 w-8 text-right text-label font-mono tabular-nums font-medium"
                          style={{ color: scoreColor(r.overall) }}
                        >
                          {r.overall.toFixed(1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-body text-text-1 truncate">{r.company}</div>
                          <div className="text-[11px] text-text-4 truncate">{r.role || '—'}</div>
                        </div>
                        {used && <Check size={13} className="text-success shrink-0" />}
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

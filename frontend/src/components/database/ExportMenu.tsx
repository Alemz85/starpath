'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Copy, FileDown, Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry } from '@/types'
import { serializeRows, downloadText, exportFilename } from '@/lib/export'

// Title-bar export control for the Database lens. Opens a small dropdown
// (mirrors the RowActionPopover styling) with two outputs: copy a TSV blob
// to the clipboard, or download a CSV. `rows` is the already-filtered,
// entity-flattened list — what export produces is exactly what the user
// is looking at.
export function ExportMenu({ rows }: { rows: ScoreEntry[] }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const disabled = rows.length === 0

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Defer the click listener a tick so the opening click doesn't also
    // close the menu (same trick as RowActionPopover).
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(serializeRows(rows, 'tsv'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (rare in Electron) — fail quietly; Download still works.
    }
    setOpen(false)
  }

  const handleDownload = () => {
    downloadText(exportFilename('csv'), serializeRows(rows, 'csv'), 'text/csv')
    setOpen(false)
  }

  return (
    <div ref={ref} className="titlebar-no-drag relative">
      <button
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        disabled={disabled}
        title={disabled ? 'No rows to export' : 'Export the filtered table'}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-label transition-colors',
          disabled
            ? 'text-text-4 opacity-50 cursor-not-allowed'
            : 'text-text-3 hover:text-text-1 hover:bg-bg-elevated',
        )}
      >
        {copied ? <Check size={13} className="text-success" /> : <Download size={13} />}
        {copied ? 'Copied' : 'Export'}
        <ChevronDown size={11} className={cn('transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-60 rounded-lg border border-border-strong bg-bg-base shadow-lift overflow-hidden z-50"
          style={{ animation: 'chip-appear 160ms ease both' }}
        >
          <div className="px-3 py-2 border-b border-border-default">
            <span className="text-micro text-text-4 uppercase">
              Export {rows.length} {rows.length === 1 ? 'row' : 'rows'}
            </span>
          </div>
          <div className="py-1">
            <MenuItem
              icon={Copy}
              label="Copy to clipboard"
              hint="TSV · paste into Sheets / Excel"
              onClick={handleCopy}
            />
            <MenuItem
              icon={FileDown}
              label="Download CSV"
              hint={exportFilename('csv')}
              onClick={handleDownload}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon, label, hint, onClick,
}: {
  icon: React.ElementType
  label: string
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-text-2 hover:bg-bg-elevated hover:text-text-1 transition-colors"
    >
      <Icon size={13} className="shrink-0 opacity-80" />
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] truncate">{label}</span>
        {hint && <span className="block text-[10.5px] text-text-4 truncate font-mono">{hint}</span>}
      </span>
    </button>
  )
}

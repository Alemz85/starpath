'use client'

import { useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { useAppStore } from '@/store/app'
import { FileText, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FilesStripProps {
  company: string
  role: string
  size?: 'sm' | 'md'
  className?: string
}

// Visual indicator for which generated artifacts exist for a given listing.
// Solid icon = file present (clickable, opens with the system viewer).
// Faded outline icon = not generated yet (visual only).
//
// Canonical paths (relative to repoPath):
//   CV:   output/{Company} - {Role}.pdf
//   Prep: interview-prep/{Company} - {Role}.md   (best-guess; if the user's
//         interview-prep mode writes elsewhere this will silently render
//         faded — safe fallback)
//
// Add Draft (and any future artifacts) here in one place; every consumer
// surface picks them up automatically.
export function FilesStrip({ company, role, size = 'md', className }: FilesStripProps) {
  const repoPath = useAppStore(s => s.repoPath)
  const [cvExists, setCvExists] = useState(false)
  const [prepExists, setPrepExists] = useState(false)

  const cvPath = `output/${company} - ${role}.pdf`
  const prepPath = `interview-prep/${company} - ${role}.md`

  useEffect(() => {
    let alive = true
    Promise.all([
      ipc.fileExists(cvPath),
      ipc.fileExists(prepPath),
    ]).then(([cv, prep]) => {
      if (!alive) return
      setCvExists(!!cv)
      setPrepExists(!!prep)
    })
    return () => { alive = false }
  }, [cvPath, prepPath])

  const open = (relPath: string) => {
    if (!repoPath) return
    // openExternal accepts file:// URLs on macOS/Windows; system opens with
    // the default app for that extension (Preview for PDFs, etc).
    const url = `file://${encodeURI(`${repoPath}/${relPath}`)}`
    ipc.openExternal(url)
  }

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <FileIcon icon={FileText} label="Tailored CV"   exists={cvExists}   onClick={() => open(cvPath)}   size={size} />
      <FileIcon icon={BookOpen} label="Interview prep" exists={prepExists} onClick={() => open(prepPath)} size={size} />
    </div>
  )
}

function FileIcon({
  icon: Icon, label, exists, onClick, size,
}: {
  icon: React.ElementType
  label: string
  exists: boolean
  onClick: () => void
  size: 'sm' | 'md'
}) {
  const dims  = size === 'sm' ? 'w-6 h-6' : 'w-[26px] h-[26px]'
  const iconN = size === 'sm' ? 11 : 12

  if (!exists) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-md border border-dashed',
          'text-text-4 border-border-default opacity-55 select-none',
          dims,
        )}
        title={`${label} — not yet generated`}
        aria-label={`${label} — not yet generated`}
      >
        <Icon size={iconN} />
      </span>
    )
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        'inline-flex items-center justify-center rounded-md border transition-colors',
        'text-accent border-accent/40 bg-accent/[0.08] hover:bg-accent/[0.16] hover:border-accent/60',
        dims,
      )}
      title={`${label} — open`}
      aria-label={`${label} — open`}
    >
      <Icon size={iconN} />
    </button>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { useAppStore } from '@/store/app'
import { FileText, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  findCvFile,
  findCvSidecar,
  readinessFromInputs,
  type AtsReadiness,
} from '@/lib/atsReadiness'

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
// The CV icon additionally carries an **ATS-coverage badge** when a tailored CV
// has been ATS-measured: pdf mode persists the measured keyword coverage to a
// sidecar (`output/cv-…-{date}.ats.json`) next to the CV, and this strip reads it
// so "is this ready to send?" reflects tailoring *quality*, not just file
// presence. A CV present without a sidecar reads as "not ATS-checked" (amber dot,
// honest re-tailor nudge) — the same signal apply-kit's readiness verdict gives.
// All band/threshold logic lives in the pure, unit-tested `lib/atsReadiness`.
//
// Canonical paths (relative to repoPath, both mirror the
// reports/tier-N/{Company} - {Role}.md naming so a single (company, role)
// pair joins all three):
//   CV:   output/{Company} - {Role}.pdf
//   Prep: interview-prep/{Company} - {Role}.md
//
// Add Draft (and any future artifacts) here in one place; every consumer
// surface picks them up automatically.
export function FilesStrip({ company, role, size = 'md', className }: FilesStripProps) {
  const repoPath = useAppStore(s => s.repoPath)
  // The real tailored-CV path, resolved by globbing output/ for the company's
  // `cv-…` file (the name pdf mode actually writes). Falls back to the legacy
  // `{Company} - {Role}.pdf` path if that's all that's on disk. Null = no CV.
  const [cvPath, setCvPath] = useState<string | null>(null)
  const [prepExists, setPrepExists] = useState(false)
  const [ats, setAts] = useState<AtsReadiness | null>(null)

  const legacyCvPath = `output/${company} - ${role}.pdf`
  const prepPath = `interview-prep/${company} - ${role}.md`

  useEffect(() => {
    ipc.fileExists(prepPath).then(setPrepExists)
  }, [prepPath])

  // One output/ listing resolves both the CV presence AND its ATS readiness, so
  // the two can never disagree. pdf mode writes the CV as
  // `cv-{candidate}-{company}-{date}.{pdf,html}` and the coverage sidecar as the
  // `.ats.json` twin — both keyed by an embedded company token (candidate + date
  // vary, so we glob rather than reconstruct an exact name). All resilient to an
  // absent output/ dir or missing sidecar: presence falls back to the legacy
  // path, readiness falls through to 'absent' / 'unchecked'.
  useEffect(() => {
    let alive = true
    ipc.listDir('output').then(async (raw) => {
      const files = Array.isArray(raw) ? raw : []
      const cvFile = findCvFile(company, files)
      const sidecar = findCvSidecar(company, files)
      const text = sidecar ? await ipc.readFile(`output/${sidecar}`) : null
      if (!alive) return
      let cvFound = !!cvFile
      if (cvFile) {
        setCvPath(`output/${cvFile}`)
      } else {
        // No globbed cv-… file. Fall back to the legacy per-(company,role) path.
        const legacy = await ipc.fileExists(legacyCvPath)
        if (!alive) return
        cvFound = legacy
        setCvPath(legacy ? legacyCvPath : null)
      }
      // Readiness keys off CV existence, not the sidecar: a CV present without a
      // sidecar is honestly 'unchecked' (apply-kit's stale → re-tailor), not
      // 'absent'. 'absent' means no tailored CV at all.
      setAts(readinessFromInputs(cvFound, text))
    }).catch(() => { if (alive) { setCvPath(null); setAts(null) } })
    return () => { alive = false }
  }, [company, legacyCvPath])

  const open = (relPath: string) => {
    if (!repoPath) return
    // openExternal accepts file:// URLs on macOS/Windows; system opens with
    // the default app for that extension (Preview for PDFs, etc).
    const url = `file://${encodeURI(`${repoPath}/${relPath}`)}`
    ipc.openExternal(url)
  }

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <FileIcon
        icon={FileText}
        label="Tailored CV"
        exists={!!cvPath}
        onClick={() => cvPath && open(cvPath)}
        size={size}
        ats={ats}
      />
      <FileIcon icon={BookOpen} label="Application prep" exists={prepExists} onClick={() => open(prepPath)} size={size} />
    </div>
  )
}

// Map an ATS tone token → the badge's surface/text classes. Tokens only — no new
// colors. 'accent' is the readiness floor (galaxy violet, the brand action
// color); success/warning are the semantic outcome hues from DESIGN-meta.
const ATS_BADGE_CLASS: Record<AtsReadiness['tone'], string> = {
  success: 'bg-success text-white',
  accent:  'bg-accent text-white',
  warning: 'bg-warning text-text-1',
  muted:   'bg-bg-elevated text-text-4',
}

function FileIcon({
  icon: Icon, label, exists, onClick, size, ats,
}: {
  icon: React.ElementType
  label: string
  exists: boolean
  onClick: () => void
  size: 'sm' | 'md'
  // Only the CV icon receives ATS readiness; the prep icon leaves it undefined.
  ats?: AtsReadiness | null
}) {
  const dims  = size === 'sm' ? 'w-6 h-6' : 'w-[26px] h-[26px]'
  const iconN = size === 'sm' ? 11 : 12

  // The badge only renders when there's a coverage signal worth showing — a CV
  // that's been ATS-measured (strong/ok/low) or a CV present-but-unchecked.
  // 'absent' (no tailored CV at all) shows nothing; the faded outline icon below
  // already conveys "not generated yet".
  const showBadge = !!ats && ats.verdict !== 'absent'
  // For measured coverage we show the rounded %; for an unchecked CV there's no
  // number, so we render a bare dot so the user still sees "present but
  // unverified".
  const badgeText = ats?.coveragePct != null ? `${ats.coveragePct}` : ''

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

  // Title folds the file action and (when present) the ATS readiness into one
  // honest hover string, e.g. "Tailored CV — open · ATS coverage 82% — strong".
  const title = ats && ats.verdict !== 'absent'
    ? `${label} — open · ${ats.label}`
    : `${label} — open`

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        'relative inline-flex items-center justify-center rounded-md border transition-colors',
        'text-accent border-accent/40 bg-accent/[0.08] hover:bg-accent/[0.16] hover:border-accent/60',
        dims,
      )}
      title={title}
      aria-label={title}
    >
      <Icon size={iconN} />
      {showBadge && ats && (
        <span
          className={cn(
            'absolute -top-1.5 -right-1.5 inline-flex items-center justify-center',
            'rounded-full ring-1 ring-bg-base shadow-subtle select-none',
            'text-[8px] font-semibold leading-none tabular-nums',
            ATS_BADGE_CLASS[ats.tone],
            // A measured % needs width for up to 3 digits; an unchecked CV has no
            // number, so it collapses to a compact status dot.
            badgeText !== '' ? 'min-w-[14px] h-[14px] px-[3px]' : 'w-[8px] h-[8px]',
          )}
          aria-hidden="true"
        >
          {badgeText}
        </span>
      )}
    </button>
  )
}

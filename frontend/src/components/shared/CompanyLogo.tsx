'use client'

import { useState, useEffect } from 'react'
import { ipc } from '@/lib/ipc'
import { guessDomain } from '@/lib/companyDomain'

// ─── Avatar fallback ─────────────────────────────────────────────────────────

// Meta FDS spectrum — pairs of accent + slightly darker variant for gradient avatars on white
const PALETTE: [string, string][] = [
  ['#7C5CFF', '#5B3FE8'], ['#A121CE', '#6F1B91'], ['#2ABBA7', '#1F8478'],
  ['#FB724B', '#C8431F'], ['#F3425F', '#C81F3D'], ['#54C7EC', '#2A8FB5'],
  ['#FF66BF', '#C73D93'], ['#C99518', '#8E6610'],
]

function hashPalette(name: string): [string, string] {
  let h = 0
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) & 0xffff
  return PALETTE[h % PALETTE.length]
}

function initials(company: string): string {
  return company
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?'
}

// ─── Component ────────────────────────────────────────────────────────────────

interface CompanyLogoProps {
  company: string
  size?: number
  className?: string
}

export function CompanyLogo({ company, size = 20, className }: CompanyLogoProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const domain = guessDomain(company)
  const radius = size <= 16 ? 3 : size <= 24 ? 4 : 6
  const [from, to] = hashPalette(company)
  const abbr = initials(company)
  const fontSize = Math.round(size * 0.38)

  useEffect(() => {
    let cancelled = false
    ipc.fetchLogo(domain).then(url => {
      if (!cancelled) setDataUrl(url)
    })
    return () => { cancelled = true }
  }, [domain])

  const baseStyle: React.CSSProperties = {
    width: size, height: size, minWidth: size,
    borderRadius: radius,
    overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  // Still loading — show initials as placeholder (no flash)
  if (dataUrl === null) {
    return (
      <div className={className} style={{
        ...baseStyle,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        fontSize, fontWeight: 600, color: '#fff',
        userSelect: 'none', letterSpacing: '-0.01em',
      }}>
        {abbr}
      </div>
    )
  }

  // IPC returned nothing — stay on initials permanently
  if (dataUrl === '') {
    return (
      <div className={className} style={{
        ...baseStyle,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        fontSize, fontWeight: 600, color: '#fff',
        userSelect: 'none', letterSpacing: '-0.01em',
      }}>
        {abbr}
      </div>
    )
  }

  return (
    <div className={className} style={{ ...baseStyle, background: '#fff' }}>
      <img
        src={dataUrl}
        alt={company}
        width={size}
        height={size}
        style={{ objectFit: 'contain', width: '100%', height: '100%' }}
        onError={() => setDataUrl('')}
      />
    </div>
  )
}

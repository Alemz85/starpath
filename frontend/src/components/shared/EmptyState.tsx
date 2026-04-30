import { cn } from '@/lib/utils'

interface EmptyStateProps {
  title: string
  hint?: string
  className?: string
}

// Small reusable empty state with a hand-drawn constellation glyph.
// Reserved for the "you have no data yet" surfaces — not for filter-
// returns-nothing inline messages, which keep the simple-text pattern
// to avoid over-decorating routine search misses.
export function EmptyState({ title, hint, className }: EmptyStateProps) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center gap-4 py-10',
      className,
    )}>
      <ConstellationGlyph />
      <div className="space-y-1">
        <p className="text-section text-text-2">{title}</p>
        {hint && <p className="text-label text-text-4 max-w-[40ch]">{hint}</p>}
      </div>
    </div>
  )
}

function ConstellationGlyph() {
  return (
    <svg
      viewBox="0 0 110 70"
      width="110"
      height="70"
      fill="none"
      strokeLinecap="round"
      aria-hidden
    >
      {/* Faint connecting lines — drawn first so circles overlay on top */}
      <path
        d="M14 56 L36 22 M36 22 L62 42 M62 42 L94 16 M36 22 L48 6"
        stroke="currentColor"
        strokeWidth="0.6"
        className="text-accent/30"
      />
      {/* Stars: alternating sizes for natural rhythm */}
      <circle cx="14" cy="56" r="1.6" fill="currentColor" className="text-accent/50" />
      <circle cx="36" cy="22" r="2.4" fill="currentColor" className="text-accent/80" />
      <circle cx="62" cy="42" r="1.7" fill="currentColor" className="text-accent/55" />
      <circle cx="94" cy="16" r="2.4" fill="currentColor" className="text-accent/80" />
      <circle cx="48" cy="6"  r="1.2" fill="currentColor" className="text-accent/40" />
      {/* Two lone background twinkles for ambient depth */}
      <circle cx="78" cy="58" r="0.9" fill="currentColor" className="text-accent/30" />
      <circle cx="22" cy="14" r="0.9" fill="currentColor" className="text-accent/30" />
    </svg>
  )
}

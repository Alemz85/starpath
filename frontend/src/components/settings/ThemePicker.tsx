'use client'

import { useRef } from 'react'
import { Check } from 'lucide-react'
import { PALETTES, themeColor, type ChannelToken, type PaletteId } from '@/lib/themes'
import { usePaletteStore } from '@/store/palette'
import { cn } from '@/lib/utils'

// Settings › General › Appearance. One card per theme in lib/themes.ts: a
// strip of the theme's four signature colours, its name and a line on what
// it is. The strip reads the colours from the theme's own block through
// data-palette={id}, so nothing is copied here and a new theme gets a
// correct strip the moment its CSS block and registry entry exist.
// Radio-group semantics: arrow keys move and select, the choice applies
// instantly.

export function ThemePicker() {
  const palette = usePaletteStore(s => s.palette)
  const setPalette = usePaletteStore(s => s.setPalette)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (index + step + PALETTES.length) % PALETTES.length
    setPalette(PALETTES[next].id)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
      {PALETTES.map((p, i) => {
        const selected = p.id === palette
        return (
          <button
            key={p.id}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-describedby={`theme-desc-${p.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setPalette(p.id as PaletteId)}
            onKeyDown={e => onKeyDown(e, i)}
            className="group self-start text-left rounded-lg focus-visible:outline-none"
          >
            <ThemeSwatches id={p.id} swatches={p.swatches} selected={selected} />
            <span className="mt-2 flex items-center gap-1 text-body font-medium text-text-1">
              {p.name}
              {selected && <Check size={13} className="text-accent-text" aria-hidden />}
            </span>
            <span id={`theme-desc-${p.id}`} className="block text-label text-text-3 line-clamp-3">
              {p.description}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** The theme's four signature colours as one strip. The strip carries
 *  data-palette={id}, so each swatch reads the token from that theme's own
 *  block; the ring sits outside it and uses the active theme's accent. */
function ThemeSwatches({ id, swatches, selected }: { id: string; swatches: readonly ChannelToken[]; selected: boolean }) {
  return (
    <div
      className={cn(
        'rounded-md p-0.5 transition-shadow duration-150 ease-quart',
        selected ? 'ring-2 ring-accent' : 'group-hover:shadow-card group-focus-visible:ring-2 group-focus-visible:ring-accent/40',
      )}
    >
      <div data-palette={id} aria-hidden className="h-11 flex rounded overflow-hidden border border-black/10">
        {swatches.map(t => (
          <span key={t} className="flex-1" style={{ background: themeColor(t) }} />
        ))}
      </div>
    </div>
  )
}

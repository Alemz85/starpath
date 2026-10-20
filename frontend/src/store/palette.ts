import { create } from 'zustand'
import { DEFAULT_PALETTE, PALETTE_STORAGE_KEY, isPaletteId, type PaletteId } from '@/lib/themes'

// The active colour theme. The inline boot script in app/layout.tsx has
// already set data-palette on <html> before first paint; this store reads it
// back so Settings shows the right selection, and writes both the attribute
// and localStorage when the user picks another theme. Nothing else needs to
// subscribe: every colour is a CSS variable, so the repaint is the cascade's.

function readInitial(): PaletteId {
  if (typeof document === 'undefined') return DEFAULT_PALETTE
  const attr = document.documentElement.getAttribute('data-palette')
  return isPaletteId(attr) ? attr : DEFAULT_PALETTE
}

interface PaletteState {
  palette: PaletteId
  setPalette: (id: PaletteId) => void
}

export const usePaletteStore = create<PaletteState>(set => ({
  palette: readInitial(),
  setPalette: id => {
    document.documentElement.setAttribute('data-palette', id)
    try { localStorage.setItem(PALETTE_STORAGE_KEY, id) } catch { /* storage blocked: the choice lasts this session */ }
    set({ palette: id })
  },
}))

// Theme registry — data only. The colours themselves live in
// src/app/themes.css, one `[data-palette="<id>"]` block per entry below.
// Adding a theme = one CSS block + one entry here; themes.test.ts fails if
// either half is missing or a token is left out. See DESIGN-meta.md § 2.

export interface PaletteInfo {
  id: string
  name: string
  description: string
  /** The four tokens that best tell this theme apart, shown as its swatch
   *  strip in Settings. Token names, not colours: the strip reads them from
   *  the theme's own block. */
  swatches: readonly [ChannelToken, ChannelToken, ChannelToken, ChannelToken]
}

export const PALETTES = [
  { id: 'bluehour',    name: 'Blue hour',   description: 'One blue family from night to sky. Navy sidebar with stars, cerulean accent.',
    swatches: ['nav-bg', 'accent', 'accent-light', 'nav-brand-2'] },
  { id: 'aurora',      name: 'Aurora',      description: 'Navy night with an aurora glow. Jade carries selection and scores.',
    swatches: ['nav-bg', 'accent', 'nav-brand-3', 'nav-brand-2'] },
  { id: 'starchart',   name: 'Star chart',  description: 'A celestial atlas: Prussian blue, a drawn constellation, gold for Go.',
    swatches: ['nav-bg', 'accent', 'accent-light', 'nav-brand-2'] },
  { id: 'observatory', name: 'Observatory', description: 'Night-violet sidebar with stars beside a pale lavender day.',
    swatches: ['nav-bg', 'accent', 'accent-light', 'bg-panel'] },
  { id: 'galaxy',      name: 'Galaxy',      description: 'The original look: galaxy violet on cool greys, light sidebar.',
    swatches: ['tier-1', 'accent', 'accent-light', 'glow-2'] },
] as const satisfies readonly PaletteInfo[]

export type PaletteId = (typeof PALETTES)[number]['id']

/** Used when nothing is stored or the stored id no longer exists. Matches the
 *  `:root` block in themes.css, so even a missing attribute renders it. */
export const DEFAULT_PALETTE: PaletteId = 'bluehour'

/** localStorage key. Read before first paint by the inline script in
 *  app/layout.tsx, written by store/palette.ts. */
export const PALETTE_STORAGE_KEY = 'starpath.palette'

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && PALETTES.some(p => p.id === v)
}

/** Inline script for <head>: sets data-palette on <html> before the first
 *  paint so a stored theme never flashes the default on launch. Unknown ids
 *  fall back to the default. Kept as a string because it runs before React. */
export const PALETTE_BOOT_SCRIPT = `(function(){try{var ids=${JSON.stringify(PALETTES.map(p => p.id))};var v=localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});document.documentElement.setAttribute('data-palette',ids.indexOf(v)>=0?v:${JSON.stringify(DEFAULT_PALETTE)})}catch(e){document.documentElement.setAttribute('data-palette',${JSON.stringify(DEFAULT_PALETTE)})}})()`

// ─── Colour roles ────────────────────────────────────────────────────────────
// Every theme block in themes.css defines exactly these tokens (themes.test.ts
// checks). Channel tokens are sRGB triplets usable with an alpha; full tokens
// are complete colours. A new role is added here, to every theme block, and
// to tailwind.config.ts.

export const CHANNEL_TOKENS = [
  'bg-base', 'bg-cosmos', 'bg-panel', 'bg-elevated',
  'border-default', 'border-strong', 'divider', 'divider-soft', 'control-border',
  'text-1', 'text-2', 'text-3', 'text-4',
  'accent', 'accent-hover', 'accent-press', 'accent-text', 'accent-light',
  'action', 'action-hover', 'action-press', 'action-text',
  'tier-1', 'tier-1-bg', 'tier-1-light', 'tier-2', 'tier-2-bg', 'tier-2-light',
  'tier-3', 'tier-3-bg', 'tier-3-light', 'tier-4', 'tier-4-bg', 'tier-4-light',
  'score-mid', 'track', 'track-strong', 'bar-track',
  'success', 'warning', 'warning-text', 'danger',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7',
  'night-deep', 'night', 'night-2', 'scrim',
  'term-text', 'term-tool', 'term-ok', 'term-err', 'term-warn',
  'glow-2', 'star-1', 'star-2', 'shadow', 'shadow-accent',
  'nav-bg', 'nav-line', 'nav-text', 'nav-strong', 'nav-muted', 'nav-faint',
  'nav-active-text', 'nav-count-text', 'nav-accent', 'nav-brand-1', 'nav-brand-2', 'nav-brand-3',
] as const

export const FULL_TOKENS = [
  'accent-soft', 'nav-hover-bg', 'nav-input-bg', 'nav-input-border', 'nav-input-border-hover', 'nav-active-bg', 'nav-count-bg',
] as const

/** Non-colour custom properties each theme block also sets. */
export const THEME_EXTRAS = ['--nav-stars-opacity', '--nav-sky-after', '--cosmos-grain'] as const

export type ChannelToken = (typeof CHANNEL_TOKENS)[number]
export type FullToken = (typeof FULL_TOKENS)[number]

/** A theme colour for inline styles, SVG attributes and chart props — the one
 *  way to colour something outside a Tailwind class. Follows the active
 *  theme with no re-render. `themeColor('accent', 0.2)` → 20% accent. */
export function themeColor(token: ChannelToken, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--c-${token}))` : `rgb(var(--c-${token}) / ${alpha})`
}

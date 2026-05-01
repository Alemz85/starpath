import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds — observatory premium. Card surfaces stay on
        // bg-base (true white for legibility), but the page shell uses
        // bg-cosmos: a barely-perceptible OKLCH violet bleed so every
        // surface reads as floating in galaxy space rather than on
        // generic white. Chroma 0.004 keeps the tint subliminal.
        'bg-base':     '#FFFFFF',  // card / popover canvas
        'bg-cosmos':   'oklch(0.99 0.004 285)', // app shell / page wash
        'bg-panel':    '#F1F4F7',  // soft gray secondary sections (--dolly-bg-grey)
        'bg-elevated': '#F7F8FA',  // warm gray card surface
        'bg-chrome':   '#F0F2F5',  // web wash deemphasized
        // Borders — Dolly divider scale
        'border-default': '#DEE3E9',  // dolly divider gray
        'border-strong':  '#CED0D4',  // standard divider / input border
        // Text — Dolly hierarchy on light
        'text-1': '#050505',  // primary headings, max contrast
        'text-2': '#1C2B33',  // dark charcoal body (--dolly-text-primary)
        'text-3': '#5D6C7B',  // slate gray secondary (--dolly-text-secondary)
        'text-4': '#8595A4',  // muted, disabled labels
        // Accent — Galaxy violet (lighter version of the immersive #0A0820)
        'accent':       '#7C5CFF',
        'accent-hover': '#5B3FE8',
        'accent-press': '#4A2FC8',
        'accent-soft':  'rgba(124,92,255,0.12)',
        'accent-text':  '#7C5CFF',
        'accent-light': '#B5A3FF',
        // Tier palette — galaxy violet gradient. T1 deep indigo for the
        // strongest matches; T4 fades to slate so the worst rows recede.
        // Used for tier chips (badge + matching `tier-N-bg` surface) where
        // the lavender reads as a tier marker thanks to chip context.
        //
        // Note: continuous score colors (Database cells, Trends top-X,
        // slide-over rollups) DIVERGE from this scale — they use a 5-band
        // gradient with aurora teal at the top (≥9.0), brand violets in
        // the apply zone (7.0–8.9), and neutral slate below. See
        // `lib/tier.ts → scoreColor` for the full banding + rationale.
        'tier-1':      '#3D2BB5',  // deep galaxy indigo — strongest
        'tier-1-bg':   '#EFEAFF',
        'tier-2':      '#7C5CFF',  // galaxy violet (matches accent)
        'tier-2-bg':   '#F1ECFF',
        'tier-3':      '#A89CD9',  // muted lavender — softer
        'tier-3-bg':   '#F4F1FA',
        'tier-4':      '#94A3B8',  // faded slate — barely there
        // Semantic — Dolly/FDS
        'success': '#007D1E',
        'warning': '#F7B928',
        'danger':  '#C80A28',
        'info':    '#7C5CFF',
        // Galaxy surfaces — matte palette for activity panels
        'galaxy-deep':    '#0A0820',  // immersive splash
        'galaxy-matte':   '#1F1B36',  // activity panel body (matte/pastel)
        'galaxy-matte-2': '#2A2548',  // activity panel header (slightly lighter)
        // Data viz categorical palette — aurora-tuned cousins of galaxy
        // violet. Used for multi-series charts (TrendsView lines, future
        // radar/spider, breakdown panels) where 5–7 distinguishable hues
        // are needed without collapsing into one violet ladder. Anchored
        // on chart-1 = accent so "Overall" reads as the brand series; the
        // rest fan out warm + cool. See DESIGN-meta.md § Data Viz palette.
        'chart-1': '#7C5CFF',  // galaxy violet — anchor / Overall
        'chart-2': '#3D2BB5',  // deep indigo — strongest fit
        'chart-3': '#2EB8A8',  // aurora teal — cool counterpart
        'chart-4': '#E84F8E',  // nebula pink — warm counterpart
        'chart-5': '#F2A837',  // cosmic amber — warm tertiary
        'chart-6': '#4D8DFF',  // azure — cool tertiary
        'chart-7': '#8595A4',  // slate — neutral / "muted by intent"
      },
      fontFamily: {
        // Optimistic VF is proprietary; Montserrat (a Meta-listed fallback)
        // and Inter approximate its humanist-geometric feel.
        sans: ['Montserrat', 'Inter', '-apple-system', 'system-ui', 'Helvetica', 'Arial', 'Noto Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      fontSize: {
        // One display moment — used exclusively on the entry hero
        // (CommandCenter Scouting). Capped at 36px so it never strays
        // into marketing-page territory; the rest of the app stays on
        // text-page (22px) and below for ruthless density consistency.
        'display-2': ['36px', { lineHeight: '1.12', fontWeight: '500', letterSpacing: '-0.02em' }],
        'page':    ['22px', { lineHeight: '1.28', fontWeight: '500' }],
        'section': ['16px', { lineHeight: '1.4',  fontWeight: '500', letterSpacing: '-0.16px' }],
        'body':    ['13px', { lineHeight: '1.5',  fontWeight: '400' }],
        'cell':    ['13px', { lineHeight: '1',    fontWeight: '400' }],
        'label':   ['12px', { lineHeight: '1.4',  fontWeight: '400', letterSpacing: '-0.14px' }],
        'micro':   ['11px', { lineHeight: '1',    fontWeight: '600', letterSpacing: '0.06em' }],
      },
      borderRadius: {
        'sm':   '8px',    // inputs, small UI elements
        'md':   '12px',   // mid containers
        'lg':   '20px',   // standard card (--card-corner-radius)
        'xl':   '24px',   // feature card
        'pill': '100px',  // pill buttons, tags, badges
      },
      boxShadow: {
        // Meta dual-shadow pattern: ambient + direct. Black-alpha is the
        // baseline for neutral surfaces.
        'card':  '0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)',
        'lift':  '0 16px 32px 0 rgba(0,0,0,0.10), 0 2px 6px 0 rgba(0,0,0,0.05)',
        'subtle':'0 2px 4px 0 rgba(0,0,0,0.06)',
        // Galaxy-tinted shadows — ambient + direct on the violet hue
        // axis instead of pure black. Used on hero cards and the
        // primary CTA so cast shadow inherits the brand temperature
        // (a high-end-visual cue: shadow color matches surface mood).
        'cosmos':  '0 12px 28px 0 rgba(76, 47, 200, 0.10), 0 2px 4px 0 rgba(76, 47, 200, 0.05)',
        'cosmos-lift': '0 18px 36px 0 rgba(76, 47, 200, 0.14), 0 3px 8px 0 rgba(76, 47, 200, 0.06)',
        // Pill CTA shadows — galaxy-violet drop. Match `.btn-pill`.
        'pill':       '0 1px 2px rgba(76, 47, 200, 0.15)',
        'pill-hover': '0 6px 18px 0 rgba(124, 92, 255, 0.32), 0 1px 2px 0 rgba(76, 47, 200, 0.18)',
      },
      transitionTimingFunction: {
        // Ease-out-quart — exponential decay curve. Used for every UI
        // transition app-wide so motion has a coherent feel. Replaces
        // ad-hoc `ease`, `ease-out`, and `ease-in-out` calls (those
        // accumulate as visual inconsistency over a dozen components).
        'quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        // Spring-ish ease-out for the more playful comet/sweep style
        // moments — sharper start, gentler tail than quart.
        'expo':  'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      spacing: {
        '4.5': '18px',
      },
    },
  },
  plugins: [],
}

export default config

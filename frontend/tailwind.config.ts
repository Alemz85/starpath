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
        // Backgrounds — Meta Store binary surface strategy
        'bg-base':     '#FFFFFF',  // pure white canvas
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
        // Tier palette (Meta-tuned for white surface)
        'tier-1':      '#C99518',  // gold (deeper for contrast on white)
        'tier-1-bg':   '#FFF8E1',
        'tier-2':      '#6B7280',  // silver gray
        'tier-2-bg':   '#F1F4F7',
        'tier-3':      '#A0612C',  // bronze
        'tier-3-bg':   '#FBF1E8',
        'tier-4':      '#7A8590',  // medium slate, readable when row is dimmed
        // Semantic — Dolly/FDS
        'success': '#007D1E',
        'warning': '#F7B928',
        'danger':  '#C80A28',
        'info':    '#7C5CFF',
        // Galaxy surfaces — matte palette for activity panels
        'galaxy-deep':    '#0A0820',  // immersive splash
        'galaxy-matte':   '#1F1B36',  // activity panel body (matte/pastel)
        'galaxy-matte-2': '#2A2548',  // activity panel header (slightly lighter)
      },
      fontFamily: {
        // Optimistic VF is proprietary; Montserrat (a Meta-listed fallback)
        // and Inter approximate its humanist-geometric feel.
        sans: ['Montserrat', 'Inter', '-apple-system', 'system-ui', 'Helvetica', 'Arial', 'Noto Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      fontSize: {
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
        // Meta dual-shadow pattern: ambient + direct
        'card':  '0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)',
        'lift':  '0 16px 32px 0 rgba(0,0,0,0.10), 0 2px 6px 0 rgba(0,0,0,0.05)',
        'subtle':'0 2px 4px 0 rgba(0,0,0,0.06)',
      },
      spacing: {
        '4.5': '18px',
      },
    },
  },
  plugins: [],
}

export default config

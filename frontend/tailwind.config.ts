import type { Config } from 'tailwindcss'

// Design tokens — the single source of truth for colour, type, shape and
// elevation. DESIGN-meta.md documents the rules; this file holds the values.
const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  // Component classes referenced only through data (e.g. a status → tone map)
  // must stay in the build even when no source file spells them out.
  safelist: [
    { pattern: /^btn-(primary|secondary|ghost|tinted|danger|stop|xs|sm|lg|icon)$/ },
    { pattern: /^chip-(accent|success|warning|danger|muted|plain|md|pill)$/ },
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces. Cards sit on bg-base (true white); the app shell uses
        // bg-cosmos, a barely-perceptible violet wash.
        'bg-base':     '#FFFFFF',
        'bg-cosmos':   'oklch(0.99 0.004 285)',
        'bg-panel':    '#F1F4F7',
        'bg-elevated': '#F7F8FA',
        'bg-chrome':   '#F6F7FA',
        // Borders
        'border-default': '#E4E8ED',
        'border-strong':  '#D3D9E0',
        // Text
        'text-1': '#050505',
        'text-2': '#1C2B33',
        'text-3': '#5D6C7B',
        'text-4': '#8595A4',
        // Accent — galaxy violet. Reserved for actions, selection, links.
        'accent':       '#7C5CFF',
        'accent-hover': '#5B3FE8',
        'accent-press': '#4A2FC8',
        'accent-soft':  'rgba(124,92,255,0.12)',
        'accent-text':  '#5B3FE8',
        'accent-light': '#B5A3FF',
        // Tier ladder — one ordinal violet scale shared by tier chips and
        // score numbers (see lib/tier.ts → scoreColor).
        'tier-1':      '#3D2BB5',
        'tier-1-bg':   '#EFEAFF',
        'tier-2':      '#7C5CFF',
        'tier-2-bg':   '#F1ECFF',
        'tier-3':      '#8B7FC2',
        'tier-3-bg':   '#F4F1FA',
        'tier-4':      '#94A3B8',
        // Semantic — application lifecycle and process state only.
        'success':      '#007D1E',
        'warning':      '#F7B928',
        'warning-text': '#8A5A00',
        'danger':       '#C80A28',
        'info':         '#7C5CFF',
        // Dark surfaces (Activity terminal, onboarding)
        'galaxy-deep':    '#0A0820',
        'galaxy-matte':   '#1F1B36',
        'galaxy-matte-2': '#2A2548',
        // Categorical chart palette — charts only, never chrome.
        'chart-1': '#7C5CFF',
        'chart-2': '#3D2BB5',
        'chart-3': '#2EB8A8',
        'chart-4': '#E84F8E',
        'chart-5': '#F2A837',
        'chart-6': '#4D8DFF',
        'chart-7': '#8595A4',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'IBM Plex Sans', '-apple-system', 'system-ui', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['var(--font-mono)', 'IBM Plex Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      fontSize: {
        // Seven steps. Nothing outside this scale, nothing uppercase.
        'display': ['28px', { lineHeight: '1.15', fontWeight: '600', letterSpacing: '-0.02em' }],
        'display-2': ['28px', { lineHeight: '1.15', fontWeight: '600', letterSpacing: '-0.02em' }],
        'page':    ['20px', { lineHeight: '1.25', fontWeight: '600', letterSpacing: '-0.01em' }],
        'stat':    ['26px', { lineHeight: '1',    fontWeight: '600', letterSpacing: '-0.015em' }],
        'title':   ['15px', { lineHeight: '1.35', fontWeight: '600' }],
        'section': ['14px', { lineHeight: '1.4',  fontWeight: '600' }],
        'body':    ['13px', { lineHeight: '1.5',  fontWeight: '400' }],
        'cell':    ['13px', { lineHeight: '1.25', fontWeight: '400' }],
        'label':   ['12px', { lineHeight: '1.4',  fontWeight: '400' }],
        'micro':   ['11px', { lineHeight: '1.35', fontWeight: '500', letterSpacing: '0' }],
      },
      borderRadius: {
        // Controls 8, containers 14, overlays 18, chips and badges pill.
        'sm':   '6px',
        DEFAULT: '8px',
        'md':   '10px',
        'lg':   '14px',
        'xl':   '18px',
        '2xl':  '22px',
        'pill': '100px',
      },
      boxShadow: {
        // Soft depth: a 1px contact shadow plus a wide, faint ambient one,
        // tinted toward the violet so cards feel lit by the page wash.
        'subtle': '0 1px 2px 0 rgba(40, 32, 90, 0.05), 0 1px 1px 0 rgba(40, 32, 90, 0.03)',
        'card':   '0 1px 2px 0 rgba(40, 32, 90, 0.05), 0 10px 30px -12px rgba(40, 32, 90, 0.14)',
        'lift':   '0 2px 6px 0 rgba(40, 32, 90, 0.06), 0 24px 56px -16px rgba(40, 32, 90, 0.24)',
        'menu':   '0 1px 2px 0 rgba(40, 32, 90, 0.06), 0 14px 40px -10px rgba(40, 32, 90, 0.20)',
        // Violet-tinted variants for the two dark/hero moments that keep one.
        'cosmos':      '0 1px 2px 0 rgba(76, 47, 200, 0.06), 0 10px 28px -10px rgba(76, 47, 200, 0.16)',
        'cosmos-lift': '0 2px 6px 0 rgba(76, 47, 200, 0.08), 0 18px 44px -12px rgba(76, 47, 200, 0.22)',
        'pill':       '0 1px 2px rgba(76, 47, 200, 0.15)',
        'pill-hover': '0 4px 12px 0 rgba(124, 92, 255, 0.28)',
      },
      transitionTimingFunction: {
        'quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
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

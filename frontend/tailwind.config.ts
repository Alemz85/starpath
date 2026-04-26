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
        // Backgrounds
        'bg-base':     '#0D0A1F',
        'bg-panel':    '#15102B',
        'bg-elevated': '#1D1638',
        'bg-chrome':   '#1A1432',
        // Borders
        'border-default': '#2A2342',
        'border-strong':  '#3D3458',
        // Text
        'text-1': '#E8E6F0',
        'text-2': '#C8C5D6',
        'text-3': '#8A83A8',
        'text-4': '#6B6680',
        // Accent (galaxy violet)
        'accent':      '#7C5CFF',
        'accent-soft': 'rgba(124,92,255,0.15)',
        'accent-text': '#B5A3FF',
        // Tier palette (metals)
        'tier-1':      '#E8B547',
        'tier-1-bg':   '#1A0F00',
        'tier-2':      '#C8C5D6',
        'tier-2-bg':   '#2A2342',
        'tier-3':      '#C77B3B',
        'tier-3-bg':   '#1A0A00',
        'tier-4':      '#525252',
        // Semantic
        'success': '#10B981',
        'warning': '#F59E0B',
        'danger':  '#EF4444',
        'info':    '#3B82F6',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      fontSize: {
        'page':    ['22px', { lineHeight: '1.3', fontWeight: '500' }],
        'section': ['16px', { lineHeight: '1.4', fontWeight: '500' }],
        'body':    ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        'cell':    ['13px', { lineHeight: '1', fontWeight: '400' }],
        'label':   ['12px', { lineHeight: '1.4', fontWeight: '400' }],
        'micro':   ['11px', { lineHeight: '1', fontWeight: '500', letterSpacing: '0.04em' }],
      },
      borderRadius: {
        'sm': '4px',
        'md': '6px',
        'lg': '8px',
      },
      spacing: {
        '4.5': '18px',
      },
    },
  },
  plugins: [],
}

export default config

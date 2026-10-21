import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHANNEL_TOKENS, FULL_TOKENS, THEME_EXTRAS, PALETTES, DEFAULT_PALETTE, themeColor, isPaletteId, PALETTE_BOOT_SCRIPT } from '@/lib/themes'

// Theme completeness and contrast. Every theme in PALETTES must have a block
// in src/app/themes.css that defines exactly the shared token set, and its
// text colours must stay readable. A sixth theme that forgets a token fails
// here instead of silently inheriting the default's colour.

const CSS = readFileSync(new URL('../app/themes.css', import.meta.url), 'utf8')

type Block = { selector: string; vars: Map<string, string> }
function blocks(): Block[] {
  const out: Block[] = []
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const vars = new Map<string, string>()
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars.set(d[1], d[2].trim())
    out.push({ selector: m[1].trim(), vars })
  }
  return out
}
function themeBlock(id: string): Block | undefined {
  return blocks().find(b => b.selector.split(',').map(s => s.trim()).includes(`[data-palette="${id}"]`))
}

const EXPECTED = [...CHANNEL_TOKENS.map(t => `--c-${t}`), ...FULL_TOKENS.map(t => `--c-${t}`), ...THEME_EXTRAS].sort()

test('every registered theme has a themes.css block with exactly the shared token set', () => {
  for (const p of PALETTES) {
    const b = themeBlock(p.id)
    assert.ok(b, `themes.css has no [data-palette="${p.id}"] block`)
    assert.deepEqual([...b.vars.keys()].sort(), EXPECTED, `theme "${p.id}" token set differs from CHANNEL_TOKENS + FULL_TOKENS + THEME_EXTRAS`)
  }
})

test('every themes.css palette block is registered in PALETTES', () => {
  const ids = [...CSS.matchAll(/\[data-palette="([a-z0-9-]+)"\]/g)].map(m => m[1])
  for (const id of ids) assert.ok(isPaletteId(id), `themes.css defines "${id}" but PALETTES does not list it`)
})

test('channel tokens are sRGB triplets; the default theme also owns :root', () => {
  for (const p of PALETTES) {
    const b = themeBlock(p.id)!
    for (const t of CHANNEL_TOKENS) {
      assert.match(b.vars.get(`--c-${t}`) ?? '', /^\d{1,3} \d{1,3} \d{1,3}$/, `${p.id}: --c-${t} must be "R G B"`)
    }
  }
  const def = themeBlock(DEFAULT_PALETTE)!
  assert.ok(def.selector.split(',').map(s => s.trim()).includes(':root'), 'the default theme block must also match :root')
})

test('themeColor builds a variable reference, with or without alpha', () => {
  assert.equal(themeColor('accent'), 'rgb(var(--c-accent))')
  assert.equal(themeColor('tier-1', 0.2), 'rgb(var(--c-tier-1) / 0.2)')
})

test('the boot script knows every theme and falls back to the default', () => {
  for (const p of PALETTES) assert.ok(PALETTE_BOOT_SCRIPT.includes(`"${p.id}"`))
  assert.ok(PALETTE_BOOT_SCRIPT.includes(`"${DEFAULT_PALETTE}"`))
})

// ─── Contrast ────────────────────────────────────────────────────────────────

type RGB = [number, number, number]
const rgbOf = (b: Block, t: string): RGB => {
  const v = b.vars.get(`--c-${t}`)!
  const tri = v.match(/^(\d+) (\d+) (\d+)$/)
  if (tri) return [+tri[1], +tri[2], +tri[3]]
  throw new Error(`--c-${t} is not a channel token`)
}
// A full token like rgba(120, 170, 235, 0.15) composited over a solid colour.
const over = (b: Block, full: string, base: RGB): RGB => {
  const v = b.vars.get(`--c-${full}`)!
  const m = v.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)/)
  if (!m) throw new Error(`cannot parse ${full}: ${v}`)
  const a = m[4] === undefined ? 1 : +m[4]
  return [0, 1, 2].map(i => Math.round(+m[i + 1] * a + base[i] * (1 - a))) as RGB
}
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

// [foreground, background, minimum]. Every colour that carries words or a
// figure holds 4.5:1 on the surfaces it sits on, Apple's floor for text under
// 18pt (accessibility.md › Vision). The ladder steps fade by chroma, never
// below the floor: a Match of 3.2 is still a number someone reads.
const PAIRS: Array<[string, string, number]> = [
  ['text-1', 'bg-base', 4.5], ['text-2', 'bg-base', 4.5], ['text-3', 'bg-base', 4.5], ['text-3', 'bg-cosmos', 4.5],
  ['text-3', 'bg-elevated', 4.5], ['text-4', 'bg-base', 4.5], ['text-4', 'bg-cosmos', 4.5],
  ['accent-text', 'bg-base', 4.5], ['action-text', 'action', 4.5], ['action-text', 'action-hover', 4.5],
  ['tier-1', 'bg-base', 4.5], ['tier-2', 'bg-base', 3], ['tier-3', 'bg-cosmos', 4.5], ['tier-4', 'bg-cosmos', 4.5], ['score-mid', 'bg-base', 4.5],
  ['tier-1', 'tier-1-bg', 4.5], ['tier-2', 'tier-2-bg', 3], ['tier-3', 'tier-3-bg', 3], ['tier-4', 'tier-4-bg', 4.5],
  ['success', 'bg-base', 4.5], ['warning-text', 'bg-base', 4.5], ['danger', 'bg-base', 4.5],
  ['nav-text', 'nav-bg', 4.5], ['nav-strong', 'nav-bg', 4.5], ['nav-muted', 'nav-bg', 4.5], ['nav-faint', 'nav-bg', 4.5],
  ['nav-accent', 'nav-bg', 3],
  ['term-text', 'night', 4.5], ['term-tool', 'night', 4.5], ['term-ok', 'night', 4.5], ['term-err', 'night', 4.5], ['term-warn', 'night', 4.5],
]

// Known shortfalls, each with its reason. Galaxy is the pre-theme palette kept
// pixel-identical on purpose, so its one existing miss is recorded, not fixed.
// New themes get no entries here.
const KNOWN: Record<string, string> = {
  'galaxy: action-text on action': 'white on #7C5CFF (4.35) as shipped before themes; Galaxy stays as it was',
}

test('text colours meet their contrast minimum in every theme', () => {
  const fails: string[] = []
  for (const p of PALETTES) {
    const b = themeBlock(p.id)!
    for (const [fg, bg, min] of PAIRS) {
      const r = ratio(rgbOf(b, fg), rgbOf(b, bg))
      if (r < min && !KNOWN[`${p.id}: ${fg} on ${bg}`]) fails.push(`${p.id}: ${fg} on ${bg} = ${r.toFixed(2)} (< ${min})`)
    }
    const navBg = rgbOf(b, 'nav-bg')
    const active = ratio(rgbOf(b, 'nav-active-text'), over(b, 'nav-active-bg', navBg))
    if (active < 4.5) fails.push(`${p.id}: nav-active-text on nav-active-bg = ${active.toFixed(2)}`)
    const count = ratio(rgbOf(b, 'nav-count-text'), over(b, 'nav-count-bg', navBg))
    if (count < 4.5) fails.push(`${p.id}: nav-count-text on nav-count-bg = ${count.toFixed(2)}`)
    const soft = ratio(rgbOf(b, 'accent-text'), over(b, 'accent-soft', rgbOf(b, 'bg-base')))
    if (soft < 4.5) fails.push(`${p.id}: accent-text on accent-soft = ${soft.toFixed(2)}`)
  }
  assert.deepEqual(fails, [])
})

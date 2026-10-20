import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Colour-literal guard. Every colour in the app comes from a theme token
// (src/app/themes.css), used through Tailwind classes or themeColor() /
// tierColor() for inline styles and SVG. A raw colour written into a
// component ignores the theme, so it fails here. The fix is never to add the
// file to the allowlist: pick the role token that fits (DESIGN-meta.md § 2),
// or add a new role to every theme.

const SRC = fileURLToPath(new URL('..', import.meta.url))

// Files that legitimately hold raw colours, each with its reason.
const ALLOW: Record<string, string> = {
  'app/themes.css': 'the token file itself',
  'components/shared/CompanyLogo.tsx': 'fallback initials avatars: fixed identity colours per company, not UI chrome',
  'components/shared/Logos.tsx': 'the Claude mark keeps its own brand colours',
  'components/ui/celestial-sphere.tsx': 'onboarding WebGL shader; onboarding is pinned to the Galaxy palette',
}
const ALLOW_DIRS = [
  ['components/onboarding/', 'onboarding is pinned to the Galaxy palette and keeps its fixed star colours'],
]

const RULES: Array<[RegExp, string]> = [
  [/(?<![\w&/[-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g, 'hex colour'],
  [/%23[0-9a-fA-F]{6}\b/g, 'URL-encoded hex colour'],
  [/\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*(?!var\()(?!255[ ,]+255[ ,]+255\b)(?!0[ ,]+0[ ,]+0\b)[\d.]/g, 'colour function with literal values'],
  [/-\[(?:#|rgba?\(|hsla?\(|oklch\()/g, 'Tailwind arbitrary colour'],
  [/\b(?:galaxy-deep|galaxy-matte(?:-2)?|bg-chrome)\b|var\(--(?:accent|divider-gray|galaxy-[a-z0-9-]+)\)/g, 'retired colour name'],
  [/\b(?:accent-soft|nav-hover-bg|nav-input-bg|nav-input-border(?:-hover)?|nav-active-bg|nav-count-bg)\/\d/g, 'opacity modifier on a full-colour token (it has no effect)'],
]

// Tailwind only generates opacity modifiers from its scale (multiples of 5);
// any other number (bg-accent/12) produces no CSS at all, silently. Use a
// scale step or a bracketed value (bg-accent/[0.12]).
const OPACITY_SCALE = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100])
const MODIFIER = /\b(?:bg|text|border|ring|ring-offset|from|to|via|divide|fill|stroke|outline|decoration|placeholder|shadow|caret|accent)-[a-z0-9-]+\/(\d+)\b/g

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p
  }
}

test('no raw colour literals outside the theme tokens', () => {
  const hits: string[] = []
  for (const abs of files(SRC)) {
    const rel = relative(SRC, abs).split(sep).join('/')
    if (ALLOW[rel] || ALLOW_DIRS.some(([d]) => rel.startsWith(d))) continue
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const [re, what] of RULES) {
        for (const m of line.matchAll(re)) hits.push(`src/${rel}:${i + 1}  ${what}: ${m[0]}`)
      }
      for (const m of line.matchAll(MODIFIER)) {
        if (!OPACITY_SCALE.has(Number(m[1]))) hits.push(`src/${rel}:${i + 1}  opacity modifier off Tailwind's scale (generates no CSS): ${m[0]}`)
      }
    })
  }
  assert.deepEqual(hits, [], `Use a theme token instead (DESIGN-meta.md § 2):\n${hits.join('\n')}`)
})

test('every allowlisted path still exists', () => {
  for (const rel of [...Object.keys(ALLOW), ...ALLOW_DIRS.map(([d]) => d)]) {
    assert.ok(statSync(join(SRC, rel), { throwIfNoEntry: false }), `allowlist entry ${rel} no longer exists`)
  }
})

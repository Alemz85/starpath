// Guard: the Electron main process may never VALUE-import through the '@/'
// alias.
//
// tsconfig.electron.json declares `paths: {"@/*": ["./src/*"]}` so tsc can
// typecheck shared src files — but tsc does not rewrite the alias in its
// emitted CommonJS. A value import like `import { X } from '@/lib/y'` compiles
// clean, passes every test, and then crashes the packaged app at boot with
// "Cannot find module '@/lib/y'" before a window exists (shipped once:
// chat/args.ts importing spawnFormat). `import type` through the alias is fine
// — it is erased at compile and emits no require.
//
// This test walks the runtime import graph from electron/*.ts (following
// relative value imports into src/) and fails on any aliased value import or
// require it finds along the way.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ELECTRON_DIR = path.join(FRONTEND_ROOT, 'electron')

interface ImportRef {
  specifier: string
  typeOnly: boolean
  line: number
}

function stripComments(source: string): string {
  // Blank out comments but keep line structure so reported lines stay right.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function parseImports(source: string): ImportRef[] {
  const clean = stripComments(source)
  const refs: ImportRef[] = []
  // import/export … from '…' — non-greedy across newlines handles multiline
  // binding lists; every such statement ends at its own `from`.
  const fromRe = /\b(import|export)\s+(type\s)?[\s\S]*?from\s*(['"])([^'"]+)\3/g
  for (const m of clean.matchAll(fromRe)) {
    refs.push({ specifier: m[4], typeOnly: m[2] !== undefined, line: lineOf(clean, m.index) })
  }
  // Side-effect imports and bare requires are always value imports.
  for (const m of clean.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) {
    refs.push({ specifier: m[2], typeOnly: false, line: lineOf(clean, m.index) })
  }
  for (const m of clean.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    refs.push({ specifier: m[2], typeOnly: false, line: lineOf(clean, m.index) })
  }
  return refs
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

test('the electron main-process import graph has no aliased value imports', () => {
  const queue = fs
    .readdirSync(ELECTRON_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => path.join(ELECTRON_DIR, f))
  assert.ok(queue.length >= 3, 'expected main/preload/chat entry files under electron/')

  const seen = new Set<string>(queue)
  const violations: string[] = []

  while (queue.length > 0) {
    const file = queue.pop()!
    const source = fs.readFileSync(file, 'utf8')
    for (const ref of parseImports(source)) {
      if (ref.typeOnly) continue
      if (ref.specifier.startsWith('@/')) {
        const rel = path.relative(FRONTEND_ROOT, file)
        violations.push(
          `${rel}:${ref.line} value-imports '${ref.specifier}' — unreachable at runtime in ` +
            `the main process; use a relative path (or 'import type' if only types are needed)`,
        )
        continue
      }
      if (!ref.specifier.startsWith('.')) continue
      const resolved = resolveRelative(file, ref.specifier)
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push(resolved)
      }
    }
  }

  assert.deepEqual(violations, [])
})

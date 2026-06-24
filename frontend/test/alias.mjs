// Test-only module resolution shim.
//
// Two things the renderer relies on that the bare Node test runner doesn't do:
//   1. the `@/*` path alias (tsconfig `paths`) — Next/Webpack understands it
//      at build time, Node doesn't.
//   2. extensionless *relative* TypeScript imports (`import … from './foo'`) —
//      Node's ESM resolver won't append `.ts`, so `./foo` referring to
//      `foo.ts` fails with ERR_MODULE_NOT_FOUND.
//
// This registers a synchronous resolve hook (`module.registerHooks`,
// in-thread, no worker) that handles both by probing the usual TS/JS
// extensions + index files, then lets Node's built-in type-stripping load the
// resolved `.ts`. Zero extra dependencies.
//
// Loaded via `node --import ./test/alias.mjs` (see package.json `test`).

import { registerHooks } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Order matters: a bare `./foo` should prefer `foo.ts` over `foo/index.ts`.
const FILE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_EXTS = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs']

// Already carries an extension we shouldn't second-guess (lets node_modules
// and explicit `.js`/`.json` imports fall straight through to the default).
function hasKnownExtension(spec) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|node|css)$/.test(spec)
}

function probe(basePath) {
  for (const ext of FILE_EXTS) {
    const candidate = basePath + ext
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href
    }
  }
  for (const idx of INDEX_EXTS) {
    const candidate = basePath + idx
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@/x` → `<frontend>/src/x`
    if (specifier.startsWith('@/')) {
      const url = probe(resolvePath(SRC, specifier.slice(2)))
      if (url) return { url, shortCircuit: true }
    }

    // Extensionless relative TS imports, resolved against the importer.
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !hasKnownExtension(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const basePath = fileURLToPath(new URL(specifier, context.parentURL))
      const url = probe(basePath)
      if (url) return { url, shortCircuit: true }
    }

    return nextResolve(specifier, context)
  },
})

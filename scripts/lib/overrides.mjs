/**
 * overrides.mjs — your own versions of system files.
 *
 * The public repo ships generic defaults. A file at
 * `<data root>/overrides/<same repo path>` REPLACES the default; a file at
 * `<data root>/overrides/<path without .md>.append.md` is ADDED after the
 * default (or after the replacement). Personal examples, schools, companies
 * and timelines can live there verbatim — nothing has to be generalised.
 *
 * Overridable: modes/*.md, batch/batch-prompt.md, templates/**,
 * config/profile.example.yml, .claude/skills/career-ops*\/SKILL.md.
 *
 * Consumers:
 *   - scripts:  resolveSystemFile() / composeSystemFile()
 *   - spawns:   `node scripts/overrides.mjs resolve <rel>` prints a file path
 *               ready for --append-system-prompt-file (composed when needed)
 *   - sessions: the career-ops router + CLAUDE.md rule; the SessionStart hook
 *               prints `overrides.mjs --brief`
 *
 * Pure functions take injectable fs probes; unit-tested in overrides.test.mjs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const OVERRIDES_DIR = 'overrides'

const OVERRIDABLE = [
  /^modes\/[^/]+\.md$/,
  /^batch\/batch-prompt\.md$/,
  /^templates\/.+/,
  /^config\/profile\.example\.yml$/,
  /^\.claude\/skills\/career-ops[^/]*\/SKILL\.md$/,
]

function norm(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

export function isOverridable(rel) {
  const p = norm(rel)
  if (p.endsWith('.append.md')) return false
  return OVERRIDABLE.some((re) => re.test(p))
}

/** 'modes/scouting.md' → 'modes/scouting.append.md'; null for non-markdown files. */
export function appendPathFor(rel) {
  const p = norm(rel)
  return p.endsWith('.md') ? p.slice(0, -3) + '.append.md' : null
}

/**
 * Where a system file comes from.
 * @returns {{ rel, path, source: 'default'|'override', appendPath: string|null, overridable: boolean }}
 */
export function resolveSystemFile({ repoRoot, dataRoot, rel, exists = existsSync }) {
  const p = norm(rel)
  const defaultPath = join(repoRoot, p)
  if (!dataRoot || !isOverridable(p)) {
    return { rel: p, path: defaultPath, source: 'default', appendPath: null, overridable: isOverridable(p) }
  }
  const base = join(dataRoot, OVERRIDES_DIR)
  const replacement = join(base, p)
  const appendRel = appendPathFor(p)
  const appendPath = appendRel && exists(join(base, appendRel)) ? join(base, appendRel) : null
  if (exists(replacement)) {
    return { rel: p, path: replacement, source: 'override', appendPath, overridable: true }
  }
  return { rel: p, path: defaultPath, source: 'default', appendPath, overridable: true }
}

/**
 * The effective text of a system file: default or replacement, then the
 * append file (separated by a marker comment so the seam is visible).
 * @returns {{ text: string, parts: string[], composed: boolean }}
 */
export function composeSystemFile({ repoRoot, dataRoot, rel, exists = existsSync, read = (f) => readFileSync(f, 'utf-8') }) {
  const r = resolveSystemFile({ repoRoot, dataRoot, rel, exists })
  const parts = [r.path]
  let text = read(r.path)
  if (r.appendPath) {
    const add = read(r.appendPath)
    text = text.replace(/\s*$/, '\n') +
      `\n<!-- appended from private overrides: ${appendPathFor(r.rel)} -->\n\n` + add
    parts.push(r.appendPath)
  }
  return { text, parts, composed: parts.length > 1 }
}

/** Every file under <dataRoot>/overrides, as repo-relative override entries. */
export function listOverrides({ dataRoot, repoRoot, exists = existsSync }) {
  const base = join(dataRoot, OVERRIDES_DIR)
  if (!exists(base)) return []
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === '.DS_Store') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      const rel = relative(base, full).replace(/\\/g, '/')
      const isAppend = rel.endsWith('.append.md')
      const target = isAppend ? rel.slice(0, -'.append.md'.length) + '.md' : rel
      out.push({
        rel,
        target,
        mode: isAppend ? 'append' : 'replace',
        valid: isOverridable(target),
        defaultExists: repoRoot ? exists(join(repoRoot, target)) : null,
        path: full,
      })
    }
  }
  walk(base)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

// jd-archive-fs.mjs — reads the disk for the JD archive tools (the checker,
// verify-pipeline and the backfill). The decisions live in jd-archive-core.mjs.

import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { auditReports, parseUnrecoverable, formatUnrecoverableLine } from './jd-archive-core.mjs'
import { writeFileAtomic } from './write-file-atomic.mjs'

export const JDS_DIR = 'jds'
export const UNRECOVERABLE_FILE = '.unrecoverable.tsv'

function readHead(file, bytes = 4096) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally { closeSync(fd) }
}

function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const fp = join(dir, e.name)
    if (e.isDirectory()) walk(fp, out)
    else if (e.name.endsWith('.md')) out.push(fp)
  }
}

/** Read a data root and audit it: which T1–T3 reports have a JD archive. */
export function loadAudit(root) {
  const reportsDir = join(root, 'reports')
  const files = []
  for (const t of ['tier-1', 'tier-2', 'tier-3']) walk(join(reportsDir, t), files)
  const reports = files.map((fp) => ({
    path: relative(root, fp).split('\\').join('/'),
    text: readFileSync(fp, 'utf8'),
  }))
  const trackers = ['data/scouting.md', 'data/applications.md']
    .map((p) => join(root, p))
    .filter(existsSync)
    .map((p) => readFileSync(p, 'utf8'))
  const jds = join(root, JDS_DIR)
  const archive = existsSync(jds)
    ? readdirSync(jds).filter((n) => n.endsWith('.md')).map((name) => ({ name, head: readHead(join(jds, name)) }))
    : []
  const unrecoverableFile = join(jds, UNRECOVERABLE_FILE)
  const unrecoverable = existsSync(unrecoverableFile) ? parseUnrecoverable(readFileSync(unrecoverableFile, 'utf8')) : new Map()
  return { ...auditReports({ reports, trackers, archive, unrecoverable }), jdsDir: jds }
}

/** Write an archive file; never overwrites one that exists (the archive is the record). */
export function writeArchiveFile(root, name, content) {
  const target = join(root, JDS_DIR, name)
  if (existsSync(target)) throw new Error(`${JDS_DIR}/${name} already exists`)
  return writeFileAtomic(target, content)
}

export function logUnrecoverable(root, entry) {
  const dir = join(root, JDS_DIR)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, UNRECOVERABLE_FILE), formatUnrecoverableLine(entry) + '\n')
}

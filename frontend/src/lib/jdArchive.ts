// The saved job description behind a report: resolution and parsing for the
// "Job listing" tab. Mirrors scripts/lib/jd-archive-core.mjs (the renderer
// can't import the .mjs): change them together. Layout of `jds/<num>-<company>-<role>.md`
// is documented there.
//
// Pure functions of their inputs — no IPC, no React — so the lookup order is
// unit-tested with plain fixtures. `loadJdArchive` is the one async helper and
// takes the two IPC reads it needs as arguments.

import type { ApplicationEntry, ScoutingEntry } from '@/types'

export interface JdArchive {
  /** `jds/…` path the text was read from. */
  path: string
  /** Fetched date (YYYY-MM-DD); empty for a hand-saved file that doesn't state one. */
  fetched: string
  /** Listing URL stored in the file's header; empty when none. */
  url: string
  /** Where the text came from (worker, greenhouse-api, page-html, …); empty if unstated. */
  source: string
  /** The posting text, unedited. */
  body: string
}

export function slugify(s: string, max = 60): string {
  const slug = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max)
  const edge = cut.lastIndexOf('-')
  return (edge > max * 0.6 ? cut.slice(0, edge) : cut).replace(/-+$/g, '')
}

const TRACKING_PARAMS = /^(utm_|gh_src$|ref$|source$|src$|lever-source|fbclid$|gclid$)/i

export function normalizeUrl(raw: string | null | undefined): string {
  let u: URL
  try { u = new URL(String(raw ?? '').trim()) } catch { return '' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
  u.hash = ''
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k)
  u.searchParams.sort()
  const qs = u.searchParams.toString()
  return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${qs ? `?${qs}` : ''}`
}

function numOfFileName(name: string): number | null {
  const m = /^(\d{1,6})-/.exec(name)
  return m ? Number(m[1]) : null
}

const slugOfFileName = (name: string) => name.replace(/\.md$/i, '').replace(/^\d{1,6}-/, '')

/**
 * The report's tracker row number: the row whose report link points at the
 * report file, else the row for the same company + role. Scouting rows win
 * over applications rows.
 */
export function reportNumberFor(args: {
  scouting: ScoutingEntry[]
  applications: ApplicationEntry[]
  reportPath: string | null
  company: string
  role: string
}): number | null {
  const { scouting, applications, reportPath, company, role } = args
  const rows: Array<{ num: number; report: string; company: string; role: string }> = [...scouting, ...applications]
  const linked = (r: { report: string }) => {
    if (!reportPath) return false
    let link = r.report ?? ''
    try { link = decodeURI(link) } catch { /* as written */ }
    return link.includes(reportPath)
  }
  const byLink = rows.find(r => r.num > 0 && linked(r))
  if (byLink) return byLink.num
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const byName = rows.find(r => r.num > 0 && same(r.company, company) && same(r.role, role))
  return byName ? byName.num : null
}

/** Cheap pick from file names alone: by number (padded or not), then by company+role slug. */
export function pickByName(names: string[], q: { num: number | null; company: string; role: string }): string | null {
  const md = names.filter(n => /\.md$/i.test(n))
  if (q.num != null) {
    const hit = md.find(n => numOfFileName(n) === q.num)
    if (hit) return hit
  }
  const slug = [slugify(q.company), slugify(q.role)].filter(Boolean).join('-')
  return slug ? md.find(n => slugOfFileName(n) === slug) ?? null : null
}

const FIELD = (name: string) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(.+?)\\s*$`, 'im')

export function parseArchive(text: string): Omit<JdArchive, 'path'> & { structured: boolean } {
  const t = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = t.split('\n')
  let rule = -1
  for (let i = 1; i < Math.min(lines.length, 14); i++) {
    if (/^-{3,}\s*$/.test(lines[i])) { rule = i; break }
  }
  const head = lines.slice(0, rule === -1 ? 14 : rule).join('\n')
  const field = (name: string) => {
    const v = FIELD(name).exec(head)?.[1]?.trim() ?? ''
    return v === '—' ? '' : v
  }
  const structured = rule !== -1 && /\*\*Fetched:\*\*/i.test(head)
  const url = field('URL')
  return {
    structured,
    fetched: field('Fetched'),
    url: /^https?:\/\//i.test(url) ? url : '',
    source: field('Source'),
    body: structured ? lines.slice(rule + 1).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '') : t.trim(),
  }
}

/** Legacy files without a number: how many are opened to match on their URL. */
const MAX_URL_SCANS = 40

/**
 * Find and read a report's archive.
 *
 * @param io.list  names in `jds/`
 * @param io.read  file text by repo-relative path, null when unreadable
 * @returns the archive, or null when the report has none
 */
export async function loadJdArchive(
  q: { num: number | null; company: string; role: string; url: string },
  io: { list: () => Promise<string[]>; read: (path: string) => Promise<string | null> },
): Promise<JdArchive | null> {
  const names = (await io.list()).filter(n => /\.md$/i.test(n))
  let name = pickByName(names, q)
  if (!name && q.url) {
    const want = normalizeUrl(q.url)
    for (const n of names.filter(n => numOfFileName(n) === null).slice(0, MAX_URL_SCANS)) {
      const text = await io.read(`jds/${n}`)
      if (text && want && normalizeUrl(parseArchive(text).url) === want) { name = n; break }
    }
  }
  if (!name) return null
  const text = await io.read(`jds/${name}`)
  if (!text || !text.trim()) return null
  return { path: `jds/${name}`, ...parseArchive(text) }
}

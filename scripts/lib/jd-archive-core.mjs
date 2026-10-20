// jd-archive-core.mjs — pure core of the job-description archive.
//
// Every listing that gets a report (tiers T1–T3; T4 writes no report file)
// keeps its job description as `jds/<num>-<company-slug>-<role-slug>.md`,
// because postings disappear. `<num>` is the report number: the tracker row
// number that the row's report link carries (`[12](reports/tier-1/…)`), the
// same one the worker reserved. Padded and unpadded numbers both resolve
// (`012-…` is report 12).
//
// File layout (the app's "Job listing" tab and the checker parse it):
//
//   # {Company} — {Role}
//
//   - **Company:** {Company}
//   - **Role:** {Role}
//   - **URL:** {listing URL}
//   - **Fetched:** {YYYY-MM-DD}
//   - **Source:** {worker | greenhouse-api | … | page-html}
//
//   ---
//
//   {the job description text, unedited}
//
// Older hand-saved files (a `URL:` line, no `---` block, no number) still
// resolve — by URL, then by slug — and render whole.
//
// Everything here is a pure function (no I/O, no clock) so the checker, the
// backfill and the tests share it; scripts/lib/jd-archive-fs.mjs reads the
// disk. The app mirrors the resolution in frontend/src/lib/jdArchive.ts —
// change them together.

/** Tiers whose evaluations write a report file (and so get an archive). */
export const ARCHIVED_TIERS = [1, 2, 3];

export function padNum(n) {
  return String(n).padStart(3, '0');
}

/** Lower-case ascii slug, accents folded, capped at `max` chars on a word edge. */
export function slugify(s, max = 60) {
  const slug = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const edge = cut.lastIndexOf('-');
  return (edge > max * 0.6 ? cut.slice(0, edge) : cut).replace(/-+$/g, '');
}

/** `jds/` file name for a report. Without a number the name is just the slugs. */
export function archiveFileName({ num, company, role }) {
  const body = [slugify(company), slugify(role)].filter(Boolean).join('-') || 'listing';
  return Number.isFinite(Number(num)) && Number(num) > 0 ? `${padNum(num)}-${body}.md` : `${body}.md`;
}

/** The leading report number of an archive file name, or null (legacy names). */
export function numOfFileName(name) {
  const m = /^(\d{1,6})-/.exec(name);
  return m ? Number(m[1]) : null;
}

/** The slug part of an archive file name (number prefix and `.md` removed). */
export function slugOfFileName(name) {
  return name.replace(/\.md$/i, '').replace(/^\d{1,6}-/, '');
}

const TRACKING_PARAMS = /^(utm_|gh_src$|ref$|source$|src$|lever-source|fbclid$|gclid$)/i;

/** URL comparison key: host lower-cased, hash/tracking params/trailing slash dropped. '' when not http(s). */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '');
  const qs = u.searchParams.toString();
  return `${u.hostname.toLowerCase()}${path}${qs ? `?${qs}` : ''}`;
}

// ── Reports ──────────────────────────────────────────────────────────────────

/** `reports/tier-2/Foo - Bar.md` → 2; anything else → null. */
export function tierOfReportPath(relPath) {
  const m = /(?:^|\/)tier-(\d)\//.exec(String(relPath).replace(/\\/g, '/'));
  return m ? Number(m[1]) : null;
}

/** Company / role / URL / date out of a report's text, falling back to its file name. */
export function parseReport(text, relPath = '') {
  const t = String(text ?? '');
  let company = '';
  let role = '';
  const title = /^#\s+(?:Scouting|Gap\s*&\s*Growth)\s*:\s*(.+?)\s+[—–]\s+(.+?)\s*$/im.exec(t);
  if (title) {
    company = title[1].trim();
    role = title[2].trim();
  } else {
    const base = String(relPath).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '');
    const i = base.indexOf(' - ');
    if (i > 0) { company = base.slice(0, i).trim(); role = base.slice(i + 3).trim(); }
    else role = base;
  }
  const urlRaw = /^\*\*URL:\*\*\s*(\S+)/im.exec(t)?.[1] ?? '';
  const date = /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/im.exec(t)?.[1] ?? '';
  return { company, role, url: /^https?:\/\//i.test(urlRaw) ? urlRaw : '', date };
}

/**
 * Report path → tracker row number, from the `[12](reports/tier-1/…md)` links
 * in the scouting and applications trackers. The first number found for a path
 * wins; paths are compared decoded and with forward slashes.
 */
export function trackerNumbers(trackerTexts) {
  const map = new Map();
  const re = /\[#?(\d+)\]\(\s*<?([^)>]+?\.md)>?\s*\)/g;
  for (const text of trackerTexts) {
    for (const m of String(text ?? '').matchAll(re)) {
      let p = m[2].trim().replace(/\\/g, '/');
      try { p = decodeURI(p); } catch { /* keep as written */ }
      if (!/^reports\//.test(p)) continue;
      if (!map.has(p)) map.set(p, Number(m[1]));
    }
  }
  return map;
}

// ── Archive files ────────────────────────────────────────────────────────────

/** The text of an archive file for a report. `body` is the posting text, unedited. */
export function formatArchive({ company, role, url, fetched, source, body }) {
  const title = [company, role].filter(Boolean).join(' — ') || 'Job listing';
  const head = [
    `# ${title}`,
    '',
    `- **Company:** ${company || '—'}`,
    `- **Role:** ${role || '—'}`,
    `- **URL:** ${url || '—'}`,
    `- **Fetched:** ${fetched || '—'}`,
    ...(source ? [`- **Source:** ${source}`] : []),
    '',
    '---',
    '',
  ];
  return `${head.join('\n')}${String(body ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '')}\n`;
}

const FIELD_RE = (name) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(.+?)\\s*$`, 'im');

/**
 * Read an archive file. `structured` is true for the layout above (a `---`
 * rule closes the header block); `body` is then everything after it. A legacy
 * file keeps its whole text as the body, with whatever `URL:` / `Fetched:`
 * lines it carries read from its first lines.
 */
export function parseArchive(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  let rule = -1;
  for (let i = 0; i < Math.min(lines.length, 14); i++) {
    if (/^-{3,}\s*$/.test(lines[i]) && i > 0) { rule = i; break; }
  }
  const head = lines.slice(0, rule === -1 ? 14 : rule).join('\n');
  const field = (name) => {
    const v = FIELD_RE(name).exec(head)?.[1]?.trim() ?? '';
    return v === '—' ? '' : v;
  };
  const structured = rule !== -1 && /\*\*Fetched:\*\*/i.test(head);
  const url = field('URL');
  return {
    structured,
    company: field('Company'),
    role: field('Role'),
    url: /^https?:\/\//i.test(url) ? url : '',
    fetched: field('Fetched'),
    source: field('Source'),
    body: structured ? lines.slice(rule + 1).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n' : t,
  };
}

/**
 * Index the archive folder for lookups. `files` = `[{ name, head }]`, `head`
 * being the first few KB of the file (only read for the URL match).
 */
export function buildArchiveIndex(files) {
  const byNum = new Map();
  const byUrl = new Map();
  const bySlug = new Map();
  for (const f of files) {
    if (!/\.md$/i.test(f.name)) continue;
    const num = numOfFileName(f.name);
    if (num !== null) (byNum.get(num) ?? byNum.set(num, []).get(num)).push(f.name);
    const slug = slugOfFileName(f.name);
    if (!bySlug.has(slug)) bySlug.set(slug, f.name);
    const u = normalizeUrl(parseArchive(f.head ?? '').url);
    if (u && !byUrl.has(u)) byUrl.set(u, f.name);
  }
  return { byNum, byUrl, bySlug };
}

/**
 * The archive file for a report, or null. By report number first (padded or
 * not), then by the listing URL in the file's header, then by the
 * company+role slug — so a renumbered report or a hand-saved file still
 * resolves. Returns `{ name, how }`.
 */
export function findArchive(report, index) {
  const num = Number(report.num);
  if (Number.isFinite(num) && num > 0) {
    const hit = index.byNum.get(num)?.[0];
    if (hit) return { name: hit, how: 'number' };
  }
  const u = normalizeUrl(report.url);
  if (u && index.byUrl.has(u)) return { name: index.byUrl.get(u), how: 'url' };
  const slug = [slugify(report.company), slugify(report.role)].filter(Boolean).join('-');
  if (slug && index.bySlug.has(slug)) return { name: index.bySlug.get(slug), how: 'slug' };
  return null;
}

// ── Unrecoverable log (jds/.unrecoverable.tsv) ───────────────────────────────

/** One line: `date \t key \t url \t reason`. `key` is the padded number, or the report path without one. */
export function unrecoverableKey({ num, path }) {
  return Number.isFinite(Number(num)) && Number(num) > 0 ? padNum(num) : String(path);
}

export function formatUnrecoverableLine({ date, key, url, reason }) {
  const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return `${clean(date)}\t${clean(key)}\t${clean(url) || '—'}\t${clean(reason)}`;
}

/** key → `{ date, url, reason }`; the latest line per key wins. */
export function parseUnrecoverable(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [date = '', key = '', url = '', reason = ''] = line.split('\t');
    if (key) map.set(key.trim(), { date: date.trim(), url: url.trim(), reason: reason.trim() });
  }
  return map;
}

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Which reports have an archive.
 *
 * @param {{
 *   reports: Array<{ path: string, text: string }>,   // reports/tier-N/*.md
 *   trackers: string[],                               // scouting.md / applications.md text
 *   archive: Array<{ name: string, head?: string }>,  // the jds/ folder
 *   unrecoverable?: Map<string, object>,
 * }} input
 * @returns {{ rows: Array<object>, counts: { total: number, archived: number, missing: number, unrecoverable: number } }}
 *   Row status is `archived` | `missing` | `unrecoverable`. Reports outside
 *   tiers 1–3 are not audited.
 */
export function auditReports({ reports, trackers, archive, unrecoverable = new Map() }) {
  const nums = trackerNumbers(trackers);
  const index = buildArchiveIndex(archive);
  const rows = [];
  for (const r of reports) {
    const path = r.path.replace(/\\/g, '/');
    const tier = tierOfReportPath(path);
    if (!ARCHIVED_TIERS.includes(tier)) continue;
    if (/\/\.history\//.test(path)) continue;
    const info = parseReport(r.text, path);
    const num = nums.get(path) ?? null;
    const hit = findArchive({ ...info, num }, index);
    const key = unrecoverableKey({ num, path });
    let status = 'missing';
    if (hit) status = 'archived';
    else if (unrecoverable.has(key)) status = 'unrecoverable';
    rows.push({
      path, tier, num, ...info,
      status,
      file: hit?.name ?? null,
      how: hit?.how ?? null,
      reason: status === 'unrecoverable' ? unrecoverable.get(key).reason : null,
      expected: archiveFileName({ num, company: info.company, role: info.role }),
    });
  }
  rows.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.path.localeCompare(b.path));
  const count = (s) => rows.filter((x) => x.status === s).length;
  return {
    rows,
    counts: { total: rows.length, archived: count('archived'), missing: count('missing'), unrecoverable: count('unrecoverable') },
  };
}

#!/usr/bin/env node

/**
 * hygiene-guard.mjs — the leak gate's scanner.
 *
 * Keeps personal data out of the PUBLIC repo. Terms are never stored in the
 * repo (not even hashed): they are derived at run time from the data root
 * (`private/`, see scripts/lib/data-root.mjs):
 *
 *   identity   name, first+last pair, email, phone, profile handles (user/profile.yml, user/cv.md)
 *   school / employer / project   user/cv.md (`### ` headings and the old **bold** format)
 *   person     Name column of data/network.md
 *   company / role   Company / Role columns of data/applications.md + data/scouting.md
 *              (and every profile under profiles/), report + prep file names
 *   extra      private/leak-terms.txt — one term per line, `#` comments, `!term` allows one
 *
 * plus the generic patterns of leak-patterns.mjs (emails, phones, home paths,
 * API keys; salary-looking figures warn).
 *
 * Severity: everything blocks except world-famous brand names on their own,
 * school names inside markdown table rows (reference tables), and generic
 * patterns marked `warn`. Roles count on their own only when they have ≥ 3
 * words and at least one word that is not generic job-title vocabulary;
 * otherwise only as a company+role pair on the same line, which always blocks.
 * Single-word terms match case-sensitively (as written, Capitalised or UPPER),
 * longer ones case-insensitively across punctuation, so `Quillfeather
 * Dynamics` also catches `quillfeather-dynamics`.
 *
 * Lines containing `hygiene-guard:allow` are skipped. Output never contains a
 * matched line or a full term: `path:line  [category]  Q·····s`.
 *
 * CLI:
 *   node scripts/lib/hygiene-guard.mjs                 all tracked files (npm run leak-check)
 *   node scripts/lib/hygiene-guard.mjs --staged        added lines of the staged diff (pre-commit)
 *   node scripts/lib/hygiene-guard.mjs --range a..b    added lines + messages of the commits (pre-push)
 *   node scripts/lib/hygiene-guard.mjs --range <sha> --not --remotes
 *   node scripts/lib/hygiene-guard.mjs --message <file>   a commit message (commit-msg)
 *   options: --generic-only (CI) · --json · --github (annotations) · --verbose · --root <checkout>
 *   exit: 0 clean or warnings only · 1 blocking hits · 2 usage / git error
 *
 * Module API (backward compatible):
 *   runHygieneGuard({ root, verbose, staged, range, message, genericOnly, include, env, dataRoot })
 *     → { violations, warnings, hits, personalData, patterns, terms, dataRoot, scanned }
 *   extractPersonalData(dataRoot) · buildPatterns(pd) · buildTerms(pd) · resolveGuardDataRoot(…)
 */

import { readFileSync, existsSync, readdirSync, lstatSync, readlinkSync, statSync, realpathSync } from 'node:fs';
import { join, relative, extname, basename, dirname, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot, isPersonalPath, LINKED_PATHS, LEAK_TERMS_FILE, PRIVATE_DIR } from './data-root.mjs';
import { ALLOW_MARKER, maskTerm, scanGenericLine } from './leak-patterns.mjs';

export { maskTerm };

// ── Utility ─────────────────────────────────────────────────────────────────

function readFileSafe(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Run git; returns stdout, or null on failure (unless `throwOnError`). */
function git(cwd, args, { env = process.env, throwOnError = false } = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    if (throwOnError) {
      const msg = (r.stderr || r.error?.message || '').trim().split('\n')[0];
      throw new GuardError(`git ${args.filter((a) => !a.startsWith('-c')).slice(0, 2).join(' ')} failed: ${msg}`);
    }
    return null;
  }
  return r.stdout;
}

class GuardError extends Error {}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Data root ───────────────────────────────────────────────────────────────

/**
 * Where the private data for a checkout lives. First hit wins:
 *   1. $STARPATH_DATA (absolute or repo-relative; `demo` is ignored — it is fictional)
 *   2. <toplevel>/private
 *   3. the MAIN worktree's private/ when `root` is a linked git worktree
 *   4. legacy <toplevel>/user + <toplevel>/data (un-migrated checkout)
 *   5. none — generic checks only
 *
 * @returns {{ root: string|null, kind: 'private'|'external'|'legacy'|'none', source: string }}
 */
export function resolveGuardDataRoot({
  root,
  env = process.env,
  exists = existsSync,
  commonDir = undefined,
} = {}) {
  const top = root;
  if (env?.STARPATH_DATA && String(env.STARPATH_DATA).trim()) {
    const r = resolveDataRoot({ repoRoot: top, env, exists });
    if (r.source === 'env' && r.kind !== 'demo' && exists(r.root)) {
      return { root: r.root, kind: r.kind === 'private' ? 'private' : 'external', source: 'env' };
    }
  }
  const own = join(top, PRIVATE_DIR);
  if (exists(own)) return { root: own, kind: 'private', source: 'checkout' };
  const common = commonDir !== undefined ? commonDir : (isCheckout(top) ? gitCommonDir(top, env) : null);
  if (common && basename(common) === '.git') {
    const mainTop = dirname(common);
    const mainPrivate = join(mainTop, PRIVATE_DIR);
    if (resolve(mainTop) !== resolve(top) && exists(mainPrivate)) {
      return { root: mainPrivate, kind: 'private', source: 'main-worktree' };
    }
  }
  if (exists(join(top, 'user')) || exists(join(top, 'data'))) {
    return { root: top, kind: 'legacy', source: 'checkout' };
  }
  return { root: null, kind: 'none', source: 'none' };
}

/** A git checkout root (main or linked worktree): has a `.git` dir or file. */
function isCheckout(root) {
  return !!root && existsSync(join(root, '.git'));
}

function gitCommonDir(root, env) {
  const abs = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env });
  if (abs) return abs.trim();
  const rel = git(root, ['rev-parse', '--git-common-dir'], { env });
  return rel ? resolve(root, rel.trim()) : null;
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** Strip diacritics so `Universität` and `Universitat` compare equal. */
function fold(s) {
  return String(s).normalize('NFD').replace(/\p{M}+/gu, '');
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokenize(s) {
  return fold(s).match(TOKEN_RE) || [];
}

function termKey(s) {
  return tokenize(s).map((t) => t.toLowerCase()).join(' ');
}

/** Markdown cell/heading → plain text. */
function stripMd(s) {
  return String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display form for masking: trimmed of leading/trailing punctuation. */
function displayOf(s) {
  return String(s).trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Job-title, institution and CV vocabulary that says nothing about a person on
// its own. A role made only of these words ("Senior Data Analyst") counts only
// as part of a company+role pair; a CV heading made only of these is dropped.
const GENERIC_WORDS = new Set(`
a an and the of for in at to on with by from via de del della di da la le les des du y e et und en el los las im am zu
analyst analysts analytics analysis associate associates consultant consultants consulting intern interns internship
internships graduate graduates trainee trainees junior senior lead leader leadership manager managers management director
head chief officer vp vice president principal partner partners staff specialist specialists coordinator executive
executives assistant administrator advisor adviser expert member representative agent owner
engineer engineers engineering developer developers development scientist scientists science researcher researchers
research designer designers design architect architecture technician programmer
data business strategy strategic operations ops operational product products project projects program programme
programs programmes marketing sales finance financial accounting accountant controller controlling audit auditor tax
risk compliance legal counsel hr people talent recruiter recruiting recruitment human resources payroll
digital growth commercial customer customers client clients success account accounts partnership partnerships
corporate investment investments investor banking bank equity private capital markets market trading trader quant
quantitative economist economics economic policy public affairs government planning planner demand supply chain
procurement purchasing buyer sourcing logistics category merchandising retail store stores ecommerce commerce
software technology technologies tech it ai ml machine learning intelligence bi insights insight pricing revenue
cloud security infrastructure network networks devops backend frontend fullstack full stack web mobile platform
platforms systems system solutions solution services service quality process processes transformation innovation
sustainability esg brand content communications communication media social pr creative ux ui user experience
support operational administrative office general generalist
rotational rotation early careers career summer winter spring autumn fall time part remote hybrid onsite global
international regional national local emea apac latam americas europe european team teams new ventures venture
entry level i ii iii iv mba msc ma ms bsc ba phd master masters bachelor bachelors degree diploma certificate
student students university school college institute business academy exchange semester year years thesis
volunteer volunteering freelance freelancer independent self employed personal side capstone course coursework
organization organisation company role title field city country top optional second name
m f d w x mwd mfd fmd wmd hf fh
`.trim().split(/\s+/));

function isGenericPhrase(tokens) {
  return tokens.length > 0 && tokens.every((t) => GENERIC_WORDS.has(t.toLowerCase()) || /^\d+$/.test(t));
}

// World-famous brands appear legitimately in rubric tables and examples: on
// their own they only warn. Public world knowledge, not anyone's data.
const FAMOUS_BRANDS = [ // hygiene-guard:allow
  'Google', 'Alphabet', 'YouTube', 'DeepMind', 'Amazon', 'AWS', 'Microsoft', 'Apple', 'Meta', 'Facebook', // hygiene-guard:allow
  'Instagram', 'WhatsApp', 'Netflix', 'Spotify', 'Uber', 'Airbnb', 'Stripe', 'Tesla', 'Nvidia', 'Intel', // hygiene-guard:allow
  'IBM', 'Oracle', 'SAP', 'Salesforce', 'Adobe', 'Cisco', 'Samsung', 'Sony', 'OpenAI', 'Anthropic', // hygiene-guard:allow
  'LinkedIn', 'Twitter', 'TikTok', 'ByteDance', 'Alibaba', 'Tencent', 'PayPal', 'Visa', 'Mastercard', // hygiene-guard:allow
  'McKinsey', 'McKinsey & Company', 'BCG', 'Boston Consulting Group', 'Bain', 'Bain & Company', // hygiene-guard:allow
  'Deloitte', 'PwC', 'KPMG', 'Accenture', 'Ernst & Young', 'Goldman Sachs', 'JPMorgan', 'J.P. Morgan', // hygiene-guard:allow
  'JPMorgan Chase', 'Morgan Stanley', 'BlackRock', 'Citi', 'Citigroup', 'HSBC', 'Barclays', 'Santander', // hygiene-guard:allow
  'BNP Paribas', 'UBS', 'Unilever', 'Nestlé', 'Procter & Gamble', "L'Oréal", 'LVMH', 'Coca-Cola', // hygiene-guard:allow
  'PepsiCo', 'Nike', 'Adidas', 'Siemens', 'Shell', 'Toyota', 'Volkswagen', 'BMW', 'Mercedes-Benz', // hygiene-guard:allow
  'IKEA', 'Inditex', 'Zara', 'Walmart', 'Disney', 'Revolut', 'Booking.com', 'Booking', // hygiene-guard:allow
]; // hygiene-guard:allow
const FAMOUS_KEYS = new Set(FAMOUS_BRANDS.map(termKey));
// Legal / regional suffixes that don't change which brand it is ("Google Ireland Ltd").
const BRAND_SUFFIXES = new Set(`inc ltd limited llc llp gmbh sa sas sarl ag plc bv nv spa srl sl corp corporation group
company co holdings international global europe emea uk usa us ireland spain france germany italy iberia
deutschland espana netherlands switzerland`.split(/\s+/));

export function isFamousBrand(name) {
  let toks = termKey(name).split(' ').filter(Boolean);
  if (FAMOUS_KEYS.has(toks.join(' '))) return true;
  while (toks.length > 1 && BRAND_SUFFIXES.has(toks[toks.length - 1])) {
    toks = toks.slice(0, -1);
    if (FAMOUS_KEYS.has(toks.join(' '))) return true;
  }
  return false;
}

// ── Personal data extraction ────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = new RegExp(`\\b(?:${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\b`, 'i');
const INSTITUTION_RE = /(universi|school|college|institut|academy|academia|polytechn|politecnic|hochschule|[eé]cole|escuela|escola|scuola|faculty|facultad|conservato|campus)/i;
const DEGREE_RE = /^(?:m\.?sc|msc|m\.?a\.?|mba|emba|m\.?s\.?|meng|mphil|llm|b\.?sc|bsc|b\.?a\.?|beng|bba|ph\.?d|dphil|master'?s?|bachelor'?s?|doctor|doctorate|diploma|certificate|grado|licenciatura|laurea|exchange|semester|study abroad|high school|cems|associate degree)\b/i;

const require_ = createRequire(import.meta.url);
function loadYaml() {
  try { return require_('js-yaml'); } catch { return null; }
}

/** `candidate:` block of profile.yml; js-yaml when present, else a minimal reader. */
function parseCandidate(raw) {
  const yaml = loadYaml();
  if (yaml) {
    try { return yaml.load(raw)?.candidate || null; } catch { /* fall through */ }
  }
  const out = {};
  let inBlock = false;
  for (const line of raw.split('\n')) {
    if (/^candidate:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\S/.test(line)) break;
    const m = inBlock && /^\s+([A-Za-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && !m[2].startsWith('#')) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return Object.keys(out).length ? out : null;
}

/** Split a heading / institution line into its parts (`A — B | C`, `A & B`). */
function splitParts(s, { alsoAmp = false } = {}) {
  const re = alsoAmp ? /\s+[—–|]\s+|\s+-\s+|\s*&\s*|\s+\+\s+|,\s*|\s+and\s+/ : /\s+[—–|]\s+|\s+-\s+/;
  return s.split(re).map((p) => p.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function looksLikeDate(s) {
  return MONTH_RE.test(s) && /\b(19|20)\d{2}\b/.test(s) || /^\s*(19|20)\d{2}\b/.test(s) || /\bpresent\b/i.test(s) && /\d{4}/.test(s);
}

function isBulletLine(s) {
  return /^\s*(?:[-*+•]|\d+[.)])\s/.test(s);
}

/**
 * The old format names the entity in bold on the first line under the
 * heading: `**Acme Corp** — City | dates`. Labels (`**Tools:**`, `**Stack**:`) are not names.
 */
function leadBold(lines) {
  const first = lines.find((l) => l.trim() !== '');
  const m = first && /^\s*\*\*([^*\n]{3,80})\*\*(?!\s*:)/.exec(first);
  if (!m) return [];
  const name = stripMd(m[1]);
  if (!name || /:$/.test(name) || looksLikeDate(name)) return [];
  return [name];
}

/**
 * Parse a CV: name (first `# ` heading), schools, employers, projects,
 * graduation dates. Supports `### Entity — subtitle` headings and the older
 * `**Entity**` lines under a role/degree heading.
 */
export function parseCv(cv) {
  const result = { name: null, schools: [], employers: [], projects: [], graduationDates: [], emails: [] };
  if (!cv) return result;
  const lines = cv.split('\n');
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) result.name = stripMd(h1.replace(/^#\s+/, ''));

  // Group lines into ## sections → ### entries.
  const sections = [];
  let section = null;
  let entry = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      section = { title: stripMd(h2[1]).toLowerCase(), entries: [] };
      entry = { heading: null, lines: [] };
      section.entries.push(entry);
      sections.push(section);
      continue;
    }
    if (!section) continue;
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      entry = { heading: stripMd(h3[1]), lines: [] };
      section.entries.push(entry);
      continue;
    }
    entry.lines.push(line);
  }

  const kindOf = (title) => {
    if (/educa|academic|studies|formaci|ausbildung|istruzione/.test(title)) return 'education';
    if (/experience|employment|work history|experiencia|berufserfahrung|esperienz/.test(title)) return 'experience';
    if (/project|proyecto|projekt|progett/.test(title)) return 'projects';
    return null;
  };
  const keep = (s) => {
    const toks = tokenize(s);
    return toks.length > 0 && !isGenericPhrase(toks) && toks.join('').length >= 3;
  };
  const firstEntity = (heading, { skipDegrees = false } = {}) => {
    for (const part of splitParts(heading)) {
      if (looksLikeDate(part)) continue;
      if (skipDegrees && DEGREE_RE.test(part)) continue;
      if (keep(part)) return part;
    }
    return null;
  };

  for (const sec of sections) {
    const kind = kindOf(sec.title);
    if (!kind) continue;
    for (const e of sec.entries) {
      const bold = leadBold(e.lines).filter(keep);
      if (kind === 'education') {
        if (e.heading) {
          const h = firstEntity(e.heading, { skipDegrees: true });
          if (h) result.schools.push(h);
        }
        for (const b of bold) result.schools.push(b);
        // The line under the heading may name the institutions:
        // "Lakeside University (home school) & Example School (exchange) — Lyon".
        const next = e.lines.find((l) => l.trim() !== '');
        if (next && !isBulletLine(next)) {
          for (const part of splitParts(stripMd(next), { alsoAmp: true })) {
            if (looksLikeDate(part) || DEGREE_RE.test(part)) continue;
            if ((INSTITUTION_RE.test(part) || /^[A-Z]{3,}\b/.test(part)) && keep(part)) result.schools.push(part);
          }
        }
      } else if (kind === 'experience') {
        if (bold.length) result.employers.push(...bold);
        else if (e.heading) {
          const h = firstEntity(e.heading);
          if (h) result.employers.push(h);
        }
      } else if (kind === 'projects') {
        if (e.heading) {
          const h = firstEntity(e.heading);
          if (h) result.projects.push(h);
        }
        result.projects.push(...bold);
      }
    }
  }

  // Graduation / program dates (month + year), full and abbreviated forms.
  const dateVariants = new Set();
  for (const d of cv.match(new RegExp(`(?:${MONTHS.join('|')})\\s+20[2-9][0-9]`, 'g')) || []) {
    const [month, year] = d.split(/\s+/);
    dateVariants.add(`${month} ${year}`);
    dateVariants.add(`${month.slice(0, 3)} ${year}`);
  }
  result.graduationDates = [...dateVariants];
  for (const m of cv.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) result.emails.push(m[0]);

  const uniq = (a) => [...new Map(a.map((x) => [termKey(x), x])).values()];
  result.schools = uniq(result.schools);
  result.employers = uniq(result.employers);
  result.projects = uniq(result.projects);
  return result;
}

/** Every markdown table in a file: lowercased header cells + row cells. */
export function parseMarkdownTables(text) {
  const tables = [];
  const lines = String(text ?? '').split('\n');
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    if (!/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const header = cells(lines[i]).map((c) => stripMd(c).toLowerCase());
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(cells(lines[j]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

const EMPTY_CELL = /^(?:|-+|—|–|n\/?a|tbd|\?|none)$/i;

/** Company/role pairs from a tracker (applications.md / scouting.md). */
export function trackerPairs(text) {
  const out = [];
  for (const t of parseMarkdownTables(text)) {
    const ci = t.header.findIndex((h) => h === 'company' || h === 'empresa');
    const ri = t.header.findIndex((h) => h === 'role' || h === 'rol' || h === 'puesto' || h === 'position');
    if (ci === -1) continue;
    for (const row of t.rows) {
      const company = stripMd(row[ci]);
      const role = ri === -1 ? '' : stripMd(row[ri]);
      if (EMPTY_CELL.test(company)) continue;
      out.push({ company, role: EMPTY_CELL.test(role) ? '' : role });
    }
  }
  return out;
}

/** Names from data/network.md (the Name column). */
export function networkNames(text) {
  const out = [];
  for (const t of parseMarkdownTables(text)) {
    const ni = t.header.findIndex((h) => h === 'name' || h === 'nombre');
    if (ni === -1) continue;
    for (const row of t.rows) {
      const name = stripMd(row[ni]);
      if (!EMPTY_CELL.test(name)) out.push(name);
    }
  }
  return out;
}

/** `{Company} - {Role}.md` file names (reports, interview prep), recursively. */
function namedFiles(dir, depth = 0, out = []) {
  if (depth > 4 || !isDir(dir)) return out;
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (isDir(full)) namedFiles(full, depth + 1, out);
    else if (/\.md$/i.test(name)) out.push(name.replace(/\.md$/i, ''));
  }
  return out;
}

/** `{Company} - {Role}` or `{num}-{slug}-{YYYY-MM-DD}` → name + optional pair. */
export function parseReportName(stem) {
  const s = String(stem).trim();
  const dash = s.indexOf(' - ');
  if (dash > 0) {
    return { name: s, company: s.slice(0, dash).trim(), role: s.slice(dash + 3).trim() };
  }
  const m = /^\d+-(.+?)-\d{4}-\d{2}-\d{2}$/.exec(s);
  if (m) return { name: m[1].replace(/-/g, ' '), company: null, role: null };
  return null;
}

/** private/leak-terms.txt → { extra, allow }. */
export function parseLeakTerms(text) {
  const extra = [];
  const allow = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { if (line.slice(1).trim()) allow.push(line.slice(1).trim()); }
    else extra.push(line);
  }
  return { extra, allow };
}

/** The roots that hold user/ data/ reports/: the data root plus every profile. */
function layoutRoots(root) {
  const roots = [root];
  const profilesDir = join(root, 'profiles');
  if (isDir(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const p = join(profilesDir, name);
      if (!name.startsWith('.') && isDir(p)) roots.push(p);
    }
  }
  return roots;
}

/**
 * Extract personal identifiers from a data root (a folder with the private
 * layout: user/, data/, reports/, …; a legacy checkout root works too).
 */
export function extractPersonalData(root) {
  const data = {
    fullName: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneDigits: null,
    nationality: null,
    emails: [],
    phones: [],
    handles: [],
    schools: [],
    employers: [],
    projectNames: [],
    graduationDates: [],
    persons: [],
    companies: [],
    roles: [],
    pairs: [],
    reportNames: [],
    extraTerms: [],
    allowTerms: [],
    sources: [],
  };
  if (!root || !existsSync(root)) return data;

  const roots = layoutRoots(root);

  // ── profile.yml (every profile) ──────────────────────────────────────────
  for (const r of roots) {
    const raw = readFileSafe(join(r, 'user', 'profile.yml'));
    if (!raw) continue;
    data.sources.push('profile');
    const c = parseCandidate(raw);
    if (!c) continue;
    if (c.full_name && !data.fullName) {
      data.fullName = String(c.full_name).trim();
      const parts = data.fullName.split(/\s+/);
      data.firstName = parts[0];
      data.lastName = parts[parts.length - 1];
    }
    if (c.email) { data.emails.push(String(c.email)); if (!data.email) data.email = String(c.email); }
    if (c.phone) {
      data.phones.push(String(c.phone));
      if (!data.phone) { data.phone = String(c.phone); data.phoneDigits = data.phone.replace(/\D/g, ''); }
    }
    if (c.nationality && !data.nationality) data.nationality = c.nationality;
    for (const k of ['linkedin', 'github', 'twitter', 'portfolio_url', 'website']) {
      const v = c[k] ? String(c[k]) : '';
      const handle = /(?:linkedin\.com\/in\/|github\.com\/|x\.com\/|twitter\.com\/)([A-Za-z0-9_.-]{3,})/i.exec(v)?.[1]
        || (/^(?:https?:\/\/)?([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)\/?$/.exec(v)?.[1]);
      if (handle) data.handles.push(handle);
    }
  }

  // ── cv.md (shared) ───────────────────────────────────────────────────────
  const cvText = readFileSafe(join(root, 'user', 'cv.md'));
  if (cvText) {
    data.sources.push('cv');
    const cv = parseCv(cvText);
    if (!data.fullName && cv.name && tokenize(cv.name).length >= 2) {
      data.fullName = cv.name;
      const parts = cv.name.split(/\s+/);
      data.firstName = parts[0];
      data.lastName = parts[parts.length - 1];
    }
    data.schools = cv.schools;
    data.employers = cv.employers;
    data.projectNames = cv.projects;
    data.graduationDates = cv.graduationDates;
    data.emails.push(...cv.emails);
  }

  // ── network, trackers, report names ──────────────────────────────────────
  const net = readFileSafe(join(root, 'data', 'network.md'));
  if (net) { data.sources.push('network'); data.persons.push(...networkNames(net)); }

  for (const r of roots) {
    for (const f of ['applications.md', 'scouting.md']) {
      const t = readFileSafe(join(r, 'data', f));
      if (!t) continue;
      data.sources.push(f.replace('.md', ''));
      for (const p of trackerPairs(t)) {
        data.companies.push(p.company);
        if (p.role) { data.roles.push(p.role); data.pairs.push(p); }
      }
    }
    for (const dir of ['reports', 'interview-prep']) {
      for (const stem of namedFiles(join(r, dir))) {
        const parsed = parseReportName(stem);
        if (!parsed) continue;
        data.reportNames.push(parsed.name);
        if (parsed.company && parsed.role) {
          data.companies.push(parsed.company);
          data.roles.push(parsed.role);
          data.pairs.push({ company: parsed.company, role: parsed.role });
        }
      }
    }
  }

  // ── leak-terms.txt ───────────────────────────────────────────────────────
  const lt = readFileSafe(join(root, LEAK_TERMS_FILE));
  if (lt) {
    data.sources.push('leak-terms');
    const { extra, allow } = parseLeakTerms(lt);
    data.extraTerms = extra;
    data.allowTerms = allow;
  }

  data.sources = [...new Set(data.sources)];
  return data;
}

// ── Terms ───────────────────────────────────────────────────────────────────

const CATEGORY_RANK = ['identity', 'extra', 'person', 'employer', 'school', 'project', 'report', 'company', 'role'];

/** Variants of a company/role string worth matching (without parentheticals / legal suffix). */
function variants(s, category) {
  const out = [s];
  const noParen = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParen && noParen !== s) out.push(noParen);
  if (category === 'company') {
    const toks = noParen.split(/\s+/);
    while (toks.length > 1 && BRAND_SUFFIXES.has(termKey(toks[toks.length - 1]))) toks.pop();
    const base = toks.join(' ');
    if (base && base !== noParen) out.push(base);
  }
  return out;
}

/**
 * Build the term list from extracted personal data.
 * Each term: { id, key, tokens, orig, category, severity: 'block'|'warn',
 *              standalone, caseSensitive, masked }.
 * @returns {{ terms: object[], pairs: Array<{ companyKey, roleKey, masked }> }}
 */
export function buildTerms(pd) {
  const allow = new Set((pd.allowTerms || []).map(termKey).filter(Boolean));
  const byKey = new Map();
  const counters = {};

  const add = (category, text, { standalone = true, severity = 'block', caseInsensitive = false, id = null } = {}) => {
    if (!text) return null;
    const raw = String(text).trim();
    const toks = tokenize(raw);
    const key = toks.map((t) => t.toLowerCase()).join(' ');
    if (!key || key.replace(/ /g, '').length < 3) return null;
    if (allow.has(key)) return null;
    const existing = byKey.get(key);
    if (existing) {
      if (CATEGORY_RANK.indexOf(category) < CATEGORY_RANK.indexOf(existing.category)) {
        existing.category = category;
        existing.severity = severity;
      } else if (category === existing.category && severity === 'block') existing.severity = 'block';
      existing.standalone = existing.standalone || standalone;
      existing.caseSensitive = existing.caseSensitive && !caseInsensitive;
      return existing;
    }
    counters[category] = (counters[category] || 0) + 1;
    const term = {
      id: id || `${category}_${counters[category]}`,
      key,
      tokens: key.split(' '),
      orig: toks.length === 1 ? toks[0] : null,
      category,
      severity,
      standalone,
      caseSensitive: toks.length === 1 && !caseInsensitive,
      masked: maskTerm(displayOf(raw)),
    };
    byKey.set(key, term);
    return term;
  };

  // identity
  if (pd.fullName) add('identity', pd.fullName, { id: 'full_name', caseInsensitive: true });
  if (pd.firstName && pd.lastName && pd.firstName.length >= 3 && pd.lastName.length >= 3 && pd.firstName !== pd.lastName) {
    add('identity', `${pd.firstName} ${pd.lastName}`, { id: 'name_pair', caseInsensitive: true });
  }
  const emails = [...new Set([pd.email, ...(pd.emails || [])].filter(Boolean))];
  emails.forEach((e, i) => add('identity', e, { id: i === 0 ? 'email' : `email_${i + 1}`, caseInsensitive: true }));
  (pd.handles || []).forEach((h, i) => add('identity', h, { id: `handle_${i + 1}` }));

  for (const p of pd.persons || []) if (tokenize(p).length >= 2) add('person', p, { caseInsensitive: true });

  const cvTerm = (category, s) => {
    const toks = tokenize(s);
    if (isGenericPhrase(toks)) return;
    const famous = (category === 'employer') && isFamousBrand(s);
    add(category, s, { severity: famous ? 'warn' : 'block' });
  };
  for (const s of pd.schools || []) cvTerm('school', s);
  for (const s of pd.employers || []) cvTerm('employer', s);
  for (const s of pd.projectNames || []) cvTerm('project', s);
  for (const s of pd.reportNames || []) {
    const toks = tokenize(s);
    if (toks.length >= 2 && !isGenericPhrase(toks)) add('report', s);
  }

  const companyTerm = (c) => {
    const terms = [];
    for (const v of variants(c, 'company')) {
      const toks = tokenize(v);
      const generic = isGenericPhrase(toks);
      const t = add('company', v, { standalone: !generic, severity: isFamousBrand(v) ? 'warn' : 'block' });
      if (t) terms.push(t);
    }
    return terms;
  };
  const roleTerm = (r) => {
    const terms = [];
    for (const v of variants(r, 'role')) {
      const toks = tokenize(v);
      const standalone = toks.length >= 3 && !isGenericPhrase(toks);
      const t = add('role', v, { standalone });
      if (t) terms.push(t);
    }
    return terms;
  };
  for (const c of pd.companies || []) companyTerm(c);
  for (const r of pd.roles || []) roleTerm(r);

  for (const e of pd.extraTerms || []) add('extra', e, { caseInsensitive: true });

  // company+role pairs (same line → block)
  const pairs = new Map();
  for (const { company, role } of pd.pairs || []) {
    if (!company || !role) continue;
    const cs = companyTerm(company);
    const rs = roleTerm(role);
    for (const c of cs) for (const r of rs) {
      if (c.key === r.key) continue;
      const k = `${c.key}\u0000${r.key}`;
      if (!pairs.has(k)) pairs.set(k, { companyKey: c.key, roleKey: r.key, masked: `${c.masked} + ${r.masked}` });
    }
  }
  return { terms: [...byKey.values()], pairs: [...pairs.values()] };
}

/** A regex equivalent of a term (for API consumers; the scanner uses the matcher). */
function termRegex(term) {
  if (term.caseSensitive) {
    const o = term.orig;
    const alts = [...new Set([o, o.toUpperCase(), o[0].toUpperCase() + o.slice(1)])].map(escapeRegex);
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'u');
  }
  const body = term.tokens.map(escapeRegex).join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

function buildProximityRegex(anchor, neighbors, windowChars) {
  const alt = neighbors.map((n) => `(?:${n})`).join('|');
  const w = `[\\s\\S]{1,${windowChars}}`;
  return new RegExp(`(?:(?:${alt})${w}(?:${anchor})|(?:${anchor})${w}(?:${alt}))`, 'i');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Regex patterns for the personal data: one per standalone term (same ids as
 * buildTerms), plus phone digits in any format and graduation dates in
 * user-addressed prose. Severity 'error' (blocks) | 'warn'.
 * Each: { id, category, regex, description (masked), severity, scanner? }.
 */
export function buildPatterns(pd) {
  const patterns = [];
  for (const t of buildTerms(pd).terms) {
    if (!t.standalone) continue;
    patterns.push({
      id: t.id,
      category: t.category,
      regex: termRegex(t),
      description: `[${t.category}] ${t.masked}`,
      severity: t.severity === 'block' ? 'error' : 'warn',
    });
  }

  const phones = [...new Set([pd.phone, ...(pd.phones || [])].filter(Boolean))];
  phones.forEach((phone, i) => {
    const sfx = i === 0 ? '' : `_${i + 1}`;
    patterns.push({
      id: `phone_full${sfx}`, category: 'identity', regex: new RegExp(escapeRegex(phone), 'i'),
      description: `[identity] ${maskTerm(phone)}`, severity: 'error',
    });
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 8) {
      const partial = digits.slice(-9);
      patterns.push({
        id: `phone_partial${sfx}`, category: 'identity',
        regex: new RegExp(`(?<!\\d)${partial.split('').join('[\\s\\-().]*')}(?!\\d)`),
        description: `[identity] ${maskTerm(phone)}`, severity: 'error', scanner: true,
      });
    }
  });

  // Graduation dates in user-addressed prose ("you finish … in Sep 2031").
  const schoolAlts = (pd.schools || []).map(escapeRegex);
  for (const date of pd.graduationDates || []) {
    const datePattern = escapeRegex(date).replace(/\s+/, '\\s');
    const neighbors = [
      'you\\s+finish\\b', 'you\\s+graduate\\b', 'you\\s+complete\\b',
      '\\byour\\s+(?:degree|MSc|master|MBA|program|studies)\\b',
      '\\byour\\s+(?:CEMS|exchange|thesis)\\b', 'your\\s+next\\s+degree',
      ...schoolAlts,
    ];
    patterns.push({
      id: `grad_date_${slugify(date)}`, category: 'date',
      regex: buildProximityRegex(datePattern, neighbors, 120),
      description: `[date] ${maskTerm(date)}`, severity: 'error', scanner: true,
    });
  }
  return patterns;
}

/** Fast line matcher over the term list (token index, no giant regex). */
export function createMatcher({ terms, pairs }) {
  const index = new Map();
  for (const t of terms) {
    const first = t.tokens[0];
    if (!index.has(first)) index.set(first, []);
    index.get(first).push(t);
  }
  const pairsByCompany = new Map();
  for (const p of pairs) {
    if (!pairsByCompany.has(p.companyKey)) pairsByCompany.set(p.companyKey, []);
    pairsByCompany.get(p.companyKey).push(p);
  }
  return {
    size: terms.length,
    pairsByCompany,
    /** @returns {Map<string, object>} matched terms by key */
    find(text) {
      const found = new Map();
      const toks = tokenize(text);
      if (!toks.length) return found;
      const lower = toks.map((t) => t.toLowerCase());
      for (let i = 0; i < lower.length; i++) {
        const cands = index.get(lower[i]);
        if (!cands) continue;
        for (const t of cands) {
          if (found.has(t.key)) continue;
          const k = t.tokens.length;
          if (i + k > lower.length) continue;
          let ok = true;
          for (let j = 1; j < k; j++) if (lower[i + j] !== t.tokens[j]) { ok = false; break; }
          if (!ok) continue;
          if (t.caseSensitive) {
            const w = toks[i];
            const o = t.orig;
            if (w !== o && w !== o.toUpperCase() && w !== o[0].toUpperCase() + o.slice(1)) continue;
          }
          found.set(t.key, t);
        }
      }
      return found;
    },
  };
}

// ── Line scanner ────────────────────────────────────────────────────────────

/**
 * Scan one line. `ctx`: { matcher, patterns (scanner regexes), generic }.
 * @returns {Array<{ category, severity: 'block'|'warn', masked, id }>}
 */
export function scanLine(text, ctx, { file = null } = {}) {
  const hits = [];
  if (!text || text.includes(ALLOW_MARKER)) return hits;
  const authorLine = !!file && basename(file) === 'package.json' && /^\s*"author"\s*:/.test(text);
  const seen = new Set();
  const push = (h) => {
    const k = `${h.category}\u0000${h.id}\u0000${h.masked}`;
    if (seen.has(k)) return;
    seen.add(k);
    hits.push(h);
  };

  if (ctx.matcher && ctx.matcher.size) {
    const found = ctx.matcher.find(text);
    const inPair = new Set();
    let pairHit = false;
    for (const key of found.keys()) {
      for (const p of ctx.matcher.pairsByCompany.get(key) || []) {
        if (!found.has(p.roleKey)) continue;
        push({ category: 'company+role', severity: 'block', masked: p.masked, id: 'pair' });
        inPair.add(p.companyKey);
        inPair.add(p.roleKey);
        pairHit = true;
      }
    }
    for (const t of found.values()) {
      if (!t.standalone) continue;
      if (inPair.has(t.key) && (t.category === 'company' || t.category === 'role')) continue;
      if (pairHit && t.category === 'report') continue;
      if (authorLine && t.category === 'identity') continue;
      let severity = t.severity;
      if (t.category === 'school' && /^\s*\|/.test(text)) severity = 'warn'; // reference table row
      push({ category: t.category, severity, masked: t.masked, id: t.id });
    }
  }
  for (const p of ctx.patterns || []) {
    if (authorLine && p.category === 'identity') continue;
    if (p.regex.test(text)) {
      push({ category: p.category, severity: p.severity === 'error' ? 'block' : 'warn', masked: p.description.replace(/^\[[^\]]+\]\s*/, ''), id: p.id });
    }
  }
  if (ctx.generic !== false) {
    for (const g of scanGenericLine(text, { skip: authorLine ? new Set(['email']) : undefined })) {
      push({ category: g.category, severity: g.severity, masked: g.masked, id: g.id });
    }
  }
  return hits;
}

// ── Sources of lines ────────────────────────────────────────────────────────

const BINARY_EXT = new Set(`.png .jpg .jpeg .gif .webp .ico .icns .bmp .tif .tiff .psd .pdf .woff .woff2 .ttf .otf .eot
.zip .gz .tgz .bz2 .xz .7z .rar .tar .jar .mp3 .mp4 .mov .wav .ogg .webm .m4a .avi .sqlite .db .bin .exe .dll .so
.dylib .node .wasm .pyc .class .keynote .key .pages .numbers .docx .xlsx .pptx`.split(/\s+/));
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function* fileUnits(root, rel) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(abs); } catch { return; }
    yield { kind: 'file', file: rel, line: 1, text: target };
    return;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES || BINARY_EXT.has(extname(rel).toLowerCase())) return;
  let buf;
  try { buf = readFileSync(abs); } catch { return; }
  if (buf.subarray(0, 8000).includes(0)) return;
  const lines = buf.toString('utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) yield { kind: 'file', file: rel, line: i + 1, text: lines[i] };
}

const PERSONAL_TOP = new Set([PRIVATE_DIR, 'profiles', ...LINKED_PATHS.map((l) => l.path.split('/')[0]).filter((p) => p !== 'batch')]);

function isPrivatePath(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '');
  return p === PRIVATE_DIR || p.startsWith(PRIVATE_DIR + '/') || isPersonalPath(p);
}

function walk(root, dir, out, { skipPersonal }) {
  let names = [];
  try { names = readdirSync(join(root, dir)); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (skipPersonal && (PERSONAL_TOP.has(rel) || isPrivatePath(rel))) continue;
    let st;
    try { st = lstatSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) walk(root, rel, out, { skipPersonal });
    else out.push(rel);
  }
  return out;
}

/** Tracked files (git ls-files); a plain folder is walked instead (minus personal dirs). */
function listFiles(root, { env, include }) {
  if (include && include.length) {
    const out = [];
    for (const d of include) {
      const rel = d.replace(/\/+$/, '');
      if (isDir(join(root, rel))) walk(root, rel, out, { skipPersonal: false });
      else if (existsSync(join(root, rel))) out.push(rel);
    }
    return { files: out, tracked: false };
  }
  const out = isCheckout(root) ? git(root, ['ls-files', '-z', '--cached'], { env }) : null;
  if (out !== null) return { files: out.split('\0').filter(Boolean), tracked: true };
  return { files: walk(root, '', [], { skipPersonal: true }), tracked: false };
}

function unquoteGitPath(p) {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const n = inner[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(inner.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf-8');
}

function diffGitPath(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const m = /^"(?:[^"\\]|\\.)*"\s+("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (m) return unquoteGitPath(m[1]).replace(/^b\//, '');
    return null;
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return b.slice(2);
  }
  const i = rest.lastIndexOf(' b/');
  return i >= 0 ? rest.slice(i + 3) : null;
}

/**
 * Added lines of a unified diff (`-U0` or more).
 * @returns {{ lines: Array<{ file, line, text }>, paths: string[] }}
 */
export function parseUnifiedDiff(text) {
  const lines = [];
  const paths = [];
  const addPath = (p) => { if (p && !paths.includes(p)) paths.push(p); };
  let file = null;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of String(text).split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === '+') { lines.push({ file, line: newLine, text: raw.slice(1) }); newLine++; newLeft--; continue; }
      if (c === '-') { oldLeft--; continue; }
      if (c === ' ') { newLine++; newLeft--; oldLeft--; continue; }
      if (c === '\\') continue;
      oldLeft = 0; newLeft = 0;
    }
    if (raw.startsWith('diff --git ')) { file = diffGitPath(raw); addPath(file); continue; }
    if (raw.startsWith('rename to ') || raw.startsWith('copy to ')) {
      file = unquoteGitPath(raw.slice(raw.indexOf(' to ') + 4)); addPath(file); continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/\t$/, '');
      if (p !== '/dev/null') { file = unquoteGitPath(p).replace(/^b\//, ''); addPath(file); }
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLine = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  return { lines, paths };
}

const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--find-renames',
  '--diff-filter=ACMRT', '--src-prefix=a/', '--dst-prefix=b/'];

function stagedSource(root, env) {
  const patch = git(root, ['-c', 'core.quotePath=false', 'diff', '--cached', ...DIFF_FLAGS], { env, throwOnError: true });
  const { lines, paths } = parseUnifiedDiff(patch);
  return { units: lines.map((l) => ({ kind: 'file', ...l })), paths: paths.map((p) => ({ file: p })), commits: 0 };
}

const RANGE_FLAG = /^--(?:not|all|remotes|branches|tags)(?:=[^\s]*)?$/;

function rangeSource(root, revArgs, env) {
  for (const a of revArgs) {
    if (a.startsWith('-') && !RANGE_FLAG.test(a)) throw new GuardError(`--range: unsupported argument ${a}`);
  }
  const msgs = git(root, ['log', '--no-color', '--no-show-signature', '--format=%x1e%H%x1f%B', ...revArgs, '--'], { env, throwOnError: true });
  const units = [];
  let commits = 0;
  for (const rec of msgs.split('\x1e')) {
    if (!rec.trim()) continue;
    const [sha, body = ''] = rec.split('\x1f');
    commits++;
    body.split('\n').forEach((text, i) => units.push({ kind: 'message', commit: sha.trim(), file: null, line: i + 1, text }));
  }
  const paths = [];
  if (commits > 0) {
    const log = git(root, ['-c', 'core.quotePath=false', 'log', '-p', '--root', '--no-merges', '--no-show-signature',
      ...DIFF_FLAGS, '--format=%x1ecommit %H', ...revArgs, '--'], { env, throwOnError: true });
    for (const rec of log.split('\x1e')) {
      const m = /^commit ([0-9a-f]+)\n/.exec(rec);
      if (!m) continue;
      const { lines, paths: ps } = parseUnifiedDiff(rec.slice(m[0].length));
      for (const l of lines) units.push({ kind: 'file', commit: m[1], ...l });
      for (const p of ps) paths.push({ file: p, commit: m[1] });
    }
  }
  return { units, paths, commits };
}

function messageSource(root, file, env) {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  const text = readFileSafe(path);
  if (text === null) throw new GuardError(`--message: cannot read ${file}`);
  let cc = (git(root, ['config', '--get', 'core.commentChar'], { env }) || '').trim();
  if (!cc || cc === 'auto') cc = '#';
  const units = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith(`${cc} `) && /-{8,} >8 -{8,}/.test(l)) break; // scissors: the rest is the diff
    if (l.startsWith(cc)) continue;
    units.push({ kind: 'message', commit: null, file: null, line: i + 1, text: l });
  }
  return { units, paths: [], commits: 0 };
}

// ── Main API ────────────────────────────────────────────────────────────────

function repoOf(root) {
  return root || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Scan for personal data.
 * @param {{ root?: string, verbose?: boolean, staged?: boolean, range?: string|string[],
 *           message?: string, genericOnly?: boolean, include?: string[], env?: object,
 *           dataRoot?: string|null }} opts
 */
export async function runHygieneGuard(opts = {}) {
  const {
    verbose = false, staged = false, range = null, message = null,
    genericOnly = false, include = null, env = process.env,
  } = opts;
  const root = resolve(repoOf(opts.root));

  let dataRoot;
  if (genericOnly) dataRoot = { root: null, kind: 'none', source: 'generic-only' };
  else if (opts.dataRoot !== undefined) {
    dataRoot = opts.dataRoot ? { root: resolve(opts.dataRoot), kind: 'external', source: 'option' } : { root: null, kind: 'none', source: 'option' };
  } else dataRoot = resolveGuardDataRoot({ root, env });

  const personalData = extractPersonalData(dataRoot.root);
  const { terms, pairs } = buildTerms(personalData);
  const patterns = buildPatterns(personalData);
  const ctx = {
    matcher: createMatcher({ terms, pairs }),
    patterns: patterns.filter((p) => p.scanner),
    generic: true,
  };
  if (verbose) {
    const byCat = {};
    for (const t of terms) byCat[t.category] = (byCat[t.category] || 0) + 1;
    console.error(`[hygiene-guard] data root: ${dataRoot.kind} (${dataRoot.source}); sources: ${personalData.sources.join(', ') || 'none'}`);
    console.error(`[hygiene-guard] terms: ${JSON.stringify(byCat)}; pairs: ${pairs.length}; regex patterns: ${ctx.patterns.length}`);
  }

  const modes = [staged, range != null, message != null].filter(Boolean).length;
  if (modes > 1) throw new GuardError('choose one of --staged, --range, --message');

  let source;
  let mode;
  let scannedFiles = 0;
  if (staged) { mode = 'staged'; source = stagedSource(root, env); }
  else if (range != null) {
    mode = 'range';
    source = rangeSource(root, Array.isArray(range) ? range : String(range).split(/\s+/).filter(Boolean), env);
  } else if (message != null) { mode = 'message'; source = messageSource(root, message, env); }
  else {
    mode = include ? 'paths' : 'tracked';
    const { files } = listFiles(root, { env, include });
    scannedFiles = files.length;
    source = {
      paths: files.map((f) => ({ file: f })),
      units: (function* () { for (const f of files) yield* fileUnits(root, f); })(),
      commits: 0,
    };
  }

  const hits = [];
  const pathCache = new Map();
  const displayPath = (file) => {
    if (!file) return file;
    if (pathCache.has(file)) return pathCache.get(file);
    let shown = file;
    if (isPrivatePath(file)) shown = `${file.split('/')[0]}/…`;
    else if (scanLine(basename(file), { ...ctx, generic: false, patterns: [] }).length) {
      const dir = dirname(file);
      shown = `${dir === '.' ? '' : dir + '/'}${maskTerm(basename(file))}`;
    }
    pathCache.set(file, shown);
    return shown;
  };
  const record = (unit, h) => {
    const file = unit.file ? displayPath(unit.file) : null;
    hits.push({
      kind: unit.kind,
      file,
      line: unit.line,
      commit: unit.commit || null,
      category: h.category,
      severity: h.severity,
      masked: h.masked,
      pattern: { id: h.id, description: `[${h.category}] ${h.masked}`, severity: h.severity === 'block' ? 'error' : 'warn' },
    });
  };

  // File names (and personal paths) first.
  const seenPaths = new Set();
  for (const p of source.paths) {
    const k = `${p.file}\u0000${p.commit || ''}`;
    if (seenPaths.has(k)) continue;
    seenPaths.add(k);
    const unit = { kind: 'path', file: p.file, line: 0, commit: p.commit || null };
    if (isPrivatePath(p.file)) {
      record(unit, { category: 'personal-path', severity: 'block', masked: `${p.file.split('/')[0]}/…`, id: 'personal_path' });
      continue;
    }
    for (const h of scanLine(p.file, ctx)) record(unit, h);
  }

  let lineCount = 0;
  for (const unit of source.units) {
    lineCount++;
    if (unit.file && isPrivatePath(unit.file)) continue; // already reported as a personal path
    for (const h of scanLine(unit.text, ctx, { file: unit.file })) record(unit, h);
  }

  const violations = hits.filter((h) => h.severity === 'block');
  const warnings = hits.filter((h) => h.severity !== 'block');
  return {
    violations,
    warnings,
    hits,
    personalData,
    patterns,
    terms,
    dataRoot,
    scanned: {
      mode,
      files: mode === 'tracked' || mode === 'paths' ? scannedFiles : seenPaths.size,
      lines: lineCount,
      commits: source.commits,
      terms: terms.filter((t) => t.standalone).length,
      pairs: pairs.length,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** `path:line  [category]  M·····d` — never the line, never the full term. */
export function formatHit(h) {
  const sha = h.commit ? h.commit.slice(0, 7) : null;
  let where;
  if (h.category === 'personal-path') {
    return `${h.file}  [personal-path]  personal data belongs in private/, never in the public repo${sha ? `  (commit ${sha})` : ''}`;
  }
  if (h.kind === 'message') where = sha ? `commit ${sha} message` : `commit message:${h.line}`;
  else if (h.kind === 'path') where = `${h.file} (file name)`;
  else where = `${h.file}:${h.line}`;
  const tail = sha && h.kind !== 'message' ? `  (commit ${sha})` : '';
  return `${where}  [${h.category}]  ${h.masked}${tail}`;
}

function githubAnnotation(h) {
  const level = h.severity === 'block' ? 'error' : 'warning';
  const msg = `[${h.category}] ${h.masked}${h.commit ? ` (commit ${h.commit.slice(0, 7)})` : ''}`;
  if (h.kind === 'file' && h.file && !h.file.includes('…') && !h.file.includes('·')) {
    return `::${level} file=${h.file},line=${h.line},title=Leak scan::${msg}`;
  }
  return `::${level} title=Leak scan::${h.kind === 'message' ? 'commit message ' : ''}${h.file || ''} ${msg}`.replace(/\s+/g, ' ');
}

export function parseArgs(argv) {
  const opts = { verbose: false, json: false, github: false, genericOnly: false, staged: false, range: null, message: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose') opts.verbose = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--github') opts.github = true;
    else if (a === '--generic-only') opts.genericOnly = true;
    else if (a === '--staged') opts.staged = true;
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--range') {
      const rev = [];
      while (i + 1 < argv.length && (!argv[i + 1].startsWith('--') || RANGE_FLAG.test(argv[i + 1]))) rev.push(argv[++i]);
      if (!rev.length) throw new GuardError('--range needs a revision range (a..b, or <sha> --not --remotes)');
      opts.range = rev;
    } else throw new GuardError(`unknown option ${a}`);
  }
  if ((opts.message === undefined) || (opts.root === undefined)) throw new GuardError('missing value for an option');
  return opts;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    console.error(`hygiene-guard: ${e.message}`);
    return 2;
  }
  let result;
  try {
    result = await runHygieneGuard({
      root: opts.root ? resolve(opts.root) : undefined,
      verbose: opts.verbose,
      staged: opts.staged,
      range: opts.range,
      message: opts.message,
      genericOnly: opts.genericOnly,
    });
  } catch (e) {
    console.error(`hygiene-guard: ${e instanceof GuardError ? e.message : `crashed: ${e.message}`}`);
    return 2;
  }
  const { violations, warnings, dataRoot, scanned } = result;
  if (!opts.genericOnly && dataRoot.kind === 'none') {
    console.error('hygiene-guard: no private data found: generic checks only');
  }

  if (opts.json) {
    const strip = ({ pattern, ...h }) => h;
    console.log(JSON.stringify({
      mode: scanned.mode,
      dataRoot: { kind: dataRoot.kind, source: dataRoot.source },
      scanned,
      blocking: violations.length,
      warnings: warnings.length,
      hits: result.hits.map(strip),
    }, null, 2));
    return violations.length ? 1 : 0;
  }

  if (opts.github) for (const h of result.hits) console.log(githubAnnotation(h));

  for (const v of violations) console.log(`  ${formatHit(v)}`);
  const WARN_LIMIT = opts.verbose ? Infinity : 20;
  warnings.slice(0, WARN_LIMIT).forEach((w) => console.log(`  (warning) ${formatHit(w)}`));
  if (warnings.length > WARN_LIMIT) console.log(`  … and ${warnings.length - WARN_LIMIT} more warning(s) (--verbose lists them all)`);

  const scope = {
    tracked: `${scanned.files} tracked files`,
    paths: `${scanned.files} files`,
    staged: `staged diff (${scanned.files} files)`,
    range: `push range (${scanned.commits} commit${scanned.commits === 1 ? '' : 's'})`,
    message: 'commit message',
  }[scanned.mode];
  const termsDesc = dataRoot.kind === 'none'
    ? 'generic checks only'
    : `${scanned.terms} private terms + ${scanned.pairs} company+role pairs from ${dataRoot.kind === 'legacy' ? 'user/ + data/' : 'private/'}${dataRoot.source === 'main-worktree' ? ' (main worktree)' : ''}`;
  console.log(`hygiene-guard: ${violations.length} blocking, ${warnings.length} warning(s) in ${scope}; ${termsDesc}.`);
  return violations.length ? 1 : 0;
}

function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
}
const invokedDirectly = !!process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

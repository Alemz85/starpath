/**
 * leak-patterns.mjs — generic leak patterns (no personal data needed).
 *
 * Shared by the leak gate (scripts/lib/hygiene-guard.mjs, which also runs
 * them in every hook mode) and the CI backup net (.github/workflows/
 * leak-scan.yml → `hygiene-guard.mjs --generic-only`). Pure and
 * dependency-free so CI can run it without `npm install`.
 *
 *   email      any address except placeholders (example.*, *.test, noreply…)
 *   phone      international numbers: +CC followed by ≥ 8 digits
 *   home-path  /Users/<name>/ or /home/<name>/ with a real-looking name
 *   secret     API-key / private-key shapes
 *   salary     salary-looking figures (WARNING only: fixtures use them)
 *
 * Each pattern's `exempt(match)` filters well-known placeholders so test
 * fixtures and docs stay clean. Unit-tested in leak-patterns.test.mjs.
 */

export const ALLOW_MARKER = 'hygiene-guard:allow';

/** First and last character, five middle dots: never the full value. */
export function maskTerm(value) {
  const s = String(value ?? '').trim();
  if (!s) return '·····';
  const chars = Array.from(s);
  if (chars.length === 1) return `${chars[0]}·····`;
  return `${chars[0]}·····${chars[chars.length - 1]}`;
}

// ── email ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'localhost',
  'users.noreply.github.com',
  // Placeholder domains used in forms and fixtures.
  'email.com', 'domain.com', 'company.com', 'yourcompany.com', 'yourdomain.com',
  'acme.com', 'acme.org', 'acme.io', 'initech.com', 'globex.com', 'hooli.com',
  'contoso.com', 'fabrikam.com', 'northwindtraders.com', 'litwareinc.com',
  'adventure-works.com', 'tailspintoys.com', 'wingtiptoys.com', 'woodgrovebank.com',
]);
const PLACEHOLDER_EMAIL_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
// `name@2x.png` (retina assets) and `pkg@1.2.3` are not addresses.
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'icns', 'pdf', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'css', 'scss', 'md', 'json', 'html', 'txt', 'yml', 'yaml', 'map',
]);
const NOREPLY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon)$/i;
const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

export function isPlaceholderEmail(address) {
  const at = address.lastIndexOf('@');
  if (at < 1) return true;
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  if (NOREPLY_LOCAL.test(local)) return true;
  if (local === 'git' && GIT_HOSTS.has(domain)) return true; // git@github.com:owner/repo
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return true;
  if (domain.endsWith('.users.noreply.github.com')) return true;
  if (PLACEHOLDER_EMAIL_TLDS.has(tld)) return true;
  if (FILE_EXTENSIONS.has(tld)) return true;
  if (labels.length === 2 && labels[0].length === 1) return true; // a@b.com
  return false;
}

// ── phone ───────────────────────────────────────────────────────────────────

/** +1 555… (fictional range), all-same digits, 123456789 runs, long zero runs. */
export function isPlaceholderPhone(match) {
  const digits = match.replace(/\D/g, '');
  if (/^\d{1,3}555/.test(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (/0{6,}/.test(digits)) return true;
  if ('0123456789012345678901234567890'.includes(digits.slice(-8))) return true;
  if ('9876543210987654321098765432109'.includes(digits.slice(-8))) return true;
  return false;
}

// ── home paths ──────────────────────────────────────────────────────────────

const PLACEHOLDER_USERS = new Set([
  'you', 'your', 'yourname', 'your-name', 'your_name', 'yourusername', 'your-username',
  'username', 'user', 'name', 'me', 'someone', 'example', 'runner', 'ubuntu', 'node',
  'shared', 'guest', 'foo', 'bar', 'test', 'demo', 'admin', 'root', 'x', 'xxx',
]);

export function isPlaceholderHomePath(match) {
  const m = /\/(?:Users|home)\/([^/]+)\//.exec(match);
  if (!m) return true;
  const name = m[1].toLowerCase();
  return PLACEHOLDER_USERS.has(name) || /^\.+$/.test(name) || /^x+$/.test(name);
}

// ── secrets ─────────────────────────────────────────────────────────────────

/** Docs show key shapes as sk-ant-xxxx…, <your-key>, etc. */
export function isPlaceholderSecret(match) {
  if (/-----BEGIN/.test(match)) return false;
  const body = match.replace(/^(?:sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|AKIA|xox[bp]-)/, '');
  if (/x{4,}|X{4,}|\.{3}|\*{3}|your|example|placeholder|redacted/i.test(body)) return true;
  if (/^(.)\1+$/.test(body)) return true;
  return false;
}

// ── catalogue ───────────────────────────────────────────────────────────────

/**
 * `regex` must be global. `severity`: 'block' fails the scan, 'warn' reports.
 */
export const GENERIC_PATTERNS = [
  {
    id: 'email',
    category: 'email',
    severity: 'block',
    regex: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
    exempt: isPlaceholderEmail,
  },
  {
    id: 'phone',
    category: 'phone',
    severity: 'block',
    regex: /(?<![\w+])\+\d{1,3}(?:[\s().-]{0,2}\d){8,}(?!\d)/g,
    exempt: isPlaceholderPhone,
  },
  {
    id: 'home-path',
    category: 'home-path',
    severity: 'block',
    regex: /\/(?:Users|home)\/[^/\s'"`<>${}*()[\]|;:,]+\//g,
    exempt: isPlaceholderHomePath,
  },
  {
    id: 'secret',
    category: 'secret',
    severity: 'block',
    regex: new RegExp([
      '(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}',
      '(?<![A-Za-z0-9-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}',
      '(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}',
      '(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}',
      '(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])',
      '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----',
      '(?<![A-Za-z0-9])xox[bp]-[A-Za-z0-9-]{10,}',
    ].join('|'), 'g'),
    exempt: isPlaceholderSecret,
  },
  {
    id: 'salary',
    category: 'salary',
    severity: 'warn',
    regex: /€\s?\d{2,3}(?:[.,]\d)?\s?[Kk](?![A-Za-z])|(?<![\d.,])\d{2,3}[.,]?000\s?(?:EUR|€)/g,
    exempt: () => false,
  },
];

/**
 * Scan one line with the generic patterns.
 * @param {string} line
 * @param {{ skip?: Set<string> }} [opts] pattern ids to skip on this line
 * @returns {Array<{ id, category, severity, masked }>}
 */
export function scanGenericLine(line, { skip } = {}) {
  const hits = [];
  if (!line || line.includes(ALLOW_MARKER)) return hits;
  for (const p of GENERIC_PATTERNS) {
    if (skip && skip.has(p.id)) continue;
    p.regex.lastIndex = 0;
    let m;
    while ((m = p.regex.exec(line)) !== null) {
      if (m[0].length === 0) { p.regex.lastIndex++; continue; }
      if (p.exempt(m[0])) continue;
      const masked = p.id === 'home-path'
        ? m[0].replace(/^(\/(?:Users|home)\/)([^/]+)\/$/, (_, pre, name) => `${pre}${maskTerm(name)}/`)
        : maskTerm(m[0]);
      hits.push({ id: p.id, category: p.category, severity: p.severity, masked });
    }
  }
  return hits;
}

// company-research-core.mjs — pure helpers for the deep-research artifact at
// data/companies/{slug}.md (written by modes/deep.md, read by interview-prep
// and contacto). No I/O, no globals, no input mutation — the CLI script
// (scripts/company-research.mjs) owns file reads.
//
// THE ARTIFACT CONTRACT
// ---------------------
// Every company research file is one Markdown doc with a YAML frontmatter block
// fenced by `---` lines, followed by fixed `## ` sections. The frontmatter is
// the machine-readable index other modes query; the sections are the human +
// agent reading surface. Schema is intentionally small and stable so consumers
// can rely on it:
//
//   ---
//   company: Acme Corp
//   slug: acme-corp
//   role: Senior Product Manager        # optional — the role this was scoped to
//   cached: 2026-06-25                  # ISO date the research was captured
//   sources: 7                          # count of cited sources (optional)
//   confidence: medium                  # high | medium | low (optional)
//   ---
//
// `cached` drives the 30-day freshness window (FRESH_DAYS). `slug` must match
// the filename stem so a mislabelled file is detectable.

export const FRESH_DAYS = 30;

/** Canonical section headings, in render order. Consumers key off these. */
export const SECTIONS = [
  'Business Model',
  'Recent Signals',
  'Team & Role Context',
  'Engineering / Org Culture',
  'Interview Style',
  'Compensation Hints',
  'Talking Points',
  'Candidate Angle',
];

/** Frontmatter keys that must be present for a file to be "complete". */
export const REQUIRED_KEYS = ['company', 'slug', 'cached'];

/**
 * Slugify a company name to the filename stem used under data/companies/.
 * Lowercase, ASCII-fold the common accents, spaces/punct → single hyphen,
 * trim leading/trailing hyphens. "Trade Republic" → "trade-republic".
 */
export function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Path (relative to repo root) where a company's artifact lives. */
export function artifactPath(name) {
  return `data/companies/${slugify(name)}.md`;
}

/**
 * Parse the YAML-ish frontmatter block at the top of an artifact. Deliberately
 * tiny (flat `key: value` pairs only) so the lib stays dependency-free — the
 * artifact schema never nests. Returns {} if no frontmatter fence is found.
 */
export function parseFrontmatter(content) {
  const text = String(content || '');
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // unquote
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** Whole-number days between two ISO dates (cached → today). NaN if unparseable. */
export function daysBetween(cached, today) {
  const a = Date.parse(`${cached}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.floor((b - a) / 86400000);
}

/**
 * Freshness verdict for an artifact's frontmatter as of `today` (ISO).
 *   { state, ageDays, reason }
 *   state ∈ 'fresh' | 'stale' | 'missing-date' | 'invalid-date'
 * `fresh` means age < FRESH_DAYS → consumers may reuse without re-researching.
 */
export function freshness(frontmatter, today) {
  const cached = frontmatter && frontmatter.cached;
  if (!cached) return { state: 'missing-date', ageDays: null, reason: 'no `cached:` key' };
  const age = daysBetween(cached, today);
  if (Number.isNaN(age)) {
    return { state: 'invalid-date', ageDays: null, reason: `unparseable cached date "${cached}"` };
  }
  if (age < FRESH_DAYS) {
    return { state: 'fresh', ageDays: age, reason: `cached ${age}d ago (< ${FRESH_DAYS}d)` };
  }
  return { state: 'stale', ageDays: age, reason: `cached ${age}d ago (≥ ${FRESH_DAYS}d)` };
}

/** List the canonical sections actually present as `## {heading}` in the body. */
export function presentSections(content) {
  const text = String(content || '');
  const found = [];
  for (const s of SECTIONS) {
    // match "## Heading" at line start, tolerant of trailing whitespace
    const re = new RegExp(`^##\\s+${escapeRegExp(s)}\\s*$`, 'm');
    if (re.test(text)) found.push(s);
  }
  return found;
}

/**
 * Validate an artifact against the contract. Returns:
 *   { ok, errors: [], warnings: [], frontmatter, missingSections: [] }
 * Errors block reuse (missing required keys, slug mismatch). Warnings are
 * advisory (missing optional sections, low source count).
 */
export function validateArtifact(content, { expectedSlug } = {}) {
  const frontmatter = parseFrontmatter(content);
  const errors = [];
  const warnings = [];

  for (const key of REQUIRED_KEYS) {
    if (!frontmatter[key]) errors.push(`missing required frontmatter key: ${key}`);
  }
  if (expectedSlug && frontmatter.slug && frontmatter.slug !== expectedSlug) {
    errors.push(`slug mismatch: frontmatter "${frontmatter.slug}" ≠ filename "${expectedSlug}"`);
  }

  const present = presentSections(content);
  const missingSections = SECTIONS.filter((s) => !present.includes(s));
  if (missingSections.length) {
    warnings.push(`missing sections: ${missingSections.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    frontmatter,
    missingSections,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

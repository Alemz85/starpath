#!/usr/bin/env node

/**
 * hygiene-guard.mjs — System-layer personal-data hygiene guard
 *
 * Reads real user values from user/profile.yml and user/cv.md at
 * scan time, then checks system-layer files for patterns that look
 * like the real user's data has been hardcoded.
 *
 * Design goals:
 *   - Zero false positives for legitimate generic reference data
 *     (school reference tables, city example lists, etc.)
 *   - Fail closed: any new personal-data pattern that slips into
 *     system files is caught immediately
 *   - Allowlist lines/files that are explicitly approved exceptions
 *
 * Usage (module API):
 *   const { runHygieneGuard } = await import('./lib/hygiene-guard.mjs');
 *   const results = await runHygieneGuard({ root, verbose });
 *   // results: { violations: Array<Violation>, warnings: Array<Warning> }
 *
 * Usage (CLI):
 *   node scripts/lib/hygiene-guard.mjs [--verbose]
 *   node scripts/lib/hygiene-guard.mjs --root /path/to/repo [--verbose]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import yaml from 'js-yaml';

// ── Utility ─────────────────────────────────────────────────────────────────

function readFileSafe(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function walkFiles(dir, extensions, skipDirs = []) {
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!skipDirs.includes(name) && !name.startsWith('.') && name !== 'node_modules') {
        results.push(...walkFiles(full, extensions, skipDirs));
      }
    } else if (extensions.includes(extname(name))) {
      results.push(full);
    }
  }
  return results;
}

// ── Personal data extraction ─────────────────────────────────────────────────

/**
 * Extract personal identifiers from user/profile.yml and user/cv.md.
 * Returns a structured PersonalData object.
 */
export function extractPersonalData(root) {
  const profilePath = join(root, 'user', 'profile.yml');
  const cvPath = join(root, 'user', 'cv.md');

  const data = {
    fullName: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneDigits: null,    // normalized digits only for partial match
    nationality: null,
    schools: [],          // institution names from CV education section
    employers: [],        // employer names from CV experience section
    projectNames: [],     // named projects from CV
    graduationDates: [],  // e.g. "October 2026", "Dec 2027"
  };

  // ── profile.yml ──────────────────────────────────────────────────────────
  if (existsSync(profilePath)) {
    const raw = readFileSafe(profilePath);
    if (raw) {
      try {
        const profile = yaml.load(raw);
        const c = profile?.candidate;
        if (c) {
          if (c.full_name) {
            data.fullName = c.full_name;
            const parts = c.full_name.trim().split(/\s+/);
            data.firstName = parts[0];
            data.lastName = parts[parts.length - 1];
          }
          if (c.email) data.email = c.email;
          if (c.phone) {
            data.phone = c.phone;
            // Strip non-digits for partial matching (phone can appear formatted many ways)
            data.phoneDigits = c.phone.replace(/\D/g, '');
          }
          if (c.nationality) data.nationality = c.nationality;
        }
      } catch {
        // YAML parse failure — skip; test-all.mjs will catch missing user data
      }
    }
  }

  // ── cv.md ────────────────────────────────────────────────────────────────
  if (existsSync(cvPath)) {
    const cv = readFileSafe(cvPath);
    if (cv) {
      // Extract schools — lines with "**...**" inside Education section
      // Pattern: bold institution names, usually followed by "—" or "("
      const schoolMatches = cv.match(/\*\*([A-Z][^\*]{4,60}(?:Business School|University|Guido Carli|Institut|College|School of|CBS))\*\*/g) || [];
      data.schools = schoolMatches
        .map(m => m.replace(/\*\*/g, '').trim())
        .filter(s => s.length > 4 && !s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)/));

      // Extract employers from Experience section — bold company names
      // They appear as **Company Name** at start of employer line
      const expSection = cv.match(/## Experience\n([\s\S]*?)(?:\n## |$)/)?.[1] || '';
      const empMatches = expSection.match(/\*\*([^*\n]{3,60})\*\*/g) || [];
      data.employers = empMatches
        .map(m => m.replace(/\*\*/g, '').trim())
        .filter(e => e.length > 3 && !e.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)/));

      // Extract project named entities (bold names in Projects section)
      const projSection = cv.match(/## Projects\n([\s\S]*?)(?:\n## |$)/)?.[1] || '';
      const projMatches = projSection.match(/\*\*([^*\n]{3,80})\*\*/g) || [];
      data.projectNames = projMatches
        .map(m => m.replace(/\*\*/g, '').trim())
        .filter(p => p.length > 3 && !p.match(/^(Student Consultant|Personal Project)$/));  // those are generic enough

      // Extract graduation / program dates — month + year combos near education
      // e.g. "October 2026", "September 2025", "December 2027", "March 2025"
      // Also generate 3-letter abbreviations so "Oct 2026" matches too.
      const MONTH_ABBREVS = {
        'January': 'Jan', 'February': 'Feb', 'March': 'Mar', 'April': 'Apr',
        'May': 'May', 'June': 'Jun', 'July': 'Jul', 'August': 'Aug',
        'September': 'Sep', 'October': 'Oct', 'November': 'Nov', 'December': 'Dec',
      };
      const dateMatches = cv.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20[2-9][0-9]/g) || [];
      const dateVariants = new Set();
      for (const d of dateMatches) {
        dateVariants.add(d);  // full form: "October 2026"
        // Add abbreviated form: "Oct 2026"
        const [month, year] = d.split(' ');
        if (MONTH_ABBREVS[month]) dateVariants.add(`${MONTH_ABBREVS[month]} ${year}`);
      }
      data.graduationDates = [...dateVariants];
    }
  }

  return data;
}

// ── Pattern catalogue ────────────────────────────────────────────────────────

/**
 * Build a list of { id, regex, description, severity } patterns from
 * the extracted personal data.
 *
 * Severity: 'error' (must fix) | 'warn' (review, may be legitimate)
 */
export function buildPatterns(pd) {
  const patterns = [];

  if (pd.fullName) {
    patterns.push({
      id: 'full_name',
      regex: new RegExp(escapeRegex(pd.fullName), 'i'),
      description: `Candidate's full name "${pd.fullName}"`,
      severity: 'error',
    });
  }

  if (pd.email) {
    patterns.push({
      id: 'email',
      regex: new RegExp(escapeRegex(pd.email), 'i'),
      description: `Candidate's email "${pd.email}"`,
      severity: 'error',
    });
  }

  if (pd.phone) {
    patterns.push({
      id: 'phone_full',
      regex: new RegExp(escapeRegex(pd.phone), 'i'),
      description: `Candidate's phone (full) "${pd.phone}"`,
      severity: 'error',
    });
  }

  if (pd.phoneDigits && pd.phoneDigits.length >= 8) {
    // Match last 9 digits (country-code-stripped) appearing as phone digits
    const partial = pd.phoneDigits.slice(-9);
    patterns.push({
      id: 'phone_partial',
      regex: new RegExp(partial.split('').join('[\\s\\-()]*')),
      description: `Candidate's phone digits (partial) "${partial}"`,
      severity: 'error',
    });
  }

  // Schools are tricky: e.g. "Esade" appears in a reference TABLE which is
  // legitimate generic data (the school-region map covers 20+ EU schools).
  // We distinguish between:
  //   - A school name appearing in a table/reference list → warn, not error
  //   - A school name in prose tied to "you" / "your" / a date → error
  for (const school of pd.schools) {
    if (school.length < 4) continue;
    patterns.push({
      id: `school_prose_${slugify(school)}`,
      // Must appear next to "you", "your", or a graduation year within 80 chars
      regex: buildProximityRegex(escapeRegex(school), ['\\byou\\b', '\\byour\\b', '20[2-9][0-9]'], 80),
      description: `School "${school}" in user-specific prose (near "you/your" or a date)`,
      severity: 'error',
    });
  }

  // Employers: similar. "AP Consulting" in reference text is unusual; in prose next to
  // the user's name it's a violation.
  for (const emp of pd.employers) {
    if (emp.length < 4) continue;
    patterns.push({
      id: `employer_prose_${slugify(emp)}`,
      regex: buildProximityRegex(escapeRegex(emp), ['\\byou\\b', '\\byour\\b', '\\bI\\b', pd.firstName ? escapeRegex(pd.firstName) : null].filter(Boolean), 120),
      description: `Employer "${emp}" in user-specific prose`,
      severity: 'warn',
    });
  }

  // Graduation dates: months + years extracted from CV shouldn't appear as
  // hardcoded examples in system files (e.g. "you finish the <School> MSc in <Month YYYY>").
  //
  // To avoid false positives from generic year references in code comments
  // (e.g. "// year suffixes: '(2025-2026)', 'Spring 2026', 'Start September 2026'"),
  // we only flag when the date appears near USER-ADDRESSED prose ("you finish",
  // "your degree", "your MSc") or alongside a school name from the candidate's CV.
  // Generic code comments with month+year are NOT flagged.
  for (const date of pd.graduationDates) {
    const datePattern = escapeRegex(date).replace('\\s+', '[\\s]');
    // Neighbors that imply user-specific context (second-person prose or school name)
    const userAddressedNeighbors = [
      'you\\s+finish\\b',
      'you\\s+graduate\\b',
      'you\\s+complete\\b',
      '\\byour\\s+(?:degree|MSc|master|MBA|program|studies)\\b',
      '\\byour\\s+(?:CEMS|exchange|thesis)\\b',
      'your\\s+next\\s+degree',
      ...pd.schools.map(escapeRegex),
    ];
    patterns.push({
      id: `grad_date_${slugify(date)}`,
      regex: buildProximityRegex(datePattern, userAddressedNeighbors, 120),
      description: `Graduation date "${date}" hardcoded in user-addressed prose`,
      severity: 'error',
    });
  }

  return patterns;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Build a regex that matches `anchor` only if within `windowChars` of any of `neighbors`.
 * Returns a RegExp that matches a window of text containing both anchor and neighbor.
 */
function buildProximityRegex(anchor, neighbors, windowChars) {
  const alt = neighbors.map(n => `(?:${n})`).join('|');
  // Two alternatives: neighbor before anchor, or anchor before neighbor
  const any = `[\\s\\S]`;
  const w = `{1,${windowChars}}`;
  return new RegExp(
    `(?:(?:${alt})${any}${w}(?:${anchor})|(?:${anchor})${any}${w}(?:${alt}))`,
    'i'
  );
}

// ── Scope: which files to scan ───────────────────────────────────────────────

const SYSTEM_LAYER_DIRS = [
  'modes',
  'scripts',
  'templates',
  'frontend/src',
];

// Tracked root-level docs that are system layer per the Data Contract but live
// OUTSIDE any scanned dir — CLAUDE.md and its siblings. Without these the guard
// had a blind spot for exactly the files most likely to accrete worked examples
// with the user's real data. Glob-what-exists: only files present are scanned.
const SYSTEM_LAYER_ROOT_FILES = [
  'CLAUDE.md', 'README.md', 'TODO.md', 'DATA_CONTRACT.md',
  'DESIGN-meta.md', 'STRUCTURE.md', 'CONTEXT.md',
];

// batch/ is system layer too, but mostly gitignored (staging, worker output),
// so we can't walk it wholesale. Scan only its handful of tracked files.
const SYSTEM_LAYER_BATCH_FILES = [
  'batch/batch-prompt.md', 'batch/batch-runner.sh', 'batch/README.md',
];

const SYSTEM_LAYER_EXTS = ['.md', '.mjs', '.ts', '.tsx', '.html', '.yml', '.sh'];

/**
 * Files where a pattern match is explicitly allowed.
 * Each entry: { file (path substring), ids (pattern ids or '*') }
 */
const GLOBAL_ALLOWLIST_ENTRIES = [
  // package.json author field — legitimate project metadata, not AI context
  { file: 'package.json', ids: ['full_name', 'email'] },
  // test-all.mjs itself references user data for the leak patterns list
  { file: 'test-all.mjs', ids: '*' },
  // hygiene-guard.mjs itself (this file) references patterns in code/strings
  { file: 'hygiene-guard.mjs', ids: '*' },
  // hygiene-guard.test.mjs uses real values as test fixtures
  { file: 'hygiene-guard.test.mjs', ids: '*' },
  // DATA_CONTRACT.md documents the data model (mentions field names, not values)
  { file: 'DATA_CONTRACT.md', ids: '*' },
  // CLAUDE.md uses the user's school as an anti-pattern EXAMPLE (to illustrate what not to do)
  // The exact quote "Your Esade MSc + CEMS dual-degree + Sabadell capstone" is in the
  // "Anti-patterns to refuse" section — it's a cautionary example, not hardcoded behavior.
  // We still flag it as a warn so maintainers stay aware, but do not error on it.
  // (Handled by severity downgrade in the scanner, not a full skip)
];

/**
 * Line-level allowlist: if a line contains this marker it's explicitly approved.
 */
const LINE_ALLOWLIST_MARKER = '// hygiene-guard:allow';
const LINE_ALLOWLIST_MARKER_MD = '<!-- hygiene-guard:allow -->';

// ── Scanner ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ file: string, line: number, lineText: string, pattern: object }} Violation
 */

/**
 * Scan system-layer files for personal data patterns.
 *
 * @param {{ root: string, verbose?: boolean }} opts
 * @returns {{ violations: Violation[], warnings: Violation[] }}
 */
export async function runHygieneGuard({ root, verbose = false }) {
  const pd = extractPersonalData(root);
  const patterns = buildPatterns(pd);

  if (verbose) {
    console.log('[hygiene-guard] Personal data extracted:');
    console.log('  name:', pd.fullName);
    console.log('  email:', pd.email);
    console.log('  phone:', pd.phone);
    console.log('  schools:', pd.schools);
    console.log('  employers:', pd.employers);
    console.log('  graduationDates:', pd.graduationDates);
    console.log(`[hygiene-guard] ${patterns.length} patterns active`);
  }

  const violations = [];
  const warnings = [];

  // Build the full set of absolute paths to scan: every file under the system
  // dirs, PLUS the tracked root-level docs and batch/ files that exist.
  const filesToScan = [];
  for (const dir of SYSTEM_LAYER_DIRS) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    filesToScan.push(...walkFiles(absDir, SYSTEM_LAYER_EXTS, ['node_modules', '.next', 'dist', '__pycache__']));
  }
  for (const rel of [...SYSTEM_LAYER_ROOT_FILES, ...SYSTEM_LAYER_BATCH_FILES]) {
    const abs = join(root, rel);
    if (existsSync(abs)) filesToScan.push(abs);
  }

  for (const absFile of filesToScan) {
    const relFile = relative(root, absFile);
    const content = readFileSafe(absFile);
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip lines with explicit allowlist marker
      if (line.includes(LINE_ALLOWLIST_MARKER) || line.includes(LINE_ALLOWLIST_MARKER_MD)) continue;

      for (const pat of patterns) {
        if (!pat.regex.test(line)) continue;

        // Check global allowlist
        const allowed = GLOBAL_ALLOWLIST_ENTRIES.some(entry => {
          if (!relFile.includes(entry.file)) return false;
          return entry.ids === '*' || entry.ids.includes(pat.id);
        });

        // CLAUDE.md gets severity downgraded to warn (see comment above) — now
        // that root docs are scanned, this branch is live: a real-data example
        // in CLAUDE.md surfaces as a warning, not an error, and not silently.
        let severity = pat.severity;
        if (relFile === 'CLAUDE.md') severity = 'warn';

        const hit = { file: relFile, line: i + 1, lineText: line.trim(), pattern: pat };

        if (!allowed) {
          if (severity === 'error') violations.push(hit);
          else warnings.push(hit);
        } else if (verbose) {
          console.log(`[hygiene-guard] allowed: ${relFile}:${i + 1} (${pat.id})`);
        }
      }
    }
  }

  return { violations, warnings, personalData: pd, patterns };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('hygiene-guard.mjs')) {
  const { dirname: _dirname } = await import('path');
  const { fileURLToPath: _ftu } = await import('url');
  const { argv } = process;

  const rootArg = argv.indexOf('--root');
  const root = rootArg !== -1 ? argv[rootArg + 1] : join(_dirname(_ftu(import.meta.url)), '..', '..');
  const verbose = argv.includes('--verbose');

  const { violations, warnings } = await runHygieneGuard({ root, verbose });

  if (violations.length === 0 && warnings.length === 0) {
    console.log('[hygiene-guard] ✅  No personal data found in system layer.');
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`[hygiene-guard] ❌  ${v.file}:${v.line} — ${v.pattern.description}`);
    if (verbose) console.error(`     Line: ${v.lineText.slice(0, 120)}`);
  }
  for (const w of warnings) {
    console.warn(`[hygiene-guard] ⚠️   ${w.file}:${w.line} — ${w.pattern.description}`);
    if (verbose) console.warn(`     Line: ${w.lineText.slice(0, 120)}`);
  }

  console.log(`\n${violations.length} violation(s), ${warnings.length} warning(s).`);
  process.exit(violations.length > 0 ? 1 : 0);
}

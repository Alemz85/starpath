#!/usr/bin/env node
// company-research.mjs — locate, inspect, and validate the deep-research
// artifacts under data/companies/{slug}.md.
//
// modes/deep.md writes these files; modes/interview-prep.md and
// modes/contacto.md read them. This CLI is the single accessor so the cache
// logic (slug → path → freshness) lives in one place instead of being
// re-derived in prose by every mode. All parsing is in lib/company-research-core.mjs.
//
// Usage:
//   node scripts/company-research.mjs path "Trade Republic"
//       → prints the artifact path for a company name
//   node scripts/company-research.mjs check "Trade Republic"
//       → freshness verdict + schema validation for one company
//   node scripts/company-research.mjs check "Trade Republic" --json
//       → machine-readable verdict (for the frontend / other scripts)
//   node scripts/company-research.mjs list
//       → table of every cached company with age + state
//   node scripts/company-research.mjs list --stale
//       → only artifacts that are stale / missing-date / invalid-date
//
// Exit codes (check): 0 fresh+valid, 1 missing file, 2 stale, 3 invalid schema.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugify,
  artifactPath,
  freshness,
  validateArtifact,
  parseFrontmatter,
} from './lib/company-research-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPANIES_DIR = path.join(ROOT, 'data', 'companies');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readArtifact(name) {
  const rel = artifactPath(name);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { rel, abs, exists: false, content: null };
  return { rel, abs, exists: true, content: fs.readFileSync(abs, 'utf8') };
}

function cmdPath(name) {
  if (!name) {
    console.error('usage: company-research.mjs path "<company>"');
    process.exit(2);
  }
  console.log(artifactPath(name));
}

function cmdCheck(name, { json }) {
  if (!name) {
    console.error('usage: company-research.mjs check "<company>" [--json]');
    process.exit(2);
  }
  const slug = slugify(name);
  const { rel, exists, content } = readArtifact(name);

  if (!exists) {
    const out = { company: name, slug, path: rel, exists: false, state: 'missing' };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(`✗ ${name} — no artifact at ${rel} (run deep mode to create it)`);
    process.exit(1);
  }

  const v = validateArtifact(content, { expectedSlug: slug });
  const f = freshness(v.frontmatter, today());

  const out = {
    company: v.frontmatter.company || name,
    slug,
    path: rel,
    exists: true,
    state: f.state,
    ageDays: f.ageDays,
    valid: v.ok,
    errors: v.errors,
    warnings: v.warnings,
    sources: v.frontmatter.sources ? Number(v.frontmatter.sources) : null,
    confidence: v.frontmatter.confidence || null,
    role: v.frontmatter.role || null,
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const mark = !v.ok ? '✗' : f.state === 'fresh' ? '✓' : '○';
    console.log(`${mark} ${out.company} — ${f.reason}  [${rel}]`);
    for (const e of v.errors) console.log(`    error:   ${e}`);
    for (const w of v.warnings) console.log(`    warning: ${w}`);
    if (f.state === 'fresh' && v.ok) console.log('    → reusable: consumers may skip re-research');
    else if (f.state === 'stale') console.log('    → stale: re-run deep mode before reuse');
  }

  if (!v.ok) process.exit(3);
  if (f.state !== 'fresh') process.exit(2);
  process.exit(0);
}

function cmdList({ staleOnly, json }) {
  if (!fs.existsSync(COMPANIES_DIR)) {
    if (json) console.log('[]');
    else console.log('No data/companies/ directory yet.');
    return;
  }
  const files = fs
    .readdirSync(COMPANIES_DIR)
    .filter((f) => f.endsWith('.md'));

  const rows = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const content = fs.readFileSync(path.join(COMPANIES_DIR, file), 'utf8');
    const fm = parseFrontmatter(content);
    const v = validateArtifact(content, { expectedSlug: slug });
    const f = freshness(fm, today());
    rows.push({
      slug,
      company: fm.company || slug,
      cached: fm.cached || null,
      ageDays: f.ageDays,
      state: f.state,
      valid: v.ok,
      sources: fm.sources ? Number(fm.sources) : null,
    });
  }

  rows.sort((a, b) => (b.ageDays ?? 1e9) - (a.ageDays ?? 1e9));
  const filtered = staleOnly ? rows.filter((r) => r.state !== 'fresh' || !r.valid) : rows;

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (!filtered.length) {
    console.log(staleOnly ? 'All cached company research is fresh.' : 'No cached company research yet.');
    return;
  }

  const mark = (r) => (!r.valid ? '✗' : r.state === 'fresh' ? '✓' : '○');
  console.log('  Company                          Age    State');
  console.log('  ' + '─'.repeat(54));
  for (const r of filtered) {
    const age = r.ageDays == null ? '  –' : `${String(r.ageDays).padStart(3)}d`;
    console.log(`${mark(r)} ${r.company.padEnd(32).slice(0, 32)} ${age}  ${r.state}`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const json = flags.has('--json');

  switch (cmd) {
    case 'path':
      return cmdPath(args[0]);
    case 'check':
      return cmdCheck(args[0], { json });
    case 'list':
      return cmdList({ staleOnly: flags.has('--stale'), json });
    default:
      console.error('Commands: path <company> | check <company> [--json] | list [--stale] [--json]');
      process.exit(2);
  }
}

main();

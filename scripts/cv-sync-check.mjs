#!/usr/bin/env node

/**
 * cv-sync-check.mjs — Validates that the career-ops setup is consistent.
 *
 * Checks:
 * 1. cv.md exists
 * 2. user/profile.yml exists and has required fields
 * 3. No hardcoded metrics in _shared.md or batch/batch-prompt.md
 * 4. user/article-digest.md freshness (if exists)
 * 5. Story-bank health (count + STAR+R completeness + quantified results)
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseStoryBank, bankHealth } from './lib/story-bank.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

const warnings = [];
const errors = [];

// 1. Check cv.md exists
const cvPath = join(projectRoot, 'user/cv.md');
if (!existsSync(cvPath)) {
  errors.push('user/cv.md not found. Create it with your CV in markdown format.');
} else {
  const cvContent = readFileSync(cvPath, 'utf-8');
  if (cvContent.trim().length < 100) {
    warnings.push('user/cv.md seems too short. Make sure it contains your full CV.');
  }
}

// 2. Check profile.yml exists
const profilePath = join(projectRoot, 'config', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('user/profile.yml not found. Copy from config/profile.example.yml and fill in your details.');
} else {
  const profileContent = readFileSync(profilePath, 'utf-8');
  const requiredFields = ['full_name', 'email', 'location'];
  for (const field of requiredFields) {
    if (!profileContent.includes(field) || profileContent.includes(`"Jane Smith"`)) {
      warnings.push(`user/profile.yml may still have example data. Check field: ${field}`);
      break;
    }
  }
}

// 3. Check for hardcoded metrics in prompt files
const filesToCheck = [
  { path: join(projectRoot, 'modes', '_shared.md'), name: '_shared.md' },
  { path: join(projectRoot, 'batch', 'batch-prompt.md'), name: 'batch-prompt.md' },
];

// Pattern: numbers that look like hardcoded metrics (e.g., "170+ hours", "90% self-service")
const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/gi;

for (const { path, name } of filesToCheck) {
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf-8');

  // Skip lines that are clearly instructions (contain "NEVER hardcode" etc.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('NEVER hardcode') || line.includes('NUNCA hardcode') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const matches = line.match(metricPattern);
    if (matches) {
      warnings.push(`${name}:${i + 1} — Possible hardcoded metric: "${matches[0]}". Should this be read from user/cv.md or user/article-digest.md?`);
    }
  }
}

// 4. Check user/article-digest.md freshness
const digestPath = join(projectRoot, 'user/article-digest.md');
if (existsSync(digestPath)) {
  const stats = statSync(digestPath);
  const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (daysSinceModified > 30) {
    warnings.push(`user/article-digest.md is ${Math.round(daysSinceModified)} days old. Consider updating if your projects have new metrics.`);
  }
}

// 5. Check story bank health
const storyBankPath = join(projectRoot, 'interview-prep', 'story-bank.md');
if (!existsSync(storyBankPath)) {
  warnings.push('interview-prep/story-bank.md not found. Run /career-ops interview-prep on a few roles to build up STAR+R stories.');
} else {
  const storyContent = readFileSync(storyBankPath, 'utf-8');
  const stories = parseStoryBank(storyContent);
  const health = bankHealth(stories);

  if (health.count < 3) {
    warnings.push(`interview-prep/story-bank.md has only ${health.count} stor${health.count === 1 ? 'y' : 'ies'}. Aim for 5+ to cover common behavioral question themes.`);
  }
  // Incomplete stories (missing STAR+R beats) weaken reuse in apply.md /
  // interview-prep.md — a story with no Result/Reflection can't anchor a
  // recruiter-worthy answer. Surface up to 5 so the user can fix them.
  if (health.incomplete.length > 0) {
    const sample = health.incomplete
      .slice(0, 5)
      .map((s) => `"${s.title}" (missing: ${s.missing.join(', ')})`)
      .join('; ');
    warnings.push(`interview-prep/story-bank.md has ${health.incomplete.length} incomplete stor${health.incomplete.length === 1 ? 'y' : 'ies'} (see templates/story-bank.template.md for the STAR+R contract): ${sample}`);
  }
  // Complete stories whose Result has no number read as vague. Flag them.
  if (health.unquantified.length > 0) {
    warnings.push(`interview-prep/story-bank.md has ${health.unquantified.length} stor${health.unquantified.length === 1 ? 'y' : 'ies'} with an unquantified Result (lead with a number): ${health.unquantified.slice(0, 5).map((t) => `"${t}"`).join(', ')}`);
  }
}

// Output results
console.log('\n=== career-ops sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  WARN: ${w}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);

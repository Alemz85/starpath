#!/usr/bin/env node
/**
 * mock-interview.mjs — predict the likely interview questions for a company+role,
 * map each to the candidate's best-fit STAR+R story, and flag the competencies
 * with no covering story. The starting point for modes/mock-interview.md's
 * practice loop.
 *
 * Strictly READ-ONLY over canonical data. It reads:
 *   • interview-prep/story-bank.md     — the candidate's STAR+R stories
 *   • data/companies/{slug}.md         — deep-research artifact (if fresh): its
 *                                        `## Interview Style` section seeds the
 *                                        interview-shape detection. Optional.
 * and never mutates anything.
 *
 * All prediction / matching / gap logic lives in the pure, unit-tested
 * scripts/lib/mock-interview-core.mjs (which composes on lib/story-bank.mjs's
 * taxonomy + ranker). This file is only I/O + rendering.
 *
 * Candidate specifics (archetypes, role) come from the args / user files at
 * runtime — nothing about the candidate is baked into the code.
 *
 * Usage:
 *   node scripts/mock-interview.mjs predict "<Company>" "<Role>" [--archetype "<name>"]... [--json]
 *   node scripts/mock-interview.mjs predict "Acme" "Strategy Analyst" --archetype "Strategy & Operations"
 *   node scripts/mock-interview.mjs predict "Acme" "Data Analyst" --max 6 --json
 *
 * Flags:
 *   --archetype "<name>"   add an archetype signal (repeatable). If omitted, only
 *                          the role title drives competency emphasis.
 *   --max <n>              cap behavioral questions (default 8)
 *   --json                 machine-readable output (for the frontend / the agent)
 *
 * Exit codes: 0 ok, 2 usage error.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { parseStoryBank } from './lib/story-bank.mjs';
import {
  slugify,
  parseFrontmatter,
  freshness,
} from './lib/company-research-core.mjs';
import {
  predictQuestions,
  matchQuestionsToStories,
  predictedCompetencyGaps,
  _resetQuestionIds,
} from './lib/mock-interview-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANK_FILE = join(ROOT, 'interview-prep', 'story-bank.md');
const COMPANIES_DIR = join(ROOT, 'data', 'companies');

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ── CLI parsing ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const archetypes = [];
let asJson = false;
let maxBehavioral = 8;

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') asJson = true;
  else if (a === '--archetype') archetypes.push(argv[++i]);
  else if (a === '--max') maxBehavioral = Number(argv[++i]) || 8;
  else if (a.startsWith('--')) { /* ignore unknown flag */ }
  else positional.push(a);
}

if (cmd !== 'predict' || positional.length < 1) {
  console.error('usage: mock-interview.mjs predict "<Company>" "<Role>" [--archetype "<name>"]... [--max N] [--json]');
  process.exit(2);
}

const company = positional[0];
const role = positional[1] || '';

/* ── read the story bank ──────────────────────────────────────────────────── */

let stories = [];
let bankExists = false;
if (existsSync(BANK_FILE)) {
  bankExists = true;
  stories = parseStoryBank(readFileSync(BANK_FILE, 'utf8'));
}

/* ── read the company artifact's Interview Style (optional, fresh only) ───── */

// Pull just the `## {heading}` section out of a deep-research artifact: the body
// lines between that heading and the next `## ` (or end of file). Returns '' when
// the heading is absent, so shape detection simply yields no tags.
function extractSection(content, heading) {
  const lines = String(content || '').split('\n');
  const isH2 = (l) => /^##\s+/.test(l);
  const body = [];
  let inSection = false;
  for (const l of lines) {
    if (isH2(l)) {
      const title = l.replace(/^##\s+/, '').trim();
      if (inSection) break; // next section reached
      if (title === heading) { inSection = true; continue; }
    } else if (inSection) {
      body.push(l);
    }
  }
  return body.join('\n').trim();
}

let interviewStyle = '';
let researchNote = 'none — no cached deep research';
const artifactPath = join(COMPANIES_DIR, `${slugify(company)}.md`);
if (existsSync(artifactPath)) {
  const content = readFileSync(artifactPath, 'utf8');
  const fm = parseFrontmatter(content);
  const f = freshness(fm, today());
  if (f.state === 'fresh') {
    interviewStyle = extractSection(content, 'Interview Style');
    researchNote = `data/companies/${slugify(company)}.md (cached ${f.ageDays}d ago)`;
  } else {
    researchNote = `data/companies/${slugify(company)}.md (${f.state}) — re-run deep mode; Interview Style not used`;
  }
}

/* ── predict + match + gaps ───────────────────────────────────────────────── */

_resetQuestionIds();
const { questions, shape, emphasis } = predictQuestions({
  roleTitle: role,
  archetypes: archetypes.map((name) => ({ name })),
  interviewStyle,
  maxBehavioral,
});
const matched = matchQuestionsToStories(questions, stories, { limit: 2 });
const gaps = predictedCompetencyGaps(questions, stories);

/* ── JSON output ──────────────────────────────────────────────────────────── */

if (asJson) {
  console.log(JSON.stringify({
    company,
    role,
    archetypes,
    researched: today(),
    deepResearch: researchNote,
    bankExists,
    storyCount: stories.length,
    interviewShape: [...shape],
    emphasis,
    questions: matched.map((m) => ({
      id: m.question.id,
      text: m.question.text,
      competency: m.question.competency,
      category: m.question.category,
      source: m.question.source,
      bestFit: m.bestFit,
      gap: m.gap,
      matches: m.matches.map((x) => ({
        title: x.story.title,
        fit: x.fit,
        viaCompetency: x.viaCompetency,
      })),
    })),
    gaps,
  }, null, 2));
  process.exit(0);
}

/* ── human-readable report ────────────────────────────────────────────────── */

const line = (s = '') => console.log(s);

line(`Mock interview — ${company}${role ? ` — ${role}` : ''}`);
line(`  Deep research: ${researchNote}`);
line(`  Story bank: ${bankExists ? `${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}` : 'none yet (every question will be a gap)'}`);
if (shape.size) line(`  Interview shape: ${[...shape].join(', ')}`);
line(`  Competency emphasis: ${emphasis.slice(0, 5).join(' › ')} …`);
line();

const fitMark = (m) => (m.gap ? 'GAP ' : m.bestFit === 'strong' ? 'OK  ' : 'part');
line('Likely questions  (fit = best matching story)');
line('  ' + '─'.repeat(64));
for (const m of matched) {
  const comp = m.question.competency ? `[${m.question.competency}]` : `[${m.question.category}]`;
  line(`  ${fitMark(m)} ${m.question.text}`);
  const tag = m.question.source === 'inferred' ? 'inferred' : m.question.source;
  if (m.matches.length) {
    line(`        ${comp} → ${m.matches[0].story.title}${m.matches[0].viaCompetency ? '' : ' (adjacent)'}   (${tag})`);
  } else {
    line(`        ${comp} → no story covers this   (${tag})`);
  }
}

if (gaps.length) {
  line();
  line(`${gaps.length} competenc${gaps.length === 1 ? 'y' : 'ies'} tested but with no story — build these before the interview:`);
  for (const g of gaps) {
    line(`  · ${g.label} (${g.questions.length} question${g.questions.length === 1 ? '' : 's'})`);
  }
}

line();
line('Practice: run modes/mock-interview.md to go through these one at a time with critique.');
process.exit(0);

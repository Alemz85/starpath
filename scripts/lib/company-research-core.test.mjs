/**
 * company-research-core.test.mjs — characterization suite for the deep-research
 * artifact contract (data/companies/{slug}.md): slugging, frontmatter parsing,
 * the 30-day freshness window, section presence, and schema validation.
 *
 * The artifact is consumed by interview-prep and contacto, so the schema must
 * not drift silently — these tests pin the contract.
 *
 * Run: node --test scripts/lib/company-research-core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESH_DAYS,
  SECTIONS,
  REQUIRED_KEYS,
  slugify,
  artifactPath,
  parseFrontmatter,
  daysBetween,
  freshness,
  presentSections,
  validateArtifact,
} from './company-research-core.mjs';

const TODAY = '2026-06-25';

// ── slugify ──────────────────────────────────────────────────────────────
test('slugify lowercases and hyphenates spaces', () => {
  assert.equal(slugify('Trade Republic'), 'trade-republic');
});

test('slugify strips diacritics', () => {
  assert.equal(slugify('Société Générale'), 'societe-generale');
});

test('slugify collapses punctuation runs and trims edges', () => {
  assert.equal(slugify('  N26 (Berlin)!! '), 'n26-berlin');
  assert.equal(slugify('Booking.com'), 'booking-com');
});

test('slugify handles empty / nullish input', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('artifactPath places file under data/companies', () => {
  assert.equal(artifactPath('Trade Republic'), 'data/companies/trade-republic.md');
});

// ── parseFrontmatter ─────────────────────────────────────────────────────
test('parses flat key: value frontmatter', () => {
  const md = [
    '---',
    'company: Acme Corp',
    'slug: acme-corp',
    'cached: 2026-06-01',
    'sources: 7',
    '---',
    '',
    '## Business Model',
    'body',
  ].join('\n');
  const fm = parseFrontmatter(md);
  assert.equal(fm.company, 'Acme Corp');
  assert.equal(fm.slug, 'acme-corp');
  assert.equal(fm.cached, '2026-06-01');
  assert.equal(fm.sources, '7');
});

test('parseFrontmatter unquotes values and skips comments/blanks', () => {
  const md = ['---', '# a comment', 'company: "Quoted Co"', "role: 'PM'", '', '---'].join('\n');
  const fm = parseFrontmatter(md);
  assert.equal(fm.company, 'Quoted Co');
  assert.equal(fm.role, 'PM');
  assert.equal(fm['# a comment'], undefined);
});

test('parseFrontmatter returns {} when no fence present', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading\nno frontmatter'), {});
  assert.deepEqual(parseFrontmatter(''), {});
});

test('parseFrontmatter ignores values with colons in them gracefully', () => {
  const fm = parseFrontmatter('---\nnote: see https://example.com/x\n---');
  assert.equal(fm.note, 'see https://example.com/x');
});

// ── daysBetween / freshness ──────────────────────────────────────────────
test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-06-01', '2026-06-25'), 24);
  assert.equal(daysBetween('2026-06-25', '2026-06-25'), 0);
});

test('daysBetween is NaN for garbage dates', () => {
  assert.ok(Number.isNaN(daysBetween('not-a-date', TODAY)));
});

test('freshness: under window → fresh', () => {
  const f = freshness({ cached: '2026-06-01' }, TODAY); // 24d
  assert.equal(f.state, 'fresh');
  assert.equal(f.ageDays, 24);
});

test('freshness: exactly at window boundary → stale', () => {
  // FRESH_DAYS is exclusive: age === FRESH_DAYS is stale.
  const cached = new Date(Date.parse(`${TODAY}T00:00:00Z`) - FRESH_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  const f = freshness({ cached }, TODAY);
  assert.equal(f.ageDays, FRESH_DAYS);
  assert.equal(f.state, 'stale');
});

test('freshness: 1 day inside window → fresh', () => {
  const cached = new Date(Date.parse(`${TODAY}T00:00:00Z`) - (FRESH_DAYS - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  assert.equal(freshness({ cached }, TODAY).state, 'fresh');
});

test('freshness: missing date', () => {
  assert.equal(freshness({}, TODAY).state, 'missing-date');
});

test('freshness: invalid date', () => {
  assert.equal(freshness({ cached: 'soon' }, TODAY).state, 'invalid-date');
});

// ── presentSections ──────────────────────────────────────────────────────
test('presentSections finds canonical headings only', () => {
  const md = [
    '## Business Model',
    'x',
    '## Recent Signals',
    'y',
    '## Not A Canonical Section',
    'z',
  ].join('\n');
  const present = presentSections(md);
  assert.deepEqual(present, ['Business Model', 'Recent Signals']);
});

test('presentSections requires the ## level, not ### or inline', () => {
  assert.deepEqual(presentSections('### Business Model\ntext about Business Model'), []);
});

// ── validateArtifact ─────────────────────────────────────────────────────
function fullArtifact(overrides = {}) {
  const fm = {
    company: 'Acme Corp',
    slug: 'acme-corp',
    cached: TODAY,
    ...overrides,
  };
  const fmBlock =
    '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n';
  const body = SECTIONS.map((s) => `## ${s}\nplaceholder\n`).join('\n');
  return fmBlock + body;
}

test('validateArtifact: complete artifact is ok with no warnings', () => {
  const v = validateArtifact(fullArtifact(), { expectedSlug: 'acme-corp' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.missingSections, []);
  assert.deepEqual(v.warnings, []);
});

test('validateArtifact: missing required keys are errors', () => {
  const md = '---\ncompany: Acme\n---\n## Business Model\nx';
  const v = validateArtifact(md, { expectedSlug: 'acme' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('slug')));
  assert.ok(v.errors.some((e) => e.includes('cached')));
});

test('validateArtifact: slug mismatch is an error', () => {
  const v = validateArtifact(fullArtifact({ slug: 'wrong-slug' }), { expectedSlug: 'acme-corp' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('slug mismatch')));
});

test('validateArtifact: missing sections are warnings, not errors', () => {
  const md = '---\ncompany: Acme\nslug: acme\ncached: ' + TODAY + '\n---\n## Business Model\nx';
  const v = validateArtifact(md, { expectedSlug: 'acme' });
  assert.equal(v.ok, true); // frontmatter complete → ok
  assert.ok(v.warnings.some((w) => w.includes('missing sections')));
  assert.ok(v.missingSections.includes('Talking Points'));
});

test('REQUIRED_KEYS and SECTIONS are stable contract surfaces', () => {
  assert.deepEqual(REQUIRED_KEYS, ['company', 'slug', 'cached']);
  assert.equal(SECTIONS.length, 8);
  assert.ok(SECTIONS.includes('Interview Style'));
  assert.ok(SECTIONS.includes('Compensation Hints'));
});

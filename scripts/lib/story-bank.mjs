// story-bank.mjs — pure parsing/selection logic for interview-prep/story-bank.md.
//
// The story bank is the candidate's accumulated set of STAR+R stories. It is the
// preferred source for two conversion surfaces:
//   - modes/interview-prep.md (behavioral-question → story mapping)
//   - modes/apply.md          (application form answers + cover letters)
//
// Both surfaces, and cv-sync-check.mjs, need to agree on ONE on-disk format. This
// module owns that contract: it parses the markdown into structured records and
// exposes selection helpers (theme matching, coverage gaps, dedup-by-title) so the
// drafting agents reuse stories instead of regenerating prose from scratch.
//
// All functions are pure (no I/O, no globals, no input mutation). The CLI / agent
// owns reading the file; this module owns what a story *means*. Mirrors the
// extract-then-test pattern of lib/tracker-core.mjs and lib/scouting-core.mjs.
//
// ── THE FORMAT CONTRACT ──────────────────────────────────────────────────────
// Each story is a top-level `### {Title}` heading (so cv-sync-check.mjs's
// `^### ` story counter stays correct). Under it, the five STAR+R beats are
// bold-labeled lines, plus an optional `**Themes:**` tag line:
//
//   ### Rescued the migration deadline
//   **Themes:** ownership, conflict, delivery-under-pressure
//   **Situation:** ...
//   **Task:** ...
//   **Action:** ...
//   **Result:** ...   (lead with the number)
//   **Reflection:** ...
//
// `**Themes:**` is a comma-separated tag list used for question→story matching.
// Labels are matched case-insensitively and tolerate `R+` / `Result & Reflection`
// style variants so hand-edited banks still parse.

/* ───── canonical beats ──────────────────────────────────────────── */

// The five STAR+R beats, in canonical order. `reflection` is the "+R" — the
// learning/so-what that separates a strong story from a rote one.
export const STAR_BEATS = ['situation', 'task', 'action', 'result', 'reflection'];

// Beat-label aliases → canonical key. Hand-edited banks drift; tolerate it.
const BEAT_ALIASES = {
  situation: 'situation',
  context: 'situation',
  task: 'task',
  challenge: 'task',
  goal: 'task',
  action: 'action',
  actions: 'action',
  approach: 'action',
  result: 'result',
  results: 'result',
  outcome: 'result',
  impact: 'result',
  reflection: 'reflection',
  learning: 'reflection',
  takeaway: 'reflection',
  'so what': 'reflection',
};

/* ───── title normalization (dedup key) ──────────────────────────── */

// Two story titles collide when they normalize to the same key: lowercase,
// collapse whitespace, strip surrounding markdown emphasis and trailing
// punctuation. interview-prep.md's "never create a duplicate title" rule and
// apply.md's reuse both key off this.
export function storyTitleKey(title) {
  if (title == null) return '';
  return String(title)
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/[.:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/* ───── theme/tag normalization ──────────────────────────────────── */

// A theme tag normalizes by lowercasing and collapsing internal whitespace and
// dashes/underscores so "delivery-under-pressure" and "delivery under pressure"
// match. Returns '' for empty input.
export function normalizeTheme(theme) {
  if (theme == null) return '';
  return String(theme)
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/[\s_-]+/g, ' ')
    .toLowerCase();
}

function parseThemeLine(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((t) => normalizeTheme(t))
    .filter(Boolean);
}

/* ───── parsing ──────────────────────────────────────────────────── */

// Strip a leading `**Label:**` / `Label:` from a line and return
// { label, rest } when present, else { label: null, rest: line }.
function splitLabeledLine(line) {
  // Markdown puts emphasis either side of the colon:
  //   **Result:** rest   |   **Result & Reflection**: rest   |   Result: rest
  // So allow an optional `**`/`__` run both before the colon AND right after it.
  const m = line.match(
    /^\s*(?:\*\*|__)?\s*([A-Za-z][A-Za-z &/+]*?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*(?:\*\*|__)?\s*$/,
  );
  if (!m) return { label: null, rest: line };
  return { label: m[1].trim(), rest: m[2] };
}

// Map a raw beat label (possibly "Result & Reflection", "R+", "Actions") to a
// canonical beat key, or null if it's not a beat label.
function canonicalBeat(rawLabel) {
  if (!rawLabel) return null;
  const key = rawLabel.replace(/[&/+]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (BEAT_ALIASES[key]) return BEAT_ALIASES[key];
  // Try first word (handles "Result and Reflection" → result; "Action items" → action)
  const first = key.split(' ')[0];
  return BEAT_ALIASES[first] || null;
}

// Parse a single `### ...` story block (heading line + body lines) into a record.
function parseStoryBlock(title, bodyLines) {
  const story = {
    title: title.trim(),
    titleKey: storyTitleKey(title),
    themes: [],
    situation: '',
    task: '',
    action: '',
    result: '',
    reflection: '',
  };

  let currentBeat = null; // accumulate wrapped lines onto the last-seen beat

  for (const rawLine of bodyLines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      currentBeat = null; // blank line ends a beat's continuation
      continue;
    }
    const { label, rest } = splitLabeledLine(line);

    if (label) {
      const labelKey = label.toLowerCase();
      if (labelKey === 'themes' || labelKey === 'theme' || labelKey === 'tags' || labelKey === 'tag') {
        story.themes.push(...parseThemeLine(rest));
        currentBeat = null;
        continue;
      }
      const beat = canonicalBeat(label);
      if (beat) {
        story[beat] = story[beat] ? `${story[beat]} ${rest}`.trim() : rest.trim();
        currentBeat = beat;
        continue;
      }
    }

    // Non-labeled line: continuation of the current beat (wrapped prose / bullets).
    if (currentBeat) {
      story[currentBeat] = `${story[currentBeat]} ${line.trim()}`.trim();
    }
  }

  // Dedup themes, preserve first-seen order.
  const seen = new Set();
  story.themes = story.themes.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));

  return story;
}

// Parse the full story-bank.md content into an array of story records. Only
// `### ` headings are treated as stories (matching cv-sync-check.mjs); `#` and
// `##` are document title / section headers and are ignored.
export function parseStoryBank(content) {
  if (!content) return [];
  const lines = content.split('\n');
  const stories = [];

  let curTitle = null;
  let curBody = [];
  let inFence = false; // inside a ``` / ~~~ fenced code block

  const flush = () => {
    if (curTitle != null) stories.push(parseStoryBlock(curTitle, curBody));
    curTitle = null;
    curBody = [];
  };

  for (const line of lines) {
    // Toggle fenced-code state. Headings inside a fence are format-contract
    // examples (see templates/story-bank.template.md), not real stories.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (curTitle != null) curBody.push(line);
      continue;
    }
    if (inFence) {
      if (curTitle != null) curBody.push(line);
      continue;
    }

    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      flush();
      curTitle = h3[1];
      curBody = [];
      continue;
    }
    // A higher-level heading (## or #) ends the current story block.
    if (/^#{1,2}\s+/.test(line)) {
      flush();
      continue;
    }
    if (curTitle != null) curBody.push(line);
  }
  flush();

  return stories;
}

/* ───── completeness ──────────────────────────────────────────────── */

// A story is "complete" when all five STAR+R beats are non-empty. The
// reflection beat is what most banks skip, so it's surfaced explicitly.
export function storyMissingBeats(story) {
  return STAR_BEATS.filter((b) => !story[b] || !String(story[b]).trim());
}

export function isStoryComplete(story) {
  return storyMissingBeats(story).length === 0;
}

// A result beat is "quantified" if it contains a digit (a number, %, €/$, a
// count, a multiple). apply.md / interview-prep.md want results to lead with a
// number; this flags rote results that don't.
export function resultIsQuantified(story) {
  return /\d/.test(String(story.result || ''));
}

/* ───── selection ─────────────────────────────────────────────────── */

// Tokenize a free-text question/topic into normalized words (drop stopwords and
// 1-2 char tokens). Used to match a question against story themes + body text.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'about',
  'tell', 'me', 'give', 'your', 'you', 'when', 'how', 'what', 'time', 'example',
  'describe', 'was', 'were', 'did', 'do', 'is', 'are', 'that', 'this', 'have',
  'had', 'has', 'they', 'their', 'it', 'at', 'as', 'by', 'be',
]);

export function tokenizeQuestion(text) {
  if (!text) return [];
  const norm = normalizeTheme(text);
  return norm
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Score how well a story matches a question/topic. Theme hits are weighted
// heaviest (the candidate explicitly tagged them), then title hits, then body
// hits. Returns a number ≥ 0; 0 means no overlap.
export function scoreStoryForQuestion(story, question) {
  const tokens = tokenizeQuestion(question);
  if (!tokens.length) return 0;

  const themeText = (story.themes || []).join(' ');
  const titleText = normalizeTheme(story.title || '');
  const bodyText = normalizeTheme(
    STAR_BEATS.map((b) => story[b] || '').join(' '),
  );

  let score = 0;
  for (const tok of tokens) {
    if (themeText.includes(tok)) score += 3;
    else if (titleText.includes(tok)) score += 2;
    else if (bodyText.includes(tok)) score += 1;
  }
  return score;
}

// Rank stories by fit for a question. Returns [{ story, score, fit }] sorted
// desc, dropping zero-score stories. `fit` is a coarse label the agent can paste
// into the interview-prep mapping table.
export function rankStoriesForQuestion(stories, question, { limit = 3 } = {}) {
  const ranked = (stories || [])
    .map((story) => {
      const score = scoreStoryForQuestion(story, question);
      let fit = 'none';
      if (score >= 3) fit = 'strong';
      else if (score >= 1) fit = 'partial';
      return { story, score, fit };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return limit ? ranked.slice(0, limit) : ranked;
}

// Given the bank and a list of themes a target role/JD wants covered (e.g.
// ["leadership", "conflict", "ambiguity"]), report which themes have no
// matching story — the coverage gaps the candidate should build stories for.
export function coverageGaps(stories, wantedThemes) {
  const have = new Set();
  for (const s of stories || []) {
    for (const t of s.themes || []) have.add(t);
  }
  return (wantedThemes || [])
    .map((t) => normalizeTheme(t))
    .filter(Boolean)
    .filter((t) => {
      if (have.has(t)) return false;
      // Also count a partial token overlap in any theme as "covered".
      for (const h of have) {
        if (h.includes(t) || t.includes(h)) return false;
      }
      return true;
    });
}

// Find an existing story whose title collides with `title` (dedup-by-title).
// Returns the existing story or null. Backs interview-prep.md's "update, never
// duplicate" rule and apply.md's reuse.
export function findStoryByTitle(stories, title) {
  const key = storyTitleKey(title);
  return (stories || []).find((s) => s.titleKey === key) || null;
}

// One-shot health summary for cv-sync-check.mjs and the agent: counts, the
// incomplete stories (with which beats they miss), and unquantified results.
export function bankHealth(stories) {
  const list = stories || [];
  const incomplete = list
    .map((s) => ({ title: s.title, missing: storyMissingBeats(s) }))
    .filter((s) => s.missing.length > 0);
  const unquantified = list
    .filter((s) => isStoryComplete(s) && !resultIsQuantified(s))
    .map((s) => s.title);
  const allThemes = new Set();
  for (const s of list) for (const t of s.themes || []) allThemes.add(t);
  return {
    count: list.length,
    complete: list.filter(isStoryComplete).length,
    incomplete,
    unquantified,
    themes: [...allThemes].sort(),
  };
}

/* ───── competency taxonomy ────────────────────────────────────────── */
//
// The story bank's `**Themes:**` tags are free text (the candidate writes
// whatever language fits). But interview-prep.md Step 5 wants a *deterministic*
// question→story map: classify a likely question to a known competency, then
// look up which stories cover it. That needs a shared vocabulary on both sides.
//
// COMPETENCIES is that vocabulary — the universal behavioral-interview landscape
// large employers (FAANG, MBB, Big-4, top scaleups) actually screen for. This is
// legitimate system reference data (cf. CLAUDE.md § System Layer Hygiene — like
// the school-region map, it's the universal landscape, NOT one user's tags).
//
// `aliases` lets a candidate's natural-language theme ("led a team",
// "delivery-under-pressure") normalize to a canonical competency id, so the
// existing free-text `themes` field doubles as competency tagging — no new
// on-disk field, the `### {Title}` + `**Themes:**` format stays exactly as the
// canonical bank, apply.md, and cv-sync-check.mjs already expect it.

export const COMPETENCIES = [
  { id: 'ownership',     label: 'Ownership / Drive',            aliases: ['ownership', 'drive', 'bias for action', 'initiative', 'proactivity', 'self starter', 'autonomy', 'delivery under pressure'] },
  { id: 'leadership',    label: 'Leadership / Influence',       aliases: ['leadership', 'led a team', 'leading', 'influence', 'influence without authority', 'stakeholder management', 'managing up', 'mentoring', 'mentorship'] },
  { id: 'collaboration', label: 'Collaboration / Teamwork',     aliases: ['collaboration', 'teamwork', 'cross functional', 'working with others', 'partnership'] },
  { id: 'conflict',      label: 'Conflict / Disagreement',      aliases: ['conflict', 'disagreement', 'pushback', 'difficult conversation', 'difficult stakeholder', 'tension'] },
  { id: 'failure',       label: 'Failure / Resilience',         aliases: ['failure', 'mistake', 'setback', 'resilience', 'recovered from', 'things went wrong'] },
  { id: 'ambiguity',     label: 'Ambiguity / Judgment',         aliases: ['ambiguity', 'ambiguous', 'uncertainty', 'incomplete information', 'judgment', 'decision making', 'tradeoff'] },
  { id: 'analytical',    label: 'Analytical / Problem-Solving', aliases: ['analytical', 'problem solving', 'data driven', 'data driven decision', 'quantitative', 'analysis'] },
  { id: 'impact',        label: 'Impact / Results',             aliases: ['impact', 'results', 'delivered', 'business value', 'roi', 'outcome', 'metrics moved'] },
  { id: 'communication', label: 'Communication',                aliases: ['communication', 'presenting', 'storytelling', 'persuasion', 'explaining', 'executive communication'] },
  { id: 'customer',      label: 'Customer / User Focus',        aliases: ['customer', 'customer focus', 'customer obsession', 'user focus', 'client', 'user empathy'] },
  { id: 'learning',      label: 'Learning / Growth',            aliases: ['learning', 'growth', 'learned a new', 'learning new domain', 'upskilling', 'curiosity', 'feedback', 'self improvement'] },
  { id: 'innovation',    label: 'Innovation / Creativity',      aliases: ['innovation', 'creativity', 'novel', 'invented', 'reimagined', 'from scratch', 'greenfield'] },
];

// alias/id → canonical id. Aliases are stored already theme-normalized so a
// lookup uses the same normalization as parsed themes.
const COMPETENCY_ALIAS_TO_ID = (() => {
  const m = new Map();
  for (const c of COMPETENCIES) {
    m.set(c.id, c.id);
    for (const a of c.aliases) m.set(normalizeTheme(a), c.id);
  }
  return m;
})();

// Normalize a free-text theme/tag to a canonical competency id, or null if it
// maps to none. Tries: exact id, exact (normalized) alias, then substring
// containment (longest alias wins, so "stakeholder management" beats a bare
// "management" miss). A null result is not an error — it just means the tag is
// an extra freeform note the taxonomy doesn't recognize.
export function normalizeCompetency(tag) {
  if (tag == null) return null;
  const t = normalizeTheme(tag);
  if (!t) return null;
  if (COMPETENCY_ALIAS_TO_ID.has(t)) return COMPETENCY_ALIAS_TO_ID.get(t);
  let best = null;
  let bestLen = 0;
  for (const [alias, id] of COMPETENCY_ALIAS_TO_ID) {
    if (alias.length > bestLen && (t.includes(alias) || alias.includes(t))) {
      best = id;
      bestLen = alias.length;
    }
  }
  return best;
}

// Resolve a story's free-text `themes` into { competencies, unknownThemes }:
// the canonical competency ids the story credibly covers (deduped, bank order)
// and the themes that mapped to no competency (kept as honest freeform notes).
export function storyCompetencies(story) {
  const resolved = [];
  const unknown = [];
  for (const t of (story && story.themes) || []) {
    const id = normalizeCompetency(t);
    if (id) resolved.push(id);
    else unknown.push(t);
  }
  return { competencies: [...new Set(resolved)], unknownThemes: unknown };
}

/* ───── validation ─────────────────────────────────────────────────── */

// Validate one story against the STAR+R contract + competency tagging.
// Returns { ok, errors, warnings }.
//   errors   (block a clean bank): missing/empty STAR+R beat, no recognized
//            competency theme.
//   warnings (allowed but flagged): a theme that maps to no competency, a
//            placeholder-length beat, a complete-but-unquantified Result.
export function validateStory(story) {
  const errors = [];
  const warnings = [];

  if (!story || !story.title || !String(story.title).trim()) {
    errors.push('missing title');
  }

  for (const beat of STAR_BEATS) {
    const v = String((story && story[beat]) || '').trim();
    if (!v) {
      errors.push(`missing ${beat}`);
    } else if (v.length < 12) {
      warnings.push(`${beat} looks like a placeholder (under 12 chars): "${v}"`);
    }
  }

  const { competencies, unknownThemes } = storyCompetencies(story || {});
  if (competencies.length === 0) {
    errors.push('no recognized competency theme (add a "**Themes:**" line with a known competency)');
  }
  for (const u of unknownThemes) {
    warnings.push(`theme "${u}" maps to no canonical competency`);
  }

  if (story && isStoryComplete(story) && !resultIsQuantified(story)) {
    warnings.push('Result has no number — lead with a metric');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Detect duplicate story titles (normalized via storyTitleKey). interview-prep's
// dedup rule: never add a second story with the same title — update the existing
// one. Returns [{ title, count, indices }] for each collision.
export function findDuplicateTitles(stories) {
  const byKey = new Map();
  (stories || []).forEach((s, i) => {
    const key = storyTitleKey(s.title);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, { title: s.title, count: 0, indices: [] });
    const e = byKey.get(key);
    e.count++;
    e.indices.push(i);
  });
  return [...byKey.values()].filter((e) => e.count > 1);
}

/* ───── competency coverage ────────────────────────────────────────── */

// Build a competency-id → [story titles] index across the bank. This is what
// makes interview-prep Step 5 deterministic: given a likely question's
// competency, look up the covering stories instead of re-reasoning over the
// whole bank. Every canonical competency gets an entry (empty array = a gap),
// and a story keys a competency via its free-text themes resolving to it.
export function buildCompetencyIndex(stories) {
  const index = {};
  for (const c of COMPETENCIES) index[c.id] = [];
  for (const s of stories || []) {
    const { competencies } = storyCompetencies(s);
    for (const id of competencies) {
      if (!index[id]) index[id] = [];
      index[id].push(s.title);
    }
  }
  return index;
}

// Competencies with no covering story — the candidate's behavioral blind spots.
// Returns [{ id, label }] for each gap, in canonical taxonomy order.
export function competencyGaps(stories) {
  const index = buildCompetencyIndex(stories);
  return COMPETENCIES
    .filter((c) => (index[c.id] || []).length === 0)
    .map((c) => ({ id: c.id, label: c.label }));
}

// Rank stories for a question by competency first, then the free-text scorer.
// `question` is the raw likely-question text; `competency` (optional) is a
// pre-classified canonical id. A story covering the target competency gets a
// heavy boost so the deterministic competency map dominates the fuzzy token
// overlap. Returns [{ story, score, fit, viaCompetency }] sorted desc.
export function rankStoriesByCompetency(stories, question, competency = null, { limit = 3 } = {}) {
  const compId = competency ? normalizeCompetency(competency) : null;
  const ranked = (stories || [])
    .map((story) => {
      const { competencies } = storyCompetencies(story);
      const viaCompetency = compId ? competencies.includes(compId) : false;
      const textScore = scoreStoryForQuestion(story, question);
      const score = (viaCompetency ? 5 : 0) + textScore;
      let fit = 'none';
      if (viaCompetency || score >= 3) fit = 'strong';
      else if (score >= 1) fit = 'partial';
      return { story, score, fit, viaCompetency };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return limit ? ranked.slice(0, limit) : ranked;
}

// Whole-bank validation rollup for check-story-bank.mjs and the agent:
//   { ok, storyCount, perStory: [{ title, ...validateStory }],
//     duplicates, gaps, index }
// `ok` ignores warnings (errors + duplicate titles only); the CLI's --strict
// flag is what escalates warnings to a non-zero exit.
export function validateBank(stories) {
  const list = stories || [];
  const perStory = list.map((s) => ({ title: s.title, ...validateStory(s) }));
  const duplicates = findDuplicateTitles(list);
  const gaps = competencyGaps(list);
  const index = buildCompetencyIndex(list);
  const ok = perStory.every((s) => s.ok) && duplicates.length === 0;
  return { ok, storyCount: list.length, perStory, duplicates, gaps, index };
}

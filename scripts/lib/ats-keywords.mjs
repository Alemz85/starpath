/**
 * ats-keywords.mjs — deterministic ATS keyword extraction + coverage scoring.
 *
 * The CV-tailoring flow (modes/pdf.md) claims to produce an "ATS-optimized"
 * CV and to report "% keyword coverage", but until now that number was
 * eyeballed by the agent. This module makes it measurable:
 *
 *   1. extractKeywords(jdText)  → the terms an ATS is likely to weight,
 *      ranked by frequency, as unigrams + bigrams, stopword-filtered.
 *   2. analyzeCoverage(jdText, cvText)  → which of those terms the CV
 *      actually surfaces, a coverage %, and the gap list.
 *
 * It is pure (no I/O), language-aware for EN + ES (the two CV languages the
 * template supports), and contains NO user-specific data — only generic
 * stopwords and a small generic skills lexicon used to boost recall of
 * multi-word technical phrases. The candidate's actual skills/keywords are
 * always read from the JD and CV at call time, never hardcoded.
 *
 * Matching is "stem-lite": case-folded, punctuation-stripped, and reduced to
 * a small set of suffix-normalized forms so "designing" matches "design" and
 * "pipelines" matches "pipeline" without pulling in a full stemmer dependency.
 */

// ── Stopwords (generic, EN + ES) ───────────────────────────────────────────
// Common function words + recruiting boilerplate that carry no ATS signal.
const STOPWORDS = new Set([
  // English function words
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'for', 'from', 'has', 'have', 'had', 'he', 'her', 'his', 'i', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'us',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with',
  'you', 'your', 'yours', 'about', 'above', 'after', 'all', 'also', 'any',
  'because', 'before', 'both', 'can', 'could', 'do', 'does', 'each', 'how',
  'if', 'may', 'more', 'most', 'must', 'no', 'not', 'only', 'other', 'out',
  'over', 'per', 'should', 'some', 'such', 'up', 'via', 'while', 'would',
  // Spanish function words
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de',
  'del', 'al', 'en', 'con', 'por', 'para', 'que', 'se', 'su', 'sus', 'es',
  'son', 'como', 'lo', 'le', 'les', 'este', 'esta', 'estos', 'estas',
  'ser', 'estar', 'tener', 'hacer', 'más', 'pero', 'nos', 'sobre',
  // Recruiting boilerplate that bloats every JD without being a real keyword
  'role', 'job', 'position', 'work', 'working', 'team', 'teams', 'company',
  'looking', 'join', 'help', 'helping', 'across', 'within', 'including',
  'etc', 'ability', 'strong', 'good', 'great', 'excellent', 'plus', 'years',
  'year', 'experience', 'experienced', 'candidate', 'candidates', 'ideal',
  'responsibilities', 'requirements', 'preferred', 'required', 'qualifications',
  'opportunity', 'benefits', 'apply', 'applicant', 'new', 'well', 'using',
  'use', 'used', 'like', 'others', 'world', 'global', 'office',
  'remote', 'hybrid', 'fulltime', 'full', 'time', 'part',
  'need', 'needs', 'needed', 'skill', 'skills', 'want', 'wants', 'seeking',
  'seek', 'love', 'passionate', 'background', 'knowledge', 'understanding',
  'including', 'etc', 'able', 'every', 'day', 'days', 'one', 'two', 'three',
  'get', 'got', 'make', 'made', 'making', 'take', 'takes', 'come', 'go',
  'here', 'now', 'just', 'really', 'very', 'much', 'many', 'few', 'lot',
  'hiring', 'hire', 'partner', 'partners', 'partnering', 'build', 'builds',
]);

// Generic multi-word technical/role phrases worth recognising as single units.
// This is landscape reference data (not one user's skill list): it only makes
// the extractor treat e.g. "machine learning" as one keyword instead of two.
// It does NOT add skills the JD doesn't mention — a phrase only counts if it
// literally appears in the JD text.
const KNOWN_PHRASES = [
  'machine learning', 'deep learning', 'data science', 'data analysis',
  'data analytics', 'data engineering', 'business intelligence',
  'natural language processing', 'computer vision', 'artificial intelligence',
  'large language models', 'product management', 'project management',
  'stakeholder management', 'business development', 'go to market',
  'supply chain', 'financial modeling', 'financial modelling',
  'risk management', 'continuous integration', 'continuous delivery',
  'version control', 'cloud computing', 'distributed systems',
  'software engineering', 'web development', 'mobile development',
  'user experience', 'user research', 'a/b testing', 'unit testing',
  'time series', 'predictive modeling', 'predictive modelling',
  'credit scoring', 'public speaking', 'team leadership', 'cross functional',
  'problem solving', 'critical thinking', 'attention to detail',
];

// ── Tokenisation ───────────────────────────────────────────────────────────

/**
 * Lower-case, keep intra-word symbols that matter for tech terms
 * (c++, c#, node.js, ci/cd, a/b), split on everything else.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    // protect a few symbol-bearing tech tokens before stripping punctuation
    .replace(/c\+\+/g, 'cplusplus')
    .replace(/c#/g, 'csharp')
    .replace(/\.net/g, 'dotnet')
    .replace(/[^a-z0-9áéíóúñü/.+-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, '')) // trim edge punctuation
    .map((t) => (t === 'cplusplus' ? 'c++' : t === 'csharp' ? 'c#' : t === 'dotnet' ? '.net' : t))
    .filter(Boolean);
}

/**
 * Stem-lite: fold a token to a comparison key so light morphological variants
 * collide. Deliberately conservative — handles the common English/Spanish
 * plural + gerund + simple verb endings without over-stemming short words.
 */
export function stemLite(token) {
  let t = token.toLowerCase();
  if (t.length <= 3) return t;

  // Gerund/participle: designing → design, building → build.
  if (t.endsWith('ing') && t.length > 5) {
    t = t.slice(0, -3);
    // collapse a doubled final consonant (shipping → shipp → ship)
    if (t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
    return t;
  }
  // Past tense: shipped → ship, designed → design.
  if (t.endsWith('ed') && t.length > 4) {
    t = t.slice(0, -2);
    if (t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
    return t;
  }
  // Plurals / 3rd-person -s. Strip a single trailing 's' (not 'ss'); this folds
  // "pipelines"→"pipeline", "models"→"model", "designs"→"design". The "-ies"→"y"
  // case ("policies"→"policy") needs the two-char form.
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && t.length > 3) {
    return t.slice(0, -1);
  }
  return t;
}

function isStopword(token) {
  return STOPWORDS.has(token) || token.length < 2 || /^\d+$/.test(token);
}

// ── Keyword extraction ─────────────────────────────────────────────────────

/**
 * Extract ranked keywords from a job description.
 *
 * @param {string} jdText
 * @param {object} [opts]
 * @param {number} [opts.limit=24]   max keywords returned
 * @param {number} [opts.minCount=1] minimum raw frequency to include a unigram
 * @returns {Array<{term: string, count: number, type: 'unigram'|'bigram'|'phrase'}>}
 *          ranked by a relevance score (frequency, with multi-word phrases and
 *          earlier-appearing terms lightly boosted).
 */
export function extractKeywords(jdText, opts = {}) {
  const { limit = 24, minCount = 1 } = opts;
  if (!jdText || !jdText.trim()) return [];

  const lower = jdText.toLowerCase();
  const tokens = tokenize(jdText);

  // 1. Known multi-word phrases that literally appear in the JD.
  const phraseHits = new Map(); // term -> count
  for (const phrase of KNOWN_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const matches = lower.match(re);
    if (matches) phraseHits.set(phrase, matches.length);
  }
  const phraseStemSet = new Set();
  for (const p of phraseHits.keys()) {
    for (const w of p.split(' ')) phraseStemSet.add(stemLite(w));
  }

  // 2. Unigram frequencies (stopword-filtered, stem-folded but keep a display form).
  const uni = new Map(); // stem -> { display, count, firstAt }
  tokens.forEach((tok, idx) => {
    if (isStopword(tok)) return;
    const stem = stemLite(tok);
    if (!uni.has(stem)) uni.set(stem, { display: tok, count: 0, firstAt: idx });
    uni.get(stem).count += 1;
  });

  // 3. Bigrams of consecutive non-stopwords (captures "stakeholder management"
  //    style phrases not in KNOWN_PHRASES).
  const bi = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (isStopword(a) || isStopword(b)) continue;
    if (stemLite(a) === stemLite(b)) continue; // a repeated word isn't a phrase
    const term = `${a} ${b}`;
    if (!bi.has(term)) bi.set(term, { count: 0, firstAt: i });
    bi.get(term).count += 1;
  }

  const total = tokens.length || 1;
  const scored = [];

  for (const [term, c] of phraseHits) {
    scored.push({ term, count: c, type: 'phrase', score: c * 3 + 2 });
  }
  for (const [, v] of uni) {
    if (v.count < minCount) continue;
    // skip unigrams already represented inside a captured phrase
    if (phraseStemSet.has(stemLite(v.display))) continue;
    const positionBoost = 1 - v.firstAt / total; // earlier ≈ more important
    scored.push({ term: v.display, count: v.count, type: 'unigram', score: v.count + positionBoost });
  }
  for (const [term, v] of bi) {
    if (v.count < 2) continue; // a bigram needs to recur to be a real phrase
    if (phraseHits.has(term)) continue;
    scored.push({ term, count: v.count, type: 'bigram', score: v.count * 2 + 1 });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

  // de-dupe: drop a unigram if a higher-ranked multiword term already covers it
  const out = [];
  const seenStems = new Set();
  for (const k of scored) {
    if (k.type === 'unigram' && seenStems.has(stemLite(k.term))) continue;
    out.push({ term: k.term, count: k.count, type: k.type });
    for (const s of k.term.split(' ')) seenStems.add(stemLite(s));
    if (out.length >= limit) break;
  }
  return out;
}

// ── Coverage analysis ──────────────────────────────────────────────────────

/**
 * Build a set of stem-folded tokens + bigrams present in a CV text, for
 * O(1) membership testing during coverage.
 */
function buildCvIndex(cvText) {
  const tokens = tokenize(cvText);
  const stems = new Set(tokens.map(stemLite));
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${stemLite(tokens[i])} ${stemLite(tokens[i + 1])}`);
  }
  return { stems, bigrams, raw: cvText.toLowerCase() };
}

/**
 * Is a keyword (uni/bi/phrase) present in the CV index?
 * Multi-word terms match if their consecutive stem-bigram is present OR the
 * raw phrase appears verbatim; unigrams match on stem membership.
 */
function keywordPresent(term, idx) {
  const parts = term.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return idx.stems.has(stemLite(parts[0]));
  // verbatim phrase match first (handles 3+ word phrases)
  if (idx.raw.includes(term.toLowerCase())) return true;
  // else require every adjacent pair to exist as a stem-bigram
  for (let i = 0; i < parts.length - 1; i++) {
    if (!idx.bigrams.has(`${stemLite(parts[i])} ${stemLite(parts[i + 1])}`)) return false;
  }
  return true;
}

/**
 * Analyze how well a CV covers the keywords of a JD.
 *
 * @param {string} jdText
 * @param {string} cvText  plain text of the CV (HTML should be stripped first;
 *                         see htmlToText()).
 * @param {object} [opts]  forwarded to extractKeywords (limit, minCount).
 * @returns {{
 *   coverage: number,                 // 0..1 fraction of keywords present
 *   coveragePct: number,              // rounded percentage
 *   weightedCoverage: number,         // 0..1 weighted by keyword frequency
 *   total: number,
 *   covered: Array<{term,count,type}>,
 *   missing: Array<{term,count,type}>,
 *   keywords: Array<{term,count,type,present:boolean}>
 * }}
 */
export function analyzeCoverage(jdText, cvText, opts = {}) {
  const keywords = extractKeywords(jdText, opts);
  const idx = buildCvIndex(cvText || '');

  const annotated = keywords.map((k) => ({ ...k, present: keywordPresent(k.term, idx) }));
  const covered = annotated.filter((k) => k.present);
  const missing = annotated.filter((k) => !k.present);

  const total = annotated.length;
  const coverage = total ? covered.length / total : 0;

  const weightTotal = annotated.reduce((s, k) => s + k.count, 0) || 1;
  const weightCovered = covered.reduce((s, k) => s + k.count, 0);
  const weightedCoverage = weightCovered / weightTotal;

  return {
    coverage,
    coveragePct: Math.round(coverage * 100),
    weightedCoverage,
    total,
    covered: covered.map(({ present, ...k }) => k),
    missing: missing.map(({ present, ...k }) => k),
    keywords: annotated,
  };
}

// ── HTML → text (for reading a generated CV HTML file) ─────────────────────

/**
 * Strip an HTML document to its visible body text. Removes <style>/<script>,
 * decodes the handful of entities that show up in CVs, collapses whitespace.
 * Good enough for keyword coverage — not a full HTML parser.
 */
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

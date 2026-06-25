// cv-gap.mjs — pure CV-vs-target-landscape gap analysis.
//
// The CV (user/cv.md) is the one asset that goes out with every application,
// yet nothing checks it against where the user is actually aiming. The ATS
// coverage tool (scripts/ats-coverage.mjs) answers "does this CV cover THIS
// one JD?". The targeting analyzer (scripts/lib/targeting-core.mjs) answers
// "which scoring dimension drags across the landscape?". Neither answers the
// question this module is for:
//
//   "Across ALL the roles I keep evaluating, what does my CV systematically
//    fail to surface — and where are my proof points soft?"
//
// It aggregates demand across many evaluated roles (not a single JD), folds in
// the dimension-drag signal, and emits an honest, actionable gap report:
//
//   1. keywordGaps   — terms in demand across N roles that the CV never
//                      surfaces, ranked by how many roles demand them.
//   2. weakProof     — CV result/impact bullets with no quantified outcome
//                      (a number, %, €/$, ×, or time delta), the proof-point
//                      weakness recruiters notice first.
//   3. dimensionGaps — the systematically low scoring dimensions, lifted
//                      straight from targeting-core's dimensionDrag.
//   4. recommendations — a few concrete "add / quantify / learn" moves.
//
// PURE: no I/O, no globals, no mutation of inputs. The thin file/CLI wrapper
// lives in scripts/cv-gap.mjs. NO user data is hardcoded — the CV, the demand
// documents, and the score history are all passed in by the caller, who reads
// them from user/* + data/* at runtime.
//
// Reuses (imports, never modifies):
//   - extractKeywords / stemLite / htmlToText from ./ats-keywords.mjs
//   - dimensionDrag (+ DIMENSIONS) from ./targeting-core.mjs

import { extractKeywords, stemLite, htmlToText } from './ats-keywords.mjs';
import { dimensionDrag } from './targeting-core.mjs';

export { htmlToText };

/* ───── CV text → searchable stem index ─────────────────────────────────────
 *
 * We reuse ats-keywords' stemLite so a CV that says "designed pipelines"
 * matches a demand keyword of "design pipeline". The index is the set of
 * stem-folded unigrams plus consecutive stem-bigrams present in the CV, mirror
 * of ats-keywords' private buildCvIndex (re-implemented here so we don't reach
 * into that module's internals — it only exports the JD-coverage entry points).
 */
function tokenizeWords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/c\+\+/g, 'cplusplus')
    .replace(/c#/g, 'csharp')
    .replace(/\.net/g, 'dotnet')
    .replace(/[^a-z0-9áéíóúñü/.+-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .map((t) => (t === 'cplusplus' ? 'c++' : t === 'csharp' ? 'c#' : t === 'dotnet' ? '.net' : t))
    .filter(Boolean);
}

export function buildCvIndex(cvText) {
  const tokens = tokenizeWords(cvText || '');
  const stems = new Set(tokens.map(stemLite));
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${stemLite(tokens[i])} ${stemLite(tokens[i + 1])}`);
  }
  return { stems, bigrams, raw: (cvText || '').toLowerCase() };
}

/**
 * Is a (uni/bi/multi-word) term present in the CV index? Multi-word terms
 * match on a verbatim substring OR every adjacent stem-bigram being present;
 * unigrams match on stem membership. Same matching contract as ats-keywords.
 */
export function termInCv(term, idx) {
  const parts = String(term).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return idx.stems.has(stemLite(parts[0]));
  if (idx.raw.includes(term.toLowerCase())) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!idx.bigrams.has(`${stemLite(parts[i])} ${stemLite(parts[i + 1])}`)) return false;
  }
  return true;
}

/* ───── Demand aggregation across the evaluated landscape ────────────────────
 *
 * Each "demand document" is the text of one evaluated role — a report body, a
 * stored JD, or any blob that carries that role's vocabulary. We run the SAME
 * keyword extractor used for single-JD ATS coverage on each document, then
 * tally, per keyword, in how many DISTINCT roles it appears (documentFrequency)
 * — the landscape-level signal a single JD can't give. A term demanded by 1 of
 * 30 roles is noise; a term demanded by 18 of 30 is a real, systematic ask.
 */

/**
 * @param {string[]} demandDocs   one text blob per evaluated role
 * @param {object}  [opts]
 * @param {number}  [opts.perDocLimit=24]  keywords extracted per role doc
 * @returns {Array<{term, type, documentFrequency, totalCount, share}>}
 *   ranked by documentFrequency (then raw frequency), where share is the
 *   fraction of roles that demand the term.
 */
export function aggregateDemand(demandDocs, opts = {}) {
  const { perDocLimit = 24 } = opts;
  const docs = (demandDocs || []).filter((d) => d && d.trim());
  const nDocs = docs.length;
  if (nDocs === 0) return [];

  // term key (stem-folded) -> aggregate; keep a human display form + type.
  const agg = new Map();
  for (const doc of docs) {
    const kws = extractKeywords(doc, { limit: perDocLimit });
    // de-dupe within a single doc by stem key so one role counts a term once.
    const seenInDoc = new Set();
    for (const kw of kws) {
      const key = kw.term.split(/\s+/).map(stemLite).join(' ');
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      if (!agg.has(key)) {
        agg.set(key, { term: kw.term, type: kw.type, documentFrequency: 0, totalCount: 0 });
      }
      const e = agg.get(key);
      e.documentFrequency += 1;
      e.totalCount += kw.count;
      // prefer a multi-word display form over a unigram for the same key
      if (kw.term.includes(' ') && !e.term.includes(' ')) {
        e.term = kw.term;
        e.type = kw.type;
      }
    }
  }

  return [...agg.values()]
    .map((e) => ({ ...e, share: Math.round((e.documentFrequency / nDocs) * 100) }))
    .sort(
      (a, b) =>
        b.documentFrequency - a.documentFrequency ||
        b.totalCount - a.totalCount ||
        a.term.localeCompare(b.term),
    );
}

/* ───── Keyword gaps — demanded terms the CV never surfaces ─────────────────
 *
 * Intersect aggregated demand with the CV index. A gap is a term in demand
 * across at least `minRoles` evaluated roles that the CV does not surface in
 * any form. Ranked by documentFrequency so the most systematic omissions sit
 * at the top — those are the terms worth adding (if the user genuinely has the
 * experience) or learning (if they don't).
 */
export function keywordGaps(cvText, demandDocs, opts = {}) {
  const { minRoles = 2, perDocLimit = 24, limit = 30 } = opts;
  const demand = aggregateDemand(demandDocs, { perDocLimit });
  const idx = buildCvIndex(cvText);
  const totalRoles = (demandDocs || []).filter((d) => d && d.trim()).length;

  const annotated = demand.map((d) => ({ ...d, present: termInCv(d.term, idx) }));
  const gaps = annotated
    .filter((d) => !d.present && d.documentFrequency >= minRoles)
    .slice(0, limit)
    .map(({ present, ...d }) => d);
  const covered = annotated.filter((d) => d.present);

  return {
    totalRoles,
    demandTerms: demand.length,
    coveredTerms: covered.length,
    // share of distinct demanded terms the CV already surfaces
    coveragePct: demand.length ? Math.round((covered.length / demand.length) * 100) : 0,
    gaps,
  };
}

/* ───── Weak proof points — result bullets with no quantified outcome ────────
 *
 * Recruiters skim for numbers. A bullet that says "improved onboarding" is
 * weaker than "cut onboarding time 40%". We scan CV bullet lines that read like
 * an ACHIEVEMENT (an action/impact verb) and flag the ones with NO quantified
 * outcome (a number, %, currency, multiplier, or explicit time delta).
 *
 * Deliberately conservative — we only flag lines that look like results, so we
 * don't nag about section headers, skills lists, or descriptive context. The
 * action-verb lexicon is generic résumé language, not user-specific.
 */
const IMPACT_VERBS = [
  'led', 'built', 'launched', 'shipped', 'delivered', 'drove', 'grew',
  'increased', 'reduced', 'cut', 'saved', 'improved', 'boosted', 'scaled',
  'accelerated', 'streamlined', 'optimized', 'optimised', 'automated',
  'designed', 'developed', 'created', 'implemented', 'managed', 'owned',
  'achieved', 'generated', 'raised', 'expanded', 'decreased', 'lowered',
  'won', 'closed', 'secured', 'spearheaded', 'established', 'launched',
  'transformed', 'doubled', 'tripled', 'eliminated',
];
const IMPACT_VERB_STEMS = new Set(IMPACT_VERBS.map(stemLite));

// Quantified-outcome signals: a digit, a percentage word, a currency symbol/
// word, a multiplier (3x), or an explicit magnitude word (thousand/million/k).
const QUANT_RE =
  /(\d|\bpercent\b|%|[€$£]|\beur\b|\busd\b|\bk\b|\bthousand\b|\bmillion\b|\bbillion\b|\bx\b|\bhrs?\b|\bhours?\b|\bweeks?\b|\bmonths?\b|\bdays?\b)/i;

/**
 * Pull bullet-like lines out of a markdown CV. A bullet starts with -, *, •, or
 * a numbered marker; we strip the marker and surrounding markdown emphasis.
 */
export function extractBullets(cvText) {
  if (!cvText) return [];
  const out = [];
  for (const rawLine of cvText.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (!m) continue;
    const text = m[2].replace(/[*_`]/g, '').trim();
    if (text.length >= 12) out.push(text);
  }
  return out;
}

function looksLikeAchievement(bullet) {
  const first = tokenizeWords(bullet).slice(0, 4); // verb is usually up front
  return first.some((w) => IMPACT_VERB_STEMS.has(stemLite(w)));
}

export function isQuantified(bullet) {
  return QUANT_RE.test(bullet);
}

/**
 * Find achievement bullets that carry no quantified outcome.
 * @returns {{ totalBullets, achievementBullets, quantifiedCount, quantifiedPct,
 *            weak: Array<{text}> }}
 */
export function weakProofPoints(cvText, opts = {}) {
  const { limit = 20 } = opts;
  const bullets = extractBullets(cvText);
  const achievements = bullets.filter(looksLikeAchievement);
  const quantified = achievements.filter(isQuantified);
  const weak = achievements
    .filter((b) => !isQuantified(b))
    .slice(0, limit)
    .map((text) => ({ text }));

  return {
    totalBullets: bullets.length,
    achievementBullets: achievements.length,
    quantifiedCount: quantified.length,
    quantifiedPct: achievements.length
      ? Math.round((quantified.length / achievements.length) * 100)
      : 0,
    weak,
  };
}

/* ───── Dimension gaps — systematically low scoring dimensions ───────────────
 *
 * Lifted straight from targeting-core's dimensionDrag: the dimensions that most
 * consistently drag the user's Overall down across the evaluated landscape. We
 * surface only the genuinely low ones (avg below `avgThreshold` OR low in a
 * meaningful share of evals) and attach a CV-oriented hint where the drag is
 * something the CV itself can influence (skills_match) vs. a sourcing/targeting
 * fix the CV can't (ease_of_entry, brand_value).
 */
const DIM_CV_HINT = {
  skills_match:
    'Closest CV lever — surface the in-demand skills you actually have in your CV vocabulary; if the skill is genuinely absent, this is a learn-it gap, not a wording gap.',
  ease_of_entry:
    'Mostly a targeting signal (seniority/qualification mismatch), not a CV-wording fix — tighten which roles you evaluate.',
  strategic_fit:
    'Re-check your scan keywords against your target archetypes; the CV can reinforce the narrative but the drift is in sourcing.',
  growth_mobility: 'Weight sourcing toward higher-growth companies — not a CV fix.',
  optionality_exit: 'Favor roles/companies with broader downstream paths — not a CV fix.',
  brand_value: 'Add stronger target companies to your portals — not a CV fix.',
};

export function dimensionGaps(scoreRows, opts = {}) {
  const { avgThreshold = 6.0, lowShareThreshold = 25 } = opts;
  const drag = dimensionDrag(scoreRows || []);
  return drag
    .filter((d) => d.avg < avgThreshold || d.lowShare >= lowShareThreshold)
    .map((d) => ({
      key: d.key,
      label: d.label,
      avg: d.avg,
      lowShare: d.lowShare,
      count: d.count,
      cvActionable: d.key === 'skills_match',
      hint: DIM_CV_HINT[d.key] || 'Consistently drags your scores down.',
    }));
}

/* ───── Recommendations — a few concrete moves ──────────────────────────────
 *
 * Conservative gates so we don't fire advice on thin data. Each rec carries an
 * impact tag and a reasoning string the CLI/mode prints verbatim.
 */
export function gapRecommendations(report, opts = {}) {
  const { minRolesForKeyword = 3 } = opts;
  const recs = [];
  const { keyword, proof, dimension } = report;

  // 1. Top systematic keyword omissions (only the ones demanded broadly).
  const topGaps = (keyword?.gaps || []).filter((g) => g.documentFrequency >= minRolesForKeyword);
  if (topGaps.length) {
    const terms = topGaps.slice(0, 5).map((g) => `"${g.term}" (${g.documentFrequency} roles)`).join(', ');
    recs.push({
      action: `Surface or close ${topGaps.length} systematically-demanded term(s) missing from your CV: ${terms}`,
      reasoning:
        'These appear across many roles you evaluate but never in your CV. Add them where you genuinely have the experience (in the role’s vocabulary, never invented); where you don’t, that’s a skills gap to close, not a wording fix.',
      impact: topGaps[0].documentFrequency >= Math.max(5, (keyword.totalRoles || 0) * 0.5) ? 'high' : 'medium',
    });
  }

  // 2. Proof-point weakness.
  if (proof && proof.achievementBullets >= 4 && proof.quantifiedPct < 60) {
    recs.push({
      action: `Quantify ${proof.weak.length} result bullet(s) — only ${proof.quantifiedPct}% of your achievement bullets carry a number`,
      reasoning:
        'Recruiters skim for measurable outcomes. Attach a metric (%, €/$, ×, time saved, count) to each impact bullet — pull the real figures from user/article-digest.md, never invent them.',
      impact: proof.quantifiedPct < 40 ? 'high' : 'medium',
    });
  }

  // 3. Skills-match dimension drag (the one dimension the CV can influence).
  const skillsDim = (dimension || []).find((d) => d.key === 'skills_match');
  if (skillsDim) {
    recs.push({
      action: `Address the "Skills Match" drag (landscape avg ${skillsDim.avg}, low in ${skillsDim.lowShare}% of evals)`,
      reasoning: skillsDim.hint,
      impact: 'high',
    });
  }

  // 4. Non-CV dimension drags — flag as targeting, not CV, so the user doesn't
  //    waste time rewording a CV for a problem the CV can't fix.
  const otherDims = (dimension || []).filter((d) => !d.cvActionable);
  if (otherDims.length) {
    const labels = otherDims.map((d) => d.label).join(', ');
    recs.push({
      action: `${labels} drag your scores too, but these are targeting/sourcing fixes — not CV rewrites`,
      reasoning:
        'Don’t rewrite your CV for these. They reflect which roles and companies you evaluate; adjust your scan keywords and portals instead.',
      impact: 'medium',
    });
  }

  return recs;
}

/* ───── Top-level report (consumed by the CLI/mode) ─────────────────────────
 *
 * @param {object} input
 * @param {string} input.cvText                 plain text of user/cv.md
 * @param {string[]} input.demandDocs           one text blob per evaluated role
 * @param {Array}  [input.scoreRows]            parsed score-history rows
 * @param {object} [input.opts]                 thresholds (see sub-functions)
 */
export function analyzeCvGap(input = {}) {
  const { cvText = '', demandDocs = [], scoreRows = [], opts = {} } = input;

  if (!cvText.trim()) {
    return { error: 'No CV text provided. Pass the plain text of user/cv.md.' };
  }
  if ((demandDocs.filter((d) => d && d.trim()).length === 0) && (scoreRows.length === 0)) {
    return {
      error:
        'No target-landscape signal: provide evaluated-role demand documents (reports) and/or score-history rows.',
    };
  }

  const keyword = keywordGaps(cvText, demandDocs, opts.keyword || {});
  const proof = weakProofPoints(cvText, opts.proof || {});
  const dimension = dimensionGaps(scoreRows, opts.dimension || {});

  const report = {
    metadata: {
      analysisDate: new Date().toISOString().split('T')[0],
      rolesAnalyzed: keyword.totalRoles,
      scoreRows: scoreRows.length,
    },
    keyword,
    proof,
    dimension,
  };
  report.recommendations = gapRecommendations(report, opts.recommendations || {});
  return report;
}

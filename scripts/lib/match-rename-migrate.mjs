/**
 * match-rename-migrate.mjs — pure text transforms that carry a workspace's
 * data over the rename of the first scoring axis, "Want", to "Match"
 * (docs/scoring-v2.md). Each transform returns { text, changes } and is a
 * no-op on text that is already migrated, so the migration is safe to repeat.
 *
 *   score-history.tsv   header column `want` → `match`
 *   scouting.md         table header `| Want |` → `| Match |`
 *   applications.md,    score cells `W8.3 E5.6` → `M8.3 E5.6`
 *   pipeline.md,
 *   tracker additions
 *   reports/**.md       header `**Want:**` → `**Match:**`; dimension tags
 *                       `(want)` → `(match)`; `**Want (rollup)**` → `**Match (rollup)**`
 *   profile.yml         `want_weights:` → `match_weights:`, and "Want" in comments
 *   _profile.md         the scoring phrases ("Want floor", "+0.25 Want", "into Want")
 *
 * Plain-English "want" is never touched: every pattern is anchored on the
 * score's own syntax. The CLI is scripts/migrate-match-rename.mjs.
 */

const count = (text, re) => (text.match(re) || []).length

/** data/score-history.tsv: rename the header column; rows are positional. */
export function migrateScoreHistoryText(text) {
  const nl = text.indexOf('\n')
  const head = nl === -1 ? text : text.slice(0, nl)
  const cols = head.split('\t')
  let changes = 0
  const next = cols.map((c) => (c.trim() === 'want' ? (changes++, 'match') : c))
  if (!changes) return { text, changes: 0 }
  return { text: next.join('\t') + (nl === -1 ? '' : text.slice(nl)), changes }
}

/** data/scouting.md: the table header's fifth column. */
export function migrateScoutingText(text) {
  const re = /^(\|\s*#\s*\|\s*Date\s*\|\s*Company\s*\|\s*Role\s*\|\s*)Want(\s*\|)/gm
  const changes = count(text, re)
  return changes ? { text: text.replace(re, '$1Match$2'), changes } : { text, changes: 0 }
}

// A v2 score pair filling a whole table cell or TSV field: `W8.3 E5.6`,
// `**W8 E7.43**`, `W8.3 · E5.6` (the separators parseScoreCell tolerates).
const cellPair = (end) => String.raw`(?:\*\*)?W(?=\d+(?:\.\d+)?\s*[ ·/,]?\s*E\d+(?:\.\d+)?(?:\*\*)?${end})`

/** applications.md / pipeline.md: score cells inside `|` tables. */
export function migrateScoreCellsText(text) {
  const re = new RegExp(String.raw`(\|\s*)(${cellPair(String.raw`\s*\|`)})`, 'g')
  let changes = 0
  const next = text.replace(re, (_, pre, w) => { changes++; return pre + w.replace(/W$/, 'M') })
  return { text: next, changes }
}

/** batch/tracker-additions/*.tsv: score fields between tabs. */
export function migrateTsvScoreCellsText(text) {
  const re = new RegExp(String.raw`(^|\t)(${cellPair(String.raw`(?:\t|$)`)})`, 'gm')
  let changes = 0
  const next = text.replace(re, (_, pre, w) => { changes++; return pre + w.replace(/W$/, 'M') })
  return { text: next, changes }
}

/** A report: the header line and the dimensional table's tags. */
export function migrateReportText(text) {
  let changes = 0
  const sub = (t, re, to) => t.replace(re, (...m) => { changes++; return typeof to === 'function' ? to(...m) : to })
  let next = sub(text, /^\*\*Want:\*\*/gm, '**Match:**')
  next = sub(next, /^(\|[^|\n]*?)\(\s*want\s*\)(\s*\|)/gim, (_, a, b) => `${a}(match)${b}`)
  next = sub(next, /^(\|\s*)(\*\*)?Want \(rollup\)(\*\*)?(\s*\|)/gm, (_, a, b = '', c = '', d) => `${a}${b}Match (rollup)${c}${d}`)
  return { text: next, changes }
}

/** user/profile.yml: the weights key, and the axis name in comments. */
export function migrateProfileYmlText(text) {
  let changes = 0
  const lines = text.split('\n').map((line) => {
    let l = line.replace(/^(\s*)want_weights(\s*:)/, (_, a, b) => { changes++; return `${a}match_weights${b}` })
    const hash = l.indexOf('#')
    if (hash !== -1) {
      const comment = l.slice(hash).replace(/\bWant\b(?! me\b| to\b)/g, () => { changes++; return 'Match' })
      l = l.slice(0, hash) + comment
    }
    return l
  })
  return { text: lines.join('\n'), changes }
}

/** user/_profile.md: only the phrases the scoring system itself writes. */
export function migrateProfileMdText(text) {
  let changes = 0
  const next = text.replace(/\bWant floor\b|\+0\.25 Want\b|\binto Want\b/g, (m) => { changes++; return m.replace('Want', 'Match') })
  return { text: next, changes }
}

/** True when any transform would still change this text (used by doctor). */
export function needsMigration(kind, text) {
  const fn = TRANSFORMS[kind]
  return fn ? fn(String(text ?? '')).changes > 0 : false
}

export const TRANSFORMS = {
  'score-history': migrateScoreHistoryText,
  scouting: migrateScoutingText,
  'score-cells': migrateScoreCellsText,
  'tsv-score-cells': migrateTsvScoreCellsText,
  report: migrateReportText,
  'profile-yml': migrateProfileYmlText,
  'profile-md': migrateProfileMdText,
}

// cv-summary-core.mjs — pure logic behind scripts/cv-summary.mjs.
//
// Deterministically compresses the user's CV (plus a few structural facts
// from their profile YAML) into the compact summary artifact eval workers
// read instead of the full `user/cv.md` (token-cost lever 3, TODO.md).
// No LLM involved: same inputs → same output, so the artifact can be
// refreshed with a plain mtime check.
//
// What it keeps / drops:
//   - Every heading and the bold employer/date lines under them — the CV's
//     skeleton survives intact so section citations stay valid.
//   - Bullet runs are capped per entry (default 4), preferring quantified
//     bullets (ones carrying a digit / % / currency) — proof points beat
//     prose. Kept bullets are copied VERBATIM, so the eval rule "cite exact
//     CV lines" holds against this file exactly as it does against cv.md.
//   - Sections whose heading mentions skills / languages / education /
//     certifications are kept whole — they're dense signal, not prose.
//   - Contact PII (emails, phone numbers) in the pre-section preamble is
//     dropped — eval workers never need it, and the artifact should spread
//     the user's contact details to as few files as possible.
//
// Data-contract note: this module is system layer and contains ZERO user
// data — it only transforms whatever `user/*` content the caller reads at
// run time. The generated artifact (`batch/cv-summary.md`) is derived user
// data and is gitignored.

const VERBATIM_SECTION_RE = /skill|language|education|certification/i
const BULLET_RE = /^\s*[-*]\s+/
const QUANTIFIED_RE = /\d|%|€|\$|£/
const EMAIL_RE = /\S+@\S+\.\S+/
const PHONE_RE = /\+?\d[\d\s().\/-]{7,}\d/

/**
 * Cap a run of consecutive bullet lines to `maxBullets`, preferring
 * quantified bullets (those containing a digit or currency/percent sign)
 * over prose-only ones. Relative order of the kept bullets is preserved.
 */
export function capBulletRun(bullets, maxBullets) {
  if (bullets.length <= maxBullets) return bullets
  const keep = new Set()
  for (let i = 0; i < bullets.length && keep.size < maxBullets; i++) {
    if (QUANTIFIED_RE.test(bullets[i])) keep.add(i)
  }
  for (let i = 0; i < bullets.length && keep.size < maxBullets; i++) keep.add(i)
  return bullets.filter((_, i) => keep.has(i))
}

/**
 * Summarize a markdown CV: keep all headings, cap bullet runs outside the
 * verbatim sections, strip contact PII from the pre-section preamble, and
 * collapse repeated blank lines. Returns markdown ending in one newline.
 */
export function summarizeCv(cvText, { maxBullets = 4 } = {}) {
  const lines = cvText.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let section = ''  // text of the current ## heading ('' = preamble)
  let run = []      // current run of consecutive bullet lines

  const isVerbatim = () => VERBATIM_SECTION_RE.test(section)
  const flush = () => {
    if (run.length === 0) return
    out.push(...(isVerbatim() ? run : capBulletRun(run, maxBullets)))
    run = []
  }

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush()
      section = line
      out.push(line)
      continue
    }
    if (BULLET_RE.test(line)) {
      run.push(line)
      continue
    }
    flush()
    // Contact PII lives in the preamble (above the first ## section) —
    // drop any preamble line carrying an email or phone number.
    if (section === '' && (EMAIL_RE.test(line) || PHONE_RE.test(line))) continue
    out.push(line)
  }
  flush()

  const collapsed = []
  for (const l of out) {
    if (l.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') continue
    collapsed.push(l)
  }
  return collapsed.join('\n').trim() + '\n'
}

// Structural facts worth surfacing from profile.yml — scalar keys that feed
// the eval dimensions directly (visa/work-rights → Ease of Entry, languages
// → language-gate calibration, comp target → Salary Adj context). Output
// order follows this list, not the YAML.
const FACT_KEYS = [
  'nationality',
  'work_permit',
  'visa_status',
  'languages',
  'target_range',
  'location_flexibility',
]

/**
 * Line-based extraction of the FACT_KEYS scalars from a profile YAML text.
 * Deliberately not a YAML parser: scripts/ are zero-dep, and first-occurrence
 * scalar matching is deterministic and sufficient for these keys.
 * Returns [{ key, value }] in FACT_KEYS order (missing keys omitted).
 */
export function extractProfileFacts(profileText) {
  if (!profileText) return []
  const byKey = new Map()
  for (const raw of profileText.replace(/\r\n/g, '\n').split('\n')) {
    const m = raw.match(/^\s*([a-z_]+):\s*(.+?)\s*$/)
    if (!m) continue
    const key = m[1]
    if (!FACT_KEYS.includes(key) || byKey.has(key)) continue
    let value = m[2].replace(/\s+#.*$/, '').trim()
    value = value.replace(/^["']+|["']+$/g, '').trim()
    if (!value || value === '|' || value === '>') continue
    byKey.set(key, value)
  }
  return FACT_KEYS.filter(k => byKey.has(k)).map(k => ({ key: k, value: byKey.get(k) }))
}

export const GENERATED_HEADER = `<!-- GENERATED by scripts/cv-summary.mjs — compact CV summary for eval workers.
     Derived from user/cv.md + user/profile.yml. DO NOT EDIT — regenerate with:
       node scripts/cv-summary.mjs
     Bullets are verbatim CV lines, so anything cited from this file also
     exists word-for-word in user/cv.md. Full detail: user/cv.md. -->`

/**
 * Render the full artifact: generated-file header, candidate facts from the
 * profile (if any), then the summarized CV.
 */
export function renderCvSummary({ cvText, profileText = '', maxBullets = 4 }) {
  const parts = [GENERATED_HEADER, '']
  const facts = extractProfileFacts(profileText)
  if (facts.length > 0) {
    parts.push('## Candidate facts (from user/profile.yml)', '')
    for (const { key, value } of facts) parts.push(`- **${key}:** ${value}`)
    parts.push('')
  }
  parts.push(summarizeCv(cvText, { maxBullets }))
  return parts.join('\n')
}

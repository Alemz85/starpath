// Canonical archetype buckets for the Database tab.
//
// The scan / pipeline / scoring layer writes verbose archetype strings like
// "Strategy & Operations Analyst — Technology Sector" that are useful for
// the AI agents but unreadable in a tight table cell. This helper maps any
// such input to a short, stable bucket label.
//
// Order matters: the most specific patterns come first so e.g. "M&A" wins
// over a generic "Analyst" fallback. The mapping is intentionally
// over-specific in places (Investment Banking, Private Equity, FP&A) so the
// Database can group meaningfully even though scan / pipeline keep their
// long-form labels intact.

const RULES: Array<[RegExp, string]> = [
  // Finance verticals
  [/m\s*&\s*a|mergers\s*&\s*acquisitions/i, 'M&A'],
  [/investment\s*banking|\bib\b\s*analyst/i, 'Investment Banking'],
  [/private\s*equity|\bpe\b\s*analyst/i,    'Private Equity'],
  [/venture\s*capital|\bvc\b\s*analyst/i,   'Venture Capital'],
  [/fp\s*&\s*a|financial\s*planning/i,      'FP&A'],
  [/corporate\s*finance/i,                   'Corporate Finance'],
  [/equity\s*research/i,                     'Equity Research'],
  [/credit\s*analyst|risk\s*analyst/i,      'Credit / Risk'],
  [/financial\s*analyst|finance\s*analyst/i,'Financial Analyst'],

  // Strategy / consulting / ops
  [/management\s*consult|\bmbb\b/i,          'Management Consulting'],
  [/strategy\s*&?\s*op|strat\s*ops/i,       'Strategy & Ops'],
  [/strategy\s*analyst|strategic\s*planning|corporate\s*strategy/i, 'Strategy'],
  [/revenue\s*operations|\brev\s*ops\b/i,    'Revenue Ops'],
  [/operations\s*analyst|ops\s*analyst/i,    'Operations'],
  [/program\s*manager|project\s*manager/i,   'Program Manager'],

  // Data / ML
  [/data\s*scien|machine\s*learning|\bml\b\s*engineer/i, 'Data Scientist'],
  [/analytics\s*engineer|data\s*engineer/i,  'Data Engineer'],
  [/data\s*analyst|business\s*intelligence|\bbi\b\s*analyst/i, 'Data Analyst'],
  [/research\s*scien|applied\s*research/i,   'Research Scientist'],

  // Product
  [/product\s*manager|\bpm\b\s*role/i,        'Product Manager'],
  [/product\s*analyst|product\s*ops/i,        'Product Analyst'],
  [/growth\s*analyst|growth\s*marketing/i,    'Growth'],

  // Business
  [/business\s*analyst/i,                     'Business Analyst'],

  // Engineering / technical
  [/solutions\s*architect|solutions\s*engineer/i, 'Solutions Architect'],
  [/devops|platform\s*engineer|\bsre\b/i,    'Platform / DevOps'],
  [/software\s*engineer|backend|frontend|full[\s-]?stack/i, 'Software Engineer'],
  [/ai\s*engineer/i,                          'AI Engineer'],

  // Go-to-market
  [/marketing\s*analyst|marketing\s*manager/i,'Marketing'],
  [/sales\s*operations|\bsales\s*analyst/i,   'Sales Ops'],

  // Design
  [/ux\s*design|product\s*design|ui\s*design/i, 'Design'],
]

export function canonicalizeArchetype(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (!s) return ''
  for (const [re, bucket] of RULES) {
    if (re.test(s)) return bucket
  }
  // Fallback: take the first segment before a comma / paren / dash, capped
  // at 28 chars. Keeps unmapped values short without dropping them entirely.
  const head = s.split(/[,(\-–—]/)[0].trim()
  return head.length <= 28 ? head : head.slice(0, 27) + '…'
}

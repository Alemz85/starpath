// prose-pins.mjs — extractors behind scripts/prose-pins.test.mjs.
//
// Each one turns prose into the values a test compares: the statuses a prompt
// tells an agent to write, the script paths a guide names, the header lines of
// a report template. They live apart from the test file so
// prose-pins.lib.test.mjs can feed them known-bad text and prove they would
// notice drift (a pin that cannot fail pins nothing).

/** 1-based line number of a character offset. */
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * Where a prompt hands an agent an application status to write. Three shapes:
 *   status `Applied`  /  Status to `Interview`  /  status cell `X`
 *   `Applied` status
 *   set-status.mjs <num> Applied
 * Lower-case backticked words after "status" (`status: red`, `skipped_dup`,
 * the batch JSON's "failed") belong to other vocabularies — eligibility
 * checks, scan results — and are not application statuses.
 *
 * @returns {{ value: string, line: number }[]}
 */
export function statusWrites(text) {
  const out = []
  const push = (m, value) => out.push({ value, line: lineOf(text, m.index) })
  for (const m of text.matchAll(/\bstatus(?:\*\*)?(?: cell| column| field)?(?: to| of| =| as)?\s+`([A-Z][A-Za-z ]*)`/gi)) {
    if (/^[A-Z]/.test(m[1])) push(m, m[1])
  }
  for (const m of text.matchAll(/`([A-Z][A-Za-z]*)` status\b/g)) push(m, m[1])
  for (const m of text.matchAll(/set-status\.mjs\s+(?:<[^>]+>|\d+)\s+([A-Za-z]+)/g)) push(m, m[1])
  return out
}

/**
 * scripts/<path>.mjs mentions with their line. Globs and `{placeholders}` are
 * skipped; a path preceded by a word character or slash (`frontend/scripts/…`)
 * is someone else's.
 *
 * @returns {{ path: string, line: number }[]}
 */
export function scriptPaths(text) {
  const out = []
  for (const m of text.matchAll(/(?<![\w/.-])scripts\/([A-Za-z0-9_./-]+\.mjs)\b/g)) {
    out.push({ path: `scripts/${m[1]}`, line: lineOf(text, m.index) })
  }
  return out
}

/** `**Label:**` names of one template, in order ("**Want:** … · **Ease:** …" is two labels). */
export function labelsOf(block) {
  const labels = []
  for (const line of block.split('\n')) {
    const lead = line.match(/^\*\*([^*:]+):\*\*/)
    if (lead) labels.push(lead[1])
    const second = line.match(/·\s*\*\*([^*:]+):\*\*/)
    if (second) labels.push(second[1])
  }
  return labels
}

/** Header labels of the first ```markdown report template that opens with a `# Scouting:` / `# Gap & Growth:` title. */
export function headerLabels(text) {
  const fence = text.match(/```markdown\n(# (?:Scouting|Gap & Growth):[\s\S]*?)```/)
  if (!fence) throw new Error('no report header template found')
  return labelsOf(fence[1])
}

/** Header labels of the "Standard report block format" template in modes/_shared.md. */
export function sharedHeaderLabels(text) {
  const at = text.indexOf('### Standard report block format')
  if (at < 0) throw new Error('no "Standard report block format" section')
  const fence = text.slice(at).match(/```markdown\n([\s\S]*?)```/)
  if (!fence) throw new Error('the standard block has no header template')
  return labelsOf(fence[1])
}

/** True when `small` appears in `big` in the same order (gaps allowed). */
export function isSubsequence(small, big) {
  let i = 0
  for (const x of big) if (x === small[i]) i += 1
  return i === small.length
}

/**
 * worker-capabilities.mjs — what each headless `claude -p` worker may do.
 *
 * Every background worker (batch evaluations, the app's eval spawns, scans,
 * Tailor CV / Draft / Prep, chat…) used to run --dangerously-skip-permissions.
 * A job posting is untrusted internet text, so a worker that reads one must
 * not be able to do more than its job needs. This module is the single
 * capability table; the CLI flags are DERIVED from it, never hand-written:
 *
 *   --permission-mode dontAsk   anything not allowed below is denied, never
 *                               prompted (there is nobody to answer)
 *   --strict-mcp-config         no MCP servers (the user's desktop/browser
 *                               MCPs would bypass every rule here)
 *   --setting-sources project   only the repo's .claude/settings.json (its
 *                               deny list); no user/local allow rules
 *   --tools                     the built-in tools that exist at all
 *   --allowedTools              read the checkout, write the kind's paths,
 *                               run the kind's commands, use the web
 *   --disallowedTools           PROJECT_DENY + the kind's own denies
 *
 * Path rules. `Edit(...)` covers Write/Edit/NotebookEdit. The CLI checks a
 * write against the path as written AND its resolved target, so a write to
 * `data/x.tsv` (a link into private/, or private/profiles/<slug>/) needs both
 * `Edit(./data/x.tsv)` and `Edit(./private/**\/data/x.tsv)`; `personalVariants`
 * adds the second form for every linked path (LINKED_PATHS in data-root.mjs).
 *
 * Bash counts as a write tool: a kind gets Bash only through exact command
 * prefixes (`Bash(node scripts/score-listing.mjs:*)`). The CLI splits
 * pipes / `&&` / `;` and checks each part, refuses output redirection and
 * command substitution unless allowed, so `echo '{…}' | node scripts/x.mjs`
 * works and `node scripts/x.mjs > file` does not.
 *
 * A denied call is reported in the result event's `permission_denials`;
 * `deniedTools()` reads it so every caller can fail the run loudly.
 *
 * Consumers: batch/batch-runner.sh (`node scripts/lib/worker-capabilities.mjs
 * args eval`), the Electron main process (shell:spawn expands the renderer's
 * `--starpath-worker <kind>` marker; chat.ts builds chat's flags), tests.
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { LINKED_PATHS } from './data-root.mjs'

/** Marker the renderer puts in a claude spawn's argv; main replaces it. */
export const WORKER_FLAG = '--starpath-worker'

/** Flags no worker argv may carry: they would widen or bypass the table. */
export const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--settings',
  '--setting-sources',
  '--mcp-config',
  '--strict-mcp-config',
  '--permission-prompt-tool',
  WORKER_FLAG,
]

/**
 * Denied for every worker AND for interactive sessions in this repo: these
 * entries are also `.claude/settings.json` → permissions.deny (a guard test
 * keeps the two identical). Only things no session should ever do — reading
 * credentials, skipping the leak gate, rewriting published history, editing
 * the git hooks or the private repo's internals.
 */
export const PROJECT_DENY = [
  // `*` matches anywhere (also nothing): these catch the flag in any position.
  'Bash(git commit *--no-verify*)',
  'Bash(git push *--no-verify*)',
  'Bash(git push *--force*)',
  'Bash(git push -f*)',
  'Bash(git push * -f*)',
  'Bash(sudo *)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.netrc)',
  'Read(./**/.env)',
  'Read(./**/.env.*)',
  'Edit(./.git/**)',
  'Edit(./.githooks/**)',
  'Edit(./private/.git/**)',
  'Edit(./private/.githooks/**)',
  'WebFetch(domain:localhost)',
  'WebFetch(domain:127.0.0.1)',
  'WebFetch(domain:169.254.169.254)',
]

/** Read-only built-ins every worker has. */
const READ_TOOLS = ['Read', 'Glob', 'Grep']

// The trackers only merge scripts and the app's status ledger may write.
const TRACKERS = ['data/applications.md', 'data/scouting.md']

// Evaluation outputs (batch/batch-prompt.md § Step 6–7, modes/scouting.md),
// plus batch/work/: the JSON inputs a worker hands to score-listing.mjs --input.
const EVAL_WRITES = [
  'reports/tier-1/**',
  'reports/tier-2/**',
  'reports/tier-3/**',
  'batch/scouting-additions/**',
  'batch/work/**',
  'data/score-history.tsv',
  'data/report-summaries.tsv',
  'data/comp-cache.tsv',
  'data/tax-cache.tsv',
  'data/col-cache.tsv',
]

const EVAL_COMMANDS = [
  'node scripts/posting-guard.mjs',
  'node scripts/score-listing.mjs',
  'node scripts/reserve-report-num.mjs',
  'node scripts/cv-summary.mjs',
  'node scripts/agent-log.mjs log',
]

// Read-only digests chat may run. Prefix rules, so each script here must have
// no write flag (daily-brief and apply-kit do, so they are exact or absent).
const READ_ONLY_SCRIPTS = [
  'node scripts/deadlines.mjs',
  'node scripts/whats-new.mjs',
  'node scripts/outreach-plan.mjs',
  'node scripts/peer-rank.mjs',
  'node scripts/comp-bench.mjs',
  'node scripts/score-trend.mjs',
  'node scripts/analyze-patterns.mjs',
  'node scripts/cv-gap.mjs',
  'node scripts/positioning-intel.mjs',
  'node scripts/network.mjs',
  'node scripts/company-research.mjs check',
  { exact: 'node scripts/daily-brief.mjs --json' },
  { exact: 'node scripts/session-handoff.mjs read' },
  { exact: 'npm run handoff -- read' },
]

/**
 * The capability table. Per kind:
 *   writes    repo-relative gitignore-style paths it may create/edit
 *   tmp       file globs it may write in the OS temp dir (scratch text)
 *   commands  what it may run through Bash (none → no Bash at all):
 *             'prefix' → `Bash(prefix:*)` · { exact } → that command only ·
 *             { pattern } → a `*` pattern, matched as written
 *   web       'fetch+search' | 'fetch' | 'search' | 'none'
 *   deny      extra rules on top of PROJECT_DENY
 */
export const WORKER_CAPABILITIES = {
  // batch/batch-runner.sh and the scheduled run: one listing per worker.
  eval: {
    summary: 'Scouting evaluation of one listing (batch runner, scheduled run)',
    writes: EVAL_WRITES,
    tmp: [],
    commands: EVAL_COMMANDS,
    web: 'fetch+search',
    deny: ['Edit(./user/**)', ...TRACKERS.map((p) => `Edit(./${p})`)],
  },
  // The app's eval spawns: Add listing, inbox Evaluate, Filter to Database,
  // top-5 reports, popover Generate Report (which runs modes/scouting.md and
  // may cite peer rank / outreach). They also triage data/pipeline.md and
  // merge their own scouting TSVs.
  'eval-app': {
    summary: 'App evaluations and pipeline triage (Add listing, Filter to Database, top 5, Generate report)',
    writes: [...EVAL_WRITES, 'data/pipeline.md'],
    tmp: [],
    commands: [
      ...EVAL_COMMANDS,
      'node scripts/merge-scouting.mjs',
      'node scripts/peer-rank.mjs',
      'node scripts/outreach-plan.mjs',
      'npm run outreach-plan',
      'node scripts/cv-sync-check.mjs',
    ],
    web: 'fetch+search',
    deny: ['Edit(./user/**)', ...TRACKERS.map((p) => `Edit(./${p})`)],
  },
  // Full scan / Filtered scan (/career-ops scan → modes/scan.md): scan.mjs
  // does the API work; the worker adds websearch hits to the pipeline, saves a
  // found careers_url into portals.yml, and may keep a private JD under jds/.
  scan: {
    summary: 'Portal scan (Full scan, Filtered scan)',
    writes: ['data/pipeline.md', 'data/scan-history.tsv', 'user/portals.yml', 'jds/**'],
    tmp: [],
    commands: ['node scripts/scan.mjs', 'node scripts/whats-new.mjs', 'node scripts/agent-log.mjs log'],
    web: 'fetch+search',
    deny: ['Edit(./user/cv.md)', 'Edit(./user/profile.yml)', 'Edit(./user/_profile.md)', ...TRACKERS.map((p) => `Edit(./${p})`)],
  },
  // Tailor CV / Draft application / Prep application (modes/pdf.md, apply.md,
  // interview-prep.md, and the user's overrides of them): build a tailored
  // CV under private/CV/, copy the PDF to output/, write prep notes, tick the
  // PDF cell in applications.md. Scratch text goes to the OS temp dir.
  'apply-flow': {
    summary: 'Tailor CV, Draft application, Prep application',
    writes: ['private/CV/applications/**', 'output/**', 'interview-prep/**', 'data/applications.md'],
    tmp: ['jd-*.txt', 'cv-*.txt', 'cv-*.html'],
    commands: [
      'private/CV/bin/new-cv',
      'private/CV/bin/build-cv',
      'pdfinfo',
      'pdftotext',
      'node scripts/ats-coverage.mjs',
      'node scripts/generate-pdf.mjs',
      'node scripts/cv-sync-check.mjs',
      'node scripts/company-research.mjs check',
      'node scripts/check-story-bank.mjs',
      'node scripts/agent-log.mjs log',
      { pattern: 'cp private/CV/applications/*.pdf output/*.pdf' },
    ],
    web: 'fetch+search',
    deny: ['Edit(./user/**)', 'Edit(./data/scouting.md)'],
  },
  // /career-ops positioning: one report from the user's own data.
  positioning: {
    summary: 'Positioning review',
    writes: ['reports/positioning/**'],
    tmp: [],
    commands: ['node scripts/positioning-intel.mjs', 'node scripts/score-trend.mjs', 'node scripts/agent-log.mjs log'],
    web: 'none',
    deny: ['Edit(./user/**)'],
  },
  // Settings › Profile save: applies the diff to the narrative + portals.
  'profile-sync': {
    summary: 'Profile sync after a Settings edit',
    writes: ['user/_profile.md', 'user/portals.yml'],
    tmp: [],
    commands: [],
    web: 'none',
    deny: ['Edit(./user/cv.md)'],
  },
  // Settings › Add company: probes the ATS APIs, rewrites one portals block.
  'company-probe': {
    summary: 'Add-company ATS probe',
    writes: ['user/portals.yml'],
    tmp: [],
    commands: [],
    web: 'fetch',
    deny: [],
  },
  // Onboarding: CV PDF (attached with @path) → user/cv.md.
  'cv-import': {
    summary: 'Onboarding CV import',
    writes: ['user/cv.md'],
    tmp: [],
    commands: [],
    web: 'none',
    deny: [],
  },
  // Onboarding tailoring (.claude/skills/career-ops-setup): filters + context.
  setup: {
    summary: 'Onboarding workspace tailoring',
    writes: ['user/portals.yml', 'user/profile.yml', 'user/_profile.md'],
    tmp: [],
    commands: [],
    web: 'none',
    deny: ['Edit(./user/cv.md)'],
  },
  // Chat advisor: reads everything, writes nothing (it proposes changes in
  // starpath:* fences the user confirms). No WebFetch: chat reads reports
  // that quote untrusted postings, and a fetch is the way data would leave.
  chat: {
    summary: 'Chat advisor (read-only; proposals go through confirm cards)',
    writes: [],
    tmp: [],
    commands: READ_ONLY_SCRIPTS,
    web: 'search',
    deny: ['Edit', 'Write', 'NotebookEdit', 'WebFetch'],
  },
}

export const WORKER_KINDS = Object.keys(WORKER_CAPABILITIES)

// ─── Derivation ──────────────────────────────────────────────────────────────

/** Is this repo-relative path (or glob) under a link into the data root? */
export function isLinkedPath(rel) {
  const clean = rel.replace(/^\.\//, '')
  return LINKED_PATHS.some(({ path }) => clean === path || clean.startsWith(`${path}/`))
}

/** The rule paths for one repo-relative write path: as written + resolved. */
export function personalVariants(rel) {
  const clean = rel.replace(/^\.\//, '')
  return isLinkedPath(clean) ? [`./${clean}`, `./private/**/${clean}`] : [`./${clean}`]
}

function capabilityFor(kind) {
  const cap = WORKER_CAPABILITIES[kind]
  if (!cap) throw new Error(`unknown worker kind: ${kind} (known: ${WORKER_KINDS.join(', ')})`)
  return cap
}

/** The built-in tools the worker has at all (`--tools`). */
export function workerTools(kind) {
  const cap = capabilityFor(kind)
  const tools = [...READ_TOOLS]
  if (cap.writes.length > 0 || cap.tmp.length > 0) tools.push('Edit', 'Write')
  if (cap.commands.length > 0) tools.push('Bash')
  if (cap.web.includes('fetch')) tools.push('WebFetch')
  if (cap.web.includes('search')) tools.push('WebSearch')
  return tools
}

/** The Bash rule for one `commands` entry. */
export function bashRule(entry) {
  if (typeof entry === 'string') return `Bash(${entry}:*)`
  if (entry.exact) return `Bash(${entry.exact})`
  return `Bash(${entry.pattern})`
}

/**
 * `--allowedTools` rules. `tmpdirs` are the OS temp dir as the environment
 * names it and as it resolves (macOS: /var/folders/… → /private/var/folders/…);
 * without them a kind's `tmp` globs are left out (the run cannot use scratch).
 */
export function allowedRules(kind, { tmpdirs = [], cwds = [] } = {}) {
  const cap = capabilityFor(kind)
  const rules = ['Read(./**)', 'Glob', 'Grep']
  for (const p of cap.writes) for (const v of personalVariants(p)) rules.push(`Edit(${v})`)
  for (const dir of new Set(tmpdirs.map((d) => d.replace(/\/+$/, '')).filter((d) => d.startsWith('/')))) {
    for (const g of cap.tmp) rules.push(`Edit(/${dir}/${g})`)
  }
  for (const c of cap.commands) rules.push(bashRule(c))
  // Models prefix commands with `cd <checkout> &&` out of habit. Only a cd to
  // the working directory itself is allowed (exact rules): a cd anywhere else
  // would make `node scripts/x.mjs` run a file planted in a writable folder.
  if (cap.commands.length > 0) {
    rules.push('Bash(cd .)')
    for (const dir of new Set(cwds.filter((d) => d.startsWith('/')))) rules.push(`Bash(cd ${dir})`)
  }
  if (cap.web.includes('fetch')) rules.push('WebFetch')
  if (cap.web.includes('search')) rules.push('WebSearch')
  return rules
}

/** `--disallowedTools` rules: the project deny list, then the kind's own. */
export function disallowedRules(kind) {
  const cap = capabilityFor(kind)
  const own = cap.deny.flatMap((r) => {
    const m = r.match(/^Edit\((.+)\)$/)
    return m ? personalVariants(m[1]).map((v) => `Edit(${v})`) : [r]
  })
  return [...PROJECT_DENY, ...own]
}

/** The permission flags for a worker kind, ready to splice into argv. */
export function workerPermissionArgs(kind, opts = {}) {
  return [
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--tools', workerTools(kind).join(','),
    '--allowedTools', ...allowedRules(kind, opts),
    '--disallowedTools', ...disallowedRules(kind),
  ]
}

/**
 * Replace the `--starpath-worker <kind>` marker in a claude argv with the
 * derived flags. Throws when the marker is missing or unknown, or when the
 * argv carries any flag that would widen permissions — a spawn either runs
 * least-privilege or not at all.
 */
export function expandWorkerArgs(args, opts = {}) {
  const i = args.indexOf(WORKER_FLAG)
  if (i === -1) throw new Error(`claude spawn without ${WORKER_FLAG} <kind>: refused`)
  const kind = args[i + 1]
  capabilityFor(kind)
  const rest = [...args.slice(0, i), ...args.slice(i + 2)]
  const bad = rest.find((a) => FORBIDDEN_FLAGS.includes(a.split('=')[0]))
  if (bad) throw new Error(`claude spawn may not pass ${bad}: permissions come from the worker kind`)
  return [...workerPermissionArgs(kind, opts), ...rest]
}

/**
 * The calls the CLI denied, from a `result` event (stream-json or json
 * output): `["Bash: rm -rf out", "Write: /abs/path"]`. Empty when none.
 */
export function deniedTools(resultEvent) {
  const list = resultEvent && Array.isArray(resultEvent.permission_denials) ? resultEvent.permission_denials : []
  return list.map((d) => {
    const input = d && typeof d.tool_input === 'object' && d.tool_input ? d.tool_input : {}
    const what = input.command ?? input.file_path ?? input.url ?? input.query ?? input.pattern ?? ''
    const name = String(d?.tool_name ?? 'tool')
    return what ? `${name}: ${String(what).slice(0, 120)}` : name
  })
}

/** The working directory as named and as resolved, for `allowedRules`' cwds. */
export function osCwds(dir = process.cwd()) {
  try { return [...new Set([dir, realpathSync(dir)])] } catch { return [dir] }
}

/**
 * The temp dirs scratch may go to, as named and as resolved, for
 * `allowedRules`' tmpdirs: $TMPDIR (the user's pdf override) and /tmp (the
 * public modes/pdf.md).
 */
export function osTmpdirs() {
  const out = []
  for (const dir of [tmpdir(), '/tmp']) {
    out.push(dir)
    try { out.push(realpathSync(dir)) } catch { /* missing: the named form is enough */ }
  }
  return [...new Set(out)]
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// `node scripts/lib/worker-capabilities.mjs args <kind>` prints the flags one
// per line (bash 3.2 reads them into an array with a while-read loop).
// `… table` prints the capability table as JSON.

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const [cmd, kind] = process.argv.slice(2)
  try {
    if (cmd === 'args' && kind) {
      process.stdout.write(workerPermissionArgs(kind, { tmpdirs: osTmpdirs(), cwds: osCwds() }).join('\n') + '\n')
    } else if (cmd === 'table') {
      process.stdout.write(JSON.stringify(WORKER_CAPABILITIES, null, 2) + '\n')
    } else {
      process.stderr.write('usage: worker-capabilities.mjs args <kind> | table\n')
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exit(2)
  }
}

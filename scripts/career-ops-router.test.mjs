// career-ops-router.test.mjs — the /career-ops router and modes/ stay in step:
// every routed mode has a file, every mode file is routed or explicitly
// excluded with a reason, and each routed mode says which context it loads.
//
// Run: node --test scripts/career-ops-router.test.mjs   (or `npm test`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(ROOT, '.claude/skills/career-ops/SKILL.md'), 'utf8')

/** Mode files that are deliberately not slash-command routes, with the reason. */
const NOT_ROUTED = {
  '_shared': 'the shared scoring rubric, loaded alongside the evaluation modes; not a mode',
  'chat': "the starpath app's chat system prompt, appended by the app (frontend/electron/chat.ts); not a command",
}

/** Routes whose command is not a mode file. */
const NON_FILE_ROUTES = new Set(['discovery'])

const routeTable = skill.slice(skill.indexOf('## Mode Routing'), skill.indexOf('## Discovery Mode'))
const routes = [...routeTable.matchAll(/^\| `([^`]+)` \| `([^`]+)`/gm)].map(([, input, mode]) => ({ input, mode }))
const routedModes = new Set(routes.map((r) => r.mode))
const modeFiles = readdirSync(join(ROOT, 'modes')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))

test('the router has a routing table', () => {
  assert.ok(routes.length >= 20, `parsed ${routes.length} routes`)
})

test('every routed mode has a mode file', () => {
  for (const mode of routedModes) {
    if (NON_FILE_ROUTES.has(mode)) continue
    assert.ok(existsSync(join(ROOT, 'modes', `${mode}.md`)), `modes/${mode}.md is routed but missing`)
  }
})

test('every mode file is routed or explicitly excluded with a reason', () => {
  for (const mode of modeFiles) {
    if (mode in NOT_ROUTED) {
      assert.ok(NOT_ROUTED[mode].length > 10)
      assert.ok(!routedModes.has(mode), `${mode} is excluded, so it must not also be routed`)
    } else {
      assert.ok(routedModes.has(mode), `modes/${mode}.md has no route in .claude/skills/career-ops/SKILL.md (route it, or exclude it here with a reason)`)
    }
  }
  for (const mode of Object.keys(NOT_ROUTED)) assert.ok(modeFiles.includes(mode), `excluded ${mode} no longer exists: drop it from NOT_ROUTED`)
})

test('a sub-command is routed once', () => {
  const inputs = routes.map((r) => r.input)
  assert.equal(new Set(inputs).size, inputs.length)
})

test('each routed mode is in the argument hint, the menu and exactly one context-loading list', () => {
  const hint = skill.match(/^argument-hint: "\[(.*)\]"/m)?.[1].split('|').map((s) => s.trim())
  assert.ok(hint, 'argument-hint present')
  const menu = skill.slice(skill.indexOf('## Discovery Mode'), skill.indexOf('## Context Loading by Mode'))
  const withShared = skill.match(/### Modes that require `_shared.md`[^\n]*\n[^\n]*\n\nApplies to: ([^\n]*)/)?.[1] ?? ''
  const standalone = skill.match(/### Standalone modes[^\n]*\n[^\n]*\n\nApplies to: ([^\n]*)/)?.[1] ?? ''
  const listed = (text) => new Set([...text.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]))
  const shared = listed(withShared)
  const alone = listed(standalone)
  for (const mode of routedModes) {
    if (NON_FILE_ROUTES.has(mode)) continue
    assert.ok(hint.includes(mode), `${mode} missing from argument-hint`)
    assert.ok(menu.includes(`/career-ops ${mode} `) || menu.includes(`/career-ops ${mode}\n`), `${mode} missing from the discovery menu`)
    assert.equal(Number(shared.has(mode)) + Number(alone.has(mode)), 1, `${mode} must be in exactly one context-loading list`)
  }
  for (const mode of [...shared, ...alone]) assert.ok(routedModes.has(mode), `context list names unrouted mode ${mode}`)
})

test('the router keeps its private-overrides block', () => {
  assert.match(skill, /\*\*Private overrides \(always check first\)\.\*\*/)
  assert.match(skill, /private\/overrides\/modes\/X\.append\.md/)
})

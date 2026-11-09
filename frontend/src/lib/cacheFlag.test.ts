import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CACHE_FLAG, withCacheFlag } from '@/lib/cacheFlag'

test('the cache flag goes only on eval spawns, only when the CLI lists it', () => {
  const evalArgv = ['--permission-mode', 'dontAsk', '--append-system-prompt-file', 'batch/batch-prompt.md', '-p', 'task']
  const help = `Options:\n  ${CACHE_FLAG}  Move per-machine sections\n`
  assert.deepEqual(withCacheFlag(evalArgv, help), [CACHE_FLAG, ...evalArgv])
  assert.equal(withCacheFlag(evalArgv, 'Options:\n  --model <model>\n'), evalArgv)
  assert.equal(withCacheFlag(evalArgv, null), evalArgv)
  const chatArgv = ['--permission-mode', 'acceptEdits', '-p', 'hello']
  assert.equal(withCacheFlag(chatArgv, help), chatArgv)
  const already = [CACHE_FLAG, ...evalArgv]
  assert.equal(withCacheFlag(already, help), already)
})

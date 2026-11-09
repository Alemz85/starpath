import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logoCacheNames, outcomeForStatus, provisionalIsStale, PROVISIONAL_TTL_MS } from '@/lib/logoCache'

test('a rate limit or outage is not "no logo"', () => {
  assert.equal(outcomeForStatus(200), 'ok')
  assert.equal(outcomeForStatus(404), 'missing')
  assert.equal(outcomeForStatus(400), 'missing')
  for (const s of [429, 408, 500, 502, 503, undefined]) assert.equal(outcomeForStatus(s), 'unavailable')
})

test('a provisional favicon is retried after a day, not before', () => {
  const now = 1_000_000_000_000
  assert.equal(provisionalIsStale(now - 60_000, now), false)
  assert.equal(provisionalIsStale(now - PROVISIONAL_TTL_MS, now), true)
})

test('cache names keep the two kinds apart and stay file-safe', () => {
  assert.deepEqual(logoCacheNames('nimbus.app'), { kept: 'nimbus.app.b64', provisional: 'nimbus.app.provisional.b64' })
  assert.equal(logoCacheNames('a/b:c.io').kept, 'a_b_c.io.b64')
})

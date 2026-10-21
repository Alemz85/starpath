// messages-core.test.mjs — building, parsing and folding agent → user
// Messages. Fixtures are fictional.
//
// Run: node --test scripts/lib/messages-core.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPost, buildUpdate, closedMessages, duplicateOf, findMessage, foldMessages, inferLinkKind, makeId,
  normalizeLink, openCount, openMessages, parseRecords, planUpdate, postFromSuggestion, renderList, serializeRecord,
} from './messages-core.mjs'

const T0 = new Date('2026-07-10T09:00:00Z')
const at = (min) => new Date(T0.getTime() + min * 60_000)
const post = (id, min, extra = {}) => buildPost({ title: `Message ${id}`, ...extra }, { id, now: at(min) })

test('makeId: date plus hex suffix', () => {
  assert.equal(makeId(T0, 'A1B2c3d4'), 'm-20260710-a1b2c3d4')
})

test('buildPost: defaults, trimming, validation', () => {
  const p = buildPost({ title: '  Scan   stuck \n', body: 'a\r\nb' }, { id: 'm-1', now: T0 })
  assert.deepEqual(p, { type: 'post', id: 'm-1', created_at: T0.toISOString(), source: 'session', kind: 'fyi', title: 'Scan stuck', body: 'a\nb', links: [] })
  assert.equal(buildPost({ title: 'x', kind: 'APPROVAL', source: 'Scheduler', key: ' k ' }, { id: 'm', now: T0 }).kind, 'approval')
  assert.equal(buildPost({ title: 'x', key: ' k ' }, { id: 'm', now: T0 }).key, 'k')
  assert.throws(() => buildPost({ title: '' }, { id: 'm', now: T0 }), { code: 'EBADMSG' })
  assert.throws(() => buildPost({ title: 'x', kind: 'urgent' }, { id: 'm', now: T0 }), /kind must be one of/)
  assert.throws(() => buildPost({ title: 'x', source: 'cron' }, { id: 'm', now: T0 }), /source must be one of/)
  assert.throws(() => buildPost({ title: 'x'.repeat(201) }, { id: 'm', now: T0 }), /title is longer/)
})

test('links: inferred kinds, app: prefix, unsafe paths dropped', () => {
  assert.equal(inferLinkKind('https://example.com/job'), 'url')
  assert.equal(inferLinkKind('reports/tier-1/12-nimbus.md'), 'report')
  assert.equal(inferLinkKind('app:nimbus-robotics|strategy-analyst'), 'application')
  assert.equal(inferLinkKind('user/profile.yml'), 'file')
  assert.deepEqual(normalizeLink('app:nimbus|analyst'), { kind: 'application', target: 'nimbus|analyst' })
  assert.deepEqual(normalizeLink({ target: 'https://example.com', label: 'Listing' }), { kind: 'url', target: 'https://example.com', label: 'Listing' })
  assert.equal(normalizeLink('/etc/passwd'), null)
  assert.equal(normalizeLink('reports/../../secret.md'), null)
  assert.equal(normalizeLink({ kind: 'url', target: 'javascript:alert(1)' }), null)
  assert.equal(normalizeLink(''), null)
  const p = buildPost({ title: 'x', links: ['reports/tier-2/a.md', null, '/abs'] }, { id: 'm', now: T0 })
  assert.deepEqual(p.links, [{ kind: 'report', target: 'reports/tier-2/a.md' }])
})

test('parseRecords: skips blank, torn and unknown lines', () => {
  const raw = [
    serializeRecord(post('m-a', 0)).trim(),
    '',
    '{"type":"post","id":"m-b","title":"cut sh',
    '{"type":"weird","id":"m-c"}',
    JSON.stringify(buildUpdate('m-a', 'resolved', { now: at(5) })),
  ].join('\n')
  const { records, skipped } = parseRecords(raw)
  assert.equal(records.length, 2)
  assert.equal(skipped, 2)
  assert.deepEqual(parseRecords('').records, [])
})

test('foldMessages: latest update wins, reopen clears resolution, unknown ids ignored', () => {
  const recs = [
    post('m-a', 0, { kind: 'alert' }),
    post('m-b', 1),
    buildUpdate('m-a', 'resolved', { note: 'fixed the portal', now: at(10) }),
    buildUpdate('m-zz', 'dismissed', { now: at(11) }),
    buildUpdate('m-b', 'dismissed', { now: at(12) }),
    buildUpdate('m-b', 'open', { now: at(13) }),
    post('m-a', 20, { title: 'duplicate id: ignored' }),
  ]
  const [a, b] = foldMessages(recs)
  assert.equal(foldMessages(recs).length, 2)
  assert.equal(a.title, 'Message m-a')
  assert.equal(a.status, 'resolved')
  assert.equal(a.resolved_at, at(10).toISOString())
  assert.equal(a.resolution_note, 'fixed the portal')
  assert.equal(a.history.length, 1)
  assert.equal(b.status, 'open')
  assert.equal(b.resolved_at, null)
  assert.equal(b.updated_at, at(13).toISOString())
  assert.equal(b.history.length, 2)
})

test('open / closed lists and the count', () => {
  const msgs = foldMessages([
    post('m-a', 0), post('m-b', 5), post('m-c', 10),
    buildUpdate('m-a', 'resolved', { now: at(30) }),
    buildUpdate('m-c', 'dismissed', { now: at(20) }),
  ])
  assert.deepEqual(openMessages(msgs).map((m) => m.id), ['m-b'])
  assert.deepEqual(closedMessages(msgs).map((m) => m.id), ['m-a', 'm-c'])
  assert.equal(openCount(msgs), 1)
  const newest = openMessages(foldMessages([post('m-a', 0), post('m-b', 5)]))
  assert.deepEqual(newest.map((m) => m.id), ['m-b', 'm-a'])
})

test('findMessage: exact, prefix, suffix, ambiguous, missing', () => {
  const msgs = foldMessages([post('m-20260710-aaaa1111', 0), post('m-20260710-bbbb2222', 1)])
  assert.equal(findMessage(msgs, 'm-20260710-aaaa1111').id, 'm-20260710-aaaa1111')
  assert.equal(findMessage(msgs, 'bbbb2222').id, 'm-20260710-bbbb2222')
  assert.throws(() => findMessage(msgs, 'm-20260710'), { code: 'EAMBIG' })
  assert.throws(() => findMessage(msgs, 'cccc'), { code: 'ENOMSG' })
  assert.throws(() => findMessage(msgs, ''), { code: 'ENOMSG' })
})

test('duplicateOf: open or dismissed keys block a repost, resolved ones do not', () => {
  const msgs = foldMessages([
    post('m-a', 0, { key: 'calib:match-floor' }),
    post('m-b', 1, { key: 'sched:failed' }),
    post('m-c', 2, { key: 'calib:ease-weights' }),
    buildUpdate('m-b', 'resolved', { now: at(3) }),
    buildUpdate('m-c', 'dismissed', { now: at(4) }),
  ])
  const again = (key) => buildPost({ title: 'again', key }, { id: 'm-new', now: at(9) })
  assert.equal(duplicateOf(msgs, again('calib:match-floor')).id, 'm-a')
  assert.equal(duplicateOf(msgs, again('sched:failed')), null)
  assert.equal(duplicateOf(msgs, again('calib:ease-weights')).id, 'm-c')
  assert.equal(duplicateOf(msgs, buildPost({ title: 'no key' }, { id: 'x', now: T0 })), null)
})

test('planUpdate: same status without a note is a no-op', () => {
  const msgs = foldMessages([post('m-a', 0)])
  assert.equal(planUpdate(msgs, 'm-a', 'open', { now: at(1) }).record, null)
  const { record } = planUpdate(msgs, 'm-a', 'resolved', { note: ' ok ', now: at(1) })
  assert.deepEqual(record, { type: 'update', id: 'm-a', at: at(1).toISOString(), status: 'resolved', note: 'ok' })
  assert.throws(() => planUpdate(msgs, 'm-a', 'archived', { now: at(1) }), /status must be one of/)
})

test('renderList: one line per message, body on request', () => {
  const msgs = foldMessages([post('m-a', 0, { body: 'line 1\nline 2', links: ['https://example.com'] })])
  assert.match(renderList(msgs), /^m-a {2}2026-07-10 09:00 {2}fyi/)
  assert.match(renderList(msgs, { showBody: true }), /line 2\n {4}→ https:\/\/example.com/)
  assert.equal(renderList([]), 'no messages')
})

test('postFromSuggestion: an outcome suggestion becomes a keyed calibrate post', () => {
  const input = postFromSuggestion({
    id: 'outcomes:ease:high-no-progress', source: 'outcomes', kind: 'suggestion',
    title: 'High-Ease applications are not progressing', body: '6 of 7 got no reply.',
    target: 'user/profile.yml', evidence: { n: 7 },
  })
  assert.deepEqual(input, {
    source: 'calibrate', kind: 'suggestion', key: 'outcomes:ease:high-no-progress',
    title: 'High-Ease applications are not progressing', body: '6 of 7 got no reply.', links: ['user/profile.yml'],
  })
  const p = buildPost(input, { id: 'm-1', now: T0 })
  assert.deepEqual(p.links, [{ kind: 'file', target: 'user/profile.yml' }])
  assert.equal(postFromSuggestion({ id: 'x', kind: 'weird', title: 't' }).kind, 'suggestion')
})

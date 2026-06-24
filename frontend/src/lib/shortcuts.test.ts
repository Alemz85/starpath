import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAV_CHORDS,
  CHORD_TIMEOUT_MS,
  IDLE_CHORD,
  reduceChord,
  navShortcutRows,
  shortcutGroups,
} from '@/lib/shortcuts'

const T0 = 1_000_000 // arbitrary fixed clock

// ─── reduceChord: leader capture ─────────────────────────────────────────────

test('a fresh `g` captures the leader without navigating', () => {
  const r = reduceChord(IDLE_CHORD, 'g', T0)
  assert.equal(r.type, 'leader')
  assert.deepEqual(r.type === 'leader' && r.next, { leader: 'g', at: T0 })
})

test('`g` is case-insensitive as a leader', () => {
  assert.equal(reduceChord(IDLE_CHORD, 'G', T0).type, 'leader')
})

test('a non-leader key with no pending chord is ignored', () => {
  assert.equal(reduceChord(IDLE_CHORD, 's', T0).type, 'ignore')
  assert.equal(reduceChord(IDLE_CHORD, 'x', T0).type, 'ignore')
  assert.equal(reduceChord(IDLE_CHORD, 'Enter', T0).type, 'ignore')
})

// ─── reduceChord: resolving the second key ───────────────────────────────────

test('`g` then a mapped letter navigates and resets', () => {
  const leader = { leader: 'g' as const, at: T0 }
  for (const [key, view] of Object.entries(NAV_CHORDS)) {
    const r = reduceChord(leader, key, T0 + 200)
    assert.equal(r.type, 'navigate', `g+${key} should navigate`)
    assert.equal(r.type === 'navigate' && r.view, view)
    assert.deepEqual(r.type === 'navigate' && r.next, IDLE_CHORD)
  }
})

test('the second key is case-insensitive', () => {
  const r = reduceChord({ leader: 'g', at: T0 }, 'D', T0 + 50)
  assert.equal(r.type === 'navigate' && r.view, 'database')
})

test('`g` then an unmapped key cancels the chord (reset, no nav)', () => {
  const r = reduceChord({ leader: 'g', at: T0 }, 'z', T0 + 50)
  assert.equal(r.type, 'reset')
  assert.deepEqual(r.type === 'reset' && r.next, IDLE_CHORD)
})

// ─── reduceChord: expiry ─────────────────────────────────────────────────────

test('a second key inside the timeout window still resolves', () => {
  const r = reduceChord({ leader: 'g', at: T0 }, 's', T0 + CHORD_TIMEOUT_MS)
  assert.equal(r.type, 'navigate')
})

test('once the leader expires, the second key is treated as a fresh press', () => {
  // The mapped letter `s` is not a leader, so a lapsed chord + `s` is ignored…
  const lapsed = reduceChord({ leader: 'g', at: T0 }, 's', T0 + CHORD_TIMEOUT_MS + 1)
  assert.equal(lapsed.type, 'ignore')
  // …but a `g` after expiry opens a brand-new chord.
  const reopened = reduceChord({ leader: 'g', at: T0 }, 'g', T0 + CHORD_TIMEOUT_MS + 1)
  assert.equal(reopened.type, 'leader')
  assert.equal(reopened.type === 'leader' && reopened.next.at, T0 + CHORD_TIMEOUT_MS + 1)
})

// ─── cheatsheet content stays in sync with the chord map ─────────────────────

test('navShortcutRows mirrors NAV_CHORDS exactly', () => {
  const rows = navShortcutRows()
  assert.equal(rows.length, Object.keys(NAV_CHORDS).length)
  for (const row of rows) {
    assert.equal(row.keys[0], 'G')
    assert.equal(row.keys.length, 2)
    assert.equal(row.combo, 'then')
    // The second chip's letter must be a real chord key.
    assert.ok(NAV_CHORDS[row.keys[1].toLowerCase()], `${row.keys[1]} should be a chord`)
    assert.ok(row.label.length > 0)
  }
})

test('shortcutGroups exposes Navigate + General with a ⌘K combo row', () => {
  const groups = shortcutGroups()
  const headings = groups.map(g => g.heading)
  assert.deepEqual(headings, ['Navigate', 'General'])

  const cmdk = groups[1].rows.find(r => r.label.startsWith('Command palette'))
  assert.ok(cmdk)
  assert.deepEqual(cmdk!.keys, ['⌘', 'K'])
  assert.equal(cmdk!.combo, 'plus')

  // The help key documents itself.
  assert.ok(groups[1].rows.some(r => r.keys.length === 1 && r.keys[0] === '?'))
})

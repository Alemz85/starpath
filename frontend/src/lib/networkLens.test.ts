import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  partitionGaps, degreeLabel, buildRosterRows, isNetworkEmpty,
  type NetworkOverview, type NetworkContact, type NetworkGap, type NetworkThread,
} from '@/lib/networkLens'

// ─── fictional fixtures ───────────────────────────────────────────────────────

function contact(over: Partial<NetworkContact> = {}): NetworkContact {
  return {
    num: 1, name: 'Ada Vega', company: 'Helios Analytics', companyKey: 'heliosanalytics',
    title: 'Strategy Analyst', relationship: 'strong', degree: 1, via: '',
    lastContact: '2026-05-20', notes: '',
    ...over,
  }
}

function gap(company: string, topScore: number): NetworkGap {
  return { company, companyKey: company.toLowerCase().replace(/[^a-z0-9]/g, ''), topScore, roles: [] }
}

function thread(over: Partial<NetworkThread> = {}): NetworkThread {
  return {
    company: 'Helios Analytics', contact: 'Bo Lindt', role: '', title: 'Recruiter',
    channel: 'Message', action: 'nudge', state: 'pending', leverage: 'recruiter',
    daysSince: 12, nextNudge: null, touches: 1, lastTouch: '2026-06-19', reason: 'No reply yet',
    ...over,
  }
}

function overview(over: Partial<NetworkOverview> = {}): NetworkOverview {
  return {
    today: '2026-07-01',
    roster: [], companies: [], gaps: [], latentLeads: [], threads: [],
    counts: {
      contacts: 0, pipelineTargets: 0, companiesWithPath: 0,
      gaps: 0, latentLeads: 0, threads: 0, dueNudges: 0,
    },
    ...over,
  }
}

// ─── partitionGaps ────────────────────────────────────────────────────────────

test('partitionGaps splits at the apply threshold and preserves order', () => {
  const gaps = [gap('Zephyr Group', 9.1), gap('Vantor', 7.0), gap('Umbra Partners', 6.4), gap('Kite Labs', 5.0)]
  const { priority, rest } = partitionGaps(gaps)
  assert.deepEqual(priority.map(g => g.company), ['Zephyr Group', 'Vantor']) // 7.0 inclusive
  assert.deepEqual(rest.map(g => g.company), ['Umbra Partners', 'Kite Labs'])
})

test('partitionGaps handles empty input', () => {
  assert.deepEqual(partitionGaps([]), { priority: [], rest: [] })
})

// ─── degreeLabel ──────────────────────────────────────────────────────────────

test('degreeLabel renders hop shorthand', () => {
  assert.equal(degreeLabel(1), '1st°')
  assert.equal(degreeLabel(2, 'Ada Vega'), '2nd° via Ada Vega')
  assert.equal(degreeLabel(2, '  '), '2nd°')
  assert.equal(degreeLabel(2, null), '2nd°')
})

// ─── buildRosterRows ──────────────────────────────────────────────────────────

test('buildRosterRows joins pipeline membership and thread state per contact', () => {
  const o = overview({
    roster: [
      contact({ num: 1, name: 'Ada Vega' }),
      contact({ num: 2, name: 'Bo Lindt', title: 'Talent Partner', relationship: 'medium' }),
      contact({ num: 3, name: 'Di Okafor', company: 'Quasar Systems', companyKey: 'quasarsystems' }),
    ],
    companies: [{
      company: 'Helios Analytics', companyKey: 'heliosanalytics', topRole: null, roles: [],
      play: 'nudge', target: null, reason: '', channel: null, cautions: [], paths: [],
      counts: { paths: 2, untouched: 1 },
    }],
    threads: [thread()],
  })
  const rows = buildRosterRows(o)
  assert.equal(rows.length, 3)
  // On-disk order preserved.
  assert.deepEqual(rows.map(r => r.contact.name), ['Ada Vega', 'Bo Lindt', 'Di Okafor'])
  // Pipeline membership comes from the matched-company keys.
  assert.deepEqual(rows.map(r => r.inPipeline), [true, true, false])
  // Only Bo has a thread; matching is name+company, not name alone.
  assert.equal(rows[0].thread, null)
  assert.equal(rows[1].thread?.action, 'nudge')
  assert.equal(rows[2].thread, null)
})

test('buildRosterRows matches threads case/whitespace-insensitively', () => {
  const o = overview({
    roster: [contact({ name: 'Bo  Lindt' })],
    threads: [thread({ contact: 'bo lindt', company: 'HELIOS ANALYTICS' })],
  })
  assert.equal(buildRosterRows(o)[0].thread?.contact, 'bo lindt')
})

// ─── isNetworkEmpty ───────────────────────────────────────────────────────────

test('isNetworkEmpty is true only when both roster and threads are empty', () => {
  assert.equal(isNetworkEmpty(overview()), true)
  assert.equal(isNetworkEmpty(overview({ roster: [contact()] })), false)
  assert.equal(isNetworkEmpty(overview({ threads: [thread()] })), false)
})

// Renderer-side parser + cadence for data/outreach.md.
//
// The backend `contacto` mode appends touch rows to data/outreach.md; the
// backend scripts/outreach-cadence.mjs owns the canonical cadence math for the
// CLI. The Today cockpit needs the same classification at render time without
// shelling out, so this module re-implements the *parse + collapse + classify*
// pipeline as pure TypeScript against the identical table schema.
//
// Kept deliberately small and faithful to the backend contract:
//   table schema: | # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
// If the file is absent (the common case until the user logs outreach) the
// parser returns [] and the cockpit simply shows no outreach items.
//
// Pure: no I/O, injectable `now`. The view reads the file via ipc and feeds the
// raw string here.

import type { OutreachCadenceEntry } from './todayCockpit'

const DAY_MS = 1000 * 60 * 60 * 24

// First-nudge / subsequent windows (days) and touch ceilings per channel
// family — mirror scripts/outreach-core.mjs § CADENCE so the cockpit and the
// CLI agree on when a nudge is due.
const CADENCE = {
  connection_first: 7,
  connection_subsequent: 7,
  connection_max: 2,
  message_first: 5,
  message_subsequent: 6,
  message_max: 2,
}

export interface OutreachTouch {
  num: number
  date: string
  company: string
  role: string
  contact: string
  title: string
  channel: string
  touch: number
  outcome: string
  notes: string
}

// Parse the markdown table into raw touch rows. Mirrors parseLog() in
// scripts/outreach-cadence.mjs — skips the header/separator and any malformed
// line, and treats a row as valid only when column 1 is a number.
export function parseOutreachLog(content: string | null): OutreachTouch[] {
  const rows: OutreachTouch[] = []
  if (!content) return rows
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const parts = line.split('|').map(s => s.trim())
    // leading '' from the edge pipe + 10 cells + trailing '' = 12 parts min.
    if (parts.length < 11) continue
    const num = parseInt(parts[1], 10)
    if (Number.isNaN(num)) continue
    rows.push({
      num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      contact: parts[5],
      title: parts[6],
      channel: parts[7],
      touch: parseInt(parts[8], 10) || 1,
      outcome: parts[9],
      notes: parts[10] ?? '',
    })
  }
  return rows
}

// Collapse touch rows to one record per (company + contact): latest touch wins,
// touch count is the max seen. Mirrors collapse() in outreach-cadence.mjs.
function collapse(rows: OutreachTouch[]) {
  const byKey = new Map<string, {
    company: string; role: string; contact: string; channel: string
    lastTouch: string; touches: number; outcome: string
  }>()
  for (const r of rows) {
    const key = `${r.company.toLowerCase()}|${r.contact.toLowerCase()}`
    const prev = byKey.get(key)
    if (!prev || r.date > prev.lastTouch || (r.date === prev.lastTouch && r.touch >= prev.touches)) {
      byKey.set(key, {
        company: r.company,
        role: r.role,
        contact: r.contact,
        channel: r.channel,
        lastTouch: r.date,
        touches: Math.max(r.touch, prev ? prev.touches : 0),
        outcome: r.outcome,
      })
    } else if (prev) {
      prev.touches = Math.max(prev.touches, r.touch)
    }
  }
  return [...byKey.values()]
}

function channelFamily(channel: string): 'connection' | 'message' {
  const c = (channel || '').trim().toLowerCase()
  if (
    c === 'connection' || c === 'connect' || c === 'linkedin connection' ||
    c === 'connection request' || c === 'request'
  ) return 'connection'
  return 'message'
}

type OutcomeState = 'replied' | 'declined' | 'accepted' | 'pending'

function normalizeOutcome(outcome: string): OutcomeState {
  const o = (outcome || '').trim().toLowerCase()
  if (!o) return 'pending'
  if (/\b(replied|reply|responded|answered|wrote back|got a reply|in touch|call booked|meeting|intro(?:duced)?)\b/.test(o)) return 'replied'
  if (/\b(declined|rejected|ignored|no response after|withdrawn|withdrew|not interested|ghosted|dead)\b/.test(o)) return 'declined'
  if (/\b(accepted|connected|connection accepted)\b/.test(o)) return 'accepted'
  return 'pending'
}

function parseDate(s: string): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null
  const d = new Date(s.trim() + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

// Classify a collapsed contact to a cadence action — faithful port of
// classifyContact() in outreach-core.mjs. Returns the subset of fields the
// cockpit consumes.
function classify(
  c: { company: string; role: string; contact: string; channel: string; lastTouch: string; touches: number; outcome: string },
  now: Date,
): OutreachCadenceEntry {
  const family = channelFamily(c.channel)
  const state = normalizeOutcome(c.outcome)
  const touches = Number.isFinite(c.touches) ? c.touches : 1
  const last = parseDate(c.lastTouch)
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const dSince = last ? Math.floor((today.getTime() - last.getTime()) / DAY_MS) : null

  const base = {
    company: c.company, contact: c.contact, role: c.role, channel: c.channel,
    lastTouch: c.lastTouch, daysSince: dSince,
  }

  if (state === 'replied') return { ...base, action: 'done', reason: 'They replied — hand off to a real conversation' }
  if (state === 'declined') return { ...base, action: 'cold', reason: 'No path here — try a different contact' }

  const max = family === 'connection' ? CADENCE.connection_max : CADENCE.message_max
  if (touches >= max) return { ...base, action: 'cold', reason: `${touches} touches, no reply — switch angle or contact` }

  const effFamily = state === 'accepted' ? 'message' : family
  const window = touches <= 1
    ? (effFamily === 'connection' ? CADENCE.connection_first : CADENCE.message_first)
    : (effFamily === 'connection' ? CADENCE.connection_subsequent : CADENCE.message_subsequent)

  if (dSince === null) return { ...base, action: 'nudge', reason: 'No valid last-touch date — review and re-send if needed' }

  if (dSince >= window) {
    const what = state === 'accepted'
      ? 'Connection accepted, no reply yet — send a value-add message'
      : (family === 'connection'
          ? 'Connection request still pending — nudge or try another contact'
          : 'No reply yet — follow up with a fresh angle')
    return { ...base, action: 'nudge', reason: what }
  }
  return { ...base, action: 'waiting', reason: 'On track' }
}

// Parse the raw outreach.md → classified cadence entries the cockpit consumes.
// Pure; `now` injectable for tests.
export function classifyOutreachLog(content: string | null, now: Date = new Date()): OutreachCadenceEntry[] {
  return collapse(parseOutreachLog(content)).map(c => classify(c, now))
}

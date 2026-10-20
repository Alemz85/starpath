/**
 * idle-slot-core.mjs — pick the weekly hour when the user is least likely to
 * be using Claude, from timestamps alone.
 *
 * Pure: every function takes plain data (epoch-ms timestamps, awake
 * intervals, a `now`) and returns plain data. Reading the transcripts and
 * `pmset` lives in idle-slot-io.mjs. Nothing here ever sees message content.
 *
 * Model. A "slot" is an hour of the week, index = weekday * 24 + hour with
 * weekday 0 = Sunday (the same numbering launchd's Weekday uses). Two signals:
 *   - usage: of the calendar days of that weekday inside the window, the
 *     fraction on which Claude was active during that hour (distinct days, not
 *     message counts, so one long burst can't outweigh a habit);
 *   - awake: the same fraction for "the Mac was fully awake during that hour".
 * A slot is eligible when the Mac is usually awake in it; the winner is the
 * eligible slot with the least usage in its hour plus half of the next hour
 * (a run takes a while).
 *
 * Local time throughout (Date getters), because "morning" is the user's.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export const DEFAULT_WEEKS = 8
export const MIN_AWAKE = 0.7
export const FALLBACK_SLOT = Object.freeze({ weekday: 2, hour: 9, minute: 0 })
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const slotIndex = (weekday, hour) => weekday * 24 + hour

export function formatSlot({ weekday, hour, minute = 0 }) {
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `${WEEKDAY_NAMES[weekday]} ${hh}:${mm}`
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Local calendar days in [fromMs, toMs]: how many fall on each weekday. */
export function daysPerWeekday(fromMs, toMs) {
  const counts = new Array(7).fill(0)
  if (!(toMs >= fromMs)) return counts
  const last = startOfDay(toMs)
  for (let t = startOfDay(fromMs); t <= last; ) {
    const d = new Date(t)
    counts[d.getDay()]++
    // Step by calendar day (a DST day is 23 or 25 hours long).
    t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  }
  return counts
}

/**
 * Per-slot activity from point-in-time timestamps.
 *
 * `excludeWindows` ([{start,end}]) drops timestamps that fall inside a
 * window, used for the scheduler's own earlier runs so its `claude -p`
 * workers don't make their own slot look busy.
 *
 * Returns { activeDays[168], dayCounts[7], fraction[168], from, to, total }.
 * `from` is the later of the window start and the first timestamp seen, so a
 * recently installed Claude doesn't count weeks it did not exist.
 */
export function usageHistogram(timestamps, { now, weeks = DEFAULT_WEEKS, excludeWindows = [] } = {}) {
  const windowStart = now - weeks * 7 * DAY_MS
  const kept = []
  for (const ts of timestamps) {
    if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue
    if (excludeWindows.some((w) => ts >= w.start && ts <= w.end)) continue
    kept.push(ts)
  }
  const first = kept.reduce((a, b) => (b < a ? b : a), Infinity)
  const from = kept.length ? Math.max(windowStart, first) : windowStart
  const seen = new Set()
  const activeDays = new Array(168).fill(0)
  for (const ts of kept) {
    const d = new Date(ts)
    const key = `${dayKey(d)}#${d.getHours()}`
    if (seen.has(key)) continue
    seen.add(key)
    activeDays[slotIndex(d.getDay(), d.getHours())]++
  }
  const dayCounts = daysPerWeekday(from, now)
  const fraction = activeDays.map((n, i) => {
    const denom = dayCounts[Math.floor(i / 24)]
    return denom > 0 ? Math.min(1, n / denom) : 0
  })
  return { activeDays, dayCounts, fraction, from, to: now, total: kept.length }
}

/**
 * Per-slot "Mac fully awake" from awake intervals ([{start,end}] epoch ms).
 *
 * `from` should be where the power log starts (it keeps only about a week).
 * With so few days per weekday, a weekday with fewer than `minDays` observed
 * days borrows the pooled hour-of-day fraction instead of trusting one sample.
 */
export function awakeHistogram(intervals, { from, now, minDays = 3 } = {}) {
  const dayCounts = daysPerWeekday(from, now)
  const awakeDays = new Array(168).fill(0)
  const seen = new Set()
  for (const iv of intervals) {
    const start = Math.max(iv.start, from)
    const end = Math.min(iv.end, now)
    if (!(end > start)) continue
    // Walk the hour slots the interval touches.
    for (let t = Math.floor(start / HOUR_MS) * HOUR_MS; t < end; t += HOUR_MS) {
      const d = new Date(t)
      const key = `${dayKey(d)}#${d.getHours()}`
      if (seen.has(key)) continue
      seen.add(key)
      awakeDays[slotIndex(d.getDay(), d.getHours())]++
    }
  }
  const pooledDays = dayCounts.reduce((a, b) => a + b, 0)
  const pooled = new Array(24).fill(0)
  for (let h = 0; h < 24; h++) {
    let n = 0
    for (let w = 0; w < 7; w++) n += awakeDays[slotIndex(w, h)]
    pooled[h] = pooledDays > 0 ? Math.min(1, n / pooledDays) : 0
  }
  const fraction = awakeDays.map((n, i) => {
    const w = Math.floor(i / 24)
    return dayCounts[w] >= minDays ? Math.min(1, n / dayCounts[w]) : pooled[i % 24]
  })
  return { awakeDays, dayCounts, fraction, pooled, from, to: now, observedDays: pooledDays }
}

/**
 * Parse `pmset -g log` into full-wake intervals. A full wake starts at a
 * `Wake` event (or "Display is turned on") and ends at the next `Sleep`.
 * `DarkWake` (maintenance wakes with the display off) never counts as awake.
 * An interval still open at the end of the log closes at `now`.
 */
export function parsePmsetAwake(text, { now = Date.now() } = {}) {
  const lineRe = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{2})(\d{2}) (.+?)(?:\s{2,}|\t)(.*)$/
  const intervals = []
  let open = null
  let first = null
  for (const raw of text.split('\n')) {
    const m = lineRe.exec(raw)
    if (!m) continue
    const ts = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
    if (!Number.isFinite(ts)) continue
    if (first === null || ts < first) first = ts
    const name = m[5].trim()
    const rest = m[6].trim()
    const wakes = name === 'Wake' || (name === 'Notification' && /^Display is turned on/.test(rest))
    if (wakes) {
      if (open === null) open = ts
    } else if (name === 'Sleep') {
      if (open !== null && ts > open) intervals.push({ start: open, end: ts })
      open = null
    }
  }
  if (open !== null && now > open) intervals.push({ start: open, end: now })
  return { intervals, from: first }
}

function confidenceOf({ usageActiveDays, awakeDays }) {
  if (usageActiveDays < 30) return 'low'
  if (awakeDays < 5) return 'low'
  // The power log only reaches back about a week, so 'high' needs a longer one.
  return usageActiveDays >= 120 && awakeDays >= 14 ? 'high' : 'medium'
}

/**
 * Rank candidate slots, least-used first among usually-awake ones.
 *
 * Options: `usage` (usageHistogram result), `awake` (awakeHistogram result or
 * null when there's no power log), `minAwake`, `topN`, `onePerDay` (suggest
 * different weekdays so the three picks are real alternatives).
 *
 * With no awake data every hour is eligible but 00:00-06:59 is skipped, so a
 * missing power log can't recommend 3am.
 *
 * Returns { picks: [{ weekday, hour, minute, label, score, usedDays, ofDays,
 * nextUsedDays, awakeFraction, evidence }], confidence, fallback }.
 */
export function rankSlots({ usage, awake = null, minAwake = MIN_AWAKE, topN = 3, onePerDay = true } = {}) {
  // A weekday has only a handful of samples (4 Tuesdays in a month), so the
  // slot's own history is blended 50/50 with how busy that hour of the day is
  // across all days. The weekday-specific part still separates equal hours.
  const totalDays = usage.dayCounts.reduce((a, b) => a + b, 0)
  const overall = new Array(24).fill(0)
  const overallDays = new Array(24).fill(0)
  for (let h = 0; h < 24; h++) {
    for (let w = 0; w < 7; w++) overallDays[h] += usage.activeDays[slotIndex(w, h)]
    overall[h] = totalDays > 0 ? overallDays[h] / totalDays : 0
  }
  const candidates = []
  for (let w = 0; w < 7; w++) {
    if (usage.dayCounts[w] === 0) continue
    for (let h = 0; h < 24; h++) {
      const i = slotIndex(w, h)
      const awakeFrac = awake ? awake.fraction[i] : (h >= 7 ? 1 : 0)
      if (awakeFrac < minAwake) continue
      const next = slotIndex(h === 23 ? (w + 1) % 7 : w, (h + 1) % 24)
      const own = usage.fraction[i] + 0.5 * usage.fraction[next]
      const pooled = overall[h] + 0.5 * overall[(h + 1) % 24]
      const score = 0.5 * own + 0.5 * pooled
      candidates.push({ w, h, i, next, score, awakeFrac })
    }
  }
  // Least used first; then the Mac being awake more reliably; then the hour
  // closest to 10:00 (a sane tie-break for the all-zero case); then weekday.
  candidates.sort((a, b) =>
    a.score - b.score
    || b.awakeFrac - a.awakeFrac
    || Math.abs(a.h - 10) - Math.abs(b.h - 10)
    || a.w - b.w)

  const picks = []
  const usedDays = new Set()
  for (const c of candidates) {
    if (onePerDay && usedDays.has(c.w)) continue
    usedDays.add(c.w)
    const ofDays = usage.dayCounts[c.w]
    const pick = {
      weekday: c.w,
      hour: c.h,
      minute: 0,
      label: formatSlot({ weekday: c.w, hour: c.h }),
      score: Number(c.score.toFixed(3)),
      usedDays: usage.activeDays[c.i],
      ofDays,
      nextUsedDays: usage.activeDays[c.next],
      overallUsedDays: overallDays[c.h],
      overallDays: totalDays,
      awakeFraction: awake ? Number(c.awakeFrac.toFixed(2)) : null,
    }
    pick.evidence = describePick(pick, awake)
    picks.push(pick)
    if (picks.length >= topN) break
  }

  if (picks.length === 0) {
    const f = { ...FALLBACK_SLOT, label: formatSlot(FALLBACK_SLOT), score: null, usedDays: 0, ofDays: 0, nextUsedDays: 0, overallUsedDays: 0, overallDays: 0, awakeFraction: null }
    f.evidence = 'No usable activity data, so this is the built-in default.'
    return { picks: [f], confidence: 'low', fallback: true }
  }
  const usageActiveDays = usage.activeDays.reduce((a, b) => a + b, 0)
  return {
    picks,
    confidence: confidenceOf({ usageActiveDays, awakeDays: awake ? awake.observedDays : 0 }),
    fallback: false,
  }
}

function describePick(p, awake) {
  const day = WEEKDAY_NAMES[p.weekday]
  const hh = String(p.hour).padStart(2, '0')
  const parts = [`Claude active in the ${hh}:00 hour on ${p.usedDays} of ${p.ofDays} ${day}s`]
  parts.push(`${p.overallUsedDays} of ${p.overallDays} days at that hour overall`)
  parts.push(`${p.nextUsedDays} in the hour after on that weekday`)
  parts.push(awake ? `Mac awake then on ${Math.round(p.awakeFraction * 100)}% of days` : 'no power log, awake assumed')
  return parts.join('; ')
}

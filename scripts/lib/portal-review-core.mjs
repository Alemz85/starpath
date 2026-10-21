/**
 * portal-review-core.mjs — pure rules that turn scan evidence into suggestions
 * about which tracked companies to keep, pause or add.
 *
 * The weekly scan gets the user's tracked companies for free (public job-board
 * APIs), so the list can be wide. Companies are added "on probation" (a
 * `# probation since YYYY-MM-DD` comment above the entry in user/portals.yml, or
 * a `PROBATION` notes prefix) and this review turns the scan history into
 * decisions. It only SUGGESTS: portal-review.mjs posts each suggestion to the
 * app's Messages and never edits portals.yml.
 *
 *   pause  a live tracked company with no posting that passed the title +
 *          location filters over at least `pauseMinScans` scans spanning at
 *          least `pauseMinDays` days (the defaults cover a full hiring season:
 *          graduate and intern programmes cluster Sep–Nov and Feb–Mar, so a few
 *          quiet weeks prove nothing), or a board whose endpoint keeps failing.
 *          Dream, lower-tier-dream and brand-affinity companies are never paused.
 *   keep   a probation company that produced a passing posting, or a listing
 *          scored go / stretch / solid.
 *   add    an untracked company that the board-wide queries or the aggregators
 *          keep surfacing, or that scored go / stretch / solid (a tracked but
 *          disabled company with such a score is suggested for re-enabling).
 *
 * Evidence comes from files the scan already writes: scan-history.tsv (every
 * admitted posting, with the dates it was seen), portal-health.tsv (boards that
 * are failing), score-history.tsv (verdicts). Scan days are the dates the API
 * scanner saw any posting; a company is only judged on those days when the
 * scanner can actually reach it (an ATS API provider detects its entry).
 *
 * Dates are ISO day strings. No I/O here (portal-review.mjs does it).
 */

import { normalizeCompany } from './dedup-index.mjs'

export const DEFAULTS = Object.freeze({
  /** pause: at least this many scans… */
  pauseMinScans: 12,
  /** …spanning at least this many days (≈ five months: from late October it reaches the Feb–Mar wave). */
  pauseMinDays: 150,
  /** pause (failing board): this many scans in a row the board's URL failed. */
  failingScans: 3,
  /** add: this many distinct postings of an untracked company… */
  addMinPostings: 2,
  /** …seen on at least this many different scan days. */
  addMinScans: 2,
  /** At most this many new suggestions are posted per run; the rest wait for the next one. */
  maxPerRun: 8,
})

/** Verdicts that make a company worth tracking / keeping. */
export const GOOD_VERDICTS = Object.freeze(['go', 'stretch', 'solid'])

const posInt = (v, fallback, min = 1) => (Number.isFinite(Number(v)) && Math.floor(Number(v)) >= min ? Math.floor(Number(v)) : fallback)

/**
 * `scanner.portal_review` of a parsed user/profile.yml → thresholds; anything
 * missing or invalid falls back per field. `enabled: false` turns the review off.
 */
export function readReviewConfig(profile) {
  const c = profile?.scanner?.portal_review || {}
  return {
    enabled: c.enabled !== false,
    pauseMinScans: posInt(c.pause_min_scans, DEFAULTS.pauseMinScans),
    pauseMinDays: posInt(c.pause_min_days, DEFAULTS.pauseMinDays),
    failingScans: posInt(c.failing_scans, DEFAULTS.failingScans),
    addMinPostings: posInt(c.add_min_postings, DEFAULTS.addMinPostings),
    addMinScans: posInt(c.add_min_scans, DEFAULTS.addMinScans),
    maxPerRun: posInt(c.max_per_run, DEFAULTS.maxPerRun, 0),
  }
}

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim()
const key = (name) => normalizeCompany(clean(name))
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s))
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const slug = (name) => key(name) || clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')

/* ───── Probation marks ──────────────────────────────────────────── */

/**
 * Companies on probation, read from the raw portals.yml text (a YAML parser
 * drops comments): a `# probation since YYYY-MM-DD` line directly above an
 * entry's `- name:` (blank lines and other comments may sit in between).
 * @returns {Map<string, {name: string, since: string}>} by normalized name
 */
export function parseProbation(portalsText) {
  const out = new Map()
  let pending = ''
  for (const line of String(portalsText ?? '').split('\n')) {
    const mark = /^\s*#\s*probation\s+since\s+(\d{4}-\d{2}-\d{2})\b/i.exec(line)
    if (mark) { pending = mark[1]; continue }
    if (!line.trim() || /^\s*#/.test(line)) continue
    const name = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line)
    if (name && pending) {
      const n = name[1].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim()
      if (n && key(n)) out.set(key(n), { name: n, since: pending })
    }
    pending = ''
  }
  return out
}

/** Probation status of a tracked entry: the dated comment wins; a `PROBATION` notes prefix means probation with no known start. */
function probationOf(entry, marks) {
  const m = marks.get(key(entry.name))
  if (m) return { since: m.since }
  if (/^\s*probation\b/i.test(String(entry.notes ?? ''))) return { since: '' }
  return null
}

/* ───── The review ───────────────────────────────────────────────── */

function groupHistory(history) {
  const byCompany = new Map()
  for (const r of history) {
    const k = key(r.company)
    if (!k || !r.url) continue
    if (!byCompany.has(k)) byCompany.set(k, new Map())
    const posting = byCompany.get(k)
    if (!posting.has(r.url)) posting.set(r.url, r)
  }
  return byCompany
}

/** The dates the API scanner ran (any date it saw a posting), ascending. Falls back to every source. */
export function scanDaysOf(history) {
  const collect = (rows) => {
    const days = new Set()
    for (const r of rows) {
      for (const d of [r.first_seen, ...(r.scan_dates || [])]) if (isDay(d)) days.add(d)
    }
    return [...days].sort()
  }
  const api = collect(history.filter((r) => /-api$/.test(String(r.portal || ''))))
  return api.length ? api : collect(history)
}

const scoresByCompany = (scores) => {
  const out = new Map()
  for (const s of scores) {
    const v = String(s.verdict || '').toLowerCase()
    if (!GOOD_VERDICTS.includes(v) || !key(s.company)) continue
    const k = key(s.company)
    if (!out.has(k)) out.set(k, [])
    out.get(k).push({ verdict: v, role: clean(s.role), date: clean(s.date) })
  }
  const order = (v) => GOOD_VERDICTS.indexOf(v)
  for (const list of out.values()) list.sort((a, b) => order(a.verdict) - order(b.verdict))
  return out
}

/** The last day a posting was on its board: its latest scan date (a still-open posting counts as passing today). */
const lastSeenOf = (p) => [p.first_seen, ...(p.scan_dates || [])].filter(isDay).sort().pop() || ''

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * @param {object} input
 * @param {string} input.today                   ISO day
 * @param {ReturnType<typeof readReviewConfig>} [input.config]
 * @param {Array<{name:string, enabled?:boolean, brand?:string, notes?:string}>} input.tracked   portals.yml tracked_companies
 * @param {Map<string,{name:string,since:string}>} [input.probation]   parseProbation()
 * @param {Array<{url:string, company:string, title?:string, portal?:string, first_seen?:string, scan_dates?:string[]}>} input.history
 * @param {Array<{company:string, role?:string, verdict:string, date?:string}>} [input.scores]
 * @param {Array<{company:string, consecutive_404?:number, consecutive_errors?:number, last_error?:string}>} [input.failing]   portal-health rows
 * @param {Iterable<string>} [input.protectedCompanies]   dream / lower-tier-dream / brand-affinity names: never paused
 * @param {Iterable<string>|null} [input.apiCovered]       tracked company names the API scanner reaches (null = assume all)
 * @param {(company:string)=>boolean} [input.isBlacklisted]
 * @returns {Array<{action:'keep'|'pause'|'add', variant:string, company:string, key:string, rank:number, title:string, body:string, evidence:object}>}
 *          every applicable suggestion, strongest first (the caller applies maxPerRun and dedup)
 */
export function reviewPortals({
  today, config = readReviewConfig(null), tracked = [], probation = new Map(), history = [], scores = [],
  failing = [], protectedCompanies = [], apiCovered = null, isBlacklisted = () => false,
}) {
  const cfg = { ...readReviewConfig(null), ...config }
  const out = []
  const trackedByKey = new Map(tracked.filter((c) => c?.name && key(c.name)).map((c) => [key(c.name), c]))
  const postings = groupHistory(history)
  const good = scoresByCompany(scores)
  const scanDays = scanDaysOf(history)
  const protectedKeys = new Set([...protectedCompanies].map(key).filter(Boolean))
  const covered = apiCovered ? new Set([...apiCovered].map(key)) : null
  const failByKey = new Map()
  for (const f of failing) {
    const k = key(f.company)
    if (!k) continue
    const cur = failByKey.get(k)
    const n = Math.max(Number(f.consecutive_404) || 0, Number(f.consecutive_errors) || 0)
    if (!cur || n > cur.n) failByKey.set(k, { n, error: clean(f.last_error), is404: (Number(f.consecutive_404) || 0) >= (Number(f.consecutive_errors) || 0) })
  }

  const bestPosting = (k) => {
    const list = [...(postings.get(k)?.values() ?? [])]
    return list.sort((a, b) => String(b.first_seen || '').localeCompare(String(a.first_seen || '')))[0] ?? null
  }
  const quote = (p) => (p?.title ? `“${clean(p.title)}”${p.first_seen ? ` (first seen ${p.first_seen})` : ''}` : '')
  const goodLine = (k) => {
    const g = good.get(k)
    return g?.length ? g.slice(0, 3).map((x) => `${x.verdict}${x.role ? ` — ${x.role}` : ''}`).join('; ') : ''
  }

  /* tracked companies: pause / keep */
  for (const [k, entry] of trackedByKey) {
    const name = clean(entry.name)
    const enabled = entry.enabled !== false
    const hits = [...(postings.get(k)?.values() ?? [])]
    const prob = probationOf(entry, probation)

    if (!enabled) {
      const g = good.get(k)
      if (g?.length && !isBlacklisted(name)) {
        out.push({
          action: 'add', variant: 'reenable', company: name, key: `portal-review:add:${slug(name)}`, rank: 80,
          title: `Re-enable ${name}? Scored ${g[0].verdict}`,
          body: [
            `**${name}** is switched off in \`user/portals.yml\` but a listing from it scored well: ${goodLine(k)}.`,
            '',
            'To track it again, set `enabled: true` on its entry. I never edit the file.',
            '',
            'Resolve once you have decided; dismiss to leave it off (I will not suggest it again).',
          ].join('\n'),
          evidence: { verdicts: g.map((x) => x.verdict) },
        })
      }
      continue
    }

    /* failing board */
    const f = failByKey.get(k)
    const failingNow = f && f.n >= cfg.failingScans
    /* quiet over a season */
    let quiet = null
    if (!protectedKeys.has(k) && (covered === null || covered.has(k))) {
      const lastHit = hits.map(lastSeenOf).filter(Boolean).sort().pop() || ''
      const floor = prob?.since && isDay(prob.since) ? prob.since : ''
      // Quiet scans: those on or after the probation start and strictly after the last passing posting.
      const window = scanDays.filter((d) => d >= floor && (!lastHit || d > lastHit))
      if (window.length >= cfg.pauseMinScans) {
        const span = daysBetween(window[0], window[window.length - 1])
        if (span >= cfg.pauseMinDays) quiet = { scans: window.length, span, from: window[0], to: window[window.length - 1], lastHit }
      }
    }
    if (quiet && !good.get(k)) {
      const brandNote = entry.brand ? `\n- Brand: ${entry.brand}` : ''
      out.push({
        action: 'pause', variant: 'quiet', company: name, key: `portal-review:pause:${slug(name)}`, rank: 50 + Math.min(quiet.span, 400) / 10,
        title: `Pause ${name}? No matching role in ${plural(quiet.scans, 'scan')}`,
        body: [
          `**${name}** has had no posting pass your title and location filters across ${plural(quiet.scans, 'scan')} spanning ${plural(quiet.span, 'day')} (${quiet.from} → ${quiet.to}).`,
          '',
          `- Scans counted: ${quiet.scans} (needs ${cfg.pauseMinScans}+ over ${cfg.pauseMinDays}+ days, so a full intake season is covered)`,
          `- Passing postings in that window: 0${quiet.lastHit ? `; the last one was on its board until ${quiet.lastHit}` : ' (none ever)'}`,
          ...(prob ? [`- On probation${prob.since ? ` since ${prob.since}` : ''}`] : []),
          ...(brandNote ? [brandNote.trim()] : []),
          ...(f ? [`- Board also failing: ${f.n} scans in a row${f.error ? ` (${f.error})` : ''}`] : []),
          '',
          'To pause it, set `enabled: false` on its entry in `user/portals.yml` (I never edit the file); an API company costs a fetch per scan, so pausing it saves little but cuts noise.',
          '',
          'Resolve once you have decided; dismiss to keep tracking it (I will not suggest it again).',
        ].join('\n'),
        evidence: { scans: quiet.scans, spanDays: quiet.span, from: quiet.from, to: quiet.to },
      })
    } else if (failingNow && !protectedKeys.has(k)) {
      out.push({
        action: 'pause', variant: 'failing', company: name, key: `portal-review:pause:${slug(name)}`, rank: 60,
        title: `Fix or pause ${name}? Its board keeps failing`,
        body: [
          `The board for **${name}** has failed ${plural(f.n, 'scan')} in a row${f.is404 ? ' (not found)' : ''}${f.error ? `: ${f.error}` : ''}.`,
          '',
          '- Check its `careers_url` / `api` in `user/portals.yml` (a moved board, a changed slug, a host that blocks the scanner), or pause it with `enabled: false`.',
          `- Threshold: ${cfg.failingScans} failing scans in a row.`,
          '',
          'Resolve once you have decided; dismiss to keep it as is (I will not suggest it again).',
        ].join('\n'),
        evidence: { failingScans: f.n, error: f.error },
      })
    }

    /* keep (probation only) */
    if (prob) {
      const g = good.get(k)
      const since = prob.since && isDay(prob.since) ? prob.since : ''
      const recent = since ? hits.filter((h) => !lastSeenOf(h) || lastSeenOf(h) >= since) : hits
      if (g?.length || recent.length) {
        const best = bestPosting(k)
        const days = since ? daysBetween(since, today) : null
        out.push({
          action: 'keep', variant: g?.length ? 'scored' : 'posting', company: name, key: `portal-review:keep:${slug(name)}`, rank: g?.length ? 75 : 70 + Math.min(recent.length, 10) / 10,
          title: g?.length ? `Keep ${name}? A listing scored ${g[0].verdict}` : `Keep ${name}? ${plural(recent.length, 'posting')} passed your filters`,
          body: [
            `**${name}** has earned its place${since ? ` after ${plural(days, 'day')} on probation (since ${since})` : ' on probation'}.`,
            '',
            `- Postings that passed your title and location filters: ${recent.length}${best ? `; latest ${quote(best)}` : ''}`,
            ...(g?.length ? [`- Scored: ${goodLine(k)}`] : []),
            '',
            'To make it permanent, delete the `# probation since …` comment (and the `PROBATION` notes prefix) on its entry in `user/portals.yml`. I never edit the file.',
            '',
            'Resolve once you have decided; dismiss if you would rather leave it as is (I will not suggest it again).',
          ].join('\n'),
          evidence: { postings: recent.length, verdicts: g?.map((x) => x.verdict) ?? [], since },
        })
      }
    }
  }

  /* untracked companies: add */
  const untracked = new Set([...postings.keys(), ...good.keys()].filter((k) => !trackedByKey.has(k)))
  for (const k of untracked) {
    const list = [...(postings.get(k)?.values() ?? [])]
    const name = clean(list[0]?.company || good.get(k)?.[0]?.company || '')
    if (!name || isBlacklisted(name)) continue
    const days = new Set()
    for (const p of list) for (const d of [p.first_seen, ...(p.scan_dates || [])]) if (isDay(d)) days.add(d)
    const g = good.get(k)
    const surfaced = list.length >= cfg.addMinPostings && days.size >= cfg.addMinScans
    if (!surfaced && !g?.length) continue
    const sources = [...new Set(list.map((p) => clean(p.portal)).filter(Boolean))]
    const best = bestPosting(k)
    out.push({
      action: 'add', variant: g?.length ? 'scored' : 'surfaced', company: name, key: `portal-review:add:${slug(name)}`, rank: g?.length ? 80 : 40 + Math.min(list.length, 20) / 2,
      title: g?.length ? `Track ${name}? A listing scored ${g[0].verdict}` : `Track ${name}? Seen in ${plural(list.length, 'posting')}`,
      body: [
        `**${name}** is not in \`tracked_companies\` but keeps turning up${sources.length ? ` via ${sources.join(', ')}` : ''}.`,
        '',
        `- Distinct postings that passed your filters: ${list.length}, over ${plural(days.size, 'scan day')}`,
        ...(best ? [`- Latest: ${quote(best)}${best.url ? ` — ${best.url}` : ''}`] : []),
        ...(g?.length ? [`- Scored: ${goodLine(k)}`] : []),
        '',
        'To track it, add an entry under `tracked_companies` in `user/portals.yml` with its careers page (mark it `# probation since …` to let the weekly review judge it). I never edit the file.',
        '',
        'Resolve once you have decided; dismiss to ignore it (I will not suggest it again).',
      ].join('\n'),
      evidence: { postings: list.length, scanDays: days.size, sources, verdicts: g?.map((x) => x.verdict) ?? [] },
    })
  }

  return out.sort((a, b) => b.rank - a.rank || a.company.localeCompare(b.company))
}

/** The post input (messages-core `buildPost`) for one suggestion. */
export function postFromReview(s) {
  return { source: 'scan', kind: 'suggestion', key: s.key, title: s.title, body: s.body, links: ['user/portals.yml'] }
}

/**
 * Which suggestions to post now: those whose key no message has ever used
 * (open, dismissed and resolved all mean the user has seen it), strongest
 * first, at most `maxPerRun`. One suggestion per key (the first, i.e. strongest).
 * @param {Array<{key:string}>} suggestions   from reviewPortals
 * @param {Array<{key?:string}>} messages     folded messages (any status)
 */
export function selectToPost(suggestions, messages, maxPerRun = DEFAULTS.maxPerRun) {
  const seen = new Set(messages.map((m) => m.key).filter(Boolean))
  const picked = []
  for (const s of suggestions) {
    if (picked.length >= maxPerRun) break
    if (seen.has(s.key)) continue
    seen.add(s.key)
    picked.push(s)
  }
  return picked
}

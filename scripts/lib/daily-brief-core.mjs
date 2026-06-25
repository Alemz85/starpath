// daily-brief-core.mjs — pure assembly logic for the daily/weekly job-search brief.
//
// Several read-only analysis cores already exist, each answering one slice of
// "where does my search stand":
//
//   • whats-new-core.mjs    — fresh, high-fit postings since the last scan.
//   • followup-cadence.mjs  — applications whose follow-up is due/overdue.
//   • outreach-core.mjs     — outreach threads where a nudge is due now.
//   • positioning-core.mjs  — the one standing targeting insight across the corpus.
//
// Nothing bundles them into a single "what should I do now?" artifact the user
// can read, cron, or email. That is this module's job. It does NOT re-implement
// any of that math — the CLI wrapper (scripts/daily-brief.mjs) runs each core's
// own pure functions over the canonical files and hands the *already-computed*
// outputs here. This module only:
//
//   1. normalizes each core's output into a uniform list of "action" items,
//   2. ranks them into sections by urgency / leverage,
//   3. renders one dated markdown brief.
//
// Everything here is a pure function of its inputs — no filesystem, no clock,
// no globals, no mutation. That keeps it exhaustively unit-testable, and keeps
// the imported cores untouched (this is a composition layer, not a fork).

/* ───── Section model ───────────────────────────────────────────────────────
 *
 * The brief is organized into ordered sections, each a bucket of action items.
 * Order = the sequence a reader should work top-to-bottom: time-sensitive
 * obligations first (a due follow-up / nudge decays if missed), then fresh
 * opportunities to act on, then the one standing strategic note.
 *
 *   followups  — applications with an overdue/urgent follow-up. Most decay-
 *                sensitive: a stale thread cools fast. Top of the brief.
 *   outreach   — outreach threads where a nudge is due now.
 *   newhits    — fresh, high-fit postings worth evaluating/applying to.
 *   insight    — one standing positioning insight (not an item to "do today",
 *                but the lens to keep in mind while doing the above).
 */
export const SECTION_ORDER = ['followups', 'outreach', 'newhits', 'insight']

export const SECTION_META = {
  followups: { title: 'Follow-ups due', kind: 'action' },
  outreach: { title: 'Outreach nudges due', kind: 'action' },
  newhits: { title: 'Fresh high-fit postings', kind: 'action' },
  insight: { title: 'Standing positioning note', kind: 'insight' },
}

/* ───── Date helpers (string YYYY-MM-DD, lexicographic = chronological) ──────*/
function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/* ───── Normalizers: each core's output → uniform action items ───────────────
 *
 * A uniform item is:
 *   { key, label, sub, urgency, sortKey, meta }
 * where
 *   key      — stable identity (for dedup / linking), `company|role`-ish.
 *   label    — the headline line (e.g. "Acme — Strategy Analyst").
 *   sub      — the one-line "why it's here / what to do".
 *   urgency  — numeric, lower = more urgent (drives intra-section sort).
 *   sortKey  — tiebreak (e.g. days overdue, score), higher = earlier.
 *   meta     — passthrough for the renderer (score, date, url, …).
 */

/**
 * Follow-up items from followup-cadence analysis output.
 * We surface only the genuinely-actionable ones: `overdue` and `urgent`.
 * `waiting` (on-track) and `cold` (maxed out) are noise for a "do now" brief.
 *
 * @param {object} followupResult  shape: { entries: [...] } or { error }
 */
export function followupItems(followupResult) {
  if (!followupResult || followupResult.error || !Array.isArray(followupResult.entries)) {
    return []
  }
  const URGENCY_RANK = { urgent: 0, overdue: 1 }
  const items = []
  for (const e of followupResult.entries) {
    if (e.urgency !== 'overdue' && e.urgency !== 'urgent') continue
    const days = Number.isFinite(e.daysSinceApplication) ? e.daysSinceApplication : 0
    const role = e.role || ''
    const contact = Array.isArray(e.contacts) && e.contacts[0] ? e.contacts[0].email : null
    const what = e.urgency === 'urgent'
      ? `Respond now — ${e.status}, ${days}d since applied`
      : `Follow up — ${e.status}, ${days}d since applied, ${e.followupCount || 0} sent`
    items.push({
      key: `${(e.company || '').toLowerCase()}|${role.toLowerCase()}`,
      label: role ? `${e.company} — ${role}` : e.company,
      sub: contact ? `${what} · ${contact}` : what,
      urgency: URGENCY_RANK[e.urgency] ?? 2,
      sortKey: days, // more days overdue → surface earlier within same urgency
      meta: {
        status: e.status,
        score: e.score,
        daysSince: days,
        followupCount: e.followupCount || 0,
        nextFollowupDate: e.nextFollowupDate || null,
        reportPath: e.reportPath || null,
      },
    })
  }
  return items.sort((a, b) => a.urgency - b.urgency || b.sortKey - a.sortKey)
}

/**
 * Outreach items from outreach-core.classifyAll output.
 * Only `nudge` (a follow-up is due now) belongs in a "do now" brief.
 *
 * @param {object} outreachResult  shape: { entries: [...] } (classifyAll output)
 */
export function outreachItems(outreachResult) {
  if (!outreachResult || !Array.isArray(outreachResult.entries)) return []
  const items = []
  for (const e of outreachResult.entries) {
    if (e.action !== 'nudge') continue
    const days = Number.isFinite(e.daysSince) ? e.daysSince : 0
    const who = e.contact || 'contact'
    items.push({
      key: `${(e.company || '').toLowerCase()}|${who.toLowerCase()}`,
      label: e.role ? `${e.company} — ${e.role}` : (e.company || who),
      sub: `${e.reason || 'Nudge due'} · ${who}${e.channel ? ` (${e.channel})` : ''}`,
      urgency: 0,
      sortKey: days, // longer since last touch → more overdue → earlier
      meta: {
        contact: who,
        title: e.title || null,
        channel: e.channel || null,
        daysSince: days,
        lastTouch: e.lastTouch || null,
        touches: e.touches ?? null,
      },
    })
  }
  return items.sort((a, b) => b.sortKey - a.sortKey)
}

/**
 * Fresh-hit items from whats-new-core.buildDigest output.
 * We surface the `prioritize` bucket (new AND high-fit) plus the `needs-eval`
 * bucket (new, unscored — go evaluate), capped so the brief stays scannable.
 *
 * @param {object} digest  buildDigest output: { items, prioritize, needsEval, ... }
 * @param {object} opts    { maxPrioritize, maxNeedsEval }
 */
export function newHitItems(digest, { maxPrioritize = 8, maxNeedsEval = 5 } = {}) {
  if (!digest || !Array.isArray(digest.items)) return []
  const items = []

  const prioritize = (digest.prioritize || []).slice(0, maxPrioritize)
  for (const it of prioritize) {
    items.push({
      key: `${(it.company || '').toLowerCase()}|${(it.title || '').toLowerCase()}`,
      label: it.title ? `${it.company} — ${it.title}` : it.company,
      sub: scoreSub(it) + (it.location ? ` · ${it.location}` : '') + ageSuffix(it),
      urgency: 0,
      sortKey: Number.isFinite(it.overall) ? it.overall : 0,
      meta: {
        kind: 'prioritize',
        overall: it.overall ?? null,
        band: it.band || null,
        location: it.location || '',
        url: it.url || null,
        ageDays: it.ageDays ?? null,
        archetype: it.archetype || null,
      },
    })
  }

  const needsEval = (digest.needsEval || []).slice(0, maxNeedsEval)
  for (const it of needsEval) {
    items.push({
      key: `${(it.company || '').toLowerCase()}|${(it.title || '').toLowerCase()}`,
      label: it.title ? `${it.company} — ${it.title}` : it.company,
      sub: `Unscored — run scouting${it.location ? ` · ${it.location}` : ''}${ageSuffix(it)}`,
      urgency: 1, // after the already-scored prioritize hits
      sortKey: 0,
      meta: {
        kind: 'needs-eval',
        location: it.location || '',
        url: it.url || null,
        ageDays: it.ageDays ?? null,
      },
    })
  }

  return items.sort((a, b) => a.urgency - b.urgency || b.sortKey - a.sortKey)
}

function scoreSub(it) {
  if (!Number.isFinite(it.overall)) return 'Scored'
  const star = it.band === 'strong' ? '★★' : it.band === 'solid' ? '★' : ''
  return `${it.overall.toFixed(1)}/10${star ? ` ${star}` : ''}`
}

function ageSuffix(it) {
  return Number.isFinite(it.ageDays) && it.ageDays > 0 ? ` · ${it.ageDays}d old` : ''
}

/**
 * The single standing positioning insight from positioning-core output.
 * Not an "item to do today" — a one-paragraph lens. We pull the systemic
 * binding constraint + its cheapest cross-archetype lever, falling back to the
 * landscape's strongest archetype if no systemic constraint binds.
 *
 * Returns a single-element array (or empty) so it slots into the section model.
 *
 * @param {object} intel  positioningIntel output, or { error }
 */
export function insightItems(intel) {
  if (!intel || intel.error) return []
  const sys = intel.systemicConstraint

  if (sys && sys.dominant) {
    const d = sys.dominant
    const names = d.archetypes || []
    const where = names.length > 2
      ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
      : names.join(', ')
    let sub = `"${d.label}" is the binding constraint across ${d.count} archetype(s)` +
      (where ? ` (${where})` : '') + '.'
    if (sys.lever) {
      sub += ` The highest-leverage move: lift ${sys.lever.label}` +
        ` (re-bands ${sys.lever.count} archetype(s), avg +${sys.lever.avgLift}).`
    }
    return [{
      key: `insight|${d.dimension}`,
      label: `Targeting: ${d.label} is your systemic blocker`,
      sub,
      urgency: 0,
      sortKey: 0,
      meta: { kind: 'systemic-constraint', dimension: d.dimension, archetypes: names },
    }]
  }

  // Fallback: no single dimension binds → point at the strongest archetype.
  // positioning-core sorts `fingerprints` strongest-first (by avgOverall).
  const top = (Array.isArray(intel.fingerprints) && intel.fingerprints[0]) || null
  if (top && top.archetype) {
    return [{
      key: `insight|${top.archetype}`,
      label: `Targeting: lean into ${top.archetype}`,
      sub: `Your strongest-scoring archetype` +
        (Number.isFinite(top.avgOverall) ? ` (avg ${round1(top.avgOverall)}/10)` : '') +
        ` — concentrate sourcing there.`,
      urgency: 0,
      sortKey: 0,
      meta: { kind: 'top-archetype', archetype: top.archetype },
    }]
  }
  return []
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/* ───── Assembly ─────────────────────────────────────────────────────────────
 *
 * Compose the normalized items into a single brief object. The caller passes
 * already-computed core outputs (the CLI runs the cores' own pure functions);
 * this stays a pure transform.
 *
 * @param {object} inputs
 *   - digest          whats-new buildDigest output (or null)
 *   - followupResult  followup-cadence analysis output (or null)
 *   - outreachResult  outreach classifyAll output (or null)
 *   - positioningIntel positioning-core positioningIntel output (or null)
 * @param {object} opts
 *   - asOf      YYYY-MM-DD "today" for the brief header (required for a dated brief)
 *   - period    'daily' | 'weekly' (label only; affects the header wording)
 *   - maxPrioritize / maxNeedsEval  caps passed to newHitItems
 *
 * @returns {object} brief:
 *   { asOf, period, sections: [{ id, title, kind, items }], counts, totalActions,
 *     topAction }
 */
export function assembleBrief(inputs = {}, opts = {}) {
  const asOf = isValidDate(opts.asOf) ? opts.asOf.trim() : null
  const period = opts.period === 'weekly' ? 'weekly' : 'daily'

  const byId = {
    followups: followupItems(inputs.followupResult),
    outreach: outreachItems(inputs.outreachResult),
    newhits: newHitItems(inputs.digest, opts),
    insight: insightItems(inputs.positioningIntel),
  }

  const sections = SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_META[id].title,
    kind: SECTION_META[id].kind,
    items: byId[id],
  }))

  const counts = {}
  let totalActions = 0
  for (const s of sections) {
    counts[s.id] = s.items.length
    if (s.kind === 'action') totalActions += s.items.length
  }

  // The single highest-value next action: first item of the first non-empty
  // ACTION section in SECTION_ORDER (insight is a note, never the top action).
  let topAction = null
  for (const s of sections) {
    if (s.kind !== 'action') continue
    if (s.items.length) {
      topAction = { section: s.id, sectionTitle: s.title, item: s.items[0] }
      break
    }
  }

  return { asOf, period, sections, counts, totalActions, topAction }
}

/* ───── Markdown renderer ────────────────────────────────────────────────────
 *
 * Render the assembled brief into one portable markdown document the user can
 * read, cron to a file, or pipe into an email. Pure: brief object → string.
 */
export function renderBrief(brief) {
  const L = []
  const dateLabel = brief.asOf || 'undated'
  const periodWord = brief.period === 'weekly' ? 'Weekly' : 'Daily'

  L.push(`# ${periodWord} job-search brief — ${dateLabel}`)
  L.push('')

  // ── Headline: the one thing to do, + a scoreboard. ──
  if (brief.totalActions === 0) {
    L.push('_Nothing time-sensitive right now._ No due follow-ups, outreach nudges, or fresh high-fit postings.')
    L.push('')
  } else {
    if (brief.topAction) {
      const ta = brief.topAction
      L.push(`**Do this first:** ${ta.item.label} — ${ta.item.sub} _(${ta.sectionTitle})_`)
      L.push('')
    }
    const board = SECTION_ORDER
      .filter((id) => SECTION_META[id].kind === 'action' && brief.counts[id] > 0)
      .map((id) => `${brief.counts[id]} ${SECTION_META[id].title.toLowerCase()}`)
      .join(' · ')
    L.push(`_${brief.totalActions} action(s):_ ${board}`)
    L.push('')
  }

  // ── Sections. ──
  for (const s of brief.sections) {
    if (s.items.length === 0) continue
    L.push(`## ${s.title}`)
    L.push('')
    if (s.kind === 'insight') {
      // Insight renders as prose, not a checklist.
      for (const it of s.items) {
        L.push(`**${it.label}.** ${it.sub}`)
        L.push('')
      }
      continue
    }
    for (const it of s.items) {
      const line = renderActionLine(s.id, it)
      L.push(`- ${line}`)
    }
    L.push('')
  }

  // Footer: provenance so a cron'd/emailed copy is self-describing.
  L.push('---')
  L.push(`_Generated ${dateLabel} · read-only over canonical job-search data · \`scripts/daily-brief.mjs\`._`)
  L.push('')

  return L.join('\n')
}

function renderActionLine(sectionId, it) {
  let head = `**${it.label}**`
  // Link fresh postings to their URL when present.
  if (sectionId === 'newhits' && it.meta && it.meta.url) {
    head = `**[${it.label}](${it.meta.url})**`
  }
  return `${head} — ${it.sub}`
}

/* ───── Convenience: render straight from raw core outputs ───────────────────*/
export function buildBriefMarkdown(inputs, opts) {
  return renderBrief(assembleBrief(inputs, opts))
}

export { isValidDate as _isValidDate, daysBetween as _daysBetween }

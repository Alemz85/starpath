// Outcomes heads-up — the "what are my own outcomes teaching me?" lesson.
//
// The Today cockpit (lib/todayCockpit.ts) answers "what should I do next?" by
// ranking forward-looking actions (deadlines, follow-ups, nudges, fresh hits).
// It deliberately says nothing about the *backward*-looking signal: of the
// applications you've already worked, which ones converted and which died —
// and is there a pattern worth correcting before you send the next one?
//
// That learned-lesson slice is exactly what the backend daily-brief surfaces
// as its `headsup` (scripts/analyze-patterns.mjs → daily-brief-core.mjs). But
// that path spawns a Claude/Node run; the cockpit needs something it can show
// instantly from data already in the store. This module is that: a pure,
// token-free synthesis over the renderer view-models — applications (the only
// place outcomes live) joined to score-history (for the archetype + the score
// each application carried) — that distills ONE honest targeting lesson.
//
// Honesty rules, carried over from lib/trendsAnalytics.ts and lib/todayCockpit:
//   • only DECIDED applications count (a win or a loss) — pending rows can't
//     teach a lesson yet;
//   • below a sample floor we report nothing rather than read noise as signal
//     (the cockpit then shows no banner — never a generic "keep going" filler);
//   • the comparison is a real contrast (winners vs losers), and a lesson only
//     surfaces when the gap between the two groups clears a deadband;
//   • everything is a pure function of its inputs, so the synthesis is
//     exhaustively unit-testable.

import type { ApplicationEntry, ScoreEntry, AppStatus } from '@/types'

// ─── Outcome taxonomy ─────────────────────────────────────────────────────────

// A "win" is any application that drew real engagement from the other side —
// a reply, an interview, or an offer. These are the outcomes worth reproducing.
const WIN_STATUSES: ReadonlySet<AppStatus> = new Set(['Responded', 'Interview', 'Offer'])
// A "loss" is a decided negative outcome. Rejected is an explicit no; Discarded
// is the candidate walking away (the listing closed, or it stopped being worth
// pursuing) — both are "this didn't convert", which is what the lesson contrasts
// wins against. SKIP never entered the funnel, so it's neither.
const LOSS_STATUSES: ReadonlySet<AppStatus> = new Set(['Rejected', 'Discarded'])
// Applied with no further movement is genuinely undecided — it might still
// convert — so it's excluded from both groups rather than counted as a loss.

export type Outcome = 'win' | 'loss'

export function classifyOutcome(status: AppStatus): Outcome | null {
  if (WIN_STATUSES.has(status)) return 'win'
  if (LOSS_STATUSES.has(status)) return 'loss'
  return null
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

// Minimum DECIDED applications before any lesson is trustworthy. Under this the
// win/loss split is a coin flip on one or two listings — the cockpit shows no
// heads-up rather than asserting a pattern. Mirrors the spirit of
// MIN_WINNERS_FOR_DELTA / MIN_PER_HALF_FOR_MOMENTUM in trendsAnalytics.
export const MIN_DECIDED = 5
// Each side of the contrast needs at least this many rows for the comparison to
// be a real contrast and not "the 4 wins vs the 1 loss".
export const MIN_PER_GROUP = 2

// A score gap (on the 0–10 scale) below this between winners' and losers' mean
// reads as flat — scoring is coarse, so sub-0.5 wobble between two small groups
// is noise, not a lesson.
export const SCORE_GAP_DEADBAND = 0.5

// An archetype must own at least this share of LOSSES (and clear a count floor)
// before "this archetype keeps not converting" is worth flagging — otherwise a
// single rejection in a rare bucket would masquerade as a trend.
export const ARCHETYPE_LOSS_SHARE = 0.5
export const ARCHETYPE_LOSS_MIN = 3

// ─── Public types ─────────────────────────────────────────────────────────────

export type HeadsUpKind = 'score-gap' | 'archetype-drag' | 'win-streak'
export type HeadsUpTone = 'positive' | 'caution' | 'neutral'

export interface OutcomesHeadsUp {
  kind: HeadsUpKind
  tone: HeadsUpTone
  /** One short headline phrase — the lesson in a glance. */
  title: string
  /** A supporting sentence with the concrete numbers behind the lesson. */
  detail: string
  /** Counts feeding the lesson, for a small "n wins · n losses" caption. */
  wins: number
  losses: number
}

export interface OutcomesInput {
  applications: ApplicationEntry[]
  /** Score-history rows — used to recover each application's archetype + the
   *  numeric overall it carried (applications.md stores score as a string). */
  scoreHistory: ScoreEntry[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// applications.md stores the score as "7.2/10"; recover the number. Returns
// null for non-/10 or unparseable values so a legacy row never mis-ranks a
// lesson by an order of magnitude.
export function parseAppScore(raw: string): number | null {
  const m = (raw ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*10$/)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

const norm = (s: string): string => (s ?? '').trim().toLowerCase()

// Build a (company|role) → latest ScoreEntry index so we can recover an
// application's archetype + dims. Newest row wins on a re-evaluation.
function scoreIndex(scoreHistory: ScoreEntry[]): Map<string, ScoreEntry> {
  const idx = new Map<string, ScoreEntry>()
  for (const e of scoreHistory) {
    const key = `${norm(e.company)}|${norm(e.role)}`
    const prev = idx.get(key)
    if (!prev || (e.date ?? '') > (prev.date ?? '')) idx.set(key, e)
  }
  return idx
}

interface DecidedRow {
  outcome: Outcome
  score: number | null
  archetype: string
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

// ─── Lesson synthesis ─────────────────────────────────────────────────────────

/**
 * Distill the single most useful targeting lesson from the user's own decided
 * outcomes. Returns null when there isn't enough signal — the cockpit then
 * renders no banner (never a generic placeholder).
 *
 * The three candidate lessons, in priority order:
 *   1. archetype-drag — one archetype is eating most of your losses. The most
 *      actionable lesson: "stop spending applications on X".
 *   2. score-gap — your wins score materially higher than your losses, so the
 *      score is predictive: lean on it, don't reach below your bar.
 *   3. win-streak — a healthy conversion rate worth naming (positive
 *      reinforcement; only when nothing corrective applies).
 */
export function buildOutcomesHeadsUp(input: OutcomesInput): OutcomesHeadsUp | null {
  const idx = scoreIndex(input.scoreHistory)

  const decided: DecidedRow[] = []
  for (const a of input.applications) {
    const outcome = classifyOutcome(a.status)
    if (!outcome) continue
    const match = idx.get(`${norm(a.company)}|${norm(a.role)}`)
    const score = parseAppScore(a.score) ?? (match ? match.overall : null) ?? null
    const archetype = (match?.archetype ?? '').trim()
    decided.push({ outcome, score, archetype })
  }

  const wins = decided.filter(d => d.outcome === 'win')
  const losses = decided.filter(d => d.outcome === 'loss')

  // Hard floors — below these we have nothing honest to say.
  if (decided.length < MIN_DECIDED) return null
  if (wins.length < MIN_PER_GROUP || losses.length < MIN_PER_GROUP) {
    // One group is too thin for a contrast. We can still surface a pure-positive
    // win-streak if losses are genuinely rare and wins dominate — but only when
    // the decided sample itself is substantial, so it's not "2 wins, 0 losses".
    return winStreak(wins.length, losses.length)
  }

  // 1. Archetype drag — does one archetype own a dominating share of losses?
  const drag = archetypeDrag(losses, wins)
  if (drag) return drag

  // 2. Score gap — do winners score materially above losers?
  const gap = scoreGap(wins, losses)
  if (gap) return gap

  // 3. Otherwise, a healthy conversion rate is worth naming.
  return winStreak(wins.length, losses.length)
}

// ── 1. Archetype drag ──
function archetypeDrag(losses: DecidedRow[], wins: DecidedRow[]): OutcomesHeadsUp | null {
  const lossByArch = new Map<string, number>()
  for (const l of losses) {
    const k = l.archetype
    if (!k) continue
    lossByArch.set(k, (lossByArch.get(k) ?? 0) + 1)
  }
  if (lossByArch.size === 0) return null

  // The archetype carrying the most losses.
  let topArch = ''
  let topLosses = 0
  for (const [arch, n] of lossByArch) {
    if (n > topLosses) { topArch = arch; topLosses = n }
  }
  const totalLossesWithArch = [...lossByArch.values()].reduce((s, n) => s + n, 0)
  const share = totalLossesWithArch ? topLosses / totalLossesWithArch : 0

  if (topLosses < ARCHETYPE_LOSS_MIN || share < ARCHETYPE_LOSS_SHARE) return null

  // How does that same archetype do on the win side? If it also wins a lot, the
  // losses are just volume, not a targeting problem — suppress the lesson.
  const archWins = wins.filter(w => w.archetype === topArch).length
  if (archWins >= topLosses) return null

  const sharePct = Math.round(share * 100)
  return {
    kind: 'archetype-drag',
    tone: 'caution',
    title: `“${topArch}” roles keep not converting`,
    detail: `${topLosses} of your ${totalLossesWithArch} decided losses were ${topArch} roles (${sharePct}%), against ${archWins} win${archWins === 1 ? '' : 's'} there — worth tightening that archetype or raising the bar before applying.`,
    wins: wins.length,
    losses: losses.length,
  }
}

// ── 2. Score gap ──
function scoreGap(wins: DecidedRow[], losses: DecidedRow[]): OutcomesHeadsUp | null {
  const winScores = wins.map(w => w.score).filter((x): x is number => x !== null)
  const lossScores = losses.map(l => l.score).filter((x): x is number => x !== null)
  if (winScores.length < MIN_PER_GROUP || lossScores.length < MIN_PER_GROUP) return null

  const winMean = mean(winScores)
  const lossMean = mean(lossScores)
  const gap = winMean - lossMean

  if (gap >= SCORE_GAP_DEADBAND) {
    return {
      kind: 'score-gap',
      tone: 'positive',
      title: 'Your score is predicting your wins',
      detail: `Applications that converted scored ${winMean.toFixed(1)} on average vs ${lossMean.toFixed(1)} for the ones that didn't — a ${gap.toFixed(1)}-point edge. Trust the bar; reaching below it has been costing you.`,
      wins: wins.length,
      losses: losses.length,
    }
  }
  if (gap <= -SCORE_GAP_DEADBAND) {
    // Counter-signal: losers scored *higher* than winners. The score isn't
    // tracking conversion — a caution that fit ≠ landability for this user.
    return {
      kind: 'score-gap',
      tone: 'caution',
      title: 'High scores aren’t converting',
      detail: `The applications that didn't convert actually scored higher (${lossMean.toFixed(1)} vs ${winMean.toFixed(1)}) — fit isn't predicting landability here. The gap may be brand reach or timing, not match quality.`,
      wins: wins.length,
      losses: losses.length,
    }
  }
  return null
}

// ── 3. Win streak ──
// Only positive reinforcement, and only when the conversion rate is genuinely
// strong over a non-trivial sample. Returns null otherwise so a mediocre rate
// never gets dressed up as good news.
function winStreak(winCount: number, lossCount: number): OutcomesHeadsUp | null {
  const decided = winCount + lossCount
  if (decided < MIN_DECIDED) return null
  if (winCount < MIN_PER_GROUP) return null
  const rate = winCount / decided
  if (rate < 0.5) return null
  const pct = Math.round(rate * 100)
  return {
    kind: 'win-streak',
    tone: 'positive',
    title: 'Your targeting is converting',
    detail: `${winCount} of your ${decided} decided applications drew real engagement (${pct}%) — well above a typical cold-apply rate. Keep aiming where you've been aiming.`,
    wins: winCount,
    losses: lossCount,
  }
}

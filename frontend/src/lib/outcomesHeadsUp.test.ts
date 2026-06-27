import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOutcomesHeadsUp,
  classifyOutcome,
  parseAppScore,
  MIN_DECIDED,
  type OutcomesInput,
} from '@/lib/outcomesHeadsUp'
import { makeApplication, makeScoreEntry } from '@/test-utils/fixtures'
import type { AppStatus } from '@/types'

// Build an (application, matching score-history) pair so the lesson can recover
// the archetype + numeric score the way it does in the app. The application's
// own `score` string is the primary source; the score-history row supplies the
// archetype.
function decided(
  company: string,
  status: AppStatus,
  opts: { score?: string; archetype?: string; overall?: number } = {},
) {
  const role = 'Analyst'
  const app = makeApplication({ company, role, status, score: opts.score ?? '8.0/10' })
  const score = makeScoreEntry({
    company, role,
    archetype: opts.archetype ?? 'Data Analyst',
    overall: opts.overall ?? 8.0,
  })
  return { app, score }
}

function run(rows: ReturnType<typeof decided>[]): ReturnType<typeof buildOutcomesHeadsUp> {
  const input: OutcomesInput = {
    applications: rows.map(r => r.app),
    scoreHistory: rows.map(r => r.score),
  }
  return buildOutcomesHeadsUp(input)
}

// ─── parseAppScore ────────────────────────────────────────────────────────────

test('parseAppScore reads /10 and rejects everything else', () => {
  assert.equal(parseAppScore('7.2/10'), 7.2)
  assert.equal(parseAppScore(' 9/10 '), 9)
  assert.equal(parseAppScore('3.40/5'), null)   // legacy /5 — never mis-ranked
  assert.equal(parseAppScore('n/d'), null)
  assert.equal(parseAppScore(''), null)
})

// ─── classifyOutcome ──────────────────────────────────────────────────────────

test('classifyOutcome buckets statuses into win / loss / undecided', () => {
  assert.equal(classifyOutcome('Responded'), 'win')
  assert.equal(classifyOutcome('Interview'), 'win')
  assert.equal(classifyOutcome('Offer'), 'win')
  assert.equal(classifyOutcome('Rejected'), 'loss')
  assert.equal(classifyOutcome('Discarded'), 'loss')
  assert.equal(classifyOutcome('Applied'), null)    // still in flight
  assert.equal(classifyOutcome('Evaluated'), null)
  assert.equal(classifyOutcome('SKIP'), null)
})

// ─── Floors: no lesson on thin / undecided data ───────────────────────────────

test('returns null below the decided-sample floor', () => {
  // 4 decided rows — under MIN_DECIDED (5) — should teach nothing.
  const rows = [
    decided('A', 'Offer'),
    decided('B', 'Responded'),
    decided('C', 'Rejected'),
    decided('D', 'Rejected'),
  ]
  assert.equal(rows.length, MIN_DECIDED - 1)
  assert.equal(run(rows), null)
})

test('pending (Applied/Evaluated) rows are not counted as decided', () => {
  const rows = [
    decided('A', 'Applied'),
    decided('B', 'Applied'),
    decided('C', 'Applied'),
    decided('D', 'Evaluated'),
    decided('E', 'Evaluated'),
    decided('F', 'Applied'),
  ]
  assert.equal(run(rows), null)
})

// ─── Archetype drag ───────────────────────────────────────────────────────────

test('flags an archetype eating most losses', () => {
  // 3 losses all in "Strategy Consultant", 0 wins there; plus 2 wins elsewhere.
  const rows = [
    decided('A', 'Rejected', { archetype: 'Strategy Consultant' }),
    decided('B', 'Rejected', { archetype: 'Strategy Consultant' }),
    decided('C', 'Discarded', { archetype: 'Strategy Consultant' }),
    decided('D', 'Offer', { archetype: 'Data Analyst' }),
    decided('E', 'Responded', { archetype: 'Data Analyst' }),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.equal(h.kind, 'archetype-drag')
  assert.equal(h.tone, 'caution')
  assert.match(h.title, /Strategy Consultant/)
  assert.equal(h.losses, 3)
  assert.equal(h.wins, 2)
})

test('archetype drag suppressed when that archetype also wins a lot', () => {
  // 3 losses in "Data Analyst" but also 3 wins there — it's volume, not a
  // targeting problem. Falls through to the score/streak lessons instead.
  const rows = [
    decided('A', 'Rejected', { archetype: 'Data Analyst', score: '7.0/10', overall: 7.0 }),
    decided('B', 'Rejected', { archetype: 'Data Analyst', score: '7.0/10', overall: 7.0 }),
    decided('C', 'Discarded', { archetype: 'Data Analyst', score: '7.0/10', overall: 7.0 }),
    decided('D', 'Offer', { archetype: 'Data Analyst', score: '7.2/10', overall: 7.2 }),
    decided('E', 'Responded', { archetype: 'Data Analyst', score: '7.2/10', overall: 7.2 }),
    decided('F', 'Interview', { archetype: 'Data Analyst', score: '7.2/10', overall: 7.2 }),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.notEqual(h.kind, 'archetype-drag')
})

// ─── Score gap ────────────────────────────────────────────────────────────────

test('flags a predictive score gap (wins score higher than losses)', () => {
  const rows = [
    decided('A', 'Offer', { score: '9.0/10', overall: 9.0, archetype: 'Data Analyst' }),
    decided('B', 'Responded', { score: '8.6/10', overall: 8.6, archetype: 'Product Manager' }),
    decided('C', 'Interview', { score: '8.8/10', overall: 8.8, archetype: 'Strategy Consultant' }),
    decided('D', 'Rejected', { score: '6.5/10', overall: 6.5, archetype: 'Data Analyst' }),
    decided('E', 'Rejected', { score: '6.8/10', overall: 6.8, archetype: 'Product Manager' }),
    decided('F', 'Discarded', { score: '6.2/10', overall: 6.2, archetype: 'Strategy Consultant' }),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.equal(h.kind, 'score-gap')
  assert.equal(h.tone, 'positive')
  assert.match(h.title, /predicting/i)
})

test('flags the counter-signal when high scores fail to convert', () => {
  // Losers score HIGHER than winners — fit isn't tracking landability.
  const rows = [
    decided('A', 'Responded', { score: '6.5/10', overall: 6.5, archetype: 'Data Analyst' }),
    decided('B', 'Interview', { score: '6.2/10', overall: 6.2, archetype: 'Product Manager' }),
    decided('C', 'Offer', { score: '6.8/10', overall: 6.8, archetype: 'Strategy Consultant' }),
    decided('D', 'Rejected', { score: '9.0/10', overall: 9.0, archetype: 'Data Analyst' }),
    decided('E', 'Rejected', { score: '8.8/10', overall: 8.8, archetype: 'Product Manager' }),
    decided('F', 'Discarded', { score: '9.2/10', overall: 9.2, archetype: 'Strategy Consultant' }),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.equal(h.kind, 'score-gap')
  assert.equal(h.tone, 'caution')
  assert.match(h.title, /aren.t converting/i)
})

test('no score-gap lesson when winners and losers score within the deadband', () => {
  // Flat scores across both groups, distinct archetypes (so no drag), even
  // win/loss split → falls through to win-streak (50% conversion).
  const rows = [
    decided('A', 'Offer', { score: '7.5/10', overall: 7.5, archetype: 'Data Analyst' }),
    decided('B', 'Responded', { score: '7.6/10', overall: 7.6, archetype: 'Product Manager' }),
    decided('C', 'Interview', { score: '7.4/10', overall: 7.4, archetype: 'Strategy Consultant' }),
    decided('D', 'Rejected', { score: '7.5/10', overall: 7.5, archetype: 'UX Researcher' }),
    decided('E', 'Rejected', { score: '7.6/10', overall: 7.6, archetype: 'Marketing Lead' }),
    decided('F', 'Discarded', { score: '7.4/10', overall: 7.4, archetype: 'Ops Manager' }),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.equal(h.kind, 'win-streak')
})

// ─── Win streak ───────────────────────────────────────────────────────────────

test('names a strong conversion rate when losses are rare', () => {
  // 5 wins, 1 loss — one group too thin for a contrast, but the win rate is
  // strong over a real sample, so positive reinforcement is honest.
  const rows = [
    decided('A', 'Offer'),
    decided('B', 'Responded'),
    decided('C', 'Interview'),
    decided('D', 'Responded'),
    decided('E', 'Interview'),
    decided('F', 'Rejected'),
  ]
  const h = run(rows)
  assert.ok(h)
  assert.equal(h.kind, 'win-streak')
  assert.equal(h.tone, 'positive')
  assert.equal(h.wins, 5)
  assert.equal(h.losses, 1)
})

test('no win-streak when the conversion rate is mediocre', () => {
  // 2 wins, 4 losses across distinct archetypes with flat scores — under 50%,
  // and no single archetype dominates the losses (2 each in two buckets), so
  // nothing honest to surface.
  const rows = [
    decided('A', 'Offer', { archetype: 'Data Analyst' }),
    decided('B', 'Responded', { archetype: 'Product Manager' }),
    decided('C', 'Rejected', { archetype: 'Data Analyst' }),
    decided('D', 'Rejected', { archetype: 'Data Analyst' }),
    decided('E', 'Discarded', { archetype: 'Product Manager' }),
    decided('F', 'Discarded', { archetype: 'Product Manager' }),
  ]
  const h = run(rows)
  // Two archetypes tie at 2 losses each → neither clears the ≥3 count floor,
  // scores are flat (no gap), and the win rate is 33% (< 50%). No lesson.
  assert.equal(h, null)
})

// ─── Join robustness ──────────────────────────────────────────────────────────

test('recovers the score from the application even when no score-history matches', () => {
  // No score-history rows at all — the lesson must still read the /10 score off
  // the application string and the archetype simply stays empty (so no drag).
  const apps = [
    makeApplication({ company: 'A', role: 'R', status: 'Offer', score: '9.0/10' }),
    makeApplication({ company: 'B', role: 'R', status: 'Responded', score: '8.8/10' }),
    makeApplication({ company: 'C', role: 'R', status: 'Interview', score: '8.6/10' }),
    makeApplication({ company: 'D', role: 'R', status: 'Rejected', score: '6.0/10' }),
    makeApplication({ company: 'E', role: 'R', status: 'Rejected', score: '6.2/10' }),
    makeApplication({ company: 'F', role: 'R', status: 'Discarded', score: '6.4/10' }),
  ]
  const h = buildOutcomesHeadsUp({ applications: apps, scoreHistory: [] })
  assert.ok(h)
  assert.equal(h.kind, 'score-gap')
  assert.equal(h.tone, 'positive')
})

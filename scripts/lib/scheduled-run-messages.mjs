/**
 * scheduled-run-messages.mjs — what the weekly scheduled run tells the user
 * in the app's Messages view (data/agent-messages.jsonl, messages-core.mjs).
 *
 * Sparing on purpose: an alert when a run fails (or a scheduled run is
 * blocked or stopped), and an fyi with the summary only when a run found or
 * evaluated something. Quiet runs, skips, dry runs and lock clashes post
 * nothing. Same-day retries share one alert key, so a failing slot that
 * retries every 2 hours leaves one alert, not five.
 *
 * Pure: `messageForRun` returns a post input or null; scheduled-run.mjs posts
 * it. Unit-tested in scheduled-run-messages.test.mjs.
 */

import { parseScoreHistory } from './targeting-core.mjs'
import { summarizeRun } from './schedule-core.mjs'

const MAX_PICKS = 5
const PICK_VERDICTS = ['go', 'stretch']

const localDate = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * The best listings scored on or after `sinceDate` (YYYY-MM-DD): `go` first,
 * then `stretch`, each by priority. From data/score-history.tsv content.
 */
export function topPicksSince(scoreHistoryTsv, sinceDate, max = MAX_PICKS) {
  return parseScoreHistory(scoreHistoryTsv)
    .filter((r) => r.date >= sinceDate && PICK_VERDICTS.includes(r.verdict))
    .sort((a, b) => PICK_VERDICTS.indexOf(a.verdict) - PICK_VERDICTS.indexOf(b.verdict) || (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, max)
    .map((r) => ({ company: r.company, role: r.role, verdict: r.verdict, want: r.want, ease: r.ease, url: r.url || null }))
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '?')

/**
 * The message for one `runScheduled` result, or null for none.
 * `picks` from topPicksSince; `trigger` is 'scheduled' | 'manual'.
 */
export function messageForRun(result, { picks = [], trigger = 'manual', now = Date.now() } = {}) {
  const outcome = result?.outcome
  const run = result?.run
  const scheduled = trigger === 'scheduled'

  if (outcome === 'blocked') {
    if (!scheduled) return null
    return {
      source: 'scheduler', kind: 'alert', key: `scheduler:blocked:${localDate(now)}`,
      title: 'The weekly run could not start: setup is incomplete',
      body: `The scheduled scan needs ${(result.missing ?? []).map((m) => `\`${m}\``).join(', ') || 'your profile files'}. Finish onboarding in the app, then it runs at the next slot.`,
    }
  }
  if (!run) return null
  const day = (run.startedAt ?? '').slice(0, 10)

  if (outcome === 'failed' || (outcome === 'interrupted' && scheduled)) {
    const bad = (run.stages ?? []).find((s) => s.status === 'failed')
    const lines = [
      `${outcome === 'failed' ? 'The run failed' : 'The run was stopped'}${bad ? ` at the **${bad.name}** stage` : ''}${run.error ? `: ${run.error}` : '.'}`,
      '',
      scheduled ? 'It retries every 2 hours today; if this stays open after that, check the log.' : 'Run it again from Settings › Scheduled runs, or check the log.',
      '',
      'Log: `data/scheduled-runs.log` · details: `npm run schedule -- status`',
    ]
    return {
      source: 'scheduler', kind: 'alert', key: `scheduler:failed:${day || run.id}`,
      title: `Weekly run ${outcome === 'failed' ? 'failed' : 'was stopped'}${bad ? ` (${bad.name})` : ''}`,
      body: lines.join('\n'),
      links: [{ kind: 'file', target: 'data/scheduled-runs.log', label: 'Run log' }],
    }
  }

  if (!['completed', 'completed-with-errors', 'partial'].includes(outcome)) return null
  const s = run.summary ?? {}
  const found = (s.scanNew ?? 0) > 0 || (s.evalCompleted ?? 0) > 0 || picks.length > 0
  if (!found) return null

  const lines = [`${summarizeRun(run)}.`]
  if (picks.length) {
    lines.push('', '**Top picks**')
    for (const p of picks) lines.push(`- ${p.company}: ${p.role} (${p.verdict}, Want ${fmt(p.want)} · Ease ${fmt(p.ease)})`)
  } else if ((s.evalCompleted ?? 0) > 0) {
    lines.push('', 'Nothing scored `go` or `stretch` this time.')
  }
  if (s.evaluations === false && (s.queued ?? 0) > 0) lines.push('', `${s.queued} listing${s.queued === 1 ? ' is' : 's are'} queued; evaluations are off, so they wait for you in Scout.`)
  if ((s.evalFailed ?? 0) + (s.evalNoResult ?? 0) > 0) lines.push('', 'Some evaluations did not finish; they stay pending for the next run.')

  const n = picks.filter((p) => p.verdict === 'go').length
  return {
    source: 'scheduler', kind: 'fyi', key: `scheduler:run:${run.id}`,
    title: n ? `Weekly run: ${n} go pick${n === 1 ? '' : 's'}` : `Weekly run: ${summarizeRun(run)}`,
    body: lines.join('\n'),
    links: picks.filter((p) => p.url).map((p) => ({ kind: 'url', target: p.url, label: `${p.company}: ${p.role}` })),
  }
}

/** Run start as a local YYYY-MM-DD (score-history dates are local). */
export function runStartDate(run) {
  const t = Date.parse(run?.startedAt ?? '')
  return Number.isFinite(t) ? localDate(t) : null
}

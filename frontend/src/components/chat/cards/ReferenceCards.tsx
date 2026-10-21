'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Building2, Check, MapPin, ScrollText, X } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useMessagesStore } from '@/store/messages'
import { useWriteGate } from '@/store/dataRoot'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { rejectionInfo } from '@/lib/applyingBoard'
import { dateCue, listingDateKey } from '@/lib/listingDates'
import type { TopListKind } from '@/lib/chat/blocks'
import { ApplicationCard } from '@/components/applying/ApplicationCard'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { DeadlineRow } from '@/components/shared/DeadlineRow'
import { EligibilityChip, VerdictChip } from '@/components/shared/EligibilityChip'
import { TOP_LIST_DEFS, TopListCard, buildTopList } from '@/components/shared/TopListCard'
import { MatchEase } from '@/components/shared/MatchEase'
import { reportSummary } from '@/components/reports/reportFacts'
import { Button, Chip, Panel, ScoreNumber, StatusChip, TierChip } from '@/components/ui'
import { KIND_TONE } from '@/components/messages/MessageCard'
import { KIND_LABEL, SOURCE_LABEL, relativeTime, type MessageStatus } from '@/lib/messages'
import { useChatCardActions } from './context'
import {
  companyOverview, deadlinesWithin, findApplication, findReport, findScouting, latestEvaluation,
} from './cardData'
import { findMessageById, messageExcerpt } from './messageCardData'

// Reference cards: the block names a listing (or a company, a window, a list)
// and the card reads it live from the store. Nothing the model wrote is shown
// as data except the key itself, and a key that matches nothing says so.

/** Caption + card. The caption is the agent's optional `label`. */
export function CardFrame({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <figure className={cn('m-0 max-w-[460px]', className)}>
      {label && <figcaption className="label mb-1.5 truncate" title={label}>{label}</figcaption>}
      {children}
    </figure>
  )
}

/** The key matched nothing in the trackers — say so plainly. */
export function MissingCard({ what }: { what: string }) {
  return (
    <div className="card px-3 py-2.5">
      <p className="text-label text-text-3">{what}</p>
    </div>
  )
}

/** Store still loading. */
export function CardSkeleton({ height = 'h-20' }: { height?: string }) {
  return <div className={cn('card shimmer', height)} aria-hidden />
}

/** A row of small text actions under a card. */
export function CardActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-1 -ml-2', className)}>{children}</div>
}

// ─── starpath:application ────────────────────────────────────────────────────

/** The Applying card itself, live. `actions` replaces the default footer. */
export function LiveApplicationCard({ company, role, actions = true, className }: {
  company: string
  role: string
  actions?: boolean
  className?: string
}) {
  const loaded = useDataStore(s => s.loaded)
  const applications = useDataStore(s => s.applications)
  const statusLog = useDataStore(s => s.statusLog)
  const listingDates = useDataStore(s => s.listingDates)
  const navigate = useNavStore(s => s.navigate)
  const { openReport } = useChatCardActions()

  const app = useMemo(() => findApplication(applications, company, role), [applications, company, role])
  const rejection = useMemo(() => (app ? rejectionInfo(statusLog, app) : null), [app, statusLog])

  if (!loaded) return <CardSkeleton />
  if (!app) return <MissingCard what={`${company} — ${role} isn't in your applications.`} />

  const cue = app.status === 'Rejected' ? null : dateCue(app, listingDates[listingDateKey(app.company, app.role)])
  return (
    <ApplicationCard
      app={app}
      cue={cue}
      rejection={rejection}
      className={className}
      footer={actions && (
        <CardActions className="mt-2 pt-1.5 border-t border-border-default/60">
          <Button tone="ghost" size="xs" icon={<ScrollText size={12} />} onClick={() => openReport(app.company, app.role)}>
            Open report
          </Button>
          <Button tone="ghost" size="xs" trailing={<ArrowRight size={12} />} onClick={() => navigate('applying')}>
            Open in Applying
          </Button>
        </CardActions>
      )}
    />
  )
}

export function ApplicationBlockCard({ company, role, label }: { company: string; role: string; label?: string }) {
  return (
    <CardFrame label={label} className="max-w-[320px]">
      <LiveApplicationCard company={company} role={role} />
    </CardFrame>
  )
}

// ─── starpath:listing ────────────────────────────────────────────────────────

export function ListingBlockCard({ company, role, label }: { company: string; role: string; label?: string }) {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const scouting = useDataStore(s => s.scouting)
  const applications = useDataStore(s => s.applications)
  const { openReport } = useChatCardActions()

  const evaluation = useMemo(() => latestEvaluation(scoreHistory, company, role), [scoreHistory, company, role])
  const scout = useMemo(() => findScouting(scouting, company, role), [scouting, company, role])
  const app = useMemo(() => findApplication(applications, company, role), [applications, company, role])

  if (!loaded) return <CardFrame label={label}><CardSkeleton /></CardFrame>
  if (!evaluation && !scout) {
    return <CardFrame label={label}><MissingCard what={`No evaluated listing matches ${company} — ${role}.`} /></CardFrame>
  }

  const name = evaluation?.company ?? scout?.company ?? company
  const title = evaluation?.role ?? scout?.role ?? role
  const match = evaluation?.match ?? scout?.match ?? null
  const ease = evaluation?.ease ?? scout?.ease ?? null
  const eligibility = evaluation?.eligibility ?? scout?.eligibility ?? null
  const reason = scout?.eligibilityReason || null
  const blocked = eligibility === 'red'
  const location = evaluation?.location && evaluation.location !== 'n/d' ? evaluation.location : ''

  return (
    <CardFrame label={label}>
      <div className="card p-3">
        <div className="flex items-start gap-2.5">
          <CompanyLogo company={name} size={28} className="shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-text-1 truncate leading-tight" title={name}>{name}</p>
            <p className="text-label text-text-3 truncate mt-0.5" title={title}>{title}</p>
          </div>
          {app ? <StatusChip status={app.status} className="shrink-0" /> : scout && <TierChip tier={scout.tier} className="shrink-0" />}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <MatchEase match={match} ease={ease} blockedReason={blocked ? (reason ?? 'Blocked') : undefined} decimals={1} />
          <span className="flex-1" />
          <VerdictChip verdict={evaluation?.verdict ?? null} />
          <EligibilityChip status={eligibility} reason={reason} />
        </div>

        {(location || scout?.deadline) && (
          <p className="mt-2 flex items-center gap-1.5 text-label text-text-3 min-w-0">
            {location && <><MapPin size={12} className="shrink-0" aria-hidden /><span className="truncate" title={location}>{location}</span></>}
            {location && scout?.deadline && scout.deadline !== '—' && <span aria-hidden>·</span>}
            {scout?.deadline && scout.deadline !== '—' && <span className="shrink-0 tabular-nums">Closes {scout.deadline}</span>}
          </p>
        )}

        <CardActions className="mt-2">
          <Button tone="ghost" size="xs" icon={<ScrollText size={12} />} onClick={() => openReport(name, title)}>
            Open report
          </Button>
          <CompanyButton company={name} />
        </CardActions>
      </div>
    </CardFrame>
  )
}

function CompanyButton({ company }: { company: string }) {
  const navigate = useNavStore(s => s.navigate)
  return (
    <Button
      tone="ghost"
      size="xs"
      icon={<Building2 size={12} />}
      onClick={() => navigate('company', '', toCompanySlug(company))}
    >
      Company dossier
    </Button>
  )
}

// ─── starpath:report ─────────────────────────────────────────────────────────

export function ReportBlockCard({ company, role, label }: { company: string; role: string; label?: string }) {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const reports = useDataStore(s => s.reports)
  const scoutingRows = useDataStore(s => s.scouting)
  const applicationRows = useDataStore(s => s.applications)
  const { openReport } = useChatCardActions()

  const evaluation = useMemo(() => latestEvaluation(scoreHistory, company, role), [scoreHistory, company, role])
  const file = useMemo(
    () => findReport(reports, company, role, [...scoutingRows, ...applicationRows]),
    [reports, company, role, scoutingRows, applicationRows],
  )
  // The TL;DR is read from the report itself, verbatim (reportFacts).
  const [summary, setSummary] = useState<{ path: string; text: string | null } | null>(null)

  useEffect(() => {
    if (!file) return
    let cancelled = false
    void ipc.readFile(file.path).then(md => {
      if (!cancelled) setSummary({ path: file.path, text: md ? reportSummary(md)?.text ?? null : null })
    }).catch(() => {
      if (!cancelled) setSummary({ path: file.path, text: null })
    })
    return () => { cancelled = true }
  }, [file])

  if (!loaded) return <CardFrame label={label}><CardSkeleton height="h-28" /></CardFrame>
  if (!file && !evaluation) {
    return <CardFrame label={label}><MissingCard what={`No report for ${company} — ${role}.`} /></CardFrame>
  }

  const name = evaluation?.company ?? file?.company ?? company
  const title = evaluation?.role ?? file?.role ?? role
  const blocked = evaluation?.eligibility === 'red'
  const tldr = summary && file && summary.path === file.path ? summary.text : undefined

  return (
    <CardFrame label={label}>
      <div className="card p-3">
        <div className="flex items-start gap-2.5">
          <CompanyLogo company={name} size={28} className="shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-text-1 truncate leading-tight" title={name}>{name}</p>
            <p className="text-label text-text-3 truncate mt-0.5" title={title}>{title}</p>
          </div>
          <VerdictChip verdict={evaluation?.verdict ?? null} className="shrink-0" />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <ScoreTile label="Match" value={blocked ? null : evaluation?.match ?? null} />
          <ScoreTile label="Ease" value={blocked ? null : evaluation?.ease ?? null} />
          <div className="rounded border border-border-default/60 bg-bg-panel/50 px-2.5 py-2">
            <p className="label">Eligibility</p>
            <div className="mt-1 min-h-6 flex items-center">
              {evaluation?.eligibility ? <EligibilityChip status={evaluation.eligibility} /> : <span className="text-label text-text-4">—</span>}
            </div>
          </div>
        </div>

        {file && (
          tldr === undefined
            ? <div className="mt-3 h-10 shimmer rounded" aria-hidden />
            : tldr
              ? <p className="mt-3 text-body text-text-2 line-clamp-4">{tldr}</p>
              : <p className="mt-3 text-label text-text-4">The report has no TL;DR.</p>
        )}

        <CardActions className="mt-2">
          <Button tone="ghost" size="xs" icon={<ScrollText size={12} />} onClick={() => openReport(name, title)}>
            Open full report
          </Button>
        </CardActions>
      </div>
    </CardFrame>
  )
}

function ScoreTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded border border-border-default/60 bg-bg-panel/50 px-2.5 py-2">
      <p className="label">{label}</p>
      <ScoreNumber value={value} size="lg" decimals={1} className="mt-0.5 block" />
    </div>
  )
}

// ─── starpath:company ────────────────────────────────────────────────────────

const COMPANY_ROWS = 6

export function CompanyBlockCard({ company, label }: { company: string; label?: string }) {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const { openReport } = useChatCardActions()

  const overview = useMemo(() => companyOverview(scoreHistory, applications, company), [scoreHistory, applications, company])

  if (!loaded) return <CardFrame label={label}><CardSkeleton height="h-32" /></CardFrame>
  if (!overview) return <CardFrame label={label}><MissingCard what={`Nothing on file for ${company}.`} /></CardFrame>

  const hidden = overview.rows.length - COMPANY_ROWS
  return (
    <CardFrame label={label}>
      <div className="card p-3">
        <div className="flex items-center gap-2.5">
          <CompanyLogo company={overview.name} size={32} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-section text-text-1 truncate" title={overview.name}>{overview.name}</p>
            <p className="text-label text-text-3">
              {overview.evaluated} evaluated · {overview.applied} in applications
            </p>
          </div>
        </div>

        <ul className="mt-2 divide-y divide-border-default/60">
          {overview.rows.slice(0, COMPANY_ROWS).map(row => (
            <li key={row.role}>
              <button
                type="button"
                onClick={() => openReport(overview.name, row.role)}
                className="w-full h-9 flex items-center gap-2.5 text-left rounded transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                title={`Open the report for ${row.role}`}
              >
                <span className="flex-1 min-w-0 text-body text-text-1 truncate">{row.role}</span>
                <MatchEase match={row.match} ease={row.ease} size="sm" bare decimals={1} className="shrink-0" />
                <span className="w-[76px] shrink-0 flex justify-end">
                  {row.application
                    ? <StatusChip status={row.application.status} />
                    : <VerdictChip verdict={row.evaluation?.verdict ?? null} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hidden > 0 && <p className="mt-1 text-label text-text-4">and {hidden} more</p>}

        <CardActions className="mt-2">
          <CompanyButton company={overview.name} />
        </CardActions>
      </div>
    </CardFrame>
  )
}

// ─── starpath:deadlines ──────────────────────────────────────────────────────

const DEADLINE_ROWS = 8

export function DeadlinesBlockCard({ days, label }: { days: number; label?: string }) {
  const loaded = useDataStore(s => s.loaded)
  const applications = useDataStore(s => s.applications)
  const navigate = useNavStore(s => s.navigate)
  const items = useMemo(() => deadlinesWithin(applications, days), [applications, days])
  const span = days === 1 ? 'the next day' : `the next ${days} days`

  if (!loaded) return <CardFrame label={label}><CardSkeleton height="h-28" /></CardFrame>
  return (
    <CardFrame label={label} className="max-w-[560px]">
      <Panel title={`Deadlines in ${span}`} meta={items.length ? `${items.length}` : undefined} flush>
        {items.length === 0 ? (
          <p className="px-4 pb-3 text-label text-text-3">Nothing due in {span}.</p>
        ) : (
          <ul className="divide-y divide-border-default/60 pb-1">
            {items.slice(0, DEADLINE_ROWS).map(item => (
              <li key={item.id}><DeadlineRow item={item} onOpen={() => navigate('applying')} /></li>
            ))}
            {items.length > DEADLINE_ROWS && (
              <li className="px-4 py-2 text-label text-text-4">and {items.length - DEADLINE_ROWS} more in Applying</li>
            )}
          </ul>
        )}
      </Panel>
    </CardFrame>
  )
}

// ─── starpath:top ────────────────────────────────────────────────────────────

export function TopBlockCard({ list, limit, label }: { list: TopListKind; limit: number; label?: string }) {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const navigate = useNavStore(s => s.navigate)
  const items = useMemo(() => buildTopList(scoreHistory, list, limit), [scoreHistory, list, limit])
  const def = TOP_LIST_DEFS[list]

  if (!loaded) return <CardFrame label={label}><CardSkeleton height="h-40" /></CardFrame>
  return (
    <CardFrame label={label} className="max-w-[400px]">
      <TopListCard
        title={def.title}
        items={items}
        icon={def.icon}
        action={(
          <Button tone="ghost" size="xs" trailing={<ArrowRight size={12} />} onClick={() => navigate('trends')}>
            Trends
          </Button>
        )}
      />
    </CardFrame>
  )
}

// ─── starpath:message ────────────────────────────────────────────────────────

/** One Messages item: kind, source, title, a plain excerpt of the body and its
 *  status, with Resolve / Dismiss while it is open. The full text, its links
 *  and a note on resolving live in Messages. */
export function MessageBlockCard({ id, label }: { id: string; label?: string }) {
  const loaded = useMessagesStore(s => s.loaded)
  const messages = useMessagesStore(s => s.messages)
  const load = useMessagesStore(s => s.load)
  const setStatus = useMessagesStore(s => s.setStatus)
  const navigate = useNavStore(s => s.navigate)
  const { canWrite, readOnlyTitle } = useWriteGate()
  const [busy, setBusy] = useState<MessageStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (!loaded) void load() }, [loaded, load])

  const message = useMemo(() => findMessageById(messages, id), [messages, id])
  const excerpt = useMemo(() => (message ? messageExcerpt(message.body) : ''), [message])

  if (!loaded) return <CardFrame label={label}><CardSkeleton height="h-24" /></CardFrame>
  if (!message) return <CardFrame label={label}><MissingCard what={`Message ${id} isn't in your Messages.`} /></CardFrame>

  const open = message.status === 'open'
  const act = async (status: MessageStatus) => {
    setBusy(status)
    setError(null)
    const res = await setStatus(message.id, status)
    setBusy(null)
    if (!res) setError('Not available outside the app')
    else if (!res.ok) setError(res.error)
  }

  return (
    <CardFrame label={label}>
      <article className="card px-3.5 py-3" aria-labelledby={`chat-msg-${message.id}`}>
        <div className="flex items-center gap-2 mb-1">
          <Chip tone={KIND_TONE[message.kind]} pill>{KIND_LABEL[message.kind]}</Chip>
          <span className="text-label text-text-3 truncate">
            {SOURCE_LABEL[message.source]} · {relativeTime(message.created_at)}
          </span>
          {!open && (
            <Chip tone={message.status === 'resolved' ? 'success' : 'muted'} pill className="ml-auto shrink-0">
              {message.status === 'resolved' ? 'Resolved' : 'Dismissed'}
            </Chip>
          )}
        </div>
        <p id={`chat-msg-${message.id}`} className="text-section text-text-1">{message.title}</p>
        {excerpt && <p className="mt-1 text-body text-text-2">{excerpt}</p>}
        {!open && message.resolution_note && (
          <p className="mt-1.5 text-label text-text-2"><span className="text-text-3">Note:</span> {message.resolution_note}</p>
        )}
        {error && <p className="mt-1.5 text-label text-danger" role="alert">{error}</p>}
        <CardActions className="mt-2 pt-1.5 border-t border-border-default/60">
          {open && (
            <>
              <Button
                size="xs"
                icon={<Check size={12} />}
                loading={busy === 'resolved'}
                disabled={!canWrite || busy !== null}
                title={readOnlyTitle}
                onClick={() => void act('resolved')}
              >
                Resolve
              </Button>
              <Button
                tone="ghost"
                size="xs"
                icon={<X size={12} />}
                loading={busy === 'dismissed'}
                disabled={!canWrite || busy !== null}
                title={readOnlyTitle ?? 'Close it without acting on it'}
                onClick={() => void act('dismissed')}
              >
                Dismiss
              </Button>
            </>
          )}
          <Button tone="ghost" size="xs" trailing={<ArrowRight size={12} />} onClick={() => navigate('messages')}>
            Open in Messages
          </Button>
        </CardActions>
      </article>
    </CardFrame>
  )
}

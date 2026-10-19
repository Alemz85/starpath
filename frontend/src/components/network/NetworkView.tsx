'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Send, Clock, Snowflake, CheckCircle2, Reply, AlertTriangle, Waypoints, Search,
} from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { CompanyLink } from '@/components/shared/CompanyLink'
import { Chip, Panel, type ChipTone } from '@/components/ui'
import { WantEase } from '@/components/shared/WantEase'
import {
  buildRosterRows, degreeLabel, isNetworkEmpty, partitionGaps,
  type CompanyPath, type NetworkGap, type NetworkOverview, type NetworkThread,
  type PlayId, type RoleRef, type RosterRow, type ThreadAction,
} from '@/lib/networkLens'

// ─── Vocabulary → presentation ────────────────────────────────────────────────
// Same chip tones as the Outreach board (DESIGN-meta § 7): accent = act now
// (nudge, warm path), neutral = on the clock, success = a win, muted = stop.

type ChipMeta = { label: string; icon: React.ElementType; tone: ChipTone }

const PLAY_META: Record<PlayId, ChipMeta> = {
  'reply-handoff': { label: 'Reply',       icon: Reply,     tone: 'success' },
  nudge:           { label: 'Nudge due',   icon: Send,      tone: 'accent' },
  'warm-direct':   { label: 'Warm direct', icon: Send,      tone: 'accent' },
  'warm-intro':    { label: 'Warm intro',  icon: Waypoints, tone: 'accent' },
  wait:            { label: 'Wait',        icon: Clock,     tone: 'neutral' },
  'cold-search':   { label: 'Cold search', icon: Search,    tone: 'muted' },
}

const ACTION_META: Record<ThreadAction, ChipMeta> = {
  nudge:   { label: 'Nudge due', icon: Send,         tone: 'accent' },
  waiting: { label: 'Waiting',   icon: Clock,        tone: 'neutral' },
  done:    { label: 'Replied',   icon: CheckCircle2, tone: 'success' },
  cold:    { label: 'Cold',      icon: Snowflake,    tone: 'muted' },
}

const TIE_LABEL: Record<string, string> = { strong: 'strong', medium: 'medium', weak: 'weak' }

function daysLabel(n: number | null): string {
  if (n == null) return '—'
  if (n === 0) return 'today'
  return `${n}d ago`
}

// ─── Overview fetch ───────────────────────────────────────────────────────────

// The overview is derived in the main process from data/network.md +
// data/outreach.md + the pipeline files (see scripts/lib/network-lens-core.mjs
// via the network:overview channel). Neither log file is in the SQLite cache,
// so re-derive whenever the store data shifts — the chokidar watcher bumps
// applications/scouting on any data/* write, which is our cue the network or
// outreach log may have changed too (same approach as the Outreach board).
//
// A hook rather than panel-local state so OutreachView mounts it once and
// shares the result between its title-bar meta and the panel body — the
// overview is never fetched twice.
export function useNetworkOverview() {
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)

  const [overview, setOverview] = useState<NetworkOverview | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    ipc.network.overview()
      .then(o => { if (!cancelled) { setOverview(o); setReady(true) } })
      .catch(() => { if (!cancelled) { setOverview(null); setReady(true) } })
    return () => { cancelled = true }
  }, [applications, scouting])

  return { overview, ready, empty: overview ? isNetworkEmpty(overview) : false }
}

// ─── The panel ────────────────────────────────────────────────────────────────

// Panel body for OutreachView's Network tab — the host owns the title bar,
// the tab strip, and the scroll container; this owns the content only.
export function NetworkPanel({ overview, ready }: {
  overview: NetworkOverview | null
  ready: boolean
}) {
  const loaded = useDataStore(s => s.loaded)

  const rosterRows = useMemo(
    () => (overview ? buildRosterRows(overview) : []),
    [overview],
  )
  const gapSplit = useMemo(
    () => partitionGaps(overview?.gaps ?? []),
    [overview],
  )

  const showSkeleton = !loaded || !ready
  const empty = overview ? isNetworkEmpty(overview) : false

  return (
    <div className="space-y-4">
      {showSkeleton ? (
        <div className="space-y-4" aria-hidden>
          <div className="h-40 shimmer rounded-lg" />
          <div className="h-32 shimmer rounded-lg" />
        </div>
      ) : overview === null ? (
        // The main process couldn't load the lens core — an old repo checkout
        // is the realistic cause. Say exactly that; nothing decorative.
        <p className="text-label text-text-3 max-w-xl leading-relaxed">
          The network lens couldn&apos;t load. It needs{' '}
          <code className="font-mono text-label text-text-2">scripts/lib/network-lens-core.mjs</code>{' '}
          in your career-ops folder — update the repo, then reopen this tab.
        </p>
      ) : empty ? (
        <RosterStarter />
      ) : (
        <>
          {/* Roster exists but data/network.md itself is empty — the threads
              below come from the outreach log alone. Still show how to start
              the roster; it's the asset this lens exists to map. */}
          {overview.roster.length === 0 && <RosterStarter compact />}

          {/* 1 · Warm paths into the pipeline, most actionable play first. */}
          {overview.companies.length > 0 && (
            <Panel
              title="Warm paths"
              meta={`${overview.counts.companiesWithPath} pipeline ${overview.counts.companiesWithPath === 1 ? 'company' : 'companies'} where you know someone`}
            >
              <div className="divide-y divide-border-default">
                {overview.companies.map(c => <CompanyRow key={c.companyKey} c={c} />)}
              </div>
            </Panel>
          )}
          {overview.companies.length === 0 && overview.roster.length > 0 && overview.counts.pipelineTargets > 0 && (
            <p className="text-label text-text-4">
              None of your {overview.counts.contacts} mapped {overview.counts.contacts === 1 ? 'contact works' : 'contacts work'} at
              a company in your pipeline yet.
            </p>
          )}

          {/* 2 · Cadence on open outreach threads. */}
          {overview.threads.length > 0 && (
            <Panel
              title="Open threads"
              meta={`${overview.counts.threads} logged · ${overview.counts.dueNudges} due a nudge`}
            >
              <div className="divide-y divide-border-default">
                {overview.threads.map(t => (
                  <ThreadRow key={`${t.company}|${t.contact}`.toLowerCase()} t={t} />
                ))}
              </div>
            </Panel>
          )}

          {/* 3 · Coverage gaps — apply-worthy companies with nobody mapped. */}
          {gapSplit.priority.length > 0 && (
            <Panel
              title="Coverage gaps"
              meta="Apply-worthy companies with no mapped contact"
            >
              <div className="divide-y divide-border-default">
                {gapSplit.priority.map(g => <GapRow key={g.companyKey} g={g} />)}
              </div>
              {gapSplit.rest.length > 0 && (
                <p className="text-label text-text-4 pt-2">
                  +{gapSplit.rest.length} more whose best role is not a Go, Stretch or Solid
                </p>
              )}
            </Panel>
          )}

          {/* 4 · Latent leads — people you know at untargeted companies. */}
          {overview.latentLeads.length > 0 && (
            <Panel
              title="Latent leads"
              meta="Contacts at companies outside your pipeline"
            >
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {overview.latentLeads.map(l => (
                  <span key={`${l.companyKey}|${l.name}`} className="text-label text-text-3">
                    <span className="text-text-2 font-medium">{l.name}</span>
                    {' @ '}{l.company}
                    {l.title && <span className="text-text-4"> · {l.title}</span>}
                    <span className="text-text-4"> · {TIE_LABEL[l.relationship] ?? l.relationship}, {degreeLabel(l.degree, l.via)}</span>
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {/* 5 · The roster itself. */}
          {rosterRows.length > 0 && (
            <Panel title="Roster" meta="Everyone in data/network.md">
              <RosterTable rows={rosterRows} />
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

// ─── Empty-roster starter — real, actionable content only ─────────────────────

function RosterStarter({ compact = false }: { compact?: boolean }) {
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-label text-text-3 leading-relaxed">
        No network mapped yet. <code className="font-mono text-label text-text-2">data/network.md</code> is
        your referral roster — one markdown table row per person you know:
      </p>
      <pre className="text-label font-mono text-text-3 bg-bg-elevated border border-border-default rounded px-3 py-2 overflow-x-auto">
        {'| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |'}
      </pre>
      {!compact && (
        <p className="text-label text-text-4 leading-relaxed">
          Relationship is strong / medium / weak. Degree 1 = you know them directly; 2 = a mutual
          can introduce you (name the mutual in Via). Add a few rows and this lens maps them
          against your pipeline — warm paths, the recommended play per company, and the
          apply-worthy companies where you still know nobody.
        </p>
      )}
    </div>
  )
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

function MetaChip({ meta }: { meta: ChipMeta }) {
  const Icon = meta.icon
  return (
    <Chip tone={meta.tone} size="sm" icon={<Icon size={12} aria-hidden />} className="shrink-0">
      {meta.label}
    </Chip>
  )
}

function CompanyRow({ c }: { c: CompanyPath }) {
  const meta = PLAY_META[c.play] ?? PLAY_META['cold-search']
  return (
    <div className="py-2.5 first:pt-0.5 last:pb-0.5">
      <div className="flex items-center gap-2.5 flex-wrap min-h-6">
        <CompanyLink company={c.company} size={18} showName className="text-body" />
        {c.topRole && (
          <span className="text-label text-text-3">
            {c.topRole.role}
            <RoleScore r={c.topRole} />
          </span>
        )}
        <MetaChip meta={meta} />
        {c.counts.untouched > 0 && (
          <span className="text-label text-text-4">
            {c.counts.untouched} of {c.counts.paths} {c.counts.paths === 1 ? 'path' : 'paths'} untouched
          </span>
        )}
      </div>
      <p className="text-label text-text-3 mt-1 leading-snug">
        {/* recommendPlay's reason often opens with the target's own name
            ("Ada is your warmest untouched path…") — prefix the bolded target
            only when it doesn't, so the name never reads twice. */}
        {c.target && !c.reason.startsWith(c.target.name) && (
          <span className="text-text-2 font-medium">{c.target.name}{c.target.title ? ` (${c.target.title})` : ''} — </span>
        )}
        {c.reason}
      </p>
      {c.paths.length > 1 && (
        <p className="text-label text-text-4 mt-1">
          Paths:{' '}
          {c.paths.map((p, i) => (
            <span key={p.name}>
              {i > 0 && ' · '}
              {p.name} ({TIE_LABEL[p.relationship] ?? p.relationship}, {degreeLabel(p.degree, p.via)}
              {p.thread ? `, thread: ${p.thread.action}` : ''})
            </span>
          ))}
        </p>
      )}
      {c.cautions.map(caution => (
        <p key={caution} className="flex items-start gap-1.5 text-label text-text-3 mt-1">
          <AlertTriangle size={12} className="text-warning-text shrink-0 mt-[2px]" aria-hidden />
          <span>{caution}</span>
        </p>
      ))}
    </div>
  )
}

function ThreadRow({ t }: { t: NetworkThread }) {
  const meta = ACTION_META[t.action] ?? ACTION_META.waiting
  return (
    <div className="min-h-10 py-2 first:pt-0.5 last:pb-0.5 flex items-center gap-2.5 flex-wrap">
      <MetaChip meta={meta} />
      <span className="text-body text-text-1 font-medium">{t.contact}</span>
      <span className="text-label text-text-3">
        {t.company}
        {t.title && <span className="text-text-4"> · {t.title}</span>}
        {t.channel && <span className="text-text-4"> · {t.channel}</span>}
        <span className="text-text-4"> · {daysLabel(t.daysSince)}</span>
        {t.action === 'waiting' && t.nextNudge && <span className="text-text-4"> · next nudge {t.nextNudge}</span>}
      </span>
      <span className="text-label text-text-4 flex-1 min-w-0 truncate" title={t.reason}>{t.reason}</span>
    </div>
  )
}

// A role's scores: the Want · Ease pair for a v2 row, the legacy label
// ("7.4/10") as quiet text for an old applications.md cell. Never Priority,
// which is only the order the core ranked these rows in.
function RoleScore({ r }: { r: RoleRef }) {
  if (r.want != null && r.ease != null) {
    return <WantEase want={r.want} ease={r.ease} size="sm" className="ml-1.5" />
  }
  if (r.scoreLabel) return <span className="ml-1.5 text-text-4">{r.scoreLabel}</span>
  return null
}

function GapRow({ g }: { g: NetworkGap }) {
  const top = g.roles[0]
  return (
    <div className="min-h-10 py-2 first:pt-0.5 last:pb-0.5 flex items-center gap-2.5 flex-wrap">
      <CompanyLink company={g.company} size={18} showName className="text-body" />
      {top && (
        <span className="text-label text-text-3">
          {top.role}
          <RoleScore r={top} />
        </span>
      )}
      <span className="text-label text-text-4">No contact mapped</span>
    </div>
  )
}

// ─── Roster table ─────────────────────────────────────────────────────────────

function RosterTable({ rows }: { rows: RosterRow[] }) {
  return (
    <div className="overflow-x-auto -mx-4">
      <table className="w-full border-collapse text-left text-body">
        <thead>
          <tr className="border-y border-border-default bg-bg-elevated/60">
            <th className="th h-8 pl-4 pr-4">Name</th>
            <th className="th h-8 pr-4">Company</th>
            <th className="th h-8 pr-4">Title</th>
            <th className="th h-8 pr-4">Tie</th>
            <th className="th h-8 pr-4">Degree</th>
            <th className="th h-8 pr-4">Last contact</th>
            <th className="th h-8 pr-4">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {rows.map(r => (
            <tr key={`${r.contact.companyKey}|${r.contact.name}`} className="h-10 hover:bg-bg-elevated transition-colors duration-150">
              <td className="pl-4 pr-4 text-text-1 font-medium whitespace-nowrap">{r.contact.name}</td>
              <td className="pr-4 whitespace-nowrap">
                {r.inPipeline
                  ? <CompanyLink company={r.contact.company} size={14} showName className="text-body" />
                  : <span className="text-text-3">{r.contact.company}</span>}
              </td>
              <td className="pr-4 text-text-3">{r.contact.title || '—'}</td>
              <td className="pr-4 text-text-3">{TIE_LABEL[r.contact.relationship] ?? r.contact.relationship}</td>
              <td className="pr-4 text-text-3 whitespace-nowrap">{degreeLabel(r.contact.degree, r.contact.via)}</td>
              <td className="pr-4 text-label text-text-4 whitespace-nowrap">{r.contact.lastContact || '—'}</td>
              <td className="pr-4">
                {r.thread
                  ? <MetaChip meta={ACTION_META[r.thread.action] ?? ACTION_META.waiting} />
                  : r.inPipeline
                    ? <span className="text-label text-accent-text">Warm path</span>
                    : <span className="text-label text-text-4">Not in pipeline</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

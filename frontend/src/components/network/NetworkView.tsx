'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Send, Clock, Snowflake, CheckCircle2, Reply, AlertTriangle, Waypoints, Search,
} from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useDataStore } from '@/store/data'
import { scoreColor } from '@/lib/tier'
import { CompanyLink } from '@/components/shared/CompanyLink'
import {
  buildRosterRows, degreeLabel, isNetworkEmpty, partitionGaps,
  type CompanyPath, type NetworkGap, type NetworkOverview, type NetworkThread,
  type PlayId, type RosterRow, type ThreadAction,
} from '@/lib/networkLens'

// ─── Vocabulary → presentation ────────────────────────────────────────────────
// Colors stay on the semantic ladder the Outreach board and Today cockpit use:
// accent = act now, info = on the clock, success = a win, muted = stop/none.
// No new tokens (DESIGN-meta § Status scale).

const PLAY_META: Record<PlayId, { label: string; icon: React.ElementType; chip: string }> = {
  'reply-handoff': { label: 'Reply',       icon: Reply,        chip: 'text-success bg-success/10 border-success/30' },
  nudge:           { label: 'Nudge due',   icon: Send,         chip: 'text-accent bg-accent/10 border-accent/30' },
  'warm-direct':   { label: 'Warm direct', icon: Send,         chip: 'text-accent bg-accent/10 border-accent/30' },
  'warm-intro':    { label: 'Warm intro',  icon: Waypoints,    chip: 'text-accent bg-accent/10 border-accent/30' },
  wait:            { label: 'Wait',        icon: Clock,        chip: 'text-info bg-info/10 border-info/30' },
  'cold-search':   { label: 'Cold search', icon: Search,       chip: 'text-text-3 bg-bg-elevated border-border-default' },
}

const ACTION_META: Record<ThreadAction, { label: string; icon: React.ElementType; chip: string }> = {
  nudge:   { label: 'Nudge due', icon: Send,         chip: 'text-accent bg-accent/10 border-accent/30' },
  waiting: { label: 'Waiting',   icon: Clock,        chip: 'text-info bg-info/10 border-info/30' },
  done:    { label: 'Replied',   icon: CheckCircle2, chip: 'text-success bg-success/10 border-success/30' },
  cold:    { label: 'Cold',      icon: Snowflake,    chip: 'text-text-3 bg-bg-elevated border-border-default' },
}

const TIE_LABEL: Record<string, string> = { strong: 'strong', medium: 'medium', weak: 'weak' }

function daysLabel(n: number | null): string {
  if (n == null) return '—'
  if (n === 0) return 'today'
  return `${n}d ago`
}

// ─── The view ─────────────────────────────────────────────────────────────────

export function NetworkView() {
  const loaded = useDataStore(s => s.loaded)
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)

  const [overview, setOverview] = useState<NetworkOverview | null>(null)
  const [ready, setReady] = useState(false)

  // The overview is derived in the main process from data/network.md +
  // data/outreach.md + the pipeline files (see scripts/lib/network-lens-core.mjs
  // via the network:overview channel). Neither log file is in the SQLite cache,
  // so re-derive whenever the store data shifts — the chokidar watcher bumps
  // applications/scouting on any data/* write, which is our cue the network or
  // outreach log may have changed too (same approach as the Outreach board).
  useEffect(() => {
    let cancelled = false
    ipc.network.overview()
      .then(o => { if (!cancelled) { setOverview(o); setReady(true) } })
      .catch(() => { if (!cancelled) { setOverview(null); setReady(true) } })
    return () => { cancelled = true }
  }, [applications, scouting])

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
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Network</h1>
        {!showSkeleton && overview && !empty && (
          <span className="text-label text-text-4 font-mono" aria-live="polite">
            {overview.counts.contacts} {overview.counts.contacts === 1 ? 'contact' : 'contacts'}
            {' · '}{overview.counts.companiesWithPath} warm {overview.counts.companiesWithPath === 1 ? 'company' : 'companies'}
            {overview.counts.dueNudges > 0 && <> · <span className="text-accent">{overview.counts.dueNudges} {overview.counts.dueNudges === 1 ? 'nudge' : 'nudges'} due</span></>}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
            <code className="font-mono text-[11px] text-text-2">scripts/lib/network-lens-core.mjs</code>{' '}
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
              <Section
                title="Warm paths"
                sub={`${overview.counts.companiesWithPath} pipeline ${overview.counts.companiesWithPath === 1 ? 'company' : 'companies'} where you know someone`}
              >
                <div className="divide-y divide-border-default/60">
                  {overview.companies.map(c => <CompanyRow key={c.companyKey} c={c} />)}
                </div>
              </Section>
            )}
            {overview.companies.length === 0 && overview.roster.length > 0 && overview.counts.pipelineTargets > 0 && (
              <p className="text-label text-text-4">
                None of your {overview.counts.contacts} mapped {overview.counts.contacts === 1 ? 'contact works' : 'contacts work'} at
                a company in your pipeline yet.
              </p>
            )}

            {/* 2 · Cadence on open outreach threads. */}
            {overview.threads.length > 0 && (
              <Section
                title="Open threads"
                sub={`${overview.counts.threads} logged · ${overview.counts.dueNudges} due a nudge`}
              >
                <div className="divide-y divide-border-default/60">
                  {overview.threads.map(t => (
                    <ThreadRow key={`${t.company}|${t.contact}`.toLowerCase()} t={t} />
                  ))}
                </div>
              </Section>
            )}

            {/* 3 · Coverage gaps — apply-worthy companies with nobody mapped. */}
            {gapSplit.priority.length > 0 && (
              <Section
                title="Coverage gaps"
                sub="apply-worthy companies with no mapped contact — worth finding a path into"
              >
                <div className="divide-y divide-border-default/60">
                  {gapSplit.priority.map(g => <GapRow key={g.companyKey} g={g} />)}
                </div>
                {gapSplit.rest.length > 0 && (
                  <p className="text-micro text-text-4 pt-2">
                    +{gapSplit.rest.length} more below the 7.0 apply threshold
                  </p>
                )}
              </Section>
            )}

            {/* 4 · Latent leads — people you know at untargeted companies. */}
            {overview.latentLeads.length > 0 && (
              <Section
                title="Latent leads"
                sub="contacts at companies not in your pipeline — leads if you ever target them"
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
              </Section>
            )}

            {/* 5 · The roster itself. */}
            {rosterRows.length > 0 && (
              <Section title="Roster" sub="everyone in data/network.md">
                <RosterTable rows={rosterRows} />
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border-default bg-bg-base px-4 py-3">
      <div className="flex items-baseline gap-2.5 mb-2">
        <h2 className="text-section text-text-1">{title}</h2>
        {sub && <span className="text-micro text-text-4 normal-case tracking-normal">{sub}</span>}
      </div>
      {children}
    </section>
  )
}

// ─── Empty-roster starter — real, actionable content only ─────────────────────

function RosterStarter({ compact = false }: { compact?: boolean }) {
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-label text-text-3 leading-relaxed">
        No network mapped yet. <code className="font-mono text-[11px] text-text-2">data/network.md</code> is
        your referral roster — one markdown table row per person you know:
      </p>
      <pre className="text-[11px] font-mono text-text-3 bg-bg-elevated border border-border-default rounded-md px-3 py-2 overflow-x-auto">
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

function Chip({ meta }: { meta: { label: string; icon: React.ElementType; chip: string } }) {
  const Icon = meta.icon
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0',
      meta.chip,
    )}>
      <Icon size={9} aria-hidden />
      {meta.label}
    </span>
  )
}

function CompanyRow({ c }: { c: CompanyPath }) {
  const meta = PLAY_META[c.play] ?? PLAY_META['cold-search']
  return (
    <div className="py-2.5 first:pt-0.5 last:pb-0.5">
      <div className="flex items-center gap-2.5 flex-wrap">
        <CompanyLink company={c.company} size={18} showName className="text-[13px]" />
        {c.topRole && (
          <span className="text-label text-text-3">
            {c.topRole.role}
            <span className="font-mono font-semibold tabular-nums ml-1.5" style={{ color: scoreColor(c.topRole.score) }}>
              {c.topRole.score.toFixed(1)}
            </span>
          </span>
        )}
        <Chip meta={meta} />
        {c.counts.untouched > 0 && (
          <span className="text-[10px] text-text-4 font-mono">
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
        <p className="text-micro text-text-4 mt-1 normal-case tracking-normal">
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
        <p key={caution} className="flex items-start gap-1.5 text-micro text-text-4 mt-1 normal-case tracking-normal">
          <AlertTriangle size={10} className="text-warning shrink-0 mt-[1px]" aria-hidden />
          <span>{caution}</span>
        </p>
      ))}
    </div>
  )
}

function ThreadRow({ t }: { t: NetworkThread }) {
  const meta = ACTION_META[t.action] ?? ACTION_META.waiting
  return (
    <div className="py-2 first:pt-0.5 last:pb-0.5 flex items-center gap-2.5 flex-wrap">
      <Chip meta={meta} />
      <span className="text-[13px] text-text-1 font-medium">{t.contact}</span>
      <span className="text-label text-text-3">
        {t.company}
        {t.title && <span className="text-text-4"> · {t.title}</span>}
        {t.channel && <span className="text-text-4"> · {t.channel}</span>}
        <span className="text-text-4"> · {daysLabel(t.daysSince)}</span>
        {t.action === 'waiting' && t.nextNudge && <span className="text-text-4"> · next nudge {t.nextNudge}</span>}
      </span>
      <span className="text-micro text-text-4 normal-case tracking-normal flex-1 min-w-0 truncate">{t.reason}</span>
    </div>
  )
}

function GapRow({ g }: { g: NetworkGap }) {
  const top = g.roles[0]
  return (
    <div className="py-2 first:pt-0.5 last:pb-0.5 flex items-center gap-2.5 flex-wrap">
      <CompanyLink company={g.company} size={18} showName className="text-[13px]" />
      {top && (
        <span className="text-label text-text-3">
          {top.role}
          <span className="font-mono font-semibold tabular-nums ml-1.5" style={{ color: scoreColor(g.topScore) }}>
            {g.topScore.toFixed(1)}
          </span>
        </span>
      )}
      <span className="text-micro text-text-4 normal-case tracking-normal">no contact mapped</span>
    </div>
  )
}

// ─── Roster table ─────────────────────────────────────────────────────────────

function RosterTable({ rows }: { rows: RosterRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-body">
        <thead>
          <tr className="text-micro text-text-4">
            <th className="font-medium py-1.5 pr-4">Name</th>
            <th className="font-medium py-1.5 pr-4">Company</th>
            <th className="font-medium py-1.5 pr-4">Title</th>
            <th className="font-medium py-1.5 pr-4">Tie</th>
            <th className="font-medium py-1.5 pr-4">Degree</th>
            <th className="font-medium py-1.5 pr-4">Last contact</th>
            <th className="font-medium py-1.5">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default/60">
          {rows.map(r => (
            <tr key={`${r.contact.companyKey}|${r.contact.name}`}>
              <td className="py-1.5 pr-4 text-text-1 font-medium whitespace-nowrap">{r.contact.name}</td>
              <td className="py-1.5 pr-4 whitespace-nowrap">
                {r.inPipeline
                  ? <CompanyLink company={r.contact.company} size={14} showName className="text-body" />
                  : <span className="text-text-3">{r.contact.company}</span>}
              </td>
              <td className="py-1.5 pr-4 text-text-3">{r.contact.title || '—'}</td>
              <td className="py-1.5 pr-4 text-text-3">{TIE_LABEL[r.contact.relationship] ?? r.contact.relationship}</td>
              <td className="py-1.5 pr-4 text-text-3 whitespace-nowrap">{degreeLabel(r.contact.degree, r.contact.via)}</td>
              <td className="py-1.5 pr-4 text-text-4 font-mono text-[11px] whitespace-nowrap">{r.contact.lastContact || '—'}</td>
              <td className="py-1.5">
                {r.thread
                  ? <Chip meta={ACTION_META[r.thread.action] ?? ACTION_META.waiting} />
                  : r.inPipeline
                    ? <span className="text-micro text-accent normal-case tracking-normal">warm path</span>
                    : <span className="text-micro text-text-4 normal-case tracking-normal">not in pipeline</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

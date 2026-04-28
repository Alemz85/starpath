'use client'

import { useEffect, useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, claudeArgs, type SpawnRecord } from '@/store/spawns'
import {
  Briefcase, AlertTriangle, FileText, MessageSquare, GraduationCap,
} from 'lucide-react'
import { StatCard } from '@/components/command-center/StatCard'
import { ActivityPanel, pickVisible } from '@/components/command-center/CommandCenter'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { ApplyAction } from '@/components/shared/ApplyAction'
import { cn, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { type AppStatus, type ApplicationEntry } from '@/types'

// Active = anything that needs your attention. Evaluated lives here too —
// it's the inbox of "I've scored this, decide whether to apply." Rejected /
// Discarded / SKIP are off-stage and not surfaced.
const ACTIVE_STATUSES: AppStatus[] = ['Interview', 'Responded', 'Applied', 'Evaluated', 'Offer']

const PER_APP_TAILOR_CV = 'app-tailor-cv'
const PER_APP_DRAFT_APP = 'app-draft'
const PER_APP_INTERVIEW = 'app-interview'

export function ApplyingView() {
  const { applications, loaded, refresh } = useDataStore()
  const { spawns, start, kill, clear } = useSpawnsStore()
  const navigate = useNavStore(s => s.navigate)

  const tailor = spawns[PER_APP_TAILOR_CV]
  const draft  = spawns[PER_APP_DRAFT_APP]
  const prep   = spawns[PER_APP_INTERVIEW]
  const visible = pickVisible(tailor, draft, prep)

  useEffect(() => {
    if (tailor?.status === 'done' || tailor?.status === 'error' || tailor?.status === 'killed') refresh()
  }, [tailor?.status, refresh])
  useEffect(() => {
    if (draft?.status === 'done' || draft?.status === 'error' || draft?.status === 'killed') refresh()
  }, [draft?.status, refresh])
  useEffect(() => {
    if (prep?.status === 'done' || prep?.status === 'error' || prep?.status === 'killed') refresh()
  }, [prep?.status, refresh])

  // Sort active applications by status priority (interview first → offer last)
  // then by deadline urgency, then by date.
  const activeList = useMemo(() => {
    const statusOrder = new Map(ACTIVE_STATUSES.map((s, i) => [s, i]))
    const urgencyRank = (s: string) => s === 'urgent' ? 0 : s === 'soon' ? 1 : 2
    return applications
      .filter(a => statusOrder.has(a.status))
      .sort((a, b) => {
        const sa = statusOrder.get(a.status)!
        const sb = statusOrder.get(b.status)!
        if (sa !== sb) return sa - sb
        const ua = urgencyRank(deadlineUrgency(a.deadline))
        const ub = urgencyRank(deadlineUrgency(b.deadline))
        if (ua !== ub) return ua - ub
        return (b.date || '').localeCompare(a.date || '')
      })
  }, [applications])

  const totalApplied      = applications.filter(a => a.status === 'Applied').length
  const totalResponded    = applications.filter(a => a.status === 'Responded').length
  const totalInterviewing = applications.filter(a => a.status === 'Interview').length
  const totalOffers       = applications.filter(a => a.status === 'Offer').length
  const urgentCount       = applications.filter(a => deadlineUrgency(a.deadline) === 'urgent').length

  const launch = (id: string, label: string, app: ApplicationEntry, modeFile: string) => {
    if (spawns[id]?.status === 'running') { kill(id); return }
    if (spawns[id]) clear(id)
    // Invoke the user-invocable career-ops skill with the mode + listing
    // context. modes/pdf.md → /career-ops pdf for {company} — {role}
    const mode = modeFile.replace(/^modes\//, '').replace(/\.md$/, '')
    const slash = `/career-ops ${mode} for ${app.company} — ${app.role}`
    start(id, `${label}: ${app.company}`, 'claude', claudeArgs(slash))
  }

  const handleTailorCV = (a: ApplicationEntry) => launch(PER_APP_TAILOR_CV, 'Tailor CV',         a, 'modes/pdf.md')
  const handleDraftApp = (a: ApplicationEntry) => launch(PER_APP_DRAFT_APP, 'Draft Application', a, 'modes/apply.md')
  const handlePrepInt  = (a: ApplicationEntry) => launch(PER_APP_INTERVIEW, 'Prep Interview',    a, 'modes/interview-prep.md')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Applying</h1>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-8 gap-6 overflow-hidden min-h-0">
        {/* Hero */}
        <div className="shrink-0 galaxy-bg rounded-lg p-6 border border-border-default">
          <div className="flex items-center gap-3">
            <Briefcase size={20} className="text-accent" />
            <div>
              <h1 className="text-page text-text-1 mb-1">Applying</h1>
              <p className="text-body text-text-3">
                {loaded
                  ? `${activeList.length} active · ${totalInterviewing} interviewing · ${totalOffers} offers`
                  : 'Loading data…'}
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="shrink-0 grid grid-cols-3 gap-3 lg:grid-cols-5">
          <StatCard label="Applied"          value={loaded ? String(totalApplied)      : '—'} icon={Briefcase} loading={!loaded} />
          <StatCard label="Responded"        value={loaded ? String(totalResponded)    : '—'} icon={MessageSquare} accent="text-accent" loading={!loaded} />
          <StatCard label="Interviewing"     value={loaded ? String(totalInterviewing) : '—'} icon={GraduationCap} accent="text-warning" loading={!loaded} />
          <StatCard label="Offers"           value={loaded ? String(totalOffers)       : '—'} icon={FileText} accent="text-success" loading={!loaded} />
          <StatCard label="Urgent deadlines" value={loaded ? String(urgentCount)       : '—'} icon={AlertTriangle} accent={urgentCount > 0 ? 'text-danger' : undefined} loading={!loaded} />
        </div>

        {/* Active applications list + activity panel */}
        <div className="flex-1 flex flex-col min-h-0 gap-4">
          <div className="flex items-center justify-between shrink-0">
            <span className="text-micro text-text-4 uppercase tracking-wider">Active applications</span>
            <button
              onClick={() => navigate('pipeline')}
              className="text-[11px] text-text-3 hover:text-accent transition-colors"
            >
              Open pipeline →
            </button>
          </div>

          <div className="overflow-y-auto pr-1 space-y-2 max-h-[360px]">
            {activeList.length === 0 ? (
              <div className="galaxy-bg rounded-lg p-8 text-center border border-border-default">
                <p className="text-body text-text-3">No active applications yet.</p>
                <p className="text-label text-text-4 mt-1">
                  Promote a listing from Database or Reports with the Apply button to add it here.
                </p>
              </div>
            ) : (
              activeList.map((app, i) => (
                <ApplicationRow
                  key={`${app.company}-${app.role}-${i}`}
                  app={app}
                  spawns={spawns}
                  onTailorCV={() => handleTailorCV(app)}
                  onDraftApp={() => handleDraftApp(app)}
                  onPrepInt={() => handlePrepInt(app)}
                  onViewReport={() => navigate('reports', `${app.company}|${app.role}`)}
                />
              ))
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <ActivityPanel record={visible} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Active application row ─────────────────────────────────────────────────

function ApplicationRow({ app, spawns, onTailorCV, onDraftApp, onPrepInt, onViewReport }: {
  app: ApplicationEntry
  spawns: Record<string, SpawnRecord>
  onTailorCV: () => void
  onDraftApp: () => void
  onPrepInt:  () => void
  onViewReport: () => void
}) {
  const urgency = deadlineUrgency(app.deadline)
  const badge = urgencyBadge(urgency)

  const tailorRunning = spawns[PER_APP_TAILOR_CV]?.status === 'running' && spawns[PER_APP_TAILOR_CV]?.label.includes(app.company)
  const draftRunning  = spawns[PER_APP_DRAFT_APP]?.status === 'running' && spawns[PER_APP_DRAFT_APP]?.label.includes(app.company)
  const prepRunning   = spawns[PER_APP_INTERVIEW]?.status === 'running' && spawns[PER_APP_INTERVIEW]?.label.includes(app.company)

  return (
    <div className="rounded-lg border border-border-default bg-bg-panel hover:border-border-strong transition-colors px-4 py-3">
      <div className="flex items-center gap-4">
        <CompanyLogo company={app.company} size={32} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-text-1 font-semibold truncate leading-tight">{app.company}</div>
          <div className="text-[11.5px] text-text-3 truncate leading-tight mt-0.5">{app.role}</div>
        </div>

        {/* Score / urgency */}
        <div className="hidden md:flex items-center gap-3 shrink-0 text-[11px] font-mono text-text-3 tabular-nums">
          <span>{app.score || '—'}</span>
          {badge && (
            <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', badge.color)}>
              {badge.label}
            </span>
          )}
        </div>

        {/* Files strip */}
        <FilesStrip company={app.company} role={app.role} size="md" className="shrink-0" />

        {/* Status / Apply */}
        <div className="shrink-0">
          <ApplyAction company={app.company} role={app.role} size="sm" />
        </div>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-1.5 mt-2.5">
        <RowAction label="Tailor CV"  running={tailorRunning} onClick={onTailorCV} />
        <RowAction label="Draft"      running={draftRunning}  onClick={onDraftApp} />
        <RowAction label="Prep"       running={prepRunning}   onClick={onPrepInt} />
        <RowAction label="Report"     running={false}         onClick={onViewReport} />
      </div>
    </div>
  )
}

function RowAction({ label, running, onClick }: { label: string; running: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors',
        running
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-border-default text-text-3 hover:text-accent hover:border-accent/40 hover:bg-accent/5',
      )}
    >
      {running ? '…' : label}
    </button>
  )
}

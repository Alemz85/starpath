'use client'

import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  X, FileText, Database as DatabaseIcon, ExternalLink, ChevronLeft, AlertTriangle, ArrowUpRight, HelpCircle,
} from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useNavStore } from '@/store/nav'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { cn, formatRelative } from '@/lib/utils'
import type { Eligibility, EligibilityFlag, ScoreEntry, Verdict } from '@/types'
import {
  assignVerdict, blockedReason, eligibilityCheckLabel, isBlocked, isScored, parseEligibilityFlags,
  verdictOf, VERDICT_ACTIONS,
} from '@/lib/scoreBands'
import { MatchEase } from '@/components/shared/MatchEase'
import { EligibilityChip, VerdictChip } from '@/components/shared/EligibilityChip'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ApplyAction } from '@/components/shared/ApplyAction'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { parseCities, entityId } from '@/lib/entityId'
import { listingDateKey } from '@/lib/listingDates'
import { parseReportPosted, pickPostedDate } from '@/lib/postedDate'
import { describeDocuments, documentsUnknown, parseReportDocuments, summarizeDocuments, type ApplicationDocuments } from '@/lib/applicationDocuments'
import {
  extractMetadata, parseDimensionalScoring, splitPeerBlock, parseReportHeader,
  splitEligibility, splitSalaryMath,
  type ParsedDimensions, type DimensionRow,
} from '@/lib/reportMarkdown'
import { peerContext, type PeerContext } from '@/lib/peerRank'
import { PeerContextCard } from '@/components/reports/PeerContextCard'
import { JobFacts, SummaryCard, type JobFact } from '@/components/reports/DossierParts'
import {
  contractLabel, reportSummary, roleSummaryFields, splitLocationLine,
} from '@/components/reports/reportFacts'
import {
  GATES, classifyMovement, confidenceTier, formatWithinNoise, NOISE_FLOORS,
} from '@/lib/scoringStats'
import { Button, Chip, ScoreNumber, ScoreBar, SectionHeading } from '@/components/ui'
import { loadJdArchive, reportNumberFor, type JdArchive } from '@/lib/jdArchive'
import { mirroredPathCandidates, reportFileStem, reportPathCandidates, resolveReport } from '@/lib/reportMatch'

// ─── The report dossier ──────────────────────────────────────────────────────
//
// A right-hand panel that reads like a document. The header has the identity
// line, then two zones: the job's own facts as a stacked list on the left,
// and on the right a well with what the app made of the listing (verdict,
// Match · Ease, eligibility, actions). Then a tab strip, and a body split into
// a sticky section index and the content. The content opens on the summary
// card (the two score tiles beside the report's own TL;DR, verbatim), then
// the eligibility checks, the scores as a statement-style table, the prose
// sections, and the salary math footer. Self-contained: it takes a listing
// and reads everything else itself, so any view can mount it. Scoring v2:
// docs/scoring-v2.md.

type Tab = 'scouting' | 'application' | 'listing' | 'history'

interface SiblingInfo {
  company: string
  role: string
  city: string
  match: number | null
  ease: number | null
}

interface HistoryEntry {
  date: string
  monthLabel: string
  match: number | null  // null when that evaluation was blocked
  ease: number | null
  verdict: Verdict | null
  tier: string
}

interface ReportSlideOverProps {
  company: string
  role: string
  scoreEntry: ScoreEntry
  /** Hide the "View in Database" action — used when opened from the Database. */
  hideDatabaseLink?: boolean
  /** Sibling navigation (same role, other city). Omit to hide. */
  onSwitchEntity?: (company: string, role: string) => void
  onClose: () => void
}

const TIER_DIRS = ['tier-1', 'tier-2', 'tier-3', 'tier-4'] as const

export function ReportSlideOver({ company, role, scoreEntry, hideDatabaseLink, onSwitchEntity, onClose }: ReportSlideOverProps) {
  const repoPath = useAppStore(s => s.repoPath)
  const navigate = useNavStore(s => s.navigate)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const scoutingRows = useDataStore(s => s.scouting)
  const applicationRows = useDataStore(s => s.applications)
  const indexedReports = useDataStore(s => s.reports)
  const [scoutingContent, setScoutingContent] = useState<string | null>(null)
  const [applicationContent, setApplicationContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('scouting')
  const [snapshot, setSnapshot] = useState<{ date: string; content: string } | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  // The saved job description (jds/): undefined while loading, null when the
  // listing has none.
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [jd, setJd] = useState<JdArchive | null | undefined>(undefined)

  // Re-evaluation history for this entity, newest first.
  const history: HistoryEntry[] = useMemo(() => {
    return scoreHistory
      .filter(r => r.company === company && r.role === role)
      .map(r => ({
        date: r.date,
        monthLabel: r.date.slice(0, 7),
        match: isScored(r) ? r.match : null,
        ease: isScored(r) ? r.ease : null,
        verdict: verdictOf(r),
        tier: r.tier,
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [scoreHistory, company, role])
  const historyAvailable = history.length >= 2

  // Live peer context (lib/peerRank.ts); null under the cohort gate or when
  // the feature is off, in which case the frozen block in the markdown stays.
  const peerEnabled = useAppStore(s => s.features.peerContext)
  const peer: PeerContext | null = useMemo(
    () => (peerEnabled ? peerContext(scoreEntry, scoreHistory) : null),
    [peerEnabled, scoreEntry, scoreHistory],
  )

  // Same role evaluated in other cities (separate Database rows).
  const siblings: SiblingInfo[] = useMemo(() => {
    if (!onSwitchEntity) return []
    const myParsed = parseCities(scoreEntry.location)
    const myId = entityId(company, role, myParsed)
    const myRoleKey = myId.split('::').slice(0, 2).join('::')
    const byEntity = new Map<string, SiblingInfo & { date: string }>()
    for (const r of scoreHistory) {
      const parsed = parseCities(r.location)
      const id = entityId(r.company, r.role, parsed)
      if (id === myId) continue
      if (!id.startsWith(myRoleKey + '::')) continue
      const prev = byEntity.get(id)
      if (!prev || r.date > prev.date) {
        byEntity.set(id, {
          company: r.company,
          role: r.role,
          city: parsed.isMulti ? `${parsed.primary ?? '?'} +${parsed.cities.length - 1}` : (parsed.primary ?? '?'),
          match: isScored(r) ? r.match : null,
          ease: isScored(r) ? r.ease : null,
          date: r.date,
        })
      }
    }
    return [...byEntity.values()].map(({ date: _d, ...rest }) => rest)
  }, [scoreHistory, company, role, scoreEntry.location, onSwitchEntity])

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setTimeout(onClose, 220)
  }, [onClose])

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    setScoutingContent(null)
    setApplicationContent(null)
    setReportPath(null)
    if (!repoPath) {
      setError('No repository configured.')
      setLoading(false)
      return
    }
    // lib/reportMatch: the report the cache index ties to this listing (by
    // the tracker row's report link, then the file-name rule), else probe the
    // disk with the same candidates — the tracker links, then each tier
    // folder under the name as written and as cleaned (no parentheses etc.).
    const trackerRows = [...scoutingRows, ...applicationRows]
    let scoutingPath: string | null = null
    const indexed = resolveReport(indexedReports, { company, role }, trackerRows)
    if (indexed && await ipc.fileExists(indexed.path)) scoutingPath = indexed.path
    if (!scoutingPath) {
      for (const p of reportPathCandidates(company, role, trackerRows)) {
        if (await ipc.fileExists(p)) { scoutingPath = p; break }
      }
    }
    let prepPath: string | null = null
    for (const p of mirroredPathCandidates('interview-prep', company, role)) {
      if (await ipc.fileExists(p)) { prepPath = p; break }
    }
    const prepExists = prepPath != null

    if (scoutingPath) {
      const text = await ipc.readFile(scoutingPath)
      if (text) setScoutingContent(text)
    }
    if (prepPath) {
      const text = await ipc.readFile(prepPath)
      if (text) setApplicationContent(text)
    }
    setReportPath(scoutingPath)
    if (scoutingPath) setActiveTab('scouting')
    else if (prepExists) setActiveTab('application')
    else setError('No report or application prep exists for this listing yet.')
    setLoading(false)
    // The tracker rows and the index only refine where the file is; reloading
    // on every store refresh would flash the panel, so they're read from the
    // latest render without being dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, role, repoPath])

  useEffect(() => { loadFiles() }, [loadFiles])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  useEffect(() => { setSnapshot(null) }, [activeTab])

  const openSnapshot = useCallback(async (date: string) => {
    if (!repoPath) return
    setSnapshotLoading(true)
    setSnapshot(null)
    // Snapshots sit beside the report as `.history/{report name}.{date}.md`:
    // try the found report's own folder and name first, then every tier
    // folder under the name as written and as cleaned.
    const candidates: string[] = []
    if (reportPath) {
      const slash = reportPath.lastIndexOf('/')
      const base = reportPath.slice(slash + 1).replace(/\.md$/i, '')
      candidates.push(`${reportPath.slice(0, slash)}/.history/${base}.${date}.md`)
    }
    const stems = [`${company} - ${role}`, reportFileStem(company, role)]
    for (const dir of TIER_DIRS) for (const stem of stems) candidates.push(`reports/${dir}/.history/${stem}.${date}.md`)
    let path: string | null = null
    for (const candidate of candidates) {
      if (await ipc.fileExists(candidate)) { path = candidate; break }
    }
    if (!path) {
      setSnapshot({ date, content: `No snapshot file was found for ${date}. Re-evaluations after this date write one under reports/tier-N/.history/.` })
      setSnapshotLoading(false)
      return
    }
    const text = await ipc.readFile(path)
    setSnapshot({ date, content: text ?? 'The snapshot file exists but could not be read.' })
    setSnapshotLoading(false)
  }, [company, role, repoPath, reportPath])

  // Header metadata parsed from the report (archetype, verification, the
  // richer location line) — rendered once, in the header.
  const reportMeta = useMemo(() => {
    if (!scoutingContent) return { archetype: '', location: '', unconfirmed: false, url: '', posted: null as string | null, documents: null as ApplicationDocuments | null, roleFields: {} as Record<string, string> }
    const { meta } = extractMetadata(scoutingContent)
    const get = (k: string) => meta.find(m => m.key.toLowerCase() === k)?.value ?? ''
    const url = scoutingContent.match(/^\*\*URL:\*\*\s*(\S+)/im)?.[1] ?? ''
    return {
      archetype: get('archetype'),
      location: get('location'),
      unconfirmed: /unconfirmed/i.test(get('verification')),
      url,
      posted: parseReportPosted(scoutingContent),
      documents: parseReportDocuments(scoutingContent),
      roleFields: roleSummaryFields(scoutingContent),
    }
  }, [scoutingContent])

  const url =
    (scoreEntry.url && /^https?:\/\//i.test(scoreEntry.url) && scoreEntry.url) ||
    (/^https?:\/\//i.test(reportMeta.url) ? reportMeta.url : '')

  // The listing's dates from scan-history (store `listingDates`, joined in
  // main by URL, then company + role): the posting date when the scan had
  // one, else when a scan first saw it; the deadline when the source stated one.
  const dates = useDataStore(s => s.listingDates[listingDateKey(company, role)])

  // Saved posting text: found by the report's tracker number, else the listing
  // URL, else company + role (lib/jdArchive.ts). Read through the same file
  // IPC as the report, so it works wherever the panel is mounted.
  useEffect(() => {
    let cancelled = false
    setJd(undefined)
    if (loading) return
    const num = reportNumberFor({ scouting: scoutingRows, applications: applicationRows, reportPath, company, role })
    loadJdArchive({ num, company, role, url }, { list: () => ipc.listDir('jds'), read: ipc.readFile })
      .then(found => { if (!cancelled) setJd(found) })
      .catch(() => { if (!cancelled) setJd(null) })
    return () => { cancelled = true }
  }, [loading, reportPath, company, role, url, scoutingRows, applicationRows])

  const entryVerdict = verdictOf(scoreEntry)
  const entryBlocked = isBlocked(scoreEntry)
  const verdictGrid = entryBlocked || !isScored(scoreEntry)
    ? null
    : assignVerdict({ match: scoreEntry.match, ease: scoreEntry.ease, eligibility: scoreEntry.eligibility })?.reason ?? null

  // The job facts column. A multi-city listing gets the same treatment as
  // its Database row: the first (scored) city plus "+N more", every city on
  // hover — never the whole list as one string.
  const facts: JobFact[] = useMemo(() => {
    const out: JobFact[] = []
    const { place, workMode } = splitLocationLine(reportMeta.location)
    const cityInfo = parseCities(scoreEntry.location || place)
    if (cityInfo.cities.length > 0) {
      const first = cityInfo.primary ?? cityInfo.cities[0]
      const head = cityInfo.country && first !== cityInfo.country ? `${first}, ${cityInfo.country}` : first
      out.push(cityInfo.isMulti
        ? {
            label: 'Location',
            value: <>{head} <span className="text-text-3">+{cityInfo.cities.length - 1} more</span></>,
            title: cityInfo.cities.join(' · '),
          }
        : { label: 'Location', value: head, title: reportMeta.location || scoreEntry.location })
    } else if (place || scoreEntry.location) {
      out.push({ label: 'Location', value: place || scoreEntry.location })
    }
    const mode = workMode || reportMeta.roleFields.Remote || ''
    if (mode) out.push({ label: 'Work mode', value: capitalize(mode) })
    const contract = contractLabel(scoreEntry.employment_type, scoreEntry.duration)
    if (contract) out.push({ label: 'Contract', value: contract })
    if (reportMeta.roleFields.Seniority) out.push({ label: 'Seniority', value: reportMeta.roleFields.Seniority })
    if (scoreEntry.salary_raw && scoreEntry.salary_raw !== '—') out.push({ label: 'Salary', value: scoreEntry.salary_raw })
    const archetype = reportMeta.archetype || scoreEntry.archetype
    if (archetype) out.push({ label: 'Archetype', value: archetype })
    // Scan-history's posting date, else the report's own `**Posted:**` line
    // (a listing added by URL has only that). The evaluation date is never
    // shown as a posting date: the Evaluated fact below already carries it.
    const posted = pickPostedDate({ scanPosted: dates?.postedDate, reportPosted: reportMeta.posted })
    if (posted) {
      out.push({
        label: 'Posted',
        value: `${formatDay(posted.date)} · ${formatRelative(posted.date)}`,
        title: posted.source === 'scan' ? 'Posting date from the job board' : 'Posting date stated in the evaluation report',
      })
    } else if (dates?.firstSeen) {
      out.push({ label: 'First seen', value: `${formatDay(dates.firstSeen)} · ${formatRelative(dates.firstSeen)}`, title: 'First picked up by a scan (no posting date on file)' })
    }
    if (dates?.deadline) out.push({ label: 'Deadline', value: `${formatDay(dates.deadline)} · ${formatRelative(dates.deadline)}`, title: 'Application deadline stated by the listing' })
    // What the application asks you to submit (the report's `**Documents:**`
    // line). Reports written before the line existed show nothing; a line
    // that knows nothing says so, so an unknown never reads as "not needed".
    const docs = reportMeta.documents
    if (docs) {
      out.push(documentsUnknown(docs)
        ? { label: 'Documents', value: <span className="text-text-3">Not stated</span>, title: 'The posting doesn’t say what to submit; check the form before you start' }
        : { label: 'Documents', value: summarizeDocuments(docs), title: describeDocuments(docs) })
    }
    if (scoreEntry.date) out.push({ label: 'Evaluated', value: `${formatDay(scoreEntry.date)} · ${formatRelative(scoreEntry.date)}` })
    if (siblings.length > 0) {
      out.push({
        label: 'Also in',
        value: (
          <span className="inline-flex items-center gap-x-2.5 flex-wrap">
            {siblings.map(s => (
              <button
                key={`${s.company}|${s.role}`}
                onClick={() => onSwitchEntity?.(s.company, s.role)}
                title={`${s.role} · ${s.city} · Match ${s.match?.toFixed(1) ?? '—'} · Ease ${s.ease?.toFixed(1) ?? '—'}`}
                className="inline-flex items-center gap-0.5 text-accent-text hover:underline underline-offset-2"
              >
                {s.city}
                <ArrowUpRight size={11} />
              </button>
            ))}
          </span>
        ),
        title: 'Same role, evaluated in other cities',
      })
    }
    return out
  }, [reportMeta, scoreEntry, dates, siblings, onSwitchEntity])

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-30 bg-scrim/[0.32] transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${company} · ${role}`}
        className={cn(
          'fixed right-0 top-0 bottom-0 z-40 w-[1040px] max-w-[calc(100vw-200px)] bg-bg-base flex flex-col sheet',
          'transition-[transform,opacity] duration-[260ms] ease-quart',
          open ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
        )}
      >
        <div className="titlebar-drag h-10 shrink-0" />

        {/* Header: identity, then two zones. Left, the job's own facts as a
            stacked list (they belong to the listing, so they sit under its
            name). Right, what the app made of it: verdict, scores, actions,
            set off by a hairline rule (no box, so both zones read alike) and
            ending under the close button, never past it. */}
        <div className="px-8 pt-2 pb-4 shrink-0">
          <div className="flex items-start gap-4">
            <CompanyLogo company={company} size={44} className="shrink-0" />
            <div className="flex-1 min-w-0">
              <h2 className="text-page text-text-1 truncate" title={company}>{company}</h2>
              <p className="text-body text-text-3 leading-snug line-clamp-2" title={role}>{role}</p>
            </div>
            <Button tone="ghost" size="sm" iconOnly aria-label="Close" title="Close (Esc)" onClick={handleClose} icon={<X size={15} />} />
          </div>

          <div className="mt-4 flex items-start gap-8 pr-7">
            <JobFacts facts={facts} className="flex-1 min-w-0 pl-[60px] pt-0.5" />

            <div className="w-[360px] shrink-0 border-l border-border-default pl-6 py-0.5 flex flex-col gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <VerdictChip verdict={entryVerdict} size="md" />
                {entryVerdict && (
                  <span className="text-body font-medium text-text-1 truncate" title={verdictGrid ?? undefined}>
                    {capitalize(VERDICT_ACTIONS[entryVerdict])}
                  </span>
                )}
                <div className="flex-1" />
                <EligibilityChip status={scoreEntry.eligibility} className="shrink-0" />
              </div>
              {(entryBlocked || isScored(scoreEntry)) && (
                <MatchEase
                  match={scoreEntry.match}
                  ease={scoreEntry.ease}
                  blockedReason={entryBlocked ? blockedReason(scoreEntry) : null}
                  decimals={2}
                  numberClassName="text-[16px]"
                />
              )}
              {reportMeta.unconfirmed && (
                <Chip tone="warning" icon={<AlertTriangle size={11} />} className="self-start" title="This report was written in batch mode without a live check of the listing.">
                  Listing unconfirmed
                </Chip>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <ApplyAction company={company} role={role} scoreEntry={scoreEntry} size="sm" />
                {url && (
                  <Button tone="secondary" size="sm" icon={<ExternalLink size={13} />} onClick={() => ipc.openExternal(url)}>
                    Open listing
                  </Button>
                )}
                <FilesStrip company={company} role={role} size="sm" />
              </div>
              {!hideDatabaseLink && (
                <Button tone="ghost" size="sm" className="self-start -ml-2 -mb-1" icon={<DatabaseIcon size={13} />} onClick={() => { navigate('database', company); handleClose() }}>
                  View in Database
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Report sections" className="flex items-center gap-7 border-b border-border-default shrink-0 px-8 mt-1">
          <TabButton label="Scouting report" active={activeTab === 'scouting'} disabled={!scoutingContent} onClick={() => setActiveTab('scouting')} />
          <TabButton label="Application prep" active={activeTab === 'application'} disabled={!applicationContent} onClick={() => setActiveTab('application')} hint="Not generated yet" />
          <TabButton label="Job listing" active={activeTab === 'listing'} disabled={false} onClick={() => setActiveTab('listing')} />
          <TabButton label="History" count={historyAvailable ? history.length : undefined} active={activeTab === 'history'} disabled={!historyAvailable} onClick={() => setActiveTab('history')} hint="Only one evaluation so far" />
        </div>

        {/* Body: section index + content */}
        <div className="flex-1 min-h-0 flex">
          {!loading && !error && activeTab !== 'history' && (
            <SectionIndex scrollEl={scrollEl} contentKey={`${activeTab}:${company}:${role}`} />
          )}
          <div ref={setScrollEl} className="flex-1 min-w-0 overflow-y-auto pl-5 pr-8 py-6">
            {loading && (
              <div className="flex flex-col gap-3" aria-busy>
                {[80, 60, 90, 50, 70].map((w, i) => (
                  <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
                ))}
              </div>
            )}
            {error && <EmptyTab message={error} />}
            {!loading && !error && activeTab === 'scouting' && (
              scoutingContent
                ? <ReportBody content={scoutingContent} entry={scoreEntry} peer={peer} onOpenComparable={onSwitchEntity} />
                : (
                  // No report (a Blocked listing never gets one): still show
                  // every eligibility check, so a listing blocked by two walls
                  // shows both, not just the first.
                  <div className="flex flex-col gap-7">
                    <EligibilitySection
                      status={scoreEntry.eligibility ?? null}
                      checks={parseEligibilityFlags(scoreEntry.eligibility_flags)}
                      questions={[]}
                    />
                    <EmptyTab message="No scouting report yet. Use Generate report from the Database row to write one." />
                  </div>
                )
            )}
            {!loading && !error && activeTab === 'application' && (
              applicationContent
                ? <ProseBody content={applicationContent} />
                : <EmptyTab message="No application prep yet. Use Prep application from the Database row to research interview intel and map your stories." />
            )}
            {!loading && !error && activeTab === 'listing' && (
              <JobListingTab jd={jd} url={url} />
            )}
            {!loading && !error && activeTab === 'history' && (
              snapshot ? (
                <HistorySnapshotView date={snapshot.date} content={snapshot.content} loading={snapshotLoading} onBack={() => setSnapshot(null)} />
              ) : (
                <HistoryTable rows={history} onPick={openSnapshot} />
              )
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
function formatDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : DAY_FMT.format(d)
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function TabButton({ label, count, active, disabled, onClick, hint }: {
  label: string
  count?: number
  active: boolean
  disabled: boolean
  onClick: () => void
  hint?: string
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={disabled ? hint ?? `${label} is not available` : undefined}
      className={cn(
        'flex items-center gap-1.5 px-0.5 pt-2.5 pb-3 text-[13px] border-b-2 -mb-px transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
        active
          ? 'text-text-1 border-accent'
          : disabled
            ? 'text-text-4 border-transparent cursor-default'
            : 'text-text-3 border-transparent hover:text-text-1',
      )}
    >
      {label}
      {typeof count === 'number' && <span className={cn('text-[12px] tabular-nums', active ? 'text-text-3' : 'text-text-4')}>{count}</span>}
    </button>
  )
}

// ─── Section index (sticky rail, scroll-spy) ─────────────────────────────────
//
// Reads every `[data-slug]` element inside the scroll container (the verdict
// card, the eligibility section, the scores table, the peer panel and each
// markdown h2 register one),
// lists them, and tracks which one is in view.

function SectionIndex({ scrollEl, contentKey }: { scrollEl: HTMLDivElement | null; contentKey: string }) {
  const [items, setItems] = useState<Array<{ slug: string; label: string }>>([])
  const [active, setActive] = useState<string>('')

  useEffect(() => {
    if (!scrollEl) return
    let nodes: HTMLElement[] = []
    const collect = () => {
      nodes = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-slug]'))
      const seen = new Set<string>()
      // One entry per slug: two sections that resolve to the same slug would
      // otherwise list twice and highlight together.
      const next = nodes
        .map(n => ({ slug: n.dataset.slug ?? '', label: n.dataset.label ?? n.textContent?.trim() ?? '' }))
        .filter(i => i.slug && i.label && !seen.has(i.slug) && (seen.add(i.slug), true))
      setItems(next)
    }
    // The active section is the last one whose top has passed a line 96px
    // below the top of the scroll area (or the last one when scrolled to
    // the end), so a heading that scrolled out of view keeps its section
    // highlighted until the next heading arrives.
    const update = () => {
      if (nodes.length === 0) return
      const rootTop = scrollEl.getBoundingClientRect().top
      const line = rootTop + 96
      const atEnd = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2
      let current = nodes[0]
      for (const n of nodes) {
        if (n.getBoundingClientRect().top <= line) current = n
      }
      if (atEnd) current = nodes[nodes.length - 1]
      const slug = current.dataset.slug
      if (slug) setActive(slug)
    }
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    collect()
    update()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    // Markdown renders after the first paint; re-collect once it settles.
    const t = window.setTimeout(() => { collect(); update() }, 150)
    return () => {
      window.clearTimeout(t)
      cancelAnimationFrame(raf)
      scrollEl.removeEventListener('scroll', onScroll)
    }
  }, [scrollEl, contentKey])

  const jump = (slug: string) => {
    if (!scrollEl) return
    const target = scrollEl.querySelector<HTMLElement>(`[data-slug="${slug}"]`)
    if (!target) return
    const offset = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - 16
    scrollEl.scrollTo({ top: offset, behavior: 'smooth' })
  }

  if (items.length < 2) return <div className="w-[168px] shrink-0" aria-hidden />

  return (
    <nav className="w-[168px] shrink-0 py-6 pl-5 pr-2 overflow-y-auto" aria-label="Report outline">
      <ul className="flex flex-col gap-1">
        {items.map(item => (
          <li key={item.slug}>
            <button
              onClick={() => jump(item.slug)}
              className={cn(
                'w-full text-left px-2.5 py-2 rounded text-label leading-snug transition-colors',
                active === item.slug ? 'bg-accent-soft text-text-1 font-medium' : 'text-text-3 hover:text-text-1 hover:bg-bg-elevated',
              )}
              aria-current={active === item.slug ? 'location' : undefined}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// ─── Report body ─────────────────────────────────────────────────────────────

function ReportBody({ content, entry, peer, onOpenComparable }: {
  content: string
  /** The listing's live score-history row: preferred over the report's
   *  frozen header for the summary card. */
  entry: ScoreEntry
  peer?: PeerContext | null
  onOpenComparable?: (company: string, role: string) => void
}) {
  const parsed = useMemo(() => {
    const header = parseReportHeader(content)
    // Carve the v2 blocks the dossier renders structurally: the
    // `## Eligibility` section and the closing `Salary math:` footer.
    const { eligibility, rest: noElig } = splitEligibility(content)
    const { salaryMath, rest: body } = splitSalaryMath(noElig)
    const { before, dims, after } = parseDimensionalScoring(body)
    if (!dims) {
      const fallback = peer ? splitPeerBlock(body).rest : body
      return { header, eligibility, salaryMath, dims: null as ParsedDimensions | null, after: '', before: stripTitle(extractMetadata(fallback).rest) }
    }
    const { rest: beforeWithoutMeta } = extractMetadata(before)
    // A legacy `## Why this score` section stays in `after` and renders as
    // an ordinary prose section.
    const afterFinal = peer ? splitPeerBlock(after).rest : after
    return { header, eligibility, salaryMath, dims, after: afterFinal, before: stripTitle(beforeWithoutMeta) }
  }, [content, peer])

  // Score values: the live score-history row first, the report header second.
  const { header } = parsed
  const blocked = isBlocked(entry) || header.eligibility === 'red'
  const match = entry.match ?? header.match
  const ease = entry.ease ?? header.ease
  const eligibility: Eligibility | null = entry.eligibility ?? header.eligibility
  const checks: EligibilityFlag[] = parsed.eligibility?.checks.length
    ? parsed.eligibility.checks
    : parseEligibilityFlags(entry.eligibility_flags)
  const questions = parsed.eligibility?.questions ?? []
  const reason = blocked
    ? (isBlocked(entry) ? blockedReason(entry) : (header.eligibilityReason || 'Not eligible'))
    : null
  const summary = useMemo(() => reportSummary(content), [content])

  return (
    <div className="flex flex-col gap-7">
      {parsed.before.trim() && <ProseBody content={parsed.before} />}
      <SummaryCard match={match} ease={ease} blockedReason={reason} summary={summary} />
      <EligibilitySection status={eligibility} checks={checks} questions={questions} />
      {parsed.dims && <ScoresTable dims={parsed.dims} />}
      {peer && <PeerContextCard peer={peer} onOpenComparable={onOpenComparable} />}
      {parsed.after.trim() && <ProseBody content={parsed.after} />}
      {parsed.salaryMath && <SalaryMathFooter text={parsed.salaryMath} />}
    </div>
  )
}

// The report's H1 repeats the company and role already in the header.
function stripTitle(md: string): string {
  return md.replace(/^\s*#\s[^\n]*\n?/, '').trim()
}

// ─── Eligibility ─────────────────────────────────────────────────────────────
//
// `## Eligibility` (docs/scoring-v2.md §8.5): the gate status, the non-green
// checks with their reasons, and the "Ask the recruiter" questions that
// resolve the amber ones. Check labels come from a label map with a humanised
// fallback, so a new check key never breaks the list.

function EligibilitySection({ status, checks, questions }: {
  status: Eligibility | null
  checks: EligibilityFlag[]
  questions: string[]
}) {
  if (!status && checks.length === 0) return null
  const nonGreen = checks.filter(c => c.status !== 'green')
  const green = checks.filter(c => c.status === 'green')
  // Questions the parser could not attach to a check still render below.
  const attached = new Set(checks.map(c => c.question).filter(Boolean))
  const loose = questions.filter(q => !attached.has(q))
  return (
    <section data-slug="eligibility" data-label="Eligibility" className="scroll-mt-4">
      <SectionHeading title="Eligibility" size="md" rule={false} action={<EligibilityChip status={status} />} />
      <div className="card overflow-hidden">
        {nonGreen.length === 0 ? (
          <p className="px-4 py-3 text-body text-text-3">
            {green.length > 0
              ? `All ${green.length} checks clear (${green.map(c => eligibilityCheckLabel(c.check).toLowerCase()).join(', ')}).`
              : 'No eligibility issues found.'}
          </p>
        ) : (
          <div className="divide-y divide-border-default">
            {nonGreen.map((c, i) => (
              <div key={`${c.check}-${i}`} className="grid grid-cols-[152px_1fr] gap-x-3 px-4 py-2.5">
                <div className="min-w-0 flex flex-col items-start gap-1">
                  <span className="text-body font-medium text-text-1 leading-snug">{eligibilityCheckLabel(c.check)}</span>
                  <EligibilityChip status={c.status} />
                </div>
                <div className="min-w-0 text-body text-text-2 leading-relaxed">
                  {c.reason ? <InlineMarkdown text={c.reason} /> : <span className="text-text-4">No reason recorded.</span>}
                  {c.question && (
                    <div className="mt-1 flex gap-1.5 text-text-3">
                      <HelpCircle size={13} className="shrink-0 mt-1 text-warning-text" aria-hidden />
                      <span>{c.question}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {loose.length > 0 && (
          <div className="px-4 py-3 border-t border-border-default">
            <div className="label mb-1.5">Ask the recruiter</div>
            <ul className="flex flex-col gap-1">
              {loose.map((q, i) => (
                <li key={i} className="flex gap-1.5 text-body text-text-2 leading-relaxed">
                  <HelpCircle size={13} className="shrink-0 mt-1 text-warning-text" aria-hidden />
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Scores table ────────────────────────────────────────────────────────────
//
// Statement-style: group rows carry the rollup, dimension rows carry the
// score, a bar and the reasoning. Report row order: the Match motivators, the
// hygiene factors that nudge Match, the Match rollup's arithmetic, then the Ease
// dimensions and the Ease rollup; context rows (not in any rollup) sit last.

function ScoresTable({ dims }: { dims: ParsedDimensions }) {
  return (
    <section data-slug="scores" data-label="Scores" className="scroll-mt-4">
      <SectionHeading title="Scores" size="md" rule={false} meta="Motivators and hygiene roll into Match, three dimensions into Ease; context rows inform the report only" />
      <div className="card overflow-hidden">
        {(dims.match.motivators.length > 0 || dims.match.hygiene.length > 0) && (
          <ScoreGroup
            title="Match"
            rollup={dims.match.rollup}
            rollupNote={dims.match.reasoning}
            rows={dims.match.motivators}
            subRows={dims.match.hygiene.length > 0 ? { title: 'Hygiene', subtitle: 'Nudges Match, never carries it', rows: dims.match.hygiene } : undefined}
          />
        )}
        {dims.ease.rows.length > 0 && (
          <ScoreGroup title="Ease" rollup={dims.ease.rollup} rollupNote={dims.ease.reasoning} rows={dims.ease.rows} />
        )}
        {dims.context.rows.length > 0 && (
          <ScoreGroup title="Context" subtitle="Shown for the decision, not in the rollups" rows={dims.context.rows} clampReasoning />
        )}
      </div>
    </section>
  )
}

function ScoreGroup({ title, subtitle, rollup, rollupNote, rows, subRows, clampReasoning }: {
  title: string
  subtitle?: string
  rollup?: string
  /** The rollup row's arithmetic ("M 8.0 + hygiene +0.25"), a quiet footer. */
  rollupNote?: string
  rows: DimensionRow[]
  /** A tagged sub-group under the main rows (Match › Hygiene). */
  subRows?: { title: string; subtitle: string; rows: DimensionRow[] }
  clampReasoning?: boolean
}) {
  const rollupNum = rollup ? parseFloat(rollup) : NaN
  const note = rollupNote && rollupNote !== '—' ? rollupNote : ''
  return (
    <div className="border-b border-border-default last:border-b-0">
      <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 bg-bg-elevated/70">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-section text-text-1">{title}</span>
          {subtitle && <span className="text-label text-text-4 truncate">{subtitle}</span>}
        </div>
        {!Number.isNaN(rollupNum) && <ScoreNumber value={rollupNum} size="md" decimals={2} className="text-[16px]" />}
      </div>
      <div className="divide-y divide-border-default">
        {rows.map((row, i) => <ScoreRow key={i} row={row} clamp={clampReasoning} />)}
      </div>
      {subRows && subRows.rows.length > 0 && (
        <>
          <div className="flex items-baseline gap-2 px-4 pt-3 pb-1.5 border-t border-border-default">
            <span className="text-body font-medium text-text-2">{subRows.title}</span>
            <span className="text-label text-text-4 truncate">{subRows.subtitle}</span>
          </div>
          <div className="divide-y divide-border-default">
            {subRows.rows.map((row, i) => <ScoreRow key={i} row={row} clamp />)}
          </div>
        </>
      )}
      {note && (
        <div className="flex items-baseline gap-2 px-4 py-2 border-t border-border-default text-label">
          <span className="text-text-4 shrink-0">{title} rollup</span>
          <span className="min-w-0 text-text-3"><InlineMarkdown text={note} /></span>
        </div>
      )}
    </div>
  )
}

function ScoreRow({ row, clamp }: { row: DimensionRow; clamp?: boolean }) {
  const num = parseFloat(row.score)
  const isNumeric = !Number.isNaN(num)
  const reasoning = row.reasoning && row.reasoning !== '—' ? row.reasoning : ''
  return (
    <div className="grid grid-cols-[36px_116px_1fr] gap-x-3 px-4 py-2.5">
      <div className="text-right pt-px">
        {isNumeric
          ? <ScoreNumber value={num} size="md" decimals={num % 1 === 0 ? 0 : 1} />
          : <span className="text-label text-text-4">{row.score || '—'}</span>}
      </div>
      <div className="min-w-0">
        <div className="text-body font-medium text-text-1 leading-snug">{row.label}</div>
        {isNumeric && <ScoreBar value={num} className="mt-1.5" width={56} />}
      </div>
      <div className="min-w-0 text-body text-text-2 leading-relaxed">
        {reasoning
          ? (clamp ? <ClampedText text={reasoning} /> : <InlineMarkdown text={reasoning} />)
          : <span className="text-text-4">No reasoning recorded.</span>}
      </div>
    </div>
  )
}

// Long calculation strings (the salary adjustment) collapse to three lines
// with a toggle; short reasoning renders as is.
function ClampedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 260
  if (!long) return <InlineMarkdown text={text} />
  return (
    <div>
      <div className={cn(!expanded && 'line-clamp-3')}><InlineMarkdown text={text} /></div>
      <Button tone="ghost" size="xs" className="mt-1 -ml-2" onClick={() => setExpanded(e => !e)}>
        {expanded ? 'Show less' : 'Show the calculation'}
      </Button>
    </div>
  )
}

// Cell-level markdown (bold, code, emphasis) without block elements.
function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{ p: ({ children }: { children?: ReactNode }) => <>{children}</> }}
    >
      {text}
    </ReactMarkdown>
  )
}

// The report's closing `Salary math:` line: the full comp → tax → COL →
// savings chain behind the salary row's one-line summary. An audit trail, so
// it sits last and quiet, in the body's own type.
function SalaryMathFooter({ text }: { text: string }) {
  return (
    <section data-slug="salary-math" data-label="Salary math" className="scroll-mt-4 pt-3 border-t border-border-default text-label text-text-3 leading-relaxed">
      <span className="text-text-2 font-medium">Salary math: </span>
      <InlineMarkdown text={text} />
    </section>
  )
}

// ─── Prose ───────────────────────────────────────────────────────────────────

function ProseBody({ content }: { content: string }) {
  return (
    <div className="prose-report">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown>
    </div>
  )
}

// h2 overrides: strip the template's "A) " prefixes, and register the heading
// with the section index. Styling comes from `.prose-report h2`.
const MD_COMPONENTS = {
  h2: ({ children }: { children?: ReactNode }) => {
    const text = flattenChildrenText(children)
    const label = text.replace(/^[A-E]\)\s+/, '').trim()
    const slug = slugify(label)
    return (
      <h2 id={slug} data-slug={slug} data-label={label} className="scroll-mt-4">
        {label}
      </h2>
    )
  },
}

function flattenChildrenText(node: ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenChildrenText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return flattenChildrenText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

// ─── Job listing ─────────────────────────────────────────────────────────────
//
// The posting text saved when the report was written (jds/, see
// scripts/lib/jd-archive-core.mjs), kept because postings disappear. Read at a
// comfortable measure; the fetched date and the live link sit above it.

function jdSourceLabel(source: string): string {
  if (source === 'worker') return 'Saved when evaluated'
  if (source === 'page-html') return 'From the posting page'
  if (source.endsWith('-api')) return 'From the job board'
  return source
}

function JobListingTab({ jd, url }: { jd: JdArchive | null | undefined; url: string }) {
  if (jd === undefined) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {[80, 60, 90, 50, 70].map((w, i) => (
          <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
        ))}
      </div>
    )
  }
  if (jd === null) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-6">
        <FileText size={22} className="text-text-4" aria-hidden />
        <p className="text-label text-text-3 leading-relaxed max-w-[44ch]">
          Not archived; the posting may be gone. If it is still online, this command saves it:
        </p>
        <code className="font-mono text-[12px] text-text-2 whitespace-nowrap select-text">node scripts/archive-posting.mjs --missing</code>
      </div>
    )
  }
  const live = jd.url || url
  return (
    <div className="max-w-[68ch]">
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-label text-text-3 pb-4 mb-4 border-b border-border-default">
        <span>{jd.fetched ? `Saved ${jd.fetched}` : 'Saved copy'}</span>
        {jd.source && <><span className="text-text-4" aria-hidden>·</span><span>{jdSourceLabel(jd.source)}</span></>}
        <div className="flex-1" />
        {live && (
          <Button tone="ghost" size="xs" icon={<ExternalLink size={12} />} onClick={() => ipc.openExternal(live)}>
            Open live posting
          </Button>
        )}
      </div>
      <ProseBody content={jd.body} />
    </div>
  )
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-6">
      <FileText size={22} className="text-text-4" aria-hidden />
      <p className="text-label text-text-3 leading-relaxed max-w-[44ch]">{message}</p>
    </div>
  )
}

// ─── History ─────────────────────────────────────────────────────────────────

// Movement across this entity's own re-evaluations, stated on Match and Ease
// SEPARATELY, each against its own noise floor (docs/scoring-v2.md §9,
// docs/scoring-statistical-design.md § 1). A sub-floor first → latest gap is
// "flat within noise", never a small improvement. Blocked evaluations carry
// no scores and drop out of the comparison.
function HistoryMovement({ rows }: { rows: HistoryEntry[] }) {
  // Same-date rows are duplicate writes, not re-evaluations over time, so they
  // collapse to one. `rows` arrives newest-first; walk it oldest-first so the
  // surviving row per date is the last one written that day.
  const byDate = new Map<string, HistoryEntry>()
  for (const r of [...rows].reverse()) {
    if (r.match == null || r.ease == null || !r.date) continue
    byDate.set(r.date, r)
  }
  const scored = [...byDate.values()]
  if (scored.length < GATES.trendMinEvals) return null
  const first = scored[0]
  const latest = scored[scored.length - 1]
  const confidence = confidenceTier(scored.length, GATES.trendMinEvals)
  return (
    <div className="flex flex-col gap-1.5 text-label">
      <MetricMovement label="Match" from={first.match as number} to={latest.match as number} floor={NOISE_FLOORS.match} />
      <MetricMovement label="Ease" from={first.ease as number} to={latest.ease as number} floor={NOISE_FLOORS.ease} />
      <span className="text-text-4">{scored.length} evaluations · {confidence} confidence</span>
    </div>
  )
}

function MetricMovement({ label, from, to, floor }: { label: string; from: number; to: number; floor: number }) {
  const delta = Math.round((to - from) * 100) / 100
  const movement = classifyMovement(delta, { floor })
  const flat = movement === 'within-noise'
  const tone = flat ? 'muted' : movement === 'improving' ? 'success' : 'danger'
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-text-3 w-10">{label}</span>
      <span className="text-text-2 tabular-nums">{from.toFixed(1)} → {to.toFixed(1)}</span>
      <Chip
        tone={tone}
        title={flat
          ? `${formatWithinNoise(delta, { floor })}: below the resolution of the rubric, so no direction is claimed`
          : `Moved ${delta > 0 ? 'up' : 'down'} by at least the ${floor} ${label} noise floor`}
      >
        {flat ? `Flat within noise (|Δ| ${Math.abs(delta).toFixed(2)} < ${floor.toFixed(2)})` : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`}
      </Chip>
    </div>
  )
}

function HistoryTable({ rows, onPick }: { rows: HistoryEntry[]; onPick: (date: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionHeading title="Past evaluations" size="md" rule={false} meta={`${rows.length} on record`} />
      <HistoryMovement rows={rows} />
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-elevated/60 border-b border-border-default">
              <th className="th text-left px-4 py-2">Month</th>
              <th className="th text-right px-4 py-2">Match · Ease</th>
              <th className="th text-right px-4 py-2">Verdict</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {rows.map((r, i) => (
              <tr
                key={`${r.date}-${i}`}
                className="cursor-pointer hover:bg-bg-elevated transition-colors"
                onClick={() => onPick(r.date)}
              >
                <td className="px-4 py-2.5 text-body text-text-2 tabular-nums">{r.monthLabel}</td>
                <td className="px-4 py-2.5 text-right">
                  <MatchEase match={r.match} ease={r.ease} size="sm" bare blockedReason={r.verdict === 'blocked' ? 'Blocked' : null} />
                </td>
                <td className="px-4 py-2.5 text-right"><VerdictChip verdict={r.verdict} /></td>
                <td className="px-4 py-2.5 text-right text-label text-text-4">View snapshot</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistorySnapshotView({ date, content, loading, onBack }: {
  date: string
  content: string
  loading: boolean
  onBack: () => void
}) {
  return (
    <div>
      <Button tone="ghost" size="sm" icon={<ChevronLeft size={13} />} className="-ml-2 mb-3" onClick={onBack}>
        Back to history
      </Button>
      <div className="label mb-3">Snapshot from {date}</div>
      {loading ? (
        <div className="flex flex-col gap-3">
          {[80, 60, 90, 50, 70].map((w, i) => (
            <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <ProseBody content={content} />
      )}
    </div>
  )
}

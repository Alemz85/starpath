'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  X, FileText, Database as DatabaseIcon, ExternalLink, BookOpen, Clock, ChevronLeft,
  Target, Sparkles, Compass, ClipboardList, Lightbulb, Coins, CheckCircle2, TrendingUp,
  AlertTriangle,
} from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useNavStore } from '@/store/nav'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { cn, formatRelative } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import type { ScoreEntry } from '@/types'
import { tierHex, scoreColor, NEUTRAL_SCORE_COLOR } from '@/lib/tier'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ApplyAction } from '@/components/shared/ApplyAction'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { parseCities, entityId } from '@/lib/entityId'

type Tab = 'scouting' | 'application' | 'history'

interface SiblingInfo {
  company: string
  role: string
  city: string                // primary city of the sibling
  score: number
}

interface HistoryEntry {
  date: string         // full YYYY-MM-DD (for snapshot filename)
  monthLabel: string   // YYYY-MM (for display)
  overall: number
  tier: string
}

interface ReportSlideOverProps {
  company: string
  role: string
  scoreEntry: ScoreEntry
  /** Hide the "View in Database" pill — used when the slide-over is opened
   *  from inside the Database itself (where the shortcut is redundant). */
  hideDatabaseLink?: boolean
  /** Click handler for sibling navigation — when this entity has
   *  same-role siblings in other cities (multi-URL multi-city like
   *  PwC Data & AI Consultant Roma + Milano), the parent owns the
   *  state of which entity is open and swaps the displayed scoreEntry
   *  when a sibling chip is clicked. Omit to hide sibling navigation. */
  onSwitchEntity?: (company: string, role: string) => void
  onClose: () => void
}

export function ReportSlideOver({ company, role, scoreEntry, hideDatabaseLink, onSwitchEntity, onClose }: ReportSlideOverProps) {
  const repoPath = useAppStore(s => s.repoPath)
  const navigate = useNavStore(s => s.navigate)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const [scoutingContent, setScoutingContent] = useState<string | null>(null)
  const [applicationContent, setApplicationContent] = useState<string | null>(null)
  const [scoutingMissing, setScoutingMissing] = useState(false)
  const [applicationMissing, setApplicationMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('scouting')
  // When set, the History tab body renders this snapshot's prose
  // instead of the row table. Click a row to drill in; click the
  // breadcrumb to return to the table.
  const [snapshot, setSnapshot] = useState<{ date: string; content: string } | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)

  // History rows for THIS entity — every score_history row matching
  // (company, role), newest first. The current evaluation is the head;
  // older rows are accumulated re-evaluations whose snapshots live
  // under reports/tier-N/.history/. Tab is enabled only when ≥2 rows
  // exist (no point in a 1-row "history").
  const history: HistoryEntry[] = useMemo(() => {
    return scoreHistory
      .filter(r => r.company === company && r.role === role)
      .map(r => ({
        date: r.date,
        monthLabel: r.date.slice(0, 7),
        overall: r.overall,
        tier: r.tier === 'T2-high' ? 'T2' : r.tier,
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [scoreHistory, company, role])

  const historyAvailable = history.length >= 2

  // Multi-city detection from the row's location string. When the JD
  // names ≥2 cities for a single posting (e.g. Rev-celerator), the
  // header band lists them all. The "current best" pick (first city
  // intersecting preferred_cities) is a v2 enhancement — for now we
  // just list them in order.
  const cityInfo = useMemo(() => parseCities(scoreEntry.location), [scoreEntry.location])

  // Siblings — entities sharing the same (company, role-canonical) but
  // different city. The Database has them as separate rows because
  // they're posted under different URLs (multi-URL multi-city, e.g.,
  // PwC Data & AI Consultant - INTERNSHIP across Roma + Milano). The
  // header band exposes them as ↗ chips so you can hop between same-
  // role evaluations without leaving the slide-over.
  const siblings: SiblingInfo[] = useMemo(() => {
    if (!onSwitchEntity) return []
    const myParsed = parseCities(scoreEntry.location)
    const myId = entityId(company, role, myParsed)
    const myRoleKey = myId.split('::').slice(0, 2).join('::')

    // Group score-history rows by entity_id and keep the LATEST per
    // entity (so re-evaluated siblings still appear once with their
    // most recent score).
    const byEntity = new Map<string, SiblingInfo & { date: string }>()
    for (const r of scoreHistory) {
      const parsed = parseCities(r.location)
      const id = entityId(r.company, r.role, parsed)
      if (id === myId) continue                   // self
      if (!id.startsWith(myRoleKey + '::')) continue   // different role
      const prev = byEntity.get(id)
      if (!prev || r.date > prev.date) {
        byEntity.set(id, {
          company:  r.company,
          role:     r.role,
          city:     parsed.isMulti ? `Multi (${parsed.cities.length})` : (parsed.primary ?? '?'),
          score:    r.overall,
          date:     r.date,
        })
      }
    }
    return [...byEntity.values()].map(({ date, ...rest }) => rest)
  }, [scoreHistory, company, role, scoreEntry.location, onSwitchEntity])

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setTimeout(onClose, 260)
  }, [onClose])

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    setScoutingContent(null)
    setApplicationContent(null)
    setScoutingMissing(false)
    setApplicationMissing(false)

    if (!repoPath) {
      setError('No repo path set.')
      setLoading(false)
      return
    }

    // 1. Scouting report — search known tier dirs, fall back to flat
    //    reports/. The report file is the same `{Company} - {Role}.md`
    //    naming, so we pair the two files by (company, role).
    let scoutingPath: string | null = null
    for (const dir of ['tier-1', 'tier-2', 'tier-3', 'tier-4']) {
      const p = `reports/${dir}/${company} - ${role}.md`
      if (await ipc.fileExists(p)) { scoutingPath = p; break }
    }
    if (!scoutingPath) {
      const flat = `reports/${company} - ${role}.md`
      if (await ipc.fileExists(flat)) scoutingPath = flat
    }

    // 2. Application prep — written by modes/interview-prep.md and the
    //    "Prep Application" button. Mirrors the report naming so the pair
    //    joins on (company, role).
    const prepPath = `interview-prep/${company} - ${role}.md`
    const prepExists = await ipc.fileExists(prepPath)

    // Read whichever exist; tabs render from the populated state.
    if (scoutingPath) {
      const text = await ipc.readFile(scoutingPath)
      if (text) setScoutingContent(text)
      else setScoutingMissing(true)
    } else {
      setScoutingMissing(true)
    }
    if (prepExists) {
      const text = await ipc.readFile(prepPath)
      if (text) setApplicationContent(text)
      else setApplicationMissing(true)
    } else {
      setApplicationMissing(true)
    }

    // Default to the scouting tab when the file exists; otherwise show the
    // application tab if THAT exists. If neither exists, surface an error.
    if (scoutingPath) setActiveTab('scouting')
    else if (prepExists) setActiveTab('application')
    else setError('No report or application prep found for this entry.')

    setLoading(false)
  }, [company, role, repoPath])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  // Switch tabs → drop any open snapshot view so we don't leak the
  // historical prose into the next tab's body.
  useEffect(() => { setSnapshot(null) }, [activeTab])

  const openSnapshot = useCallback(async (date: string) => {
    if (!repoPath) return
    setSnapshotLoading(true)
    setSnapshot(null)
    // Snapshot files live under reports/tier-N/.history/ with the
    // date appended to the entity's filename. Search every tier dir
    // for this date — the entity may have moved tiers between evals.
    let path: string | null = null
    for (const dir of ['tier-1', 'tier-2', 'tier-3', 'tier-4']) {
      const candidate = `reports/${dir}/.history/${company} - ${role}.${date}.md`
      if (await ipc.fileExists(candidate)) { path = candidate; break }
    }
    if (!path) {
      setSnapshot({ date, content: `(No snapshot file found at reports/tier-N/.history/${company} - ${role}.${date}.md — re-evaluations after this date should produce one.)` })
      setSnapshotLoading(false)
      return
    }
    const text = await ipc.readFile(path)
    setSnapshot({ date, content: text ?? '(File exists but could not be read.)' })
    setSnapshotLoading(false)
  }, [company, role, repoPath])

  const tierKey = (scoreEntry.tier as TierKey) in TIER_COLORS ? (scoreEntry.tier as TierKey) : 'T4'
  const { text: tierText } = TIER_COLORS[tierKey]
  const tierColor = tierHex(tierKey)
  const evaluatedRel = scoreEntry.date ? formatRelative(scoreEntry.date) : null

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity duration-[260ms]',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      {/* Panel — galaxy-tinted shadow ties the slide-over into the
          rest of the redesigned chrome (cosmos surface, shadow-cosmos
          on hero cards). */}
      <div className={cn(
        'fixed right-0 top-0 bottom-0 z-40 w-[720px] max-w-full bg-bg-panel border-l border-border-strong flex flex-col shadow-cosmos-lift',
        'transition-[transform,opacity] duration-[260ms] ease-out',
        open ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
      )}>
        {/* Drag bar */}
        <div className="titlebar-drag h-11 shrink-0" />

        {/* Tier-tinted hero band — gradient from the tier color out to
            transparent so the report visually identifies as a T1/T2/T3
            evaluation at a glance. Sits behind the header, providing
            atmospheric color without taking layout space. */}
        <div
          className="relative h-2 shrink-0"
          aria-hidden
          style={{
            background: `linear-gradient(90deg, ${tierColor} 0%, ${tierColor}66 60%, transparent 100%)`,
          }}
        />

        {/* Header — restructured as an editorial hero. CompanyLogo at
            48px (up from 40), company name at text-page (22px), role
            title at text-section (16px) — actual hierarchy instead of
            three lines of similarly-sized text. The tier+score+location
            meta row sits below as supporting context. */}
        <div className="flex items-start gap-4 px-6 pt-5 pb-4 border-b border-border-default shrink-0">
          <CompanyLogo company={company} size={48} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-micro text-text-4 uppercase tracking-[0.08em] mb-0.5">Evaluation</div>
            <h2 className="text-page text-text-1 leading-tight tracking-[-0.01em] truncate" title={company}>
              {company}
            </h2>
            <p className="text-section text-text-2 leading-snug mt-0.5 line-clamp-2" title={role}>
              {role}
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap text-label">
              <span
                className={cn('inline-flex items-center px-1.5 py-0.5 rounded font-mono font-semibold tabular-nums text-[10.5px]', tierText)}
                style={{ background: `${tierColor}14`, border: `1px solid ${tierColor}33` }}
              >
                {tierKey === 'T2-high' ? 'T2+' : tierKey}
              </span>
              {scoreEntry.overall > 0 && (
                <span className="font-mono tabular-nums text-text-3">
                  <span className="text-text-1 font-semibold">{scoreEntry.overall.toFixed(1)}</span>
                  <span className="text-text-4"> / 10</span>
                </span>
              )}
              {scoreEntry.location && (
                <>
                  <span className="text-text-4">·</span>
                  <span className="text-text-3 truncate max-w-[200px]" title={scoreEntry.location}>{scoreEntry.location}</span>
                </>
              )}
              {evaluatedRel && (
                <>
                  <span className="text-text-4">·</span>
                  <span className="text-text-3">evaluated {evaluatedRel}</span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Action pills */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-default shrink-0 flex-wrap">
          <ApplyAction company={company} role={role} scoreEntry={scoreEntry} size="sm" />
          {!hideDatabaseLink && (
            <button
              onClick={() => {
                navigate('database', company)
                handleClose()
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
            >
              <DatabaseIcon size={11} />
              View in Database
            </button>
          )}
          {/* URL pill — prefer scoreEntry.url; fall back to extracting
              **URL:** from the loaded scouting report markdown for orphan
              reports that don't have a matching score-history row. */}
          {(() => {
            const url =
              (scoreEntry.url && /^https?:\/\//i.test(scoreEntry.url) && scoreEntry.url) ||
              (scoutingContent ? (scoutingContent.match(/^\*\*URL:\*\*\s*(\S+)/im)?.[1] ?? '') : '')
            if (!url || !/^https?:\/\//i.test(url)) return null
            return (
              <button
                onClick={() => ipc.openExternal(url)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
              >
                <ExternalLink size={11} />
                Open URL
              </button>
            )
          })()}
          <div className="flex-1" />
          <FilesStrip company={company} role={role} size="md" />
        </div>

        {/* Multi-city band — visible only when this entity is a single
            posting that lists multiple cities (e.g., Rev-celerator
            across Berlin / Paris / London / Lisbon). The Database city
            filter expands this entity into each listed city; this band
            tells you which ones it actually appears in. */}
        {cityInfo.isMulti && cityInfo.cities.length > 1 && (
          <div className="px-5 py-2 border-b border-border-default shrink-0 text-[11.5px] text-text-3 flex items-center gap-2 flex-wrap">
            <span className="font-mono uppercase tracking-[0.08em] text-[10px] text-text-4">Cities</span>
            <span className="text-text-4">·</span>
            {cityInfo.cities.map((c, i) => (
              <span key={c} className="text-text-2">
                {c}{i < cityInfo.cities.length - 1 ? <span className="text-text-4 mx-1">·</span> : null}
              </span>
            ))}
          </div>
        )}

        {/* Sibling band — visible when other entities share the same
            company + role-canonical but different city (multi-URL
            multi-city, separate Database rows). Click a chip to swap
            the slide-over to that entity. */}
        {siblings.length > 0 && (
          <div className="px-5 py-2 border-b border-border-default shrink-0 text-[11.5px] text-text-3 flex items-center gap-2 flex-wrap">
            <span className="font-mono uppercase tracking-[0.08em] text-[10px] text-text-4">Same role in</span>
            <span className="text-text-4">·</span>
            <span className="text-text-2">
              {cityInfo.primary ?? scoreEntry.location ?? '?'} (this)
            </span>
            {siblings.map(s => (
              <button
                key={`${s.company}|${s.role}`}
                onClick={() => onSwitchEntity?.(s.company, s.role)}
                title={`${s.role} · ${s.city} · ${s.score > 0 ? s.score.toFixed(1) : '—'}/10`}
                className="inline-flex items-center gap-1 text-accent-text hover:underline transition-colors"
              >
                <span className="text-text-4">·</span>
                <span>{s.city} <span className="text-text-4">↗</span></span>
              </button>
            ))}
          </div>
        )}

        {/* Tabs — Scouting / Application prep / History. Greyed out
            when the corresponding file isn't on disk OR (history) when
            no prior evaluations exist. Each tab lazy-renders its body
            so parsers only run for the visible one. */}
        <div className="flex border-b border-border-default shrink-0">
          <TabButton
            icon={FileText}
            label="Scouting report"
            active={activeTab === 'scouting'}
            disabled={!scoutingContent}
            onClick={() => setActiveTab('scouting')}
          />
          <TabButton
            icon={BookOpen}
            label="Application prep"
            active={activeTab === 'application'}
            disabled={!applicationContent}
            onClick={() => setActiveTab('application')}
          />
          <TabButton
            icon={Clock}
            label={`History${historyAvailable ? ` (${history.length})` : ''}`}
            active={activeTab === 'history'}
            disabled={!historyAvailable}
            onClick={() => setActiveTab('history')}
          />
        </div>

        {/* Score mini-bar — only when the scouting tab is active and we
            have real score data. The application-prep tab doesn't carry
            a score on its own; it inherits from the scouting evaluation. */}
        {activeTab === 'scouting' && scoreEntry.overall > 0 && <ScoreMiniBar entry={scoreEntry} />}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="space-y-3">
              {[80, 60, 90, 50, 70].map((w, i) => (
                <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-text-4">
              <FileText size={32} className="opacity-30" />
              <p className="text-label">{error}</p>
            </div>
          )}
          {!loading && !error && activeTab === 'scouting' && (
            scoutingContent
              ? <ReportBody content={scoutingContent} tier={tierKey} />
              : <EmptyTab message="No scouting report yet — click Generate report from the Database popover to create one." />
          )}
          {!loading && !error && activeTab === 'application' && (
            applicationContent
              ? <div className="prose-report"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{applicationContent}</ReactMarkdown></div>
              : <EmptyTab message="No application prep yet — click Prep application from the Database popover to research interview intel + STAR mapping for this role." />
          )}
          {!loading && !error && activeTab === 'history' && (
            snapshot ? (
              <HistorySnapshotView
                date={snapshot.date}
                content={snapshot.content}
                loading={snapshotLoading}
                onBack={() => setSnapshot(null)}
              />
            ) : (
              <HistoryTable rows={history} onPick={openSnapshot} />
            )
          )}
        </div>
      </div>
    </>
  )
}

function HistoryTable({ rows, onPick }: { rows: HistoryEntry[]; onPick: (date: string) => void }) {
  return (
    <div className="text-[12.5px]">
      <div className="text-text-4 mb-3">
        Past evaluations for this entity. Click a row to view the snapshot.
      </div>
      <div className="rounded-md border border-border-default overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-elevated/50 text-[11px] uppercase tracking-[0.06em] text-text-4">
              <th className="text-left px-3 py-2 font-medium">Month</th>
              <th className="text-right px-3 py-2 font-medium">Score</th>
              <th className="text-right px-3 py-2 font-medium">Tier</th>
              <th className="text-right px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.date}-${i}`}
                className={cn(
                  'border-t border-border-default cursor-pointer transition-colors',
                  'hover:bg-bg-elevated/40',
                )}
                onClick={() => onPick(r.date)}
              >
                <td className="px-3 py-2 font-mono text-text-2">{r.monthLabel}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-text-1">
                  {r.overall > 0 ? r.overall.toFixed(1) : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-3">{r.tier || '—'}</td>
                <td className="px-3 py-2 text-right text-text-4 text-[11px]">view ↗</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistorySnapshotView({
  date, content, loading, onBack,
}: {
  date: string
  content: string
  loading: boolean
  onBack: () => void
}) {
  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-[11.5px] text-text-3 hover:text-text-1 transition-colors"
      >
        <ChevronLeft size={12} />
        Back to history
      </button>
      <div className="mb-3 text-[10px] uppercase tracking-[0.12em] text-text-4">
        Snapshot from {date}
      </div>
      {loading ? (
        <div className="space-y-3">
          {[80, 60, 90, 50, 70].map((w, i) => (
            <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <div className="prose-report">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function TabButton({
  icon: Icon, label, active, disabled, onClick,
}: {
  icon: React.ElementType
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${label} — not generated yet` : label}
      className={cn(
        // flex-1 + basis-0 splits the tab strip into equal thirds so
        // each tab fills its share of the slide-over width regardless
        // of label length. justify-center centers the icon+label
        // pair within the cell.
        'flex-1 basis-0 flex items-center justify-center gap-1.5 px-4 py-2 text-label transition-colors border-b-2 -mb-px',
        active
          ? 'text-text-1 border-accent'
          : disabled
            ? 'text-text-4 border-transparent opacity-50 cursor-not-allowed'
            : 'text-text-3 border-transparent hover:text-text-1 hover:border-border-default',
      )}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 gap-3 text-text-4 text-center px-6">
      <FileText size={32} className="opacity-30" />
      <p className="text-label leading-relaxed">{message}</p>
    </div>
  )
}

// ─── Report body — promotes the dimensional-scoring table into a hero +
// grouped sections. Falls back to plain markdown when parsing fails so
// older / custom report formats still render readably. ──────────────────────

function ReportBody({ content, tier }: { content: string; tier: TierKey }) {
  // Parse once per content change, not on every render. The slide-over
  // re-renders frequently (animation flag, parent state) and the regex /
  // line-walk parsers were running every time, causing a visible flicker.
  const parsed = useMemo(() => {
    const { before, dims, after } = parseDimensionalScoring(content)
    if (!dims) return { dims: null as ParsedDimensions | null, before: '', after: '', meta: [] as Array<{ key: string; value: string }>, beforeWithoutMeta: '' }
    const { meta, rest: beforeWithoutMeta } = extractMetadata(before)
    return { dims, before, after, meta, beforeWithoutMeta }
  }, [content])

  if (!parsed.dims) {
    return (
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown>
      </div>
    )
  }
  const { dims, after, meta, beforeWithoutMeta } = parsed
  return (
    <>
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{beforeWithoutMeta}</ReactMarkdown>
      </div>
      {meta.length > 0 && <ReportMeta items={meta} />}
      <DimensionalScoring dims={dims} tier={tier} />
      {after && (
        <div className="prose-report">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{after}</ReactMarkdown>
        </div>
      )}
    </>
  )
}

// Custom markdown component overrides — applied to every ReactMarkdown
// instance in the slide-over so reports render with consistent rhythm.
//   - h2: strip "A) " / "B) " / etc. admin prefixes that leak from the
//     scouting.md template ("## A) Role summary"), and prepend a small
//     lucide icon tinted to the accent so section breaks carry visual
//     identity beyond a hairline border.
const MD_COMPONENTS = {
  h2: ({ children, ...rest }: { children?: React.ReactNode }) => {
    const text = flattenChildrenText(children)
    const stripped = text.replace(/^[A-E]\)\s+/, '').trim()
    const Icon = sectionIcon(stripped)
    return (
      <h2 className="flex items-center gap-2" {...rest}>
        {Icon && (
          <Icon
            size={15}
            className="shrink-0 text-accent"
            aria-hidden
          />
        )}
        <span>{stripped}</span>
      </h2>
    )
  },
}

function flattenChildrenText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenChildrenText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return flattenChildrenText((node as { props?: { children?: React.ReactNode } }).props?.children)
  }
  return ''
}

function sectionIcon(label: string): React.ElementType | null {
  const l = label.toLowerCase()
  if (l.includes('role summary') || l === 'summary')          return ClipboardList
  if (l.includes('gap'))                                       return Lightbulb
  if (l.includes('comp') && !l.includes('recommend'))          return Coins
  if (l.includes('recommendation') || l.includes('verdict'))   return CheckCircle2
  if (l.includes('career path') || l.includes('path forward')) return TrendingUp
  if (l === 'fit / gaps' || l.includes('fit'))                 return Target
  return null
}

// Header metadata: keep contextual fields (Date / Mode / Location /
// Archetype / Verification) and drop the duplicated ones — URL has its
// own pill, the score fields are now visually prominent in the hero +
// section rollups, and Tier is in the slide-over header. Verification
// is kept because batch-mode reports need a visible "unconfirmed"
// caveat — see ReportMeta below for the warning treatment.
const META_KEEP = new Set(['date', 'mode', 'location', 'archetype', 'verification'])

function extractMetadata(text: string): {
  meta: Array<{ key: string; value: string }>
  rest: string
} {
  const lines = text.split('\n')
  const kept: Array<{ key: string; value: string }> = []
  const out: string[] = []
  // Match "**Key:** value" anywhere in the line (the metadata block has one
  // pair per line in current reports, but we forgive trailing whitespace).
  const metaRe = /^\s*\*\*([^*:]+?):\*\*\s*(.+?)\s*$/
  for (const line of lines) {
    const m = metaRe.exec(line)
    if (m) {
      const key = m[1].trim()
      const value = m[2].trim()
      if (META_KEEP.has(key.toLowerCase())) {
        kept.push({ key, value })
      }
      // Either way, the line is consumed — we don't want to re-render the
      // dropped fields as a stray paragraph.
      continue
    }
    out.push(line)
  }
  // Collapse the run of blank lines the removed metadata block leaves behind.
  const rest = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { meta: kept, rest }
}

function ReportMeta({ items }: { items: Array<{ key: string; value: string }> }) {
  return (
    <div className="my-4 grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3 rounded-lg bg-bg-elevated/50 border border-border-default">
      {items.map(({ key, value }) => {
        // Verification gets a warning treatment when the value indicates
        // an unconfirmed batch-mode report (Playwright wasn't available,
        // so the JD body came via WebFetch). Users can still see the
        // full caveat via the title tooltip on the truncated text.
        const isVerification = key.toLowerCase() === 'verification'
        const isUnconfirmed = isVerification && /unconfirmed/i.test(value)
        return (
          <div key={key} className="flex flex-col min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-4 flex items-center gap-1">
              {isUnconfirmed && <AlertTriangle size={10} className="text-warning" aria-hidden />}
              {key}
            </span>
            <span
              className={cn(
                'text-[12.5px] truncate',
                isUnconfirmed ? 'text-warning' : 'text-text-1',
              )}
              title={value}
            >
              {value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

interface DimensionRow {
  label: string
  score: string
  reasoning: string
}
interface ParsedDimensions {
  overall: { score: string } | null
  currentFit: { rollup: string; rows: DimensionRow[] }
  aspirationalFit: { rollup: string; rows: DimensionRow[] }
  context: { rows: DimensionRow[] }
}

// Split the markdown around the "## Dimensional scoring" section, parse the
// table inside it, and categorise the rows. Phase walks: rows before the
// Current Fit rollup → CF dimensions; between CF rollup and AF rollup → AF
// dimensions; after Overall → context. Rows tagged `(context)` are routed
// to the context group regardless of position. The arithmetic on rollup /
// Overall rows is intentionally discarded — section grouping replaces it.
function parseDimensionalScoring(md: string): {
  before: string
  dims: ParsedDimensions | null
  after: string
} {
  const headingRe = /^##\s+Dimensional\s+scoring\s*$/im
  const m = headingRe.exec(md)
  if (!m) return { before: md, dims: null, after: '' }

  const before = md.slice(0, m.index)
  const rest = md.slice(m.index + m[0].length)

  const nextHeadingRe = /\n##\s+\S/m
  const nextMatch = nextHeadingRe.exec(rest)
  const tableSection = nextMatch ? rest.slice(0, nextMatch.index) : rest
  const after = nextMatch ? rest.slice(nextMatch.index + 1) : ''

  const tableLines = tableSection
    .split('\n')
    .filter(l => l.trim().startsWith('|'))
    .filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l))

  if (tableLines.length < 2) return { before: md, dims: null, after: '' }

  const rows = tableLines.slice(1).map(parseRow).filter(Boolean) as Array<{
    label: string
    score: string
    reasoning: string
    tag: 'rollup' | 'signal' | 'context' | null
  }>

  const dims: ParsedDimensions = {
    overall: null,
    currentFit:      { rollup: '', rows: [] },
    aspirationalFit: { rollup: '', rows: [] },
    context:         { rows: [] },
  }

  type Phase = 'cf' | 'af' | 'post-overall'
  let phase: Phase = 'cf'

  for (const row of rows) {
    const labelLower = row.label.toLowerCase()

    if (labelLower === 'overall' || labelLower.startsWith('overall ')) {
      dims.overall = { score: row.score }
      phase = 'post-overall'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('current fit')) {
      dims.currentFit.rollup = row.score
      phase = 'af'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('aspirational fit')) {
      dims.aspirationalFit.rollup = row.score
      continue
    }
    if (row.tag === 'context' || phase === 'post-overall') {
      dims.context.rows.push({ label: row.label, score: row.score, reasoning: row.reasoning })
      continue
    }

    const dimRow: DimensionRow = { label: row.label, score: row.score, reasoning: row.reasoning }
    if (phase === 'cf') dims.currentFit.rows.push(dimRow)
    else                dims.aspirationalFit.rows.push(dimRow)
  }

  // Sanity: if we found no group rows at all, abort and fall back.
  if (
    !dims.overall &&
    dims.currentFit.rows.length === 0 &&
    dims.aspirationalFit.rows.length === 0 &&
    dims.context.rows.length === 0
  ) {
    return { before: md, dims: null, after: '' }
  }

  return { before, dims, after }
}

function parseRow(line: string) {
  // "| a | b | c |" → ['', ' a ', ' b ', ' c ', ''] → ['a','b','c']
  const cells = line.split('|').slice(1, -1).map(c => c.trim())
  if (cells.length < 2) return null
  let [label, score, reasoning = ''] = cells
  // Strip surrounding markdown bold (whole-cell only — keeps inline emphasis)
  label = label.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  score = score.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  // Strip "/N" suffix (handles both 1–10 and the old 1–5 reports)
  score = score.replace(/\s*\/\s*\d+\s*$/, '').trim()
  // Detect and strip the trailing parenthetical tag
  const tagMatch = label.match(/\(\s*(rollup|signal|context)\s*\)\s*$/i)
  const tag = tagMatch ? (tagMatch[1].toLowerCase() as 'rollup' | 'signal' | 'context') : null
  const cleanLabel = label.replace(/\s*\(\s*(rollup|signal|context)\s*\)\s*$/i, '').trim()
  return { label: cleanLabel, score, reasoning, tag }
}

function DimensionalScoring({ dims, tier }: { dims: ParsedDimensions; tier: TierKey }) {
  const heroColor = tierHex(tier)
  return (
    <div className="my-5 space-y-7">
      {dims.overall && (
        // Overall band — full-width hero. The most important number in
        // the report gets actual presence: 48px tier-colored score with
        // an "Overall fit" eyebrow. Subtle galaxy-tinted backdrop wash
        // behind it so it reads as a plate, not a thin pill.
        <div
          className="relative flex items-center justify-between gap-4 px-5 py-4 rounded-xl overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${heroColor}14 0%, ${heroColor}06 100%)`,
            border: `1px solid ${heroColor}33`,
          }}
        >
          <div>
            <div className="text-micro text-text-4 uppercase tracking-[0.12em] mb-1">
              Overall fit
            </div>
            <div className="text-[12px] text-text-3">
              {tier === 'T1'      ? 'Apply now — top-tier match' :
               tier === 'T2-high' ? 'Apply with prep' :
               tier === 'T2'      ? 'Apply if pipeline thin' :
               tier === 'T3'      ? 'Growth target — gap & build' :
                                    'Below threshold'}
            </div>
          </div>
          <span
            className="font-mono font-semibold tabular-nums leading-none text-[44px]"
            style={{ color: heroColor }}
          >
            {dims.overall.score}
          </span>
        </div>
      )}

      {dims.currentFit.rows.length > 0 && (
        <DimensionGroup
          title="Current Fit"
          icon={Target}
          rollup={dims.currentFit.rollup}
          rows={dims.currentFit.rows}
        />
      )}
      {dims.aspirationalFit.rows.length > 0 && (
        <DimensionGroup
          title="Aspirational Fit"
          icon={Sparkles}
          rollup={dims.aspirationalFit.rollup}
          rows={dims.aspirationalFit.rows}
        />
      )}
      {dims.context.rows.length > 0 && (
        <DimensionGroup title="Context" icon={Compass} rows={dims.context.rows} />
      )}
    </div>
  )
}

function DimensionGroup({
  title,
  icon: Icon,
  rollup,
  rows,
}: {
  title: string
  icon?: React.ElementType
  rollup?: string
  rows: DimensionRow[]
}) {
  const rollupNum = rollup ? parseFloat(rollup) : NaN
  const rollupColor = !Number.isNaN(rollupNum) ? scoreColor(rollupNum) : NEUTRAL_SCORE_COLOR
  return (
    <div>
      {/* Group header — same visual rhythm as the prose-report h2 so the
          slide-over reads with one type system. Optional lucide icon
          tints to the rollup color so the header carries semantic
          identification at a glance (Target = Current Fit, Sparkles =
          Aspirational, Compass = Context). */}
      <div className="flex items-baseline justify-between gap-3 pb-2.5 mb-3.5 border-b border-border-default">
        <h3 className="flex items-center gap-2 text-[16px] font-semibold text-text-1 leading-none tracking-[-0.005em]">
          {Icon && (
            <Icon
              size={14}
              className="shrink-0"
              style={{ color: rollupColor }}
              aria-hidden
            />
          )}
          <span>{title}</span>
        </h3>
        {rollup && (
          <span
            className="text-[20px] font-mono font-semibold tabular-nums leading-none"
            style={{ color: rollupColor }}
          >
            {rollup}
          </span>
        )}
      </div>
      <div className="divide-y divide-border-default/40">
        {rows.map((row, i) => {
          const numScore = parseFloat(row.score)
          const isNumeric = !Number.isNaN(numScore)
          const cellColor = isNumeric ? scoreColor(numScore) : NEUTRAL_SCORE_COLOR
          return (
            <div
              key={i}
              className="grid grid-cols-[140px_1fr] gap-5 py-3.5 items-start"
            >
              {/* Left col: stacked Category label / large score */}
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-3 leading-tight">
                  {row.label}
                </div>
                <div
                  className="font-mono font-semibold tabular-nums leading-none mt-1.5"
                  style={{
                    fontSize: isNumeric ? '22px' : '15px',
                    color: cellColor,
                  }}
                >
                  {row.score || '—'}
                </div>
              </div>
              {/* Right col: reasoning at body-text size (was 11.5px — too
                  small to read comfortably; now 13px with relaxed leading). */}
              <div className="text-[13px] text-text-2 leading-[1.55] pt-0.5">
                {row.reasoning && row.reasoning !== '—' ? row.reasoning : (
                  <span className="text-text-4 italic">No reasoning provided.</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Score color is imported from `lib/tier.ts` — same galaxy banding used
// by Database/Reports/Trends so a number reads the same everywhere.

function ScoreMiniBar({ entry }: { entry: ScoreEntry }) {
  const dims: Array<{ key: keyof ScoreEntry; label: string }> = [
    { key: 'skills_match',     label: 'Skills' },
    { key: 'strategic_fit',    label: 'Strategy' },
    { key: 'growth_mobility',  label: 'Growth' },
    { key: 'brand_value',      label: 'Brand' },
    { key: 'work_life_balance', label: 'WLB' },
    { key: 'salary_adj_city',  label: 'Comp' },
  ]

  return (
    <div className="flex justify-center gap-3 px-5 py-3 border-b border-border-default bg-bg-elevated/50 shrink-0 overflow-x-auto">
      {dims.map(({ key, label }) => {
        const raw = entry[key]
        const val = typeof raw === 'number' ? raw : 0
        const pct = Math.min(100, (val / 10) * 100)
        // Score bars use `scoreColor()` so they stay in lock-step with
        // every other floating score number in the app (Database dial,
        // slide-over rollup, Trends top-X). The 5–7 mid band drops to
        // neutral slate via `scoreColor`, not lavender — see
        // `lib/tier.ts` for the rationale.
        const fill = scoreColor(val)
        return (
          <div key={key} className="flex flex-col gap-1 items-center min-w-[56px]">
            <span className="text-micro text-text-4 uppercase whitespace-nowrap">{label}</span>
            <div className="w-full h-1 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: fill }} />
            </div>
            <span className="text-micro font-mono text-text-3">{val.toFixed(1)}</span>
          </div>
        )
      })}
    </div>
  )
}

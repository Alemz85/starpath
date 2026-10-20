'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Users, Plus, ArrowRight, CheckCircle2, Clock, Snowflake, Reply,
  X, Send, MessageSquarePlus,
} from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useWriteGate } from '@/store/dataRoot'
import { useNavStore } from '@/store/nav'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ViewTabs, viewPanelId, viewTabId, type ViewTab } from '@/components/shared/ViewTabs'
import { Button, Chip, PageHeader, Stat, StatStrip, type ChipTone } from '@/components/ui'
import { NetworkPanel, useNetworkOverview } from '@/components/network/NetworkView'
import {
  buildOutreachBoard,
  appendOutreachTouch,
  updateOutreachOutcome,
  OUTREACH_CHANNELS,
  OUTREACH_OUTCOMES,
  type OutreachContact,
  type LogTouchArgs,
} from '@/lib/outreachDoc'

const LOG_PATH = 'data/outreach.md'

// Sub-tabs: Board is the touch log (cadence + writebacks), Network is the
// roster/plays/gaps lens — one warm-outreach domain, two surfaces.
type OutreachTab = 'board' | 'network'
const OUTREACH_TABS: readonly ViewTab<OutreachTab>[] = [
  { key: 'board', label: 'Board' },
  { key: 'network', label: 'Network' },
]

// Cadence verdict → presentation. Chip tones from DESIGN-meta § 7:
//   nudge   → accent  (act now — the one action colour, matches Today)
//   waiting → neutral (on track, on the clock)
//   done    → success (they replied — a win)
//   cold    → muted   (stop pestering)
type Action = OutreachContact['action']

const ACTION_META: Record<string, {
  label: string; icon: React.ElementType; tone: ChipTone; order: number
}> = {
  nudge:   { label: 'Nudge due', icon: Send,         tone: 'accent',  order: 0 },
  waiting: { label: 'Waiting',   icon: Clock,        tone: 'neutral', order: 1 },
  done:    { label: 'Replied',   icon: CheckCircle2, tone: 'success', order: 2 },
  cold:    { label: 'Cold',      icon: Snowflake,    tone: 'muted',   order: 3 },
}

function metaFor(action: string) {
  return ACTION_META[action] ?? ACTION_META.waiting
}

function daysLabel(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n === 0) return 'today'
  return `${n}d ago`
}

export function OutreachView() {
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const applications = useDataStore(s => s.applications)
  const scouting = useDataStore(s => s.scouting)

  const [raw, setRaw] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<OutreachTab>('board')
  // Demo mode: the log reads normally, every writeback is disabled.
  const { canWrite, readOnlyTitle } = useWriteGate()

  // Honor one-shot sub-tab requests from navigate('outreach', '', '', 'network')
  // — nav.ts resets viewTab on the next payload-less navigate, so this only
  // fires when a caller explicitly asked for a tab.
  const requestedTab = useNavStore(s => s.viewTab)
  useEffect(() => {
    if (requestedTab === 'board' || requestedTab === 'network') setTab(requestedTab)
  }, [requestedTab])

  // One overview fetch serves both the Network title-bar meta and the panel
  // body (the hook lives in NetworkView.tsx beside its data contract).
  const net = useNetworkOverview()

  // Read the log straight off disk — it's a contacto-mode artifact, not in the
  // SQLite cache (same approach as TodayView). Re-read whenever the store data
  // changes (the chokidar watcher bumps the store on any data/* write).
  const reload = useCallback(() => {
    let cancelled = false
    ipc.readFile(LOG_PATH)
      .then(content => { if (!cancelled) { setRaw(content); setReady(true) } })
      .catch(() => { if (!cancelled) { setRaw(null); setReady(true) } })
    return () => { cancelled = true }
  }, [])

  useEffect(() => reload(), [reload, applications, scouting])

  const board = useMemo(() => buildOutreachBoard(raw), [raw])

  const counts = useMemo(() => {
    const c = { nudge: 0, waiting: 0, done: 0, cold: 0 }
    for (const x of board) {
      const a = x.action as keyof typeof c
      if (a in c) c[a]++
    }
    return c
  }, [board])

  // Sort: action priority (nudge first), then most-overdue, then company.
  const sorted = useMemo(() => {
    return [...board].sort((a, b) =>
      (metaFor(a.action).order - metaFor(b.action).order) ||
      ((b.daysSince ?? -1) - (a.daysSince ?? -1)) ||
      a.company.localeCompare(b.company),
    )
  }, [board])

  // ── Writeback ───────────────────────────────────────────────────────────────
  // Pure transform in the lib → write → re-read → refresh the store so the
  // Today cockpit's outreach feed and the sidebar badge re-derive too. Same
  // contract as the Apply/status writes (ARCHITECTURE.md "Apply / Status
  // writebacks").
  const writeBack = useCallback(async (next: string) => {
    setBusy(true)
    try {
      await ipc.writeFile(LOG_PATH, next)
      setRaw(next)            // optimistic — show the change immediately
      await refresh()         // re-derive store-backed surfaces (Today badge etc.)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const logTouch = useCallback(async (args: LogTouchArgs) => {
    await writeBack(appendOutreachTouch(raw, args))
  }, [raw, writeBack])

  const setOutcome = useCallback(async (c: OutreachContact, outcome: string) => {
    await writeBack(updateOutreachOutcome(raw, c.company, c.contact, outcome))
  }, [raw, writeBack])

  // "Nudge again" = log a fresh touch on the same channel, marked Pending.
  const nudgeAgain = useCallback(async (c: OutreachContact) => {
    await logTouch({
      company: c.company, role: c.role, contact: c.contact,
      title: c.title, channel: c.channel || 'Message', outcome: 'Pending',
    })
  }, [logTouch])

  const showSkeleton = !loaded || !ready
  const netSkeleton = !loaded || !net.ready

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Title-bar contents swap with the active tab — each tab's real meta,
          or nothing while it loads; never a placeholder caption. */}
      <PageHeader
        title="Outreach"
        meta={tab === 'board' ? (
          <span aria-live="polite" aria-atomic="true">
            {showSkeleton ? '…' : `${counts.nudge} ${counts.nudge === 1 ? 'nudge' : 'nudges'} due`}
          </span>
        ) : (
          !netSkeleton && net.overview && !net.empty ? (
            <span aria-live="polite">
              {net.overview.counts.contacts} {net.overview.counts.contacts === 1 ? 'contact' : 'contacts'}
              {' · '}{net.overview.counts.companiesWithPath} warm {net.overview.counts.companiesWithPath === 1 ? 'company' : 'companies'}
              {net.overview.counts.dueNudges > 0 && <> · <span className="text-accent-text">{net.overview.counts.dueNudges} {net.overview.counts.dueNudges === 1 ? 'nudge' : 'nudges'} due</span></>}
            </span>
          ) : null
        )}
        actions={tab === 'board' && (
          // The compose button belongs to the log, so it's Board-only; the
          // modal itself stays mounted at the view root.
          <Button
            tone="primary"
            size="sm"
            icon={<Plus size={13} aria-hidden />}
            onClick={() => setComposing(true)}
            disabled={showSkeleton || busy || !canWrite}
            title={readOnlyTitle}
            aria-label="Log a new outreach touch"
          >
            Log a touch
          </Button>
        )}
      />

      <ViewTabs
        tabs={OUTREACH_TABS}
        active={tab}
        onSelect={setTab}
        ariaLabel="Outreach sections"
        idPrefix="outreach"
      />

      {tab === 'board' ? (
        <div
          role="tabpanel"
          id={viewPanelId('outreach', 'board')}
          aria-labelledby={viewTabId('outreach', 'board')}
          className="flex-1 flex flex-col p-5 gap-4 overflow-hidden min-h-0"
        >
          {/* Cadence figures — inline, no card. Nudges due is the one
              "act now" figure on the page. */}
          {showSkeleton ? (
            <div className="shrink-0 h-14 shimmer rounded-lg" aria-hidden />
          ) : (
            <StatStrip className="shrink-0">
              <Stat value={counts.nudge}   label="Nudges due" hint="Reach out now" tone={counts.nudge > 0 ? 'accent' : 'default'} dot={counts.nudge > 0} />
              <Stat value={counts.waiting} label="Waiting"    hint="On the clock" />
              <Stat value={counts.done}    label="Replied"    hint="They answered" tone={counts.done > 0 ? 'success' : 'default'} />
              <Stat value={counts.cold}    label="Cold"       hint="No path left" />
            </StatStrip>
          )}

          {/* The contact list — nudges first. */}
          <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1" role="region" aria-label="Outreach contacts">
            {showSkeleton ? (
              <div className="space-y-2" aria-hidden>
                {[0, 1, 2].map(i => <div key={i} className="h-16 shimmer rounded-lg" />)}
              </div>
            ) : sorted.length === 0 ? (
              <EmptyState onLog={() => setComposing(true)} readOnlyTitle={readOnlyTitle} />
            ) : (
              <div className="space-y-2 max-w-3xl" role="list">
                {sorted.map(c => (
                  <ContactRow
                    key={`${c.company}|${c.contact}`.toLowerCase()}
                    contact={c}
                    busy={busy || !canWrite}
                    readOnlyTitle={readOnlyTitle}
                    onNudge={() => nudgeAgain(c)}
                    onOutcome={(o) => setOutcome(c, o)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          role="tabpanel"
          id={viewPanelId('outreach', 'network')}
          aria-labelledby={viewTabId('outreach', 'network')}
          className="flex-1 min-h-0 overflow-y-auto p-5"
        >
          <NetworkPanel overview={net.overview} ready={net.ready} />
        </div>
      )}

      {composing && (
        <LogTouchModal
          busy={busy}
          existing={board}
          onClose={() => setComposing(false)}
          onSubmit={async (args) => { await logTouch(args); setComposing(false) }}
        />
      )}
    </div>
  )
}

// ─── Contact row ──────────────────────────────────────────────────────────────

function ContactRow({
  contact, busy, readOnlyTitle, onNudge, onOutcome,
}: {
  contact: OutreachContact
  busy: boolean
  readOnlyTitle?: string
  onNudge: () => void
  onOutcome: (outcome: string) => void
}) {
  const meta = metaFor(contact.action)
  const Icon = meta.icon
  const terminal = contact.action === 'done' || contact.action === 'cold'
  // A cold contact has no active path forward (they went silent past the touch
  // ceiling). Showing "Mark replied" alongside "Reopen" is contradictory — hide
  // the reply shortcut for cold contacts. For a "done" (already replied) contact,
  // the reply button is already hidden by the action !== 'done' guard below.
  const showReply = contact.action !== 'done' && contact.action !== 'cold'
  const nudgeLabel = contact.action === 'nudge' ? 'Nudge' : 'Log touch'

  // Channel lives in the tooltip so the visible line keeps two separators.
  const detailTitle = [
    contact.company,
    contact.title,
    contact.channel && `via ${contact.channel}`,
    daysLabel(contact.daysSince),
  ].filter(Boolean).join(' · ')

  return (
    <div
      role="listitem"
      className="group card flex items-center gap-3 px-4 py-3 transition-colors duration-150 ease-quart hover:border-border-strong"
    >
      <CompanyLogo company={contact.company} size={32} className="shrink-0" aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-text-1 leading-tight">{contact.contact}</span>
          <Chip
            tone={meta.tone}
            size="sm"
            icon={<Icon size={12} aria-hidden />}
            aria-label={`Status: ${meta.label}`}
          >
            {meta.label}
          </Chip>
          {contact.touches > 1 && (
            <span className="text-label text-text-4" aria-label={`${contact.touches} touches sent`}>{contact.touches} touches</span>
          )}
        </div>
        <div className="text-label text-text-3 truncate mt-0.5" title={detailTitle}>
          <span className="text-text-2 font-medium">{contact.company}</span>
          {contact.title && <><span className="text-text-4" aria-hidden> · </span>{contact.title}</>}
          <span className="text-text-4" aria-hidden> · </span>
          <span className="text-text-4">{daysLabel(contact.daysSince)}</span>
        </div>
        {contact.reason && (
          <p className="text-label text-text-4 mt-0.5 line-clamp-1">{contact.reason}</p>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1.5">
        {/* "They replied" shortcut — hide for done (already replied) and cold
            (the thread is dead; "Reopen" is the explicit action if the user
            wants to restart). */}
        {showReply && (
          <Button
            tone="ghost"
            size="sm"
            iconOnly
            icon={<Reply size={14} aria-hidden />}
            onClick={() => onOutcome('Replied')}
            disabled={busy}
            title={readOnlyTitle}
            aria-label={`Mark ${contact.contact} as replied`}
            className="hover:text-success"
          />
        )}
        {/* Primary action depends on cadence: nudge-due → log a nudge; a
            terminal contact → no primary (the reply/outcome controls remain). */}
        {!terminal ? (
          <Button
            tone="primary"
            size="sm"
            icon={<MessageSquarePlus size={13} aria-hidden />}
            onClick={onNudge}
            disabled={busy}
            title={readOnlyTitle}
            aria-label={`${nudgeLabel} ${contact.contact} at ${contact.company}`}
          >
            {nudgeLabel}
          </Button>
        ) : contact.action === 'cold' ? (
          <Button
            tone="secondary"
            size="sm"
            trailing={<ArrowRight size={12} aria-hidden />}
            onClick={() => onOutcome('Pending')}
            disabled={busy}
            title={readOnlyTitle}
            aria-label={`Reopen outreach thread with ${contact.contact} at ${contact.company}`}
          >
            Reopen
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ─── Log-a-touch modal ────────────────────────────────────────────────────────

function LogTouchModal({
  busy, existing, onClose, onSubmit,
}: {
  busy: boolean
  existing: OutreachContact[]
  onClose: () => void
  onSubmit: (args: LogTouchArgs) => void | Promise<void>
}) {
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [contact, setContact] = useState('')
  const [title, setTitle] = useState('')
  const [channel, setChannel] = useState<string>(OUTREACH_CHANNELS[0])
  const [outcome, setOutcome] = useState<string>(OUTREACH_OUTCOMES[0])
  const [notes, setNotes] = useState('')
  const titleId = useId()

  // Prefill role/title/channel when the typed (company, contact) already exists —
  // logging another touch on a known thread shouldn't re-ask for the basics.
  useEffect(() => {
    const c = company.trim().toLowerCase()
    const k = contact.trim().toLowerCase()
    if (!c || !k) return
    const hit = existing.find(x => x.company.toLowerCase() === c && x.contact.toLowerCase() === k)
    if (hit) {
      setRole(r => r || (hit.role ?? ''))
      setTitle(t => t || (hit.title ?? ''))
      setChannel(ch => ch === OUTREACH_CHANNELS[0] ? (hit.channel || ch) : ch)
    }
  }, [company, contact, existing])

  // Focus trap: keep keyboard focus inside the modal while it's open.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => !el.hasAttribute('disabled'))

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const els = focusable()
      if (els.length === 0) return
      const first = els[0]
      const last = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Move focus into the modal when it opens (auto-focus the first input).
  // The `autoFocus` attribute handles the initial focus; we just need to
  // ensure focus doesn't escape on mount.
  const canSubmit = company.trim() && contact.trim() && !busy

  const submit = () => {
    if (!canSubmit) return
    void onSubmit({
      company: company.trim(),
      role: role.trim(),
      contact: contact.trim(),
      title: title.trim(),
      channel,
      outcome,
      notes: notes.trim(),
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/30"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[520px] bg-bg-base border border-border-default rounded-xl shadow-lift overflow-hidden"
        onClick={e => e.stopPropagation()}
        aria-hidden="false"
      >
        <div className="flex items-center gap-2 pl-4 pr-3 py-3 border-b border-border-default">
          <span id={titleId} className="text-title text-text-1 flex-1">Log a touch</span>
          <Button
            tone="ghost"
            size="xs"
            iconOnly
            icon={<X size={14} aria-hidden />}
            onClick={onClose}
            aria-label="Close dialog"
          />
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company" required htmlFor="ltf-company">
              <input
                id="ltf-company"
                autoFocus
                value={company}
                onChange={e => setCompany(e.target.value)}
                placeholder="Acme"
                className={inputCls}
                aria-required="true"
              />
            </Field>
            <Field label="Role" htmlFor="ltf-role">
              <input id="ltf-role" value={role} onChange={e => setRole(e.target.value)} placeholder="ML Engineer" className={inputCls} />
            </Field>
            <Field label="Contact" required htmlFor="ltf-contact">
              <input
                id="ltf-contact"
                value={contact}
                onChange={e => setContact(e.target.value)}
                placeholder="Jane Doe"
                className={inputCls}
                aria-required="true"
              />
            </Field>
            <Field label="Their title" htmlFor="ltf-title">
              <input id="ltf-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Recruiter" className={inputCls} />
            </Field>
            <Field label="Channel" htmlFor="ltf-channel">
              <select id="ltf-channel" value={channel} onChange={e => setChannel(e.target.value)} className={inputCls}>
                {OUTREACH_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Outcome" htmlFor="ltf-outcome">
              <select id="ltf-outcome" value={outcome} onChange={e => setOutcome(e.target.value)} className={inputCls}>
                {OUTREACH_OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Notes" htmlFor="ltf-notes">
            <input id="ltf-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Angle used / what to say next…" className={inputCls} />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-default">
          <Button tone="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            size="sm"
            icon={<Send size={13} aria-hidden />}
            onClick={submit}
            disabled={!canSubmit}
            loading={busy}
            aria-label="Save outreach touch"
            aria-busy={busy}
          >
            {busy ? 'Saving…' : 'Log touch'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'input'

function Field({
  label, required, htmlFor, children,
}: {
  label: string; required?: boolean; htmlFor?: string; children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label block mb-1">
        {label}{required && <span className="text-accent-text" aria-hidden> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onLog, readOnlyTitle }: { onLog: () => void; readOnlyTitle?: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center px-6 py-8 flex flex-col items-center">
        <Users size={24} className="text-text-4 mb-3" aria-hidden />
        <h3 className="text-section text-text-1">No outreach logged yet</h3>
        <p className="text-label text-text-3 mt-1">
          When you reach out to a recruiter, hiring manager or peer at a target company,
          log the touch here. The cadence engine tells you when each contact is due a nudge
          and surfaces it on Today.
        </p>
        <Button
          tone="primary"
          size="sm"
          icon={<Plus size={13} aria-hidden />}
          onClick={onLog}
          disabled={!!readOnlyTitle}
          title={readOnlyTitle}
          aria-label="Log your first outreach touch"
          className="mt-4"
        >
          Log your first touch
        </Button>
      </div>
    </div>
  )
}

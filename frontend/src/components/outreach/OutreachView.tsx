'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Users, Plus, ArrowRight, CheckCircle2, Clock, Snowflake, Reply,
  X, Send, MessageSquarePlus,
} from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useDataStore } from '@/store/data'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
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

// Cadence verdict → presentation. Reuses the same semantic ladder the Today
// cockpit maps outreach onto (DESIGN-meta tokens only — no new hues):
//   nudge   → accent  (act now — the brand action colour, matches Today)
//   waiting → info    (on track, on the clock)
//   cold    → text-3  (muted — stop pestering)
//   done    → success (they replied — a win)
type Action = OutreachContact['action']

const ACTION_META: Record<string, {
  label: string; icon: React.ElementType; chip: string; ring: string; dot: string; order: number
}> = {
  nudge:   { label: 'Nudge due', icon: Send,        chip: 'text-accent bg-accent/10 border-accent/30',          ring: 'border-accent/30',      dot: 'bg-accent',  order: 0 },
  waiting: { label: 'Waiting',   icon: Clock,       chip: 'text-info bg-info/10 border-info/30',                ring: 'border-border-default', dot: 'bg-info',    order: 1 },
  done:    { label: 'Replied',   icon: CheckCircle2,chip: 'text-success bg-success/10 border-success/30',       ring: 'border-border-default', dot: 'bg-success', order: 2 },
  cold:    { label: 'Cold',      icon: Snowflake,   chip: 'text-text-3 bg-bg-elevated border-border-default',   ring: 'border-border-default', dot: 'bg-text-4',  order: 3 },
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Outreach</h1>
        <span className="text-label text-text-4 font-mono" aria-live="polite" aria-atomic="true">
          {showSkeleton ? '…' : `${counts.nudge} ${counts.nudge === 1 ? 'nudge' : 'nudges'} due`}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setComposing(true)}
          disabled={showSkeleton || busy}
          aria-label="Log a new outreach touch"
          className="titlebar-no-drag inline-flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-pill bg-accent hover:bg-accent-hover text-white text-label font-medium transition-colors shadow-pill disabled:opacity-40 disabled:pointer-events-none"
        >
          <Plus size={13} aria-hidden />
          Log a touch
        </button>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-6 gap-5 overflow-hidden min-h-0">
        {/* Editorial hero — the cadence headline + a four-column breakdown of the
            contact mix, mirroring the Today / Applying hero pattern. */}
        <div className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos">
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            <h2 className="text-display-2 text-text-1">Stay in touch</h2>
            {!showSkeleton && counts.nudge > 0 && (
              <span className="text-label text-accent font-medium" aria-live="polite">
                {counts.nudge} {counts.nudge === 1 ? 'contact is' : 'contacts are'} due a nudge
              </span>
            )}
          </div>
          {showSkeleton ? (
            <div className="h-14 shimmer rounded-lg" aria-hidden />
          ) : (
            <div className="grid grid-cols-4 divide-x divide-border-default/50">
              <StatTile value={counts.nudge}   label="Nudges due" sub="reach out now" accent={counts.nudge > 0 ? 'text-accent' : undefined} dot={counts.nudge > 0 ? 'bg-accent' : undefined} />
              <StatTile value={counts.waiting} label="Waiting"    sub="on the clock" />
              <StatTile value={counts.done}    label="Replied"    sub="they answered" accent={counts.done > 0 ? 'text-success' : undefined} />
              <StatTile value={counts.cold}    label="Cold"       sub="no path left" />
            </div>
          )}
        </div>

        {/* The contact list — nudges first. */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1" role="region" aria-label="Outreach contacts">
          {showSkeleton ? (
            <div className="space-y-2" aria-hidden>
              {[0, 1, 2].map(i => <div key={i} className="h-[72px] shimmer rounded-lg" />)}
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState onLog={() => setComposing(true)} />
          ) : (
            <div className="space-y-2 max-w-3xl" role="list">
              {sorted.map(c => (
                <ContactRow
                  key={`${c.company}|${c.contact}`.toLowerCase()}
                  contact={c}
                  busy={busy}
                  onNudge={() => nudgeAgain(c)}
                  onOutcome={(o) => setOutcome(c, o)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

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

// ─── Stat tile ────────────────────────────────────────────────────────────────
// Local copy of the hero stat tile pattern (kept self-contained rather than
// importing CommandCenter's, so this view doesn't couple to a file another
// surface owns). Same tokens/sizing as the Today/Applying heroes.
function StatTile({
  value, label, sub, accent, dot,
}: { value: string | number; label: string; sub?: string; accent?: string; dot?: string }) {
  return (
    <div className="px-5 first:pl-0 last:pr-0">
      <div className="relative inline-block">
        <span className={cn('text-[34px] leading-none font-semibold tabular-nums', accent ?? 'text-text-1')} aria-label={`${value} ${label}`}>
          {value}
        </span>
        {dot && <span className={cn('absolute -right-2.5 top-1 w-1.5 h-1.5 rounded-full animate-pulse', dot)} aria-hidden />}
      </div>
      <div className="mt-2 text-label text-text-2 font-medium" aria-hidden>{label}</div>
      {sub && <div className="text-micro text-text-4 mt-0.5" aria-hidden>{sub}</div>}
    </div>
  )
}

// ─── Contact row ──────────────────────────────────────────────────────────────

function ContactRow({
  contact, busy, onNudge, onOutcome,
}: {
  contact: OutreachContact
  busy: boolean
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

  return (
    <div
      role="listitem"
      className={cn(
        'group flex items-center gap-3.5 rounded-lg bg-bg-base border px-4 py-3 transition-colors hover:border-border-strong',
        meta.ring,
      )}
    >
      <CompanyLogo company={contact.company} size={32} className="shrink-0" aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-text-1 leading-tight">{contact.contact}</span>
          <span className={cn(
            'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full border',
            meta.chip,
          )} aria-label={`Status: ${meta.label}`}>
            <Icon size={9} aria-hidden />
            {meta.label}
          </span>
          {contact.touches > 1 && (
            <span className="text-[10px] text-text-4 font-mono" aria-label={`${contact.touches} touches sent`}>{contact.touches} touches</span>
          )}
        </div>
        <div className="text-[12px] text-text-2 truncate mt-0.5">
          <span className="font-medium">{contact.company}</span>
          {contact.title && <><span className="text-text-4" aria-hidden> · </span><span className="text-text-3">{contact.title}</span></>}
          {contact.channel && <><span className="text-text-4" aria-hidden> · </span><span className="text-text-4">{contact.channel}</span></>}
          <span className="text-text-4" aria-hidden> · </span>
          <span className="text-text-4">{daysLabel(contact.daysSince)}</span>
        </div>
        {contact.reason && (
          <p className="text-[11px] text-text-4 leading-snug mt-1 line-clamp-1">{contact.reason}</p>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1.5">
        {/* "They replied" shortcut — hide for done (already replied) and cold
            (the thread is dead; "Reopen" is the explicit action if the user
            wants to restart). */}
        {showReply && (
          <button
            onClick={() => onOutcome('Replied')}
            disabled={busy}
            aria-label={`Mark ${contact.contact} as replied`}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-3 hover:text-success hover:bg-success/10 transition-colors disabled:opacity-40"
          >
            <Reply size={15} aria-hidden />
          </button>
        )}
        {/* Primary action depends on cadence: nudge-due → log a nudge; a
            terminal contact → no primary (the reply/outcome controls remain). */}
        {!terminal ? (
          <button
            onClick={onNudge}
            disabled={busy}
            aria-label={`${nudgeLabel} ${contact.contact} at ${contact.company}`}
            className="inline-flex items-center gap-1.5 pl-3 pr-2.5 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12px] font-medium transition-all shadow-pill hover:shadow-pill-hover disabled:opacity-50"
          >
            <MessageSquarePlus size={13} aria-hidden />
            {nudgeLabel}
          </button>
        ) : contact.action === 'cold' ? (
          <button
            onClick={() => onOutcome('Pending')}
            disabled={busy}
            aria-label={`Reopen outreach thread with ${contact.contact} at ${contact.company}`}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-pill border border-border-default text-text-3 hover:text-text-1 hover:border-border-strong text-[12px] font-medium transition-colors disabled:opacity-50"
          >
            Reopen
            <ArrowRight size={12} aria-hidden />
          </button>
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
        className="w-[520px] bg-bg-panel border border-border-strong rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
        aria-hidden="false"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-default">
          <Users size={15} className="text-accent shrink-0" aria-hidden />
          <span id={titleId} className="text-body text-text-1 font-medium flex-1">Log a touch</span>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
          >
            <X size={14} aria-hidden />
          </button>
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
          <button
            onClick={onClose}
            className="px-3 h-8 rounded-pill text-text-3 hover:text-text-1 text-label font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            aria-label="Save outreach touch"
            aria-busy={busy}
            className="inline-flex items-center gap-1.5 pl-3.5 pr-3 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12px] font-medium transition-all shadow-pill hover:shadow-pill-hover disabled:opacity-40 disabled:pointer-events-none"
          >
            <Send size={13} aria-hidden />
            {busy ? 'Saving…' : 'Log touch'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'w-full h-8 px-2.5 rounded-md bg-bg-base border border-border-default text-text-1 text-[12.5px] placeholder:text-text-4 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/25 transition-colors'

function Field({
  label, required, htmlFor, children,
}: {
  label: string; required?: boolean; htmlFor?: string; children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-micro text-text-4 uppercase tracking-wide font-medium mb-1">
        {label}{required && <span className="text-accent" aria-hidden> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onLog }: { onLog: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center px-6 py-8">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent/10 mb-4" aria-hidden>
          <Users size={20} className="text-accent" />
        </span>
        <h3 className="text-[15px] font-semibold text-text-1">No outreach logged yet</h3>
        <p className="text-[12.5px] text-text-3 leading-relaxed mt-1.5">
          When you reach out to a recruiter, hiring manager, or peer at a target company,
          log the touch here. The cadence engine tells you when each contact is due a nudge —
          and surfaces it on Today.
        </p>
        <button
          onClick={onLog}
          className="inline-flex items-center gap-1.5 mt-4 pl-3 pr-3.5 h-8 bg-accent hover:bg-accent-hover text-white rounded-pill text-[12px] font-medium transition-colors shadow-pill"
          aria-label="Log your first outreach touch"
        >
          <Plus size={13} aria-hidden />
          Log your first touch
        </button>
      </div>
    </div>
  )
}

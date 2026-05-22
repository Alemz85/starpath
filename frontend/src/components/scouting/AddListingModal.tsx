'use client'

// Global modal — paste a URL → either queue it in the inbox
// (data/pipeline.md) or evaluate it immediately (no prose report;
// just score → score-history.tsv + scouting.md row → Database).
//
// Lives at AppShell level (mounted from any view) and is controlled by
// useAddListingStore so the Scouting CTA + CmdK can both trigger it
// without prop drilling.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Sparkles, Link2, Inbox, AlertTriangle, CheckCircle2, Plus, Clipboard,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'

const ADD_LISTING_SPAWN_ID = 'add-listing-evaluate'

// Score-only evaluation prompt — mirrors the rubric of `/career-ops scouting`
// but explicitly tells the agent NOT to write a per-listing prose report.
// The user's bias is "scoring lands the listing in the Database; reports
// are opt-in from there". Generated reports cost tokens; this keeps the
// fast path cheap.
function buildEvaluatePrompt(url: string): string {
  return (
    `/career-ops scouting ${url} — SCORE ONLY mode. ` +
    `Evaluate this single URL per modes/scouting.md: fetch the JD (Playwright; WebFetch fallback in non-interactive mode), ` +
    `run the full pre-scoring JD audit + 10-dimension scoring per modes/_shared.md, ` +
    `then WRITE: ` +
    `(1) one row to data/score-history.tsv per the canonical schema, ` +
    `(2) one entry to data/scouting.md with the tier column, ` +
    `(3) update data/dedup-index.tsv. ` +
    `DO NOT write a per-listing prose report under reports/tier-*/. ` +
    `The user will trigger report generation later via the Database "Generate Report" action if the score justifies it. ` +
    `Use user/cv.md, user/_profile.md, user/profile.yml for context.`
  )
}

// Pull a guessed company name out of the URL hostname so the live
// preview can confirm the user pasted the right URL before they commit.
// Heuristic only — the real company name comes from the JD scrape, this
// just helps catch obvious typos / wrong-URL pastes.
function guessCompanyFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    // ATS hosts → pull from the path or subdomain
    if (host.endsWith('greenhouse.io') || host.endsWith('boards.greenhouse.io')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('lever.co')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('ashbyhq.com') || host.endsWith('jobs.ashbyhq.com')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('myworkdayjobs.com')) {
      // {tenant}.{whatever}.myworkdayjobs.com → tenant
      const sub = host.split('.')[0]
      if (sub) return prettify(sub)
    }
    if (host.endsWith('welcometothejungle.com')) {
      const idx = u.pathname.indexOf('/companies/')
      if (idx >= 0) {
        const seg = u.pathname.slice(idx + '/companies/'.length).split('/')[0]
        if (seg) return prettify(seg)
      }
    }
    if (host.endsWith('linkedin.com')) return 'LinkedIn job'
    if (host.endsWith('indeed.com')) return 'Indeed listing'
    // Fallback: registrable domain
    const labels = host.split('.')
    if (labels.length >= 2) return prettify(labels[labels.length - 2])
    return prettify(host)
  } catch {
    return null
  }
}

function prettify(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function AddListingModal() {
  const open = useAddListingStore(s => s.open)
  const hide = useAddListingStore(s => s.hide)
  const prefillUrl = useAddListingStore(s => s.prefillUrl)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const refresh = useDataStore(s => s.refresh)
  const repoPath = useAppStore(s => s.repoPath)
  const startSpawn = useSpawnsStore(s => s.start)
  const clearSpawn = useSpawnsStore(s => s.clear)
  const spawns = useSpawnsStore(s => s.spawns)
  const evaluateSpawn = spawns[ADD_LISTING_SPAWN_ID]

  const [url, setUrl] = useState('')
  const [active, setActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [inboxStatus, setInboxStatus] = useState<'idle' | 'done' | 'error'>('idle')
  const [clipboardSuggestion, setClipboardSuggestion] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Refresh data when the evaluate spawn finishes so the new
  // scouting.md / score-history.tsv row shows up in the Database
  // without a manual reload.
  useEffect(() => {
    if (evaluateSpawn?.status === 'done') void refresh()
  }, [evaluateSpawn?.status, refresh])

  // Open lifecycle — animate in, focus the input, clear stale state.
  useEffect(() => {
    if (!open) return
    setUrl(prefillUrl ?? '')
    setInboxStatus('idle')
    const t = setTimeout(() => {
      setActive(true)
      inputRef.current?.focus()
      // Auto-paste detection — if the clipboard has a valid URL the user
      // didn't already type one of, surface a one-click suggestion. We
      // never auto-fill (would feel invasive); just offer.
      void readClipboardSuggestion()
    }, 20)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const readClipboardSuggestion = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const trimmed = text.trim()
      if (!isValidHttpUrl(trimmed)) return
      if (trimmed === (prefillUrl ?? '').trim()) return
      setClipboardSuggestion(trimmed)
    } catch {
      // Permission denied or non-secure context — silently noop.
    }
  }

  // Esc closes; ⌘↵ submits the primary action.
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (valid && !submitting) void handleEvaluate()
      }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, submitting])

  const handleClose = () => {
    setActive(false)
    setTimeout(() => {
      hide()
      setUrl('')
      setInboxStatus('idle')
      setClipboardSuggestion(null)
      setSubmitting(false)
    }, 240)
  }

  const trimmedUrl = url.trim()
  const valid = isValidHttpUrl(trimmedUrl)
  const guessedCompany = useMemo(() => valid ? guessCompanyFromUrl(trimmedUrl) : null, [trimmedUrl, valid])

  // Smart-duplicate detection — surface a soft warning if this URL is
  // already known to score-history (re-evaluating is fine, but the user
  // should know they're spending tokens on a re-score, not a first eval).
  const duplicate = useMemo(() => {
    if (!valid) return null
    return scoreHistory.find(r => r.url && r.url.trim() === trimmedUrl) ?? null
  }, [scoreHistory, trimmedUrl, valid])

  // Primary action — evaluate this URL into the Database without writing
  // a prose report. Closes the modal after handing off; live progress
  // shows up in the Activity panel via the existing spawn machinery.
  const handleEvaluate = async () => {
    if (!valid || !repoPath) return
    setSubmitting(true)
    try {
      // First: append URL to data/pipeline.md so the inbox stays the
      // source of truth (manual paste vs scanned URL = same data shape).
      await appendToPipeline(trimmedUrl)
      // Then: spawn claude to score-only-evaluate the URL.
      if (evaluateSpawn) clearSpawn(ADD_LISTING_SPAWN_ID)
      startSpawn(
        ADD_LISTING_SPAWN_ID,
        `Evaluate ${guessedCompany ?? 'URL'}`,
        'claude',
        claudeArgs(buildEvaluatePrompt(trimmedUrl), 'sonnet'),
      )
      // Close immediately — user can watch progress in Activity.
      handleClose()
    } catch (err) {
      console.error('Evaluate failed', err)
      setSubmitting(false)
    }
  }

  // Secondary action — just queue the URL. No claude spawn, no tokens.
  // The next manual `Filter to Database` run picks it up alongside any
  // scanner-found URLs.
  const handleAddToInbox = async () => {
    if (!valid || !repoPath) return
    setSubmitting(true)
    try {
      await appendToPipeline(trimmedUrl)
      setInboxStatus('done')
      void refresh()
      // Hold the success state briefly so the user sees the confirmation,
      // then close. Snappy but legible.
      setTimeout(handleClose, 900)
    } catch (err) {
      console.error('Add to inbox failed', err)
      setInboxStatus('error')
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] transition-opacity duration-[240ms]',
          active ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      {/* Center-stage modal — narrower than the report slide-overs because
          there's effectively one field of content; the report modals run
          full-height to host long markdown, the AddListing modal is a
          single decision card. Same visual language though (accent
          gradient stripe, icon plate, eyebrow, action pills). */}
      <div className="fixed inset-0 z-50 flex items-center justify-center px-6 pointer-events-none">
        <div
          className={cn(
            'pointer-events-auto w-full max-w-[560px] bg-bg-panel border border-border-strong rounded-2xl shadow-cosmos-lift overflow-hidden flex flex-col',
            'transition-[transform,opacity] duration-[240ms] ease-out',
            active ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          {/* Accent stripe — same gradient language as PositioningModal */}
          <div
            className="h-1.5 shrink-0"
            aria-hidden
            style={{ background: 'linear-gradient(90deg, #7C5CFF 0%, #7C5CFF66 60%, transparent 100%)' }}
          />

          {/* Editorial header */}
          <div className="flex items-start gap-4 px-6 pt-5 pb-4 border-b border-border-default">
            <div
              className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center mt-0.5"
              style={{
                background: '#7C5CFF1F',
                border: '1px solid #7C5CFF40',
              }}
              aria-hidden
            >
              <Plus size={18} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-micro text-text-4 uppercase tracking-[0.08em] mb-0.5">
                Add Listing
              </div>
              <h2 className="text-section text-text-1 leading-tight tracking-[-0.005em]">
                Evaluate a job you found
              </h2>
              <p className="text-label text-text-3 leading-snug mt-1">
                Paste a job posting URL · score it into the Database or queue it for the next filter pass.
              </p>
            </div>
            <button
              onClick={handleClose}
              className="shrink-0 p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>

          {/* Body */}
          <div className="flex flex-col gap-3 px-6 py-5">
            {/* URL input + paste suggestion */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-text-4 mb-1.5">
                Job posting URL
              </label>
              <div
                className={cn(
                  'flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-bg-base transition-colors',
                  valid
                    ? 'border-accent/40'
                    : url.length > 0
                      ? 'border-warning/40'
                      : 'border-border-default focus-within:border-border-strong',
                )}
              >
                <Link2 size={14} className={cn('shrink-0', valid ? 'text-accent' : 'text-text-4')} />
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="url"
                  spellCheck={false}
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://…"
                  className="flex-1 bg-transparent outline-none text-[13.5px] text-text-1 placeholder:text-text-4 font-mono tabular-nums"
                />
                {url && (
                  <button
                    onClick={() => { setUrl(''); inputRef.current?.focus() }}
                    className="shrink-0 text-text-4 hover:text-text-2 transition-colors"
                    title="Clear"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Live preview / state row */}
              <div className="mt-1.5 min-h-[16px] text-[11px] flex items-center gap-1.5">
                {valid && guessedCompany ? (
                  <span className="text-text-3">
                    Detected · <span className="text-text-1 font-medium">{guessedCompany}</span>
                  </span>
                ) : url.length > 0 && !valid ? (
                  <span className="text-warning flex items-center gap-1">
                    <AlertTriangle size={11} />
                    Not a valid http(s) URL
                  </span>
                ) : clipboardSuggestion ? (
                  <button
                    onClick={() => { setUrl(clipboardSuggestion); setClipboardSuggestion(null); inputRef.current?.focus() }}
                    className="text-accent-text hover:underline flex items-center gap-1"
                  >
                    <Clipboard size={10} />
                    Use clipboard URL
                  </button>
                ) : (
                  <span className="text-text-4">Paste any Greenhouse / Lever / Ashby / Workday / WTTJ / company-careers URL</span>
                )}
              </div>
            </div>

            {/* Duplicate warning */}
            {duplicate && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-warning/30 bg-warning/5 text-[11.5px] text-text-2">
                <AlertTriangle size={12} className="text-warning shrink-0 mt-0.5" />
                <div className="leading-snug">
                  Already in the Database: <span className="text-text-1 font-medium">{duplicate.company}</span> · {duplicate.role} · {duplicate.overall > 0 ? `${duplicate.overall.toFixed(1)}/10` : 'unscored'}{' '}
                  <span className="text-text-4">(evaluated {duplicate.date}). Re-evaluating will replace the score.</span>
                </div>
              </div>
            )}

            {/* Inbox-only success confirmation */}
            {inboxStatus === 'done' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-success/30 bg-success/5 text-[11.5px] text-text-2">
                <CheckCircle2 size={12} className="text-success" />
                Added to pipeline inbox. The next <span className="font-medium text-text-1">Filter to Database</span> run will pick it up.
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t border-border-default bg-bg-elevated/40">
            <button
              onClick={handleClose}
              className="px-3 py-1.5 rounded-md text-[12.5px] text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddToInbox}
              disabled={!valid || submitting}
              title="Append the URL to data/pipeline.md for the next filter pass (no tokens spent now)"
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] border transition-colors',
                valid && !submitting
                  ? 'border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong'
                  : 'border-border-default bg-bg-elevated text-text-4 opacity-60 cursor-not-allowed',
              )}
            >
              <Inbox size={12} />
              Add to inbox
            </button>
            <button
              onClick={handleEvaluate}
              disabled={!valid || submitting}
              title={valid
                ? 'Score this URL into the Database now (Claude tokens). No prose report is generated — you can trigger one later from the Database.'
                : 'Paste a valid URL first'}
              className={cn(
                'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] font-medium border transition-colors shadow-sm',
                valid && !submitting
                  ? 'bg-accent border-accent text-white hover:bg-accent-hover'
                  : 'bg-accent/30 border-accent/30 text-white/70 cursor-not-allowed',
              )}
            >
              <Sparkles size={12} />
              {submitting ? 'Working…' : 'Add & evaluate'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Pipeline append helper ─────────────────────────────────────────────
// data/pipeline.md is a markdown checklist under a `## Pending` header.
// We append the new URL as a fresh `- [ ] {url}` line at the end of the
// Pending section. If the file doesn't exist yet (fresh repo), seed it
// with the canonical template so the Pending section is in the right
// shape for downstream parsers.

async function appendToPipeline(url: string): Promise<void> {
  const path = 'data/pipeline.md'
  const current = (await ipc.readFile(path)) ?? ''
  let next: string

  if (!current.trim()) {
    next = [
      '# Pipeline — Pending Evaluations',
      '',
      '<!-- URLs to process. Format: - [ ] {url} | {company} | {title} -->',
      '',
      '## Pending',
      '',
      `- [ ] ${url}`,
      '',
    ].join('\n')
  } else if (/^##\s+Pending\s*$/m.test(current)) {
    // Insert right under the `## Pending` heading so the new entry shows
    // up at the TOP of the section (most-recent-first reads more
    // naturally for a user-curated paste).
    next = current.replace(
      /^(##\s+Pending\s*\n)/m,
      `$1\n- [ ] ${url}\n`,
    )
  } else {
    // No Pending section yet — append one at the end so the format
    // catches up to canonical without clobbering whatever the file has.
    next = current.trimEnd() + `\n\n## Pending\n\n- [ ] ${url}\n`
  }

  await ipc.writeFile(path, next)
}

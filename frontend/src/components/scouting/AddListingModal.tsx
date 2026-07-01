'use client'

// Global modal — paste a URL → either queue it in the inbox
// (data/pipeline.md) or evaluate it immediately (no prose report;
// just score → score-history.tsv + scouting.md row → Database).
//
// Lives at AppShell level (mounted from any view) and is controlled by
// useAddListingStore so the Scouting CTA + CmdK can both trigger it
// without prop drilling.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Sparkles, Link2, Inbox, AlertTriangle, CheckCircle2, Plus, Clipboard,
  Loader2,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore } from '@/store/spawns'
import { claudeEvalArgs, refreshCvSummary, scoreOnlyEvalPrompt } from '@/lib/evalSpawn'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { guessCompanyFromUrl, isValidHttpUrl, normalizeUrl } from '@/lib/listingUrl'
import type { ScoreEntry, PipelineUrl } from '@/types'

const ADD_LISTING_SPAWN_ID = 'add-listing-evaluate'

// Score-only evaluation prompt — lives in lib/evalSpawn.scoreOnlyEvalPrompt.
// It rides the compact eval bundle (batch/batch-prompt.md via claudeEvalArgs)
// instead of the `/career-ops scouting` slash command, so the worker doesn't
// re-read CLAUDE.md + modes/* per eval (token-cost lever 3), and it tells the
// agent NOT to write a per-listing prose report. The user's bias is "scoring
// lands the listing in the Database; reports are opt-in from there".

// ─── State model ──────────────────────────────────────────────────────────────
// The modal moves through a small state machine so each UI zone renders a
// single explicit state rather than a tangle of overlapping conditions.
//
//  idle            No URL or clipboard hint yet — show placeholder hint
//  typing          User started typing but the URL is not yet valid
//  valid-new       URL is valid and not known to the system
//  valid-duplicate URL is valid and already scored (re-eval path)
//  valid-queued    URL is valid and already in the inbox but not scored
//  submitting      Primary or secondary action in progress
//  inbox-done      "Add to inbox" succeeded — brief confirmation
//  inbox-error     "Add to inbox" failed
//
type ModalState =
  | 'idle'
  | 'typing'
  | 'valid-new'
  | 'valid-duplicate'
  | 'valid-queued'
  | 'submitting'
  | 'inbox-done'
  | 'inbox-error'

// URL/company helpers (`guessCompanyFromUrl`, `isValidHttpUrl`, `normalizeUrl`)
// live in `@/lib/listingUrl` — `normalizeUrl` is the dedup key, so it's
// extracted + unit-tested there rather than inlined here.

export function AddListingModal() {
  const open = useAddListingStore(s => s.open)
  const hide = useAddListingStore(s => s.hide)
  const prefillUrl = useAddListingStore(s => s.prefillUrl)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const pipeline = useDataStore(s => s.pipeline)
  const refresh = useDataStore(s => s.refresh)
  const repoPath = useAppStore(s => s.repoPath)
  const startSpawn = useSpawnsStore(s => s.start)
  const clearSpawn = useSpawnsStore(s => s.clear)
  const spawns = useSpawnsStore(s => s.spawns)
  const evaluateSpawn = spawns[ADD_LISTING_SPAWN_ID]

  const [url, setUrl] = useState('')
  const [entering, setEntering] = useState(false)
  const [modalState, setModalState] = useState<ModalState>('idle')
  const [clipboardSuggestion, setClipboardSuggestion] = useState<string | null>(null)

  // Focus-trap refs: we keep a list of all focusable elements inside the
  // modal so Tab/Shift-Tab cycles within it and never leaks to the page.
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // ID for aria-labelledby / aria-describedby
  const titleId = 'add-listing-title'
  const descId = 'add-listing-desc'
  const statusId = 'add-listing-status'

  // Refresh data when the evaluate spawn finishes so the new
  // scouting.md / score-history.tsv row shows up in the Database
  // without a manual reload.
  useEffect(() => {
    if (evaluateSpawn?.status === 'done') void refresh()
  }, [evaluateSpawn?.status, refresh])

  // Open lifecycle — animate in, focus the input, clear stale state.
  useEffect(() => {
    if (!open) return
    const initialUrl = prefillUrl ?? ''
    setUrl(initialUrl)
    setModalState(initialUrl ? 'typing' : 'idle')
    setClipboardSuggestion(null)
    const t = setTimeout(() => {
      setEntering(true)
      inputRef.current?.focus()
      // Auto-paste detection — if the clipboard has a valid URL the user
      // didn't already type one of, surface a one-click suggestion. We
      // never auto-fill (would feel invasive); just offer.
      void readClipboardSuggestion(initialUrl)
    }, 20)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const readClipboardSuggestion = async (currentUrl: string) => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const trimmed = text.trim()
      if (!isValidHttpUrl(trimmed)) return
      if (trimmed === currentUrl.trim()) return
      setClipboardSuggestion(trimmed)
    } catch {
      // Permission denied or non-secure context — silently noop.
    }
  }

  // Normalized indexes for fast O(1) dedup checks
  const scoredByUrl = useMemo(() => {
    const m = new Map<string, ScoreEntry>()
    for (const r of scoreHistory) if (r.url) m.set(normalizeUrl(r.url), r)
    return m
  }, [scoreHistory])
  const queuedByUrl = useMemo(() => {
    const m = new Map<string, PipelineUrl>()
    for (const p of pipeline) if (p.url) m.set(normalizeUrl(p.url), p)
    return m
  }, [pipeline])

  const trimmedUrl = url.trim()
  const valid = isValidHttpUrl(trimmedUrl)
  const guessedCompany = useMemo(() => valid ? guessCompanyFromUrl(trimmedUrl) : null, [trimmedUrl, valid])
  const normUrl = valid ? normalizeUrl(trimmedUrl) : null
  const duplicate = normUrl ? scoredByUrl.get(normUrl) ?? null : null
  const alreadyQueued = normUrl && !duplicate ? queuedByUrl.get(normUrl) ?? null : null

  // Derive modal state from current input value + system state.
  // This runs after every url change — intentionally kept pure so it's
  // easy to test and the state machine is the single source of truth.
  useEffect(() => {
    if (modalState === 'submitting' || modalState === 'inbox-done' || modalState === 'inbox-error') {
      return // mid-flight or terminal — don't overwrite
    }
    if (!url) {
      setModalState('idle')
    } else if (!valid) {
      setModalState('typing')
    } else if (duplicate) {
      setModalState('valid-duplicate')
    } else if (alreadyQueued) {
      setModalState('valid-queued')
    } else {
      setModalState('valid-new')
    }
  }, [url, valid, duplicate, alreadyQueued, modalState])

  const isSubmitting = modalState === 'submitting'

  // ─── Focus trap ──────────────────────────────────────────────────────────
  // Tab/Shift-Tab cycles within the dialog; never reaches the page behind it.
  const handleFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'input, button, [href], [tabindex]:not([tabindex="-1"])',
    )
    const items = Array.from(focusable).filter(el => !el.hasAttribute('disabled'))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }, [])

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // Plain Enter on the input → primary action (evaluate)
        if (document.activeElement === inputRef.current && valid && !isSubmitting) {
          e.preventDefault()
          void handleEvaluate()
        }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        // ⌘↵ / Ctrl+↵ → primary action from anywhere in the modal
        e.preventDefault()
        if (valid && !isSubmitting) void handleEvaluate()
      }
      handleFocusTrap(e)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, isSubmitting, valid, handleFocusTrap])

  const handleClose = () => {
    setEntering(false)
    setTimeout(() => {
      hide()
      setUrl('')
      setModalState('idle')
      setClipboardSuggestion(null)
    }, 240)
  }

  // ─── Primary action: evaluate ─────────────────────────────────────────────
  const handleEvaluate = async () => {
    if (!valid || !repoPath || isSubmitting) return
    setModalState('submitting')
    try {
      await appendToPipeline(trimmedUrl)
      if (evaluateSpawn) clearSpawn(ADD_LISTING_SPAWN_ID)
      // Refresh the CV-summary artifact the compact bundle reads (mtime-gated,
      // ms-fast; the bundle falls back to user/cv.md if it's missing).
      await refreshCvSummary()
      startSpawn(
        ADD_LISTING_SPAWN_ID,
        `Evaluate ${guessedCompany ?? 'URL'}`,
        'claude',
        claudeEvalArgs(scoreOnlyEvalPrompt(trimmedUrl), 'sonnet'),
      )
      // Close immediately — user can watch progress in Activity.
      handleClose()
    } catch (err) {
      console.error('Evaluate failed', err)
      setModalState(valid && duplicate ? 'valid-duplicate' : valid && alreadyQueued ? 'valid-queued' : 'valid-new')
    }
  }

  // ─── Secondary action: add to inbox only ─────────────────────────────────
  const handleAddToInbox = async () => {
    if (!valid || !repoPath || isSubmitting || !!alreadyQueued) return
    setModalState('submitting')
    try {
      await appendToPipeline(trimmedUrl)
      setModalState('inbox-done')
      void refresh()
      // Brief success confirmation, then close.
      setTimeout(handleClose, 900)
    } catch (err) {
      console.error('Add to inbox failed', err)
      setModalState('inbox-error')
    }
  }

  if (!open) return null

  // ─── Derived display values ───────────────────────────────────────────────

  // Hint row below the input — shows context based on current state
  const hintContent = (() => {
    switch (modalState) {
      case 'idle':
        if (clipboardSuggestion) {
          return (
            <button
              onClick={() => {
                setUrl(clipboardSuggestion)
                setClipboardSuggestion(null)
                inputRef.current?.focus()
              }}
              className="text-accent hover:underline flex items-center gap-1 focus:outline-none focus:ring-1 focus:ring-accent/50 rounded"
            >
              <Clipboard size={10} aria-hidden />
              Use clipboard URL
            </button>
          )
        }
        return (
          <span className="text-text-4">
            Paste any Greenhouse / Lever / Ashby / Workday / WTTJ / company-careers URL
          </span>
        )
      case 'typing':
        return (
          <span className="text-warning flex items-center gap-1" role="alert" aria-atomic>
            <AlertTriangle size={11} aria-hidden />
            Not a valid http(s) URL
          </span>
        )
      case 'valid-new':
      case 'valid-duplicate':
      case 'valid-queued':
        return guessedCompany ? (
          <span className="text-text-3">
            Detected · <span className="text-text-1 font-medium">{guessedCompany}</span>
          </span>
        ) : (
          <span className="text-text-3">Valid URL</span>
        )
      case 'submitting':
        return (
          <span className="text-text-4 flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" aria-hidden />
            Working…
          </span>
        )
      case 'inbox-done':
        return (
          <span className="text-success flex items-center gap-1" role="status">
            <CheckCircle2 size={11} aria-hidden />
            Queued in pipeline
          </span>
        )
      case 'inbox-error':
        return (
          <span className="text-danger flex items-center gap-1" role="alert" aria-atomic>
            <AlertTriangle size={11} aria-hidden />
            Failed to write — check console
          </span>
        )
      default:
        return null
    }
  })()

  // Input border style — reflects validation state
  const inputBorderClass = (() => {
    if (modalState === 'typing') return 'border-warning/50 focus-within:border-warning'
    if (modalState === 'valid-new' || modalState === 'valid-duplicate' || modalState === 'valid-queued') return 'border-accent/40 focus-within:border-accent'
    if (modalState === 'submitting') return 'border-border-strong opacity-70'
    return 'border-border-default focus-within:border-border-strong'
  })()

  // "Evaluate" button label + icon
  const evaluateBtnContent = (() => {
    if (modalState === 'submitting') return <><Loader2 size={12} className="animate-spin" aria-hidden />Working…</>
    if (modalState === 'valid-duplicate') return <><Sparkles size={12} aria-hidden />Re-evaluate</>
    return <><Sparkles size={12} aria-hidden />Add &amp; evaluate</>
  })()

  const evaluateBtnEnabled = valid && !isSubmitting

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] transition-opacity duration-[240ms]',
          entering ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
        aria-hidden
      />

      {/* Center-stage dialog */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center px-6 pointer-events-none"
        // Keep the outer wrapper non-interactive so clicks on it reach the backdrop
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          className={cn(
            'pointer-events-auto w-full max-w-[560px] bg-bg-panel border border-border-strong rounded-2xl shadow-cosmos-lift overflow-hidden flex flex-col',
            'transition-[transform,opacity] duration-[240ms] ease-out',
            entering ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          {/* Accent stripe */}
          <div
            className="h-1.5 shrink-0"
            aria-hidden
            style={{ background: 'linear-gradient(90deg, #7C5CFF 0%, #7C5CFF66 60%, transparent 100%)' }}
          />

          {/* Editorial header */}
          <div className="flex items-start gap-4 px-6 pt-5 pb-4 border-b border-border-default">
            <div
              className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center mt-0.5"
              style={{ background: '#7C5CFF1F', border: '1px solid #7C5CFF40' }}
              aria-hidden
            >
              <Plus size={18} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-micro text-text-4 uppercase tracking-[0.08em] mb-0.5" aria-hidden>
                Add Listing
              </div>
              <h2 id={titleId} className="text-section text-text-1 leading-tight tracking-[-0.005em]">
                Evaluate a job you found
              </h2>
              <p id={descId} className="text-label text-text-3 leading-snug mt-1">
                Paste a job posting URL · score it into the Database or queue it for the next filter pass.
              </p>
            </div>
            <button
              onClick={handleClose}
              className="shrink-0 p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors focus:outline-none focus:ring-1 focus:ring-border-strong"
              aria-label="Close (Esc)"
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          {/* Body */}
          <div className="flex flex-col gap-3 px-6 py-5">
            {/* URL input */}
            <div>
              <label
                htmlFor="add-listing-url-input"
                className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-text-4 mb-1.5"
              >
                Job posting URL
              </label>
              <div
                className={cn(
                  'flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-bg-base transition-colors duration-150',
                  inputBorderClass,
                )}
              >
                <Link2
                  size={14}
                  aria-hidden
                  className={cn(
                    'shrink-0 transition-colors duration-150',
                    (modalState === 'valid-new' || modalState === 'valid-duplicate' || modalState === 'valid-queued')
                      ? 'text-accent'
                      : modalState === 'typing'
                        ? 'text-warning'
                        : 'text-text-4',
                  )}
                />
                <input
                  ref={inputRef}
                  id="add-listing-url-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onPaste={e => {
                    // On paste, dismiss the clipboard suggestion (the pasted
                    // value is about to become the input value).
                    if (clipboardSuggestion) setClipboardSuggestion(null)
                    // Let the paste propagate normally
                    void e
                  }}
                  placeholder="https://…"
                  disabled={isSubmitting}
                  aria-invalid={modalState === 'typing' ? 'true' : 'false'}
                  aria-describedby={`${descId} ${statusId}`}
                  className="flex-1 bg-transparent outline-none text-[13.5px] text-text-1 placeholder:text-text-4 font-mono tabular-nums disabled:opacity-50"
                />
                {url && !isSubmitting && (
                  <button
                    onClick={() => { setUrl(''); inputRef.current?.focus() }}
                    className="shrink-0 text-text-4 hover:text-text-2 transition-colors focus:outline-none focus:ring-1 focus:ring-border-default rounded"
                    aria-label="Clear URL"
                    tabIndex={0}
                  >
                    <X size={12} aria-hidden />
                  </button>
                )}
              </div>

              {/* Hint / live state row — aria-live so screen readers announce changes */}
              <div
                id={statusId}
                aria-live="polite"
                aria-atomic="false"
                className="mt-1.5 min-h-[18px] text-[11px] flex items-center gap-1.5"
              >
                {hintContent}
              </div>
            </div>

            {/* State banners — only one shows at a time */}

            {/* Duplicate warning — already scored */}
            {modalState === 'valid-duplicate' && duplicate && (
              <div
                role="status"
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-warning/30 bg-warning/5 text-[11.5px] text-text-2"
              >
                <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" aria-hidden />
                <div className="leading-snug space-y-0.5">
                  <span className="text-text-1 font-medium">Already in the Database</span>
                  <span className="text-text-3"> · {duplicate.company} · {duplicate.role}</span>
                  {duplicate.overall > 0 && (
                    <span className="text-text-3"> · {duplicate.overall.toFixed(1)}/10</span>
                  )}
                  <br />
                  <span className="text-text-4">
                    Evaluated {duplicate.date}. Hitting <span className="font-medium text-text-3">Re-evaluate</span> replaces the score.
                  </span>
                </div>
              </div>
            )}

            {/* Already-queued notice */}
            {modalState === 'valid-queued' && alreadyQueued && (
              <div
                role="status"
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-accent/25 bg-accent/[0.06] text-[11.5px] text-text-2"
              >
                <Inbox size={13} className="text-accent shrink-0 mt-0.5" aria-hidden />
                <div className="leading-snug space-y-0.5">
                  <span className="text-text-1 font-medium">Already in your inbox</span>
                  {alreadyQueued.addedDate && (
                    <span className="text-text-4"> · queued {alreadyQueued.addedDate}</span>
                  )}
                  <br />
                  <span className="text-text-4">
                    Hit <span className="font-medium text-text-3">Add &amp; evaluate</span> to score it now,
                    or the next <span className="font-medium text-text-3">Filter to Database</span> pass will pick it up automatically.
                  </span>
                </div>
              </div>
            )}

            {/* Inbox-only success confirmation */}
            {modalState === 'inbox-done' && (
              <div
                role="status"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-success/30 bg-success/5 text-[11.5px] text-text-2"
              >
                <CheckCircle2 size={13} className="text-success shrink-0" aria-hidden />
                <div className="leading-snug">
                  <span className="text-text-1 font-medium">Added to pipeline inbox.</span>{' '}
                  <span className="text-text-4">
                    The next <span className="font-medium text-text-3">Filter to Database</span> run will pick it up.
                  </span>
                </div>
              </div>
            )}

            {/* Error state */}
            {modalState === 'inbox-error' && (
              <div
                role="alert"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-danger/25 bg-danger/[0.05] text-[11.5px] text-text-2"
              >
                <AlertTriangle size={13} className="text-danger shrink-0" aria-hidden />
                <span className="leading-snug">
                  <span className="text-text-1 font-medium">Write failed.</span>{' '}
                  <span className="text-text-4">Check the Activity panel for details.</span>
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t border-border-default bg-bg-elevated/40">
            {/* Keyboard hint — visible for sighted users, hidden from AT */}
            <span className="mr-auto text-[10.5px] text-text-4 select-none hidden sm:flex items-center gap-1" aria-hidden>
              <kbd className="px-1 py-0.5 rounded bg-bg-elevated border border-border-default text-[9px] font-mono">↵</kbd>
              {' '}evaluate
              <span className="mx-1 opacity-50">·</span>
              <kbd className="px-1 py-0.5 rounded bg-bg-elevated border border-border-default text-[9px] font-mono">Esc</kbd>
              {' '}close
            </span>

            <button
              onClick={handleClose}
              className="px-3 py-1.5 rounded-md text-[12.5px] text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors focus:outline-none focus:ring-1 focus:ring-border-strong"
            >
              Cancel
            </button>

            <button
              onClick={handleAddToInbox}
              disabled={!valid || isSubmitting || !!alreadyQueued}
              title={
                alreadyQueued
                  ? 'This URL is already in your pipeline inbox'
                  : 'Append the URL to data/pipeline.md for the next filter pass (no tokens spent now)'
              }
              aria-label={
                alreadyQueued
                  ? 'Already in inbox'
                  : 'Add to inbox — queue for next filter pass, no tokens'
              }
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] border transition-colors focus:outline-none focus:ring-1 focus:ring-border-strong',
                valid && !isSubmitting && !alreadyQueued
                  ? 'border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong'
                  : 'border-border-default bg-bg-elevated text-text-4 opacity-60 cursor-not-allowed',
              )}
            >
              {alreadyQueued
                ? <><CheckCircle2 size={12} className="text-success" aria-hidden />In inbox</>
                : <><Inbox size={12} aria-hidden />Add to inbox</>
              }
            </button>

            <button
              onClick={handleEvaluate}
              disabled={!evaluateBtnEnabled}
              title={
                !valid
                  ? 'Paste a valid URL first'
                  : 'Score this URL into the Database now (Claude tokens). No prose report — trigger one later from the Database.'
              }
              aria-label={
                modalState === 'valid-duplicate'
                  ? 'Re-evaluate with Claude (replaces previous score)'
                  : 'Add and evaluate with Claude'
              }
              className={cn(
                'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] font-medium border transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-accent/50',
                evaluateBtnEnabled
                  ? 'bg-accent border-accent text-white hover:bg-accent-hover active:bg-accent-press active:scale-[0.98]'
                  : 'bg-accent/30 border-accent/30 text-white/70 cursor-not-allowed',
              )}
            >
              {evaluateBtnContent}
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

async function appendToPipeline(url: string): Promise<{ added: boolean }> {
  const path = 'data/pipeline.md'
  const current = (await ipc.readFile(path)) ?? ''
  let next: string

  // Dedup against existing checklist lines using the same normalization the
  // modal uses for its warnings — a URL pasted with a different tracking tag
  // or a trailing slash must not create a second inbox entry. We match the
  // first non-space token after a `- [ ]` / `- [x]` checkbox (the URL).
  if (current.trim()) {
    const target = normalizeUrl(url)
    const exists = [...current.matchAll(/-\s*\[[ xX]\]\s*(\S+)/g)]
      .some(m => normalizeUrl(m[1]) === target)
    if (exists) return { added: false }
  }

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
  return { added: true }
}

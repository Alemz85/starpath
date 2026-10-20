'use client'

// Global modal — paste a URL → either queue it in the inbox
// (data/pipeline.md) or evaluate it immediately (no prose report;
// just score → score-history.tsv + scouting.md row → Database).
//
// Lives at AppShell level (mounted from any view) and is controlled by
// useAddListingStore so the Scouting CTA + CmdK can both trigger it
// without prop drilling.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  X, Sparkles, Link2, Inbox, AlertTriangle, CheckCircle2, Clipboard,
  Loader2,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore } from '@/store/spawns'
import { useWriteGate } from '@/store/dataRoot'
import { claudeEvalArgsResolved, refreshCvSummary, scoreOnlyEvalPrompt } from '@/lib/evalSpawn'
import { ipc } from '@/lib/ipc'
import { WantEase } from '@/components/shared/WantEase'
import { blockedReason, isBlocked } from '@/lib/scoreBands'
import { Button } from '@/components/ui'
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
  // Demo mode: both actions write data/pipeline.md (and Evaluate spawns).
  const { canWrite, readOnlyTitle } = useWriteGate()

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
    if (!valid || !repoPath || isSubmitting || !canWrite) return
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
        await claudeEvalArgsResolved(scoreOnlyEvalPrompt(trimmedUrl), 'sonnet'),
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
    if (!valid || !repoPath || isSubmitting || !!alreadyQueued || !canWrite) return
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
              type="button"
              onClick={() => {
                setUrl(clipboardSuggestion)
                setClipboardSuggestion(null)
                inputRef.current?.focus()
              }}
              className="text-accent-text hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Clipboard size={12} aria-hidden />
              Use clipboard URL
            </button>
          )
        }
        return (
          <span className="text-text-4">
            Paste any Greenhouse, Lever, Ashby, Workday, WTTJ or company careers URL
          </span>
        )
      case 'typing':
        return (
          <span className="text-warning-text flex items-center gap-1" role="alert" aria-atomic>
            <AlertTriangle size={12} aria-hidden />
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
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Working…
          </span>
        )
      case 'inbox-done':
        return (
          <span className="text-success flex items-center gap-1" role="status">
            <CheckCircle2 size={12} aria-hidden />
            Queued in pipeline
          </span>
        )
      case 'inbox-error':
        return (
          <span className="text-danger flex items-center gap-1" role="alert" aria-atomic>
            <AlertTriangle size={12} aria-hidden />
            Failed to write — check console
          </span>
        )
      default:
        return null
    }
  })()

  // Input border style — reflects validation state
  const inputBorderClass = (() => {
    if (modalState === 'typing') return 'border-warning/60 focus:border-warning focus:ring-warning/20'
    if (modalState === 'valid-new' || modalState === 'valid-duplicate' || modalState === 'valid-queued') return 'border-accent/40 focus:border-accent/60'
    if (modalState === 'submitting') return 'border-border-strong'
    return ''
  })()

  // "Evaluate" button label + icon
  const evaluateBtnContent = (() => {
    if (modalState === 'submitting') return <><Loader2 size={13} className="animate-spin" aria-hidden />Working…</>
    if (modalState === 'valid-duplicate') return <><Sparkles size={13} aria-hidden />Re-evaluate</>
    return <><Sparkles size={13} aria-hidden />Add &amp; evaluate</>
  })()

  const evaluateBtnEnabled = valid && !isSubmitting

  return (
    <>
      {/* Backdrop */}
      <div
        className={clsx(
          'fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-quart',
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
          className={clsx(
            'pointer-events-auto w-full max-w-lg bg-bg-base border border-border-default rounded-xl shadow-lift overflow-hidden flex flex-col',
            'transition-[transform,opacity] duration-200 ease-quart',
            entering ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          {/* Header */}
          <div className="flex items-start gap-3 px-5 pt-5">
            <div className="flex-1 min-w-0">
              <h2 id={titleId} className="text-page text-text-1">
                Add a listing
              </h2>
              <p id={descId} className="text-label text-text-3 mt-1">
                Paste a job posting URL, then score it into the Database or queue it for the next filter pass.
              </p>
            </div>
            <Button
              tone="ghost"
              size="sm"
              iconOnly
              onClick={handleClose}
              aria-label="Close (Esc)"
              className="-mr-1.5 -mt-1"
              icon={<X size={14} aria-hidden />}
            />
          </div>

          {/* Body */}
          <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
            {/* URL input */}
            <div>
              <label htmlFor="add-listing-url-input" className="label block mb-1.5">
                Job posting URL
              </label>
              <div className="relative">
                <Link2
                  size={14}
                  aria-hidden
                  className={clsx(
                    'absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none transition-colors duration-150',
                    (modalState === 'valid-new' || modalState === 'valid-duplicate' || modalState === 'valid-queued')
                      ? 'text-accent'
                      : modalState === 'typing'
                        ? 'text-warning-text'
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
                  className={clsx(
                    'input h-9 pl-8 pr-8 font-mono disabled:opacity-60',
                    inputBorderClass,
                  )}
                />
                {url && !isSubmitting && (
                  <button
                    type="button"
                    onClick={() => { setUrl(''); inputRef.current?.focus() }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                className="mt-1.5 min-h-[18px] text-label flex items-center gap-1.5"
              >
                {hintContent}
              </div>
            </div>

            {/* State banners — only one shows at a time */}

            {/* Duplicate warning — already scored */}
            {modalState === 'valid-duplicate' && duplicate && (
              <div
                role="status"
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-warning/30 bg-warning/5 text-label text-text-2"
              >
                <AlertTriangle size={13} className="text-warning-text shrink-0 mt-0.5" aria-hidden />
                <div className="space-y-0.5">
                  <span className="text-text-1 font-medium">Already in the Database</span>
                  <span className="text-text-3"> · {duplicate.company} · {duplicate.role}</span>
                  {(duplicate.want != null || isBlocked(duplicate)) && (
                    <span className="text-text-3"> · <WantEase want={duplicate.want} ease={duplicate.ease} size="sm" blockedReason={isBlocked(duplicate) ? blockedReason(duplicate) : null} /></span>
                  )}
                  <br />
                  <span className="text-text-3">
                    Evaluated {duplicate.date}. <span className="font-medium text-text-2">Re-evaluate</span> replaces the score.
                  </span>
                </div>
              </div>
            )}

            {/* Already-queued notice */}
            {modalState === 'valid-queued' && alreadyQueued && (
              <div
                role="status"
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-accent/25 bg-accent/[0.06] text-label text-text-2"
              >
                <Inbox size={13} className="text-accent-text shrink-0 mt-0.5" aria-hidden />
                <div className="space-y-0.5">
                  <span className="text-text-1 font-medium">Already in your inbox</span>
                  {alreadyQueued.addedDate && (
                    <span className="text-text-3"> · queued {alreadyQueued.addedDate}</span>
                  )}
                  <br />
                  <span className="text-text-3">
                    <span className="font-medium text-text-2">Add &amp; evaluate</span> scores it now,
                    or the next <span className="font-medium text-text-2">Filter to Database</span> pass picks it up automatically.
                  </span>
                </div>
              </div>
            )}

            {/* Inbox-only success confirmation */}
            {modalState === 'inbox-done' && (
              <div
                role="status"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-success/30 bg-success/5 text-label text-text-2"
              >
                <CheckCircle2 size={13} className="text-success shrink-0" aria-hidden />
                <div>
                  <span className="text-text-1 font-medium">Added to pipeline inbox.</span>{' '}
                  <span className="text-text-3">
                    The next <span className="font-medium text-text-2">Filter to Database</span> run will pick it up.
                  </span>
                </div>
              </div>
            )}

            {/* Error state */}
            {modalState === 'inbox-error' && (
              <div
                role="alert"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-danger/25 bg-danger/5 text-label text-text-2"
              >
                <AlertTriangle size={13} className="text-danger shrink-0" aria-hidden />
                <span>
                  <span className="text-text-1 font-medium">Write failed.</span>{' '}
                  <span className="text-text-3">Check the Activity panel for details.</span>
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-default bg-bg-elevated">
            {/* Keyboard hint — visible for sighted users, hidden from AT */}
            <span className="mr-auto text-label text-text-4 select-none hidden sm:flex items-center gap-1" aria-hidden>
              <kbd className="kbd">↵</kbd>
              {' '}evaluate
              <span className="mx-1 text-border-strong">·</span>
              <kbd className="kbd">Esc</kbd>
              {' '}close
            </span>

            <Button tone="ghost" onClick={handleClose}>
              Cancel
            </Button>

            <Button
              tone="secondary"
              onClick={handleAddToInbox}
              disabled={!valid || isSubmitting || !!alreadyQueued || !canWrite}
              title={readOnlyTitle ?? (
                alreadyQueued
                  ? 'This URL is already in your pipeline inbox'
                  : 'Append the URL to data/pipeline.md for the next filter pass (no tokens spent now)'
              )}
              aria-label={
                alreadyQueued
                  ? 'Already in inbox'
                  : 'Add to inbox — queue for next filter pass, no tokens'
              }
              icon={alreadyQueued
                ? <CheckCircle2 size={13} className="text-success" aria-hidden />
                : <Inbox size={13} aria-hidden />}
            >
              {alreadyQueued ? 'In inbox' : 'Add to inbox'}
            </Button>

            <Button
              tone="primary"
              onClick={handleEvaluate}
              disabled={!evaluateBtnEnabled || !canWrite}
              title={readOnlyTitle ?? (
                !valid
                  ? 'Paste a valid URL first'
                  : 'Score this URL into the Database now (Claude tokens). No prose report — trigger one later from the Database.'
              )}
              aria-label={
                modalState === 'valid-duplicate'
                  ? 'Re-evaluate with Claude (replaces previous score)'
                  : 'Add and evaluate with Claude'
              }
            >
              {evaluateBtnContent}
            </Button>
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

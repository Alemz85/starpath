// Chat write-proposals — the validator for the ```starpath:apply /
// ```starpath:status block bodies the chat agent emits (contract in
// `modes/chat.md` § Proposals and § Cards). Finding the fences in a reply and
// the streaming states live in `./blocks`, which calls `validateProposal` for
// these two tags.
//
// Everything parsed here is MODEL OUTPUT, i.e. untrusted input, and its
// destination is `data/applications.md` — a naive pipe-delimited markdown table
// that the merge scripts, the SQLite sync, and the user's own text editor all
// read. So every field is strictly shape/type/format checked rather than
// trusted to have followed the prompt, and any violation degrades the block to
// a plain code fence. Never a half-card, never a crash, never a partial write.
//
// This module is NOT the write authority. Confirm routes through
// `lib/applicationsDoc.ts` — the same mutators the Apply button and the status
// dropdown use — so the tracker's real invariants (one row per company+role,
// refresh-in-place, the 9→10 column self-heal) live in exactly one place. What
// this file guards is the boundary: a well-formed request with cells that can't
// corrupt the table.
//
// Dependency rule (inherited from `./types`): `tsconfig.electron.json` compiles
// `src/lib/chat/**/*` into the CommonJS main bundle, where the `@/*` alias does
// not exist at runtime. Type-only imports are erased at emit and are therefore
// fine (`electron/chat.ts` imports `ModelAlias` the same way); a VALUE import of
// `@/types` or `@/lib/applicationsDoc` would emit an unresolvable `require`.
// Keep this module pure and alias-free at runtime.

import type { AppStatus } from '@/types'
import { assignVerdict, formatScoreCell } from '../scoreBands'

/** Fence info-strings that carry a proposal. Anything else is a normal fence. */
export const PROPOSAL_FENCE_TAGS = ['starpath:apply', 'starpath:status'] as const
export type ProposalFenceTag = (typeof PROPOSAL_FENCE_TAGS)[number]

// Canonical statuses (`templates/states.yml`). No frontend lib exports this as
// a runtime list — `@/types` has `STATUS_COLORS` (unusable here, see the
// dependency rule above) and `ApplyAction.tsx` keeps a component-local copy —
// so it is declared here as a `Record<AppStatus, true>`: adding a member to
// `AppStatus` without listing it makes THIS FILE fail to compile, which is the
// single-sourcing the runtime import can't provide.
const CANONICAL_STATUS: Record<AppStatus, true> = {
  Evaluated: true,
  Applied: true,
  Responded: true,
  Interview: true,
  Offer: true,
  Rejected: true,
  Discarded: true,
  SKIP: true,
}

export const CANONICAL_STATUSES = Object.keys(CANONICAL_STATUS) as AppStatus[]

export function isCanonicalStatus(value: unknown): value is AppStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CANONICAL_STATUS, value)
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

/** Add or refresh a row in `data/applications.md`. */
export interface ApplyProposal {
  kind: 'apply'
  company: string
  role: string
  /** Canonical v2 Score cell `W8.3 E5.6` (docs/scoring-v2.md §8.3), absent
   *  when no score was given. */
  score?: string
  /** Numeric Want / Ease of `score`, for `upsertApplicationRow`. */
  want?: number
  ease?: number
  status?: AppStatus
  deadline?: string
  url?: string
  notes?: string
}

/** Rewrite the Status cell of an existing row. */
export interface StatusProposal {
  kind: 'status'
  company: string
  role: string
  status: AppStatus
  /** When it happened (`YYYY-MM-DD`), for a change the user reports late;
   *  the status log rejects a future date. Absent = today. */
  date?: string
  /** Where it happened (a rejection's stage, say), free text. */
  stage?: string
}

export type ChatProposal = ApplyProposal | StatusProposal

// Caps. Generous enough for any real listing, tight enough that a runaway
// generation can't push a megabyte into the user's tracker.
export const MAX_FIELD_CHARS = 200
export const MAX_NOTES_CHARS = 500
export const MAX_URL_CHARS = 2000

// v2 Score cell (docs/scoring-v2.md §8.3): `W8.3 E5.6` — Want then Ease,
// one decimal optional. The v1 `X.X/10` form is NOT accepted for a write:
// new applications.md rows always carry the W/E form.
const SCORE_RE = /^W\s*(\d{1,2}(?:\.\d{1,2})?)\s+E\s*(\d{1,2}(?:\.\d{1,2})?)$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HTTP_URL_RE = /^https?:\/\/[^\s|]+$/i

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A cell that cannot corrupt `data/applications.md`. The tracker is split on
 * `|` by every reader in the system (the frontend parser, `merge-tracker.mjs`,
 * the SQLite sync), and none of them honour markdown's `\|` escape — so a pipe
 * anywhere in a value silently shifts every later column. Newlines and other
 * control characters would break the one-row-per-line invariant outright.
 * Rejecting is the only safe answer; silently rewriting the user's data to fit
 * would be worse than showing the raw block.
 */
function isSafeCell(value: string): boolean {
  return !/[|\r\n]/.test(value) && !/[\u0000-\u001F\u007F]/.test(value)
}

export type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export function requiredText(raw: unknown, field: string): FieldResult<string> {
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: false, reason: `${field} cannot be empty` }
  if (value.length > MAX_FIELD_CHARS) {
    return { ok: false, reason: `${field} exceeds ${MAX_FIELD_CHARS} characters` }
  }
  if (!isSafeCell(value)) return { ok: false, reason: `${field} cannot contain "|" or line breaks` }
  return { ok: true, value }
}

export function optionalText(raw: unknown, field: string, max: number): FieldResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: true, value: undefined }
  if (value.length > max) return { ok: false, reason: `${field} exceeds ${max} characters` }
  if (!isSafeCell(value)) return { ok: false, reason: `${field} cannot contain "|" or line breaks` }
  return { ok: true, value }
}

/** `W8.3 E5.6` (the tracker's v2 Score format), each 1–10 inclusive. */
function parseScore(raw: unknown): FieldResult<{ score: string; want: number; ease: number } | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: 'score must be a string like "W8.3 E5.6"' }
  const match = raw.trim().match(SCORE_RE)
  if (!match) return { ok: false, reason: 'score must look like "W8.3 E5.6" (Want, then Ease)' }
  const want = Number(match[1])
  const ease = Number(match[2])
  const inRange = (n: number) => Number.isFinite(n) && n >= 1 && n <= 10
  if (!inRange(want) || !inRange(ease)) {
    return { ok: false, reason: 'Want and Ease must each be between 1 and 10' }
  }
  return { ok: true, value: { score: formatScoreCell(want, ease), want, ease } }
}

/** `YYYY-MM-DD` (a real calendar date), `Rolling`, or `n/d`. */
function parseDeadline(raw: unknown): FieldResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: 'deadline must be a string' }
  const value = raw.trim()
  if (value === 'Rolling' || value === 'n/d') return { ok: true, value }
  if (!ISO_DATE_RE.test(value)) {
    return { ok: false, reason: 'deadline must be YYYY-MM-DD, "Rolling", or "n/d"' }
  }
  if (!isRealDate(value)) return { ok: false, reason: 'deadline is not a real calendar date' }
  return { ok: true, value }
}

// Reject 2026-13-40: Date round-trips a real date back to the same string.
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** A status change's `date`: `YYYY-MM-DD`, a real date (the log refuses future ones). */
function parseEventDate(raw: unknown): FieldResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: 'date must be a string' }
  const value = raw.trim()
  if (!ISO_DATE_RE.test(value)) return { ok: false, reason: 'date must be YYYY-MM-DD' }
  if (!isRealDate(value)) return { ok: false, reason: 'date is not a real calendar date' }
  return { ok: true, value }
}

function parseUrl(raw: unknown): FieldResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: 'url must be a string' }
  const value = raw.trim()
  if (value.length > MAX_URL_CHARS) return { ok: false, reason: 'url is too long' }
  // http(s) only — the card renders it as an openExternal target, and a
  // `javascript:` or `file:` scheme has no business reaching that call.
  if (!HTTP_URL_RE.test(value)) return { ok: false, reason: 'url must be an http(s) address' }
  return { ok: true, value }
}

function parseStatus(raw: unknown, required: boolean): FieldResult<AppStatus | undefined> {
  if (raw === undefined || raw === null || raw === '') {
    return required
      ? { ok: false, reason: 'status is required' }
      : { ok: true, value: undefined }
  }
  if (!isCanonicalStatus(raw)) {
    return { ok: false, reason: `status must be one of ${CANONICAL_STATUSES.join(', ')}` }
  }
  return { ok: true, value: raw }
}

// ─── Payload validation ───────────────────────────────────────────────────────

/**
 * Validate one proposal body. Unknown extra keys are ignored rather than
 * rejected, so a future field added to the contract downgrades to "not applied"
 * instead of breaking every card an older build renders.
 */
export function validateProposal(
  tag: ProposalFenceTag,
  json: unknown,
): { ok: true; proposal: ChatProposal } | { ok: false; reason: string } {
  if (!isRecord(json)) return { ok: false, reason: 'body must be a JSON object' }

  const company = requiredText(json.company, 'company')
  if (!company.ok) return { ok: false, reason: company.reason }
  const role = requiredText(json.role, 'role')
  if (!role.ok) return { ok: false, reason: role.reason }

  if (tag === 'starpath:status') {
    const status = parseStatus(json.status, true)
    if (!status.ok) return { ok: false, reason: status.reason }
    const date = parseEventDate(json.date)
    if (!date.ok) return { ok: false, reason: date.reason }
    const stage = optionalText(json.stage, 'stage', MAX_FIELD_CHARS)
    if (!stage.ok) return { ok: false, reason: stage.reason }
    const proposal: StatusProposal = { kind: 'status', company: company.value, role: role.value, status: status.value! }
    if (date.value) proposal.date = date.value
    if (stage.value) proposal.stage = stage.value
    return { ok: true, proposal }
  }

  const status = parseStatus(json.status, false)
  if (!status.ok) return { ok: false, reason: status.reason }
  const score = parseScore(json.score)
  if (!score.ok) return { ok: false, reason: score.reason }
  const deadline = parseDeadline(json.deadline)
  if (!deadline.ok) return { ok: false, reason: deadline.reason }
  const url = parseUrl(json.url)
  if (!url.ok) return { ok: false, reason: url.reason }
  const notes = optionalText(json.notes, 'notes', MAX_NOTES_CHARS)
  if (!notes.ok) return { ok: false, reason: notes.reason }

  const proposal: ApplyProposal = { kind: 'apply', company: company.value, role: role.value }
  if (score.value) {
    proposal.score = score.value.score
    proposal.want = score.value.want
    proposal.ease = score.value.ease
  }
  if (status.value) proposal.status = status.value
  if (deadline.value) proposal.deadline = deadline.value
  if (url.value) proposal.url = url.value
  if (notes.value) proposal.notes = notes.value
  return { ok: true, proposal }
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** Storage tier from the Want × Ease verdict grid (docs/scoring-v2.md §4) —
 *  the same replay `electron/db/sync.ts` › deriveAppTier uses for a W/E cell.
 *  Only used to pick the `reports/tier-N/` folder in the placeholder report
 *  link that `upsertApplicationRow` writes for a brand-new row. */
export function tierForProposal(proposal: ApplyProposal): string {
  if (proposal.status === 'SKIP') return 'T4'
  return assignVerdict({ want: proposal.want, ease: proposal.ease })?.tier ?? 'T4'
}

export interface ProposalSummary {
  /** Card heading — what kind of write this is. */
  kindLabel: string
  /** "Company — Role". */
  subject: string
  /** The cells that would change, in tracker column order. */
  changes: Array<{ label: string; value: string }>
  /** Past-tense confirmation once applied. */
  appliedLabel: string
}

/** Everything the card renders, derived in one pure place so the component
 *  stays a dumb view and the wording is unit-testable. */
export function describeProposal(proposal: ChatProposal): ProposalSummary {
  const subject = `${proposal.company} — ${proposal.role}`
  if (proposal.kind === 'status') {
    return {
      kindLabel: 'Status change',
      subject,
      changes: [
        { label: 'Status', value: proposal.status },
        ...(proposal.date ? [{ label: 'Date', value: proposal.date }] : []),
        ...(proposal.stage ? [{ label: 'Stage', value: proposal.stage }] : []),
      ],
      appliedLabel: `Status set to ${proposal.status}`,
    }
  }

  const changes: Array<{ label: string; value: string }> = []
  if (proposal.score) changes.push({ label: 'Score', value: proposal.score })
  changes.push({ label: 'Status', value: proposal.status ?? 'Evaluated' })
  if (proposal.deadline) changes.push({ label: 'Deadline', value: proposal.deadline })
  if (proposal.notes) changes.push({ label: 'Notes', value: proposal.notes })
  return {
    kindLabel: 'Add to applications',
    subject,
    changes,
    appliedLabel: 'Added to applications',
  }
}

/**
 * One line saying what the user did with a card, in the agent's terms. Stored
 * as the decision's `detail` and replayed to the agent on the next turn
 * (`./digest`), so it reads as a fact about the tracker, not as UI copy.
 */
export function describeDecision(proposal: ChatProposal, outcome: 'applied' | 'dismissed'): string {
  const subject = `${proposal.company} — ${proposal.role}`
  if (proposal.kind === 'status') {
    const when = [proposal.date, proposal.stage].filter(Boolean).join(', ')
    return outcome === 'applied'
      ? `moved ${subject} to ${proposal.status}${when ? ` (${when})` : ''}`
      : `dismissed moving ${subject} to ${proposal.status}`
  }
  return outcome === 'applied'
    ? `added ${subject} to applications${proposal.status ? ` as ${proposal.status}` : ''}`
    : `dismissed adding ${subject} to applications`
}

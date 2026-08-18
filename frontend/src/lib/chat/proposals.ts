// Chat write-proposals — the parser + validator for the ```starpath:apply /
// ```starpath:status fences the chat agent emits (contract in `modes/chat.md`
// § Proposals).
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
  /** Verbatim `X.X/10` as proposed, absent when no score was given. */
  score?: string
  /** Numeric form of `score`, for `upsertApplicationRow`'s `overall`. */
  scoreValue?: number
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
}

export type ChatProposal = ApplyProposal | StatusProposal

/**
 * One `starpath:` fence, identified by `id` so a Confirm/Dismiss decision can
 * be persisted against it. `invalid` carries the human-readable reason and is
 * rendered as a plain code block, never as a card.
 */
export type ChatProposalBlock =
  | { status: 'valid'; id: string; index: number; source: string; proposal: ChatProposal }
  | { status: 'invalid'; id: string; index: number; source: string; reason: string }

/**
 * An assistant turn split for rendering: prose runs through the markdown
 * renderer, valid proposals render as cards. Invalid proposals are folded back
 * into the surrounding markdown verbatim, so a malformed fence looks exactly
 * like the code block it would have been before this feature existed.
 */
export type ChatContentSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'proposal'; id: string; index: number; proposal: ChatProposal }

// Caps. Generous enough for any real listing, tight enough that a runaway
// generation can't push a megabyte into the user's tracker.
export const MAX_FIELD_CHARS = 200
export const MAX_NOTES_CHARS = 500
export const MAX_URL_CHARS = 2000
export const MAX_PROPOSALS_PER_MESSAGE = 20

const SCORE_RE = /^(\d{1,2}(?:\.\d)?)\/10$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HTTP_URL_RE = /^https?:\/\/[^\s|]+$/i

function isRecord(value: unknown): value is Record<string, unknown> {
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

type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function requiredText(raw: unknown, field: string): FieldResult<string> {
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: false, reason: `${field} cannot be empty` }
  if (value.length > MAX_FIELD_CHARS) {
    return { ok: false, reason: `${field} exceeds ${MAX_FIELD_CHARS} characters` }
  }
  if (!isSafeCell(value)) return { ok: false, reason: `${field} cannot contain "|" or line breaks` }
  return { ok: true, value }
}

function optionalText(raw: unknown, field: string, max: number): FieldResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: true, value: undefined }
  if (value.length > max) return { ok: false, reason: `${field} exceeds ${max} characters` }
  if (!isSafeCell(value)) return { ok: false, reason: `${field} cannot contain "|" or line breaks` }
  return { ok: true, value }
}

/** `X.X/10` (the tracker's Score format), 0–10 inclusive. */
function parseScore(raw: unknown): FieldResult<{ score: string; value: number } | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  const text = typeof raw === 'number' ? `${raw.toFixed(1)}/10` : raw
  if (typeof text !== 'string') return { ok: false, reason: 'score must be a string like "7.8/10"' }
  const match = text.trim().match(SCORE_RE)
  if (!match) return { ok: false, reason: 'score must look like "7.8/10"' }
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    return { ok: false, reason: 'score must be between 0 and 10' }
  }
  return { ok: true, value: { score: `${value.toFixed(1)}/10`, value } }
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
  // Reject 2026-13-40: Date round-trips a real date back to the same string.
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return { ok: false, reason: 'deadline is not a real calendar date' }
  }
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
    return {
      ok: true,
      proposal: { kind: 'status', company: company.value, role: role.value, status: status.value! },
    }
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
    proposal.scoreValue = score.value.value
  }
  if (status.value) proposal.status = status.value
  if (deadline.value) proposal.deadline = deadline.value
  if (url.value) proposal.url = url.value
  if (notes.value) proposal.notes = notes.value
  return { ok: true, proposal }
}

// ─── Fence scanning ───────────────────────────────────────────────────────────

type ScanPart =
  | { kind: 'text'; text: string }
  | { kind: 'fence'; tag: string; body: string; source: string; closed: boolean }

const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/

function isProposalTag(tag: string): tag is ProposalFenceTag {
  return (PROPOSAL_FENCE_TAGS as readonly string[]).includes(tag)
}

/**
 * Split markdown into text runs and TOP-LEVEL fenced blocks.
 *
 * Top-level matters: a fence nested inside another fence (an agent showing the
 * contract inside a ```markdown example, say) is part of that outer block's
 * body and must not be mistaken for a real proposal. Walking fences in order
 * and skipping an unrecognised block wholesale to its close is what makes that
 * true — a regex sweep for ```starpath: would happily match the example.
 */
function scanFences(text: string): ScanPart[] {
  const lines = text.split('\n')
  const parts: ScanPart[] = []
  let pending: string[] = []

  const flushText = (): void => {
    if (pending.length === 0) return
    parts.push({ kind: 'text', text: pending.join('\n') })
    pending = []
  }

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN_RE)
    if (!open) {
      pending.push(lines[i])
      continue
    }

    const [, , delimiter, tag] = open
    const marker = delimiter[0]
    const body: string[] = []
    let closed = false
    let j = i + 1
    for (; j < lines.length; j++) {
      const close = lines[j].match(/^\s{0,3}(`{3,}|~{3,})\s*$/)
      // A closing fence uses the same character and is at least as long.
      if (close && close[1][0] === marker && close[1].length >= delimiter.length) {
        closed = true
        break
      }
      body.push(lines[j])
    }

    const source = lines.slice(i, closed ? j + 1 : lines.length).join('\n')
    flushText()
    parts.push({ kind: 'fence', tag, body: body.join('\n'), source, closed })
    i = closed ? j : lines.length
  }

  flushText()
  return parts
}

function blockId(messageId: string, index: number): string {
  return `${messageId}#p${index}`
}

/**
 * Every `starpath:` fence in an assistant turn, valid or not, in document
 * order. Exposed for inspection and tests; the renderer uses
 * `splitChatContent`, which shares this scan so the ids agree.
 */
export function parseProposalBlocks(text: string, messageId: string): ChatProposalBlock[] {
  const blocks: ChatProposalBlock[] = []
  let index = 0
  for (const part of scanFences(text)) {
    if (part.kind !== 'fence' || !isProposalTag(part.tag)) continue
    const id = blockId(messageId, index)
    const current = index++
    if (!part.closed) {
      blocks.push({ status: 'invalid', id, index: current, source: part.source, reason: 'the block was cut off' })
      continue
    }
    if (current >= MAX_PROPOSALS_PER_MESSAGE) {
      blocks.push({
        status: 'invalid', id, index: current, source: part.source,
        reason: `more than ${MAX_PROPOSALS_PER_MESSAGE} proposals in one message`,
      })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(part.body)
    } catch {
      blocks.push({ status: 'invalid', id, index: current, source: part.source, reason: 'the body is not valid JSON' })
      continue
    }
    const validated = validateProposal(part.tag, json)
    blocks.push(validated.ok
      ? { status: 'valid', id, index: current, source: part.source, proposal: validated.proposal }
      : { status: 'invalid', id, index: current, source: part.source, reason: validated.reason })
  }
  return blocks
}

/**
 * Split an assistant turn into renderable segments.
 *
 * `streaming` says whether the turn is still being written. A proposal fence
 * that hasn't closed yet is mid-stream, not malformed, so while streaming it is
 * omitted entirely and the card appears when the fence closes — better than
 * flashing half a JSON body or a placeholder that says nothing. Once the turn
 * is final (completed, interrupted, failed) an unclosed fence is shown as the
 * raw text it is: the reply really was cut off there.
 */
export function splitChatContent(
  text: string,
  messageId: string,
  streaming = false,
): ChatContentSegment[] {
  const segments: ChatContentSegment[] = []
  let index = 0
  let pending: string[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    const joined = pending.join('\n')
    pending = []
    if (joined.trim()) segments.push({ kind: 'markdown', text: joined })
  }

  for (const part of scanFences(text)) {
    if (part.kind === 'text') {
      pending.push(part.text)
      continue
    }
    if (!isProposalTag(part.tag)) {
      pending.push(part.source)
      continue
    }

    const id = blockId(messageId, index)
    const current = index++

    if (!part.closed) {
      // Mid-stream: drop it. Final: it's genuinely truncated — show the text.
      if (!streaming) pending.push(part.source)
      continue
    }

    let proposal: ChatProposal | null = null
    if (current < MAX_PROPOSALS_PER_MESSAGE) {
      try {
        const validated = validateProposal(part.tag, JSON.parse(part.body))
        if (validated.ok) proposal = validated.proposal
      } catch {
        proposal = null
      }
    }

    // Anything that didn't validate falls back to the fence verbatim, which the
    // markdown renderer draws as an ordinary code block.
    if (!proposal) {
      pending.push(part.source)
      continue
    }
    flush()
    segments.push({ kind: 'proposal', id, index: current, proposal })
  }

  flush()
  return segments
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** Tier bands, mirroring `electron/db/sync.ts` › deriveTier. Only used to pick
 *  the `reports/tier-N/` folder in the placeholder report link that
 *  `upsertApplicationRow` writes for a brand-new row. */
export function tierForProposal(proposal: ApplyProposal): string {
  if (proposal.status === 'SKIP') return 'T4'
  const score = proposal.scoreValue
  if (score === undefined) return 'T4'
  if (score >= 9.0) return 'T1'
  if (score >= 7.0) return 'T2'
  return 'T3'
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
      changes: [{ label: 'Status', value: proposal.status }],
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

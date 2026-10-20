// Chat cards — the parser for every ```starpath:… fence the chat agent emits
// (contract in `modes/chat.md` § Cards and § Proposals).
//
// Two kinds of block:
//   - REFERENCE blocks (`application`, `listing`, `report`, `company`,
//     `deadlines`, `top`) carry only a key — company + role, a company, a day
//     window, a list name. The card reads the live data from the app's store,
//     so it can't drift from the trackers and the model can't put numbers in
//     the user's mouth.
//   - PROPOSAL blocks (`apply`, `status`) carry the change to apply; the body
//     is validated by `./proposals` and the card applies it on Confirm.
//
// Everything parsed here is MODEL OUTPUT, i.e. untrusted input: every field is
// type-, length- and range-checked, and a block that fails degrades to the
// plain code fence it would have been without this feature. Never a half-card,
// never a throw.
//
// Streaming: `parseChatBlock` answers ok | pending | invalid | not-a-block.
// A block that doesn't parse while the reply is still being written is
// `pending` (a "Preparing…" skeleton), not invalid — its closing fence or the
// rest of its JSON may simply not have arrived yet. Once the reply is final,
// the same block is `invalid` and shows as code.
//
// Block ids are `${messageId}#p${n}`, n counting every recognised starpath
// fence in the message. Replies written before reference cards existed only
// contain apply/status fences, so their ids — and the Confirm/Dismiss
// decisions saved against them — are unchanged.
//
// Pure and alias-free at runtime (see the dependency rule in `./proposals`).

import type { AppStatus } from '@/types'
import {
  PROPOSAL_FENCE_TAGS, isRecord, optionalText, requiredText, validateProposal,
  type ApplyProposal, type ProposalFenceTag, type StatusProposal,
} from './proposals'

/** Fence info-strings that render as cards. Anything else is a normal fence. */
export const REFERENCE_FENCE_TAGS = [
  'starpath:application',
  'starpath:listing',
  'starpath:report',
  'starpath:company',
  'starpath:deadlines',
  'starpath:top',
] as const

export const CHAT_BLOCK_TAGS = [...PROPOSAL_FENCE_TAGS, ...REFERENCE_FENCE_TAGS] as const
export type ChatBlockTag = (typeof CHAT_BLOCK_TAGS)[number]

export function isChatBlockTag(tag: string): tag is ChatBlockTag {
  return (CHAT_BLOCK_TAGS as readonly string[]).includes(tag)
}

export const TOP_LISTS = ['companies', 'locations', 'archetypes'] as const
export type TopListKind = (typeof TOP_LISTS)[number]

export const DEADLINE_DAYS_MIN = 1
export const DEADLINE_DAYS_MAX = 90
export const DEADLINE_DAYS_DEFAULT = 14
export const TOP_LIMIT_MIN = 3
export const TOP_LIMIT_MAX = 10
export const TOP_LIMIT_DEFAULT = 5
export const MAX_LABEL_CHARS = 120
/** Cards per message, proposals and references together. */
export const MAX_BLOCKS_PER_MESSAGE = 20
/** Kept for callers that predate reference cards. */
export const MAX_PROPOSALS_PER_MESSAGE = MAX_BLOCKS_PER_MESSAGE

// ─── Shapes ───────────────────────────────────────────────────────────────────

/** A listing or application, keyed the way every tracker keys it. */
export interface ListingRef {
  company: string
  role: string
  /** Optional caption above the card. */
  label?: string
}

export type ChatBlock =
  | { kind: 'apply'; proposal: ApplyProposal }
  | { kind: 'status'; proposal: StatusProposal }
  | ({ kind: 'application' } & ListingRef)
  | ({ kind: 'listing' } & ListingRef)
  | ({ kind: 'report' } & ListingRef)
  | { kind: 'company'; company: string; label?: string }
  | { kind: 'deadlines'; days: number; label?: string }
  | { kind: 'top'; list: TopListKind; limit: number; label?: string }

export type ChatBlockKind = ChatBlock['kind']

/** Blocks that carry a write and so take a Confirm/Dismiss decision. */
export type ProposalBlock = Extract<ChatBlock, { kind: 'apply' | 'status' }>

export function isProposalBlock(block: ChatBlock): block is ProposalBlock {
  return block.kind === 'apply' || block.kind === 'status'
}

export type ParseChatBlockResult =
  | { status: 'ok'; block: ChatBlock }
  | { status: 'pending' }
  | { status: 'invalid'; reason: string }
  | { status: 'not-a-block' }

// ─── Field readers ────────────────────────────────────────────────────────────

type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

function readLabel(raw: unknown): Read<string | undefined> {
  return optionalText(raw, 'label', MAX_LABEL_CHARS)
}

/** An optional whole number, clamped into [min, max]; absent → fallback. */
function readClampedInt(raw: unknown, field: string, min: number, max: number, fallback: number): Read<number> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, reason: `${field} must be a whole number` }
  }
  return { ok: true, value: Math.min(max, Math.max(min, raw)) }
}

function readListingRef(json: Record<string, unknown>): Read<ListingRef> {
  const company = requiredText(json.company, 'company')
  if (!company.ok) return company
  const role = requiredText(json.role, 'role')
  if (!role.ok) return role
  const label = readLabel(json.label)
  if (!label.ok) return label
  const ref: ListingRef = { company: company.value, role: role.value }
  if (label.value) ref.label = label.value
  return { ok: true, value: ref }
}

// ─── Per-tag validation ───────────────────────────────────────────────────────

function isProposalTag(tag: ChatBlockTag): tag is ProposalFenceTag {
  return (PROPOSAL_FENCE_TAGS as readonly string[]).includes(tag)
}

/** Validate one block body. Unknown extra keys are ignored, so a field added
 *  to the contract later degrades to "not shown" on an older build. */
export function validateBlock(tag: ChatBlockTag, json: unknown): Read<ChatBlock> {
  if (isProposalTag(tag)) {
    const validated = validateProposal(tag, json)
    if (!validated.ok) return validated
    const proposal = validated.proposal
    return {
      ok: true,
      value: proposal.kind === 'apply' ? { kind: 'apply', proposal } : { kind: 'status', proposal },
    }
  }
  if (!isRecord(json)) return { ok: false, reason: 'body must be a JSON object' }

  switch (tag) {
    case 'starpath:application':
    case 'starpath:listing':
    case 'starpath:report': {
      const ref = readListingRef(json)
      if (!ref.ok) return ref
      const kind = tag === 'starpath:application' ? 'application' : tag === 'starpath:listing' ? 'listing' : 'report'
      return { ok: true, value: { kind, ...ref.value } }
    }
    case 'starpath:company': {
      const company = requiredText(json.company, 'company')
      if (!company.ok) return company
      const label = readLabel(json.label)
      if (!label.ok) return label
      return { ok: true, value: { kind: 'company', company: company.value, ...(label.value ? { label: label.value } : {}) } }
    }
    case 'starpath:deadlines': {
      const days = readClampedInt(json.days, 'days', DEADLINE_DAYS_MIN, DEADLINE_DAYS_MAX, DEADLINE_DAYS_DEFAULT)
      if (!days.ok) return days
      const label = readLabel(json.label)
      if (!label.ok) return label
      return { ok: true, value: { kind: 'deadlines', days: days.value, ...(label.value ? { label: label.value } : {}) } }
    }
    case 'starpath:top': {
      const list = json.list
      if (typeof list !== 'string' || !(TOP_LISTS as readonly string[]).includes(list)) {
        return { ok: false, reason: `list must be one of ${TOP_LISTS.join(', ')}` }
      }
      const limit = readClampedInt(json.limit, 'limit', TOP_LIMIT_MIN, TOP_LIMIT_MAX, TOP_LIMIT_DEFAULT)
      if (!limit.ok) return limit
      const label = readLabel(json.label)
      if (!label.ok) return label
      return {
        ok: true,
        value: { kind: 'top', list: list as TopListKind, limit: limit.value, ...(label.value ? { label: label.value } : {}) },
      }
    }
    default: {
      const exhaustive: never = tag
      return { ok: false, reason: `unknown block ${String(exhaustive)}` }
    }
  }
}

/**
 * Parse one fence's (info-string, body). `streaming` says whether the reply is
 * still being written: then a body that doesn't parse or validate is probably
 * incomplete, and the answer is `pending` rather than `invalid`.
 */
export function parseChatBlock(tag: string, body: string, streaming: boolean): ParseChatBlockResult {
  if (!isChatBlockTag(tag)) return { status: 'not-a-block' }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return streaming ? { status: 'pending' } : { status: 'invalid', reason: 'the body is not valid JSON' }
  }
  const validated = validateBlock(tag, json)
  if (validated.ok) return { status: 'ok', block: validated.value }
  return streaming ? { status: 'pending' } : { status: 'invalid', reason: validated.reason }
}

// ─── Fence scanning ───────────────────────────────────────────────────────────

type ScanPart =
  | { kind: 'text'; text: string }
  | { kind: 'fence'; tag: string; body: string; source: string; closed: boolean }

const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/

/**
 * Split markdown into text runs and TOP-LEVEL fenced blocks.
 *
 * Top-level matters: a fence nested inside another fence (an agent showing the
 * contract inside a ```markdown example, say) is part of that outer block's
 * body and must not be mistaken for a real card. Walking fences in order and
 * skipping an unrecognised block wholesale to its close is what makes that
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

export function blockId(messageId: string, index: number): string {
  return `${messageId}#p${index}`
}

/** One recognised fence and what became of it, for inspection and tests. */
export type ParsedChatBlock =
  | { status: 'valid'; id: string; index: number; source: string; block: ChatBlock }
  | { status: 'invalid'; id: string; index: number; source: string; reason: string }

/** Parse each recognised fence of a turn, in document order. */
function walkBlocks(
  text: string,
  messageId: string,
  streaming: boolean,
  visit: (part: ScanPart, block: { id: string; index: number; result: ParseChatBlockResult } | null) => void,
): void {
  const parts = scanFences(text)
  let index = 0
  parts.forEach((part, partIndex) => {
    if (part.kind !== 'fence' || !isChatBlockTag(part.tag)) {
      visit(part, null)
      return
    }
    const current = index++
    const id = blockId(messageId, current)
    // Only the reply's last part can still be growing.
    const growing = streaming && partIndex === parts.length - 1
    let result: ParseChatBlockResult
    if (!part.closed) {
      result = growing ? { status: 'pending' } : { status: 'invalid', reason: 'the block was cut off' }
    } else if (current >= MAX_BLOCKS_PER_MESSAGE) {
      result = { status: 'invalid', reason: `more than ${MAX_BLOCKS_PER_MESSAGE} cards in one message` }
    } else {
      result = parseChatBlock(part.tag, part.body, growing)
    }
    visit(part, { id, index: current, result })
  })
}

/** Every recognised `starpath:` fence in a final turn, valid or not. */
export function parseChatBlocks(text: string, messageId: string): ParsedChatBlock[] {
  const out: ParsedChatBlock[] = []
  walkBlocks(text, messageId, false, (part, block) => {
    if (!block || part.kind !== 'fence') return
    const { id, index, result } = block
    if (result.status === 'ok') out.push({ status: 'valid', id, index, source: part.source, block: result.block })
    else if (result.status === 'invalid') out.push({ status: 'invalid', id, index, source: part.source, reason: result.reason })
  })
  return out
}

/**
 * An assistant turn split for rendering: prose runs through the markdown
 * renderer, valid blocks render as cards, a block still arriving renders as a
 * skeleton. Invalid blocks are folded back into the surrounding markdown
 * verbatim, so a malformed fence looks exactly like a code block.
 */
export type ChatContentSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'block'; id: string; index: number; block: ChatBlock }
  | { kind: 'pending'; id: string; index: number; tag: ChatBlockTag }

export function splitChatContent(text: string, messageId: string, streaming = false): ChatContentSegment[] {
  const segments: ChatContentSegment[] = []
  let pending: string[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    const joined = pending.join('\n')
    pending = []
    if (joined.trim()) segments.push({ kind: 'markdown', text: joined })
  }

  walkBlocks(text, messageId, streaming, (part, block) => {
    if (!block) {
      pending.push(part.kind === 'text' ? part.text : part.source)
      return
    }
    const { id, index, result } = block
    if (result.status === 'ok') {
      flush()
      segments.push({ kind: 'block', id, index, block: result.block })
    } else if (result.status === 'pending' && part.kind === 'fence' && isChatBlockTag(part.tag)) {
      flush()
      segments.push({ kind: 'pending', id, index, tag: part.tag })
    } else if (part.kind === 'fence') {
      pending.push(part.source)
    }
  })

  flush()
  return segments
}

// ─── Small shared helpers ─────────────────────────────────────────────────────

/** Case- and space-insensitive company / role match, the trackers' rule. */
export function sameKey(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** "Move to Rejected?" — the card's question for a status proposal. */
export function moveQuestion(status: AppStatus): string {
  return `Move to ${status}?`
}

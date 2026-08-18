import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_STATUSES,
  MAX_PROPOSALS_PER_MESSAGE,
  describeProposal,
  isCanonicalStatus,
  parseProposalBlocks,
  splitChatContent,
  tierForProposal,
  validateProposal,
} from '@/lib/chat/proposals'
import type { ApplyProposal, ChatProposal } from '@/lib/chat/proposals'
import {
  findApplicationRowIndex, updateApplicationFields, updateApplicationStatus, upsertApplicationRow,
} from '@/lib/applicationsDoc'
import { parseApplications } from '@/lib/parsers/markdown'

const MSG = 'msg-1'

function fence(tag: string, body: string): string {
  return ['```' + tag, body, '```'].join('\n')
}

/** The valid proposals in a turn, in document order. */
function proposalsIn(text: string, streaming = false): ChatProposal[] {
  return splitChatContent(text, MSG, streaming)
    .filter(s => s.kind === 'proposal')
    .map(s => (s as { proposal: ChatProposal }).proposal)
}

/** The markdown left over after the proposals are lifted out. */
function markdownIn(text: string, streaming = false): string {
  return splitChatContent(text, MSG, streaming)
    .filter(s => s.kind === 'markdown')
    .map(s => (s as { text: string }).text)
    .join('\n')
}

// ─── canonical statuses ───────────────────────────────────────────────────────

test('the canonical status list matches templates/states.yml', () => {
  assert.deepEqual(CANONICAL_STATUSES, [
    'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer',
    'Rejected', 'Discarded', 'SKIP',
  ])
})

test('isCanonicalStatus rejects near-misses and non-strings', () => {
  assert.equal(isCanonicalStatus('Applied'), true)
  assert.equal(isCanonicalStatus('applied'), false)   // case-sensitive
  assert.equal(isCanonicalStatus('Applied '), false)  // no implicit trim
  assert.equal(isCanonicalStatus('Ghosted'), false)
  assert.equal(isCanonicalStatus(null), false)
  assert.equal(isCanonicalStatus(3), false)
  // Prototype keys must not read as canonical statuses.
  assert.equal(isCanonicalStatus('toString'), false)
  assert.equal(isCanonicalStatus('constructor'), false)
})

// ─── starpath:apply validation ────────────────────────────────────────────────

test('a full apply proposal validates every optional field', () => {
  const result = validateProposal('starpath:apply', {
    company: 'Acme', role: 'ML Engineer', score: '7.8/10', status: 'Evaluated',
    deadline: '2026-09-30', url: 'https://jobs.acme.test/ml', notes: 'referred by Jane',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.proposal, {
    kind: 'apply',
    company: 'Acme',
    role: 'ML Engineer',
    score: '7.8/10',
    scoreValue: 7.8,
    status: 'Evaluated',
    deadline: '2026-09-30',
    url: 'https://jobs.acme.test/ml',
    notes: 'referred by Jane',
  })
})

test('apply needs only company and role', () => {
  const result = validateProposal('starpath:apply', { company: 'Acme', role: 'Analyst' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.proposal, { kind: 'apply', company: 'Acme', role: 'Analyst' })
})

test('apply rejects a missing or empty company/role', () => {
  for (const body of [
    { role: 'Analyst' },
    { company: 'Acme' },
    { company: '   ', role: 'Analyst' },
    { company: 'Acme', role: '' },
    { company: 7, role: 'Analyst' },
  ]) {
    const result = validateProposal('starpath:apply', body)
    assert.equal(result.ok, false, `expected ${JSON.stringify(body)} to be rejected`)
  }
})

test('apply rejects a non-canonical status', () => {
  const result = validateProposal('starpath:apply', {
    company: 'Acme', role: 'Analyst', status: 'Ghosted',
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /status must be one of/)
})

test('apply rejects a malformed score but accepts the tracker format', () => {
  for (const score of ['7.8', '78/10', 'high', '11.0/10', '7.85/10']) {
    const r = validateProposal('starpath:apply', { company: 'A', role: 'B', score })
    assert.equal(r.ok, false, `expected score ${score} to be rejected`)
  }
  const ok = validateProposal('starpath:apply', { company: 'A', role: 'B', score: '10.0/10' })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && (ok.proposal as ApplyProposal).scoreValue, 10)
})

test('apply normalizes an integer score into the X.X/10 form', () => {
  const r = validateProposal('starpath:apply', { company: 'A', role: 'B', score: '8/10' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && (r.proposal as ApplyProposal).score, '8.0/10')
})

test('deadline accepts YYYY-MM-DD, Rolling and n/d and rejects the rest', () => {
  for (const deadline of ['2026-09-30', 'Rolling', 'n/d']) {
    const r = validateProposal('starpath:apply', { company: 'A', role: 'B', deadline })
    assert.equal(r.ok, true, `expected ${deadline} to be accepted`)
  }
  for (const deadline of ['30/09/2026', '2026-13-01', '2026-02-30', 'soon', 'rolling']) {
    const r = validateProposal('starpath:apply', { company: 'A', role: 'B', deadline })
    assert.equal(r.ok, false, `expected ${deadline} to be rejected`)
  }
})

test('url must be http(s) — no javascript:/file: schemes reach the card', () => {
  const ok = validateProposal('starpath:apply', {
    company: 'A', role: 'B', url: 'https://x.test/a?b=1',
  })
  assert.equal(ok.ok, true)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'ftp://x.test']) {
    const r = validateProposal('starpath:apply', { company: 'A', role: 'B', url })
    assert.equal(r.ok, false, `expected ${url} to be rejected`)
  }
})

test('a pipe in any cell is rejected — it would shift every later tracker column', () => {
  for (const body of [
    { company: 'Ac|me', role: 'Analyst' },
    { company: 'Acme', role: 'Analyst | Ops' },
    { company: 'Acme', role: 'Analyst', notes: 'a | b' },
  ]) {
    const r = validateProposal('starpath:apply', body)
    assert.equal(r.ok, false, `expected ${JSON.stringify(body)} to be rejected`)
    assert.match(r.ok ? '' : r.reason, /"\|"/)
  }
})

test('newlines collapse to a space; non-whitespace control chars are rejected', () => {
  // A newline is whitespace, so normalization already removes it — the row
  // stays on one line either way.
  const newline = validateProposal('starpath:apply', { company: 'A\nB', role: 'R' })
  assert.equal(newline.ok, true)
  assert.equal(newline.ok && newline.proposal.company, 'A B')
  // NUL / BEL are not whitespace and survive normalization, so they must be
  // rejected outright rather than written into the tracker.
  for (const company of ['A\u0000B', 'A\u0007B', 'A\u007FB']) {
    assert.equal(validateProposal('starpath:apply', { company, role: 'R' }).ok, false)
  }
})

test('surrounding and inner whitespace is normalized, not rejected', () => {
  const r = validateProposal('starpath:apply', { company: '  Acme  ', role: 'ML   Engineer' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.proposal.company, 'Acme')
  assert.equal(r.ok && r.proposal.role, 'ML Engineer')
})

test('empty optional strings are dropped rather than written as empty cells', () => {
  const r = validateProposal('starpath:apply', {
    company: 'A', role: 'B', score: '', status: '', deadline: '', url: '', notes: '   ',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.proposal, { kind: 'apply', company: 'A', role: 'B' })
})

test('unknown extra keys are ignored so a newer contract degrades gracefully', () => {
  const r = validateProposal('starpath:apply', { company: 'A', role: 'B', tier: 'T1', wat: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.proposal, { kind: 'apply', company: 'A', role: 'B' })
})

test('a non-object body is rejected', () => {
  for (const body of [null, 42, 'text', ['a'], true]) {
    assert.equal(validateProposal('starpath:apply', body).ok, false)
  }
})

// ─── starpath:status validation ───────────────────────────────────────────────

test('status proposals require a canonical status', () => {
  const ok = validateProposal('starpath:status', { company: 'Acme', role: 'Analyst', status: 'Applied' })
  assert.deepEqual(ok.ok && ok.proposal, {
    kind: 'status', company: 'Acme', role: 'Analyst', status: 'Applied',
  })
  assert.equal(validateProposal('starpath:status', { company: 'A', role: 'B' }).ok, false)
  assert.equal(validateProposal('starpath:status', { company: 'A', role: 'B', status: 'Nope' }).ok, false)
})

test('status proposals ignore apply-only fields', () => {
  const r = validateProposal('starpath:status', {
    company: 'A', role: 'B', status: 'Offer', score: 'garbage', deadline: 'nonsense',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.proposal, { kind: 'status', company: 'A', role: 'B', status: 'Offer' })
})

// ─── fence extraction ─────────────────────────────────────────────────────────

test('a proposal fence is lifted out and the surrounding prose is preserved', () => {
  const text = [
    'Worth tracking:',
    fence('starpath:apply', '{"company":"Acme","role":"Analyst"}'),
    'Want me to draft the application too?',
  ].join('\n\n')

  const segments = splitChatContent(text, MSG)
  assert.deepEqual(segments.map(s => s.kind), ['markdown', 'proposal', 'markdown'])
  assert.equal(proposalsIn(text)[0].company, 'Acme')
  assert.match(markdownIn(text), /Worth tracking/)
  assert.match(markdownIn(text), /draft the application/)
})

test('multiple proposals in one message each get a distinct stable id', () => {
  const text = [
    fence('starpath:apply', '{"company":"Acme","role":"Analyst"}'),
    fence('starpath:status', '{"company":"Globex","role":"PM","status":"Applied"}'),
  ].join('\n\n')

  const blocks = parseProposalBlocks(text, MSG)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map(b => b.id), ['msg-1#p0', 'msg-1#p1'])
  assert.deepEqual(blocks.map(b => b.status), ['valid', 'valid'])
  // The ids are derived from the message id, so they are stable across reloads
  // and distinct between messages.
  assert.equal(parseProposalBlocks(text, 'msg-2')[0].id, 'msg-2#p0')
  // splitChatContent agrees with parseProposalBlocks on ids.
  const segments = splitChatContent(text, MSG).filter(s => s.kind === 'proposal')
  assert.deepEqual(segments.map(s => (s as { id: string }).id), ['msg-1#p0', 'msg-1#p1'])
})

test('an id is stable even when an earlier block is invalid', () => {
  const text = [
    fence('starpath:apply', 'not json'),
    fence('starpath:apply', '{"company":"Acme","role":"Analyst"}'),
  ].join('\n\n')
  const blocks = parseProposalBlocks(text, MSG)
  assert.deepEqual(blocks.map(b => b.status), ['invalid', 'valid'])
  assert.deepEqual(blocks.map(b => b.id), ['msg-1#p0', 'msg-1#p1'])
  // The valid one keeps index 1 in the rendered segments too.
  const segment = splitChatContent(text, MSG).find(s => s.kind === 'proposal')
  assert.equal((segment as { id: string }).id, 'msg-1#p1')
})

test('malformed JSON renders as a plain code block, never a card', () => {
  const text = fence('starpath:apply', '{"company":"Acme",')
  assert.deepEqual(proposalsIn(text), [])
  // The fence survives verbatim, so the markdown renderer draws a code block.
  assert.match(markdownIn(text), /```starpath:apply/)
  const block = parseProposalBlocks(text, MSG)[0]
  assert.equal(block.status, 'invalid')
  assert.equal(block.status === 'invalid' && block.reason, 'the body is not valid JSON')
})

test('a valid-JSON but invalid-payload block renders as a plain code block', () => {
  const text = fence('starpath:status', '{"company":"Acme","role":"Analyst","status":"Ghosted"}')
  assert.deepEqual(proposalsIn(text), [])
  assert.match(markdownIn(text), /```starpath:status/)
  const block = parseProposalBlocks(text, MSG)[0]
  assert.equal(block.status, 'invalid')
})

test('an unknown starpath: tag is left as an ordinary fence', () => {
  const text = fence('starpath:delete', '{"company":"Acme","role":"Analyst"}')
  assert.deepEqual(proposalsIn(text), [])
  assert.deepEqual(parseProposalBlocks(text, MSG), [])
  assert.match(markdownIn(text), /```starpath:delete/)
})

test('an ordinary fence is untouched', () => {
  const text = ['Here:', fence('json', '{"company":"Acme","role":"Analyst"}')].join('\n\n')
  assert.deepEqual(proposalsIn(text), [])
  assert.match(markdownIn(text), /```json/)
})

test('a proposal fence nested inside another fence is not a proposal', () => {
  // The agent documenting the contract must not trigger a real write.
  const text = [
    'The format is:',
    '````markdown',
    fence('starpath:apply', '{"company":"Acme","role":"Analyst"}'),
    '````',
  ].join('\n\n')
  assert.deepEqual(proposalsIn(text), [])
  assert.deepEqual(parseProposalBlocks(text, MSG), [])
})

test('tildes work as fence delimiters', () => {
  const text = ['~~~starpath:apply', '{"company":"Acme","role":"Analyst"}', '~~~'].join('\n')
  assert.equal(proposalsIn(text).length, 1)
})

test('an unclosed proposal fence is dropped while streaming and shown when final', () => {
  const text = ['Tracking this:', '```starpath:apply', '{"company":"Acme"'].join('\n')
  // Mid-stream: no card, no half-rendered JSON.
  assert.deepEqual(proposalsIn(text, true), [])
  assert.doesNotMatch(markdownIn(text, true), /starpath:apply/)
  assert.match(markdownIn(text, true), /Tracking this/)
  // Final: the reply really was cut off — show what arrived.
  assert.deepEqual(proposalsIn(text, false), [])
  assert.match(markdownIn(text, false), /starpath:apply/)
})

test('a closed fence renders as a card even while streaming', () => {
  const text = fence('starpath:apply', '{"company":"Acme","role":"Analyst"}')
  assert.equal(proposalsIn(text, true).length, 1)
})

test('proposals past the per-message cap do not render as cards', () => {
  const one = fence('starpath:apply', '{"company":"Acme","role":"Analyst"}')
  const text = Array.from({ length: MAX_PROPOSALS_PER_MESSAGE + 3 }, () => one).join('\n\n')
  assert.equal(proposalsIn(text).length, MAX_PROPOSALS_PER_MESSAGE)
  const blocks = parseProposalBlocks(text, MSG)
  assert.equal(blocks.filter(b => b.status === 'valid').length, MAX_PROPOSALS_PER_MESSAGE)
})

test('a message with no fences is one markdown segment', () => {
  const segments = splitChatContent('Just prose, nothing to confirm.', MSG)
  assert.deepEqual(segments, [{ kind: 'markdown', text: 'Just prose, nothing to confirm.' }])
})

test('empty and whitespace-only content produce no segments', () => {
  assert.deepEqual(splitChatContent('', MSG), [])
  assert.deepEqual(splitChatContent('\n  \n', MSG), [])
})

test('a proposal alone in a message yields exactly one card and no empty prose', () => {
  const text = fence('starpath:apply', '{"company":"Acme","role":"Analyst"}')
  const segments = splitChatContent(text, MSG)
  assert.deepEqual(segments.map(s => s.kind), ['proposal'])
})

test('an indented fence inside a list still parses', () => {
  const text = ['- worth tracking:', '  ```starpath:apply',
    '  {"company":"Acme","role":"Analyst"}', '  ```'].join('\n')
  assert.equal(proposalsIn(text).length, 1)
})

// ─── presentation ─────────────────────────────────────────────────────────────

test('describeProposal summarizes an apply proposal in tracker column order', () => {
  const summary = describeProposal({
    kind: 'apply', company: 'Acme', role: 'Analyst',
    score: '7.8/10', scoreValue: 7.8, status: 'Applied', deadline: 'Rolling', notes: 'via Jane',
  })
  assert.equal(summary.kindLabel, 'Add to applications')
  assert.equal(summary.subject, 'Acme — Analyst')
  assert.deepEqual(summary.changes, [
    { label: 'Score', value: '7.8/10' },
    { label: 'Status', value: 'Applied' },
    { label: 'Deadline', value: 'Rolling' },
    { label: 'Notes', value: 'via Jane' },
  ])
})

test('describeProposal shows the default status when none was proposed', () => {
  const summary = describeProposal({ kind: 'apply', company: 'Acme', role: 'Analyst' })
  assert.deepEqual(summary.changes, [{ label: 'Status', value: 'Evaluated' }])
})

test('describeProposal summarizes a status proposal', () => {
  const summary = describeProposal({
    kind: 'status', company: 'Acme', role: 'Analyst', status: 'Interview',
  })
  assert.equal(summary.kindLabel, 'Status change')
  assert.deepEqual(summary.changes, [{ label: 'Status', value: 'Interview' }])
  assert.equal(summary.appliedLabel, 'Status set to Interview')
})

// ─── end to end: a reply becomes a tracker row ────────────────────────────────
//
// The seam this pins is the one the unit tests above can't: that the parser's
// output actually FITS the applications.md mutators (score format, tier, field
// names). `apply` below mirrors ChatView's Confirm handler — if that
// composition or either module's signature drifts, this test is what notices.

const TRACKER = [
  '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
  '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | n/d | [#1](reports/tier-2/Acme - ML Eng.md) | emailed Jane |',
].join('\n')

function apply(raw: string, proposal: ChatProposal): string {
  if (proposal.kind === 'status') {
    if (findApplicationRowIndex(raw.split('\n'), proposal.company, proposal.role) === -1) {
      throw new Error('not tracked')
    }
    return updateApplicationStatus(raw, proposal.company, proposal.role, proposal.status)
  }
  const upserted = upsertApplicationRow(raw, {
    company: proposal.company, role: proposal.role,
    overall: proposal.scoreValue ?? 0, tier: tierForProposal(proposal),
  })
  return updateApplicationFields(upserted, proposal.company, proposal.role, {
    status: proposal.status, deadline: proposal.deadline, notes: proposal.notes,
  })
}

test('a chat reply with an apply fence becomes exactly one tracker row', () => {
  const reply = [
    'That one is worth tracking — the ops scope matches your last two evaluations.',
    '',
    '```starpath:apply',
    '{"company": "Initech", "role": "Data Analyst", "score": "7.8/10", "status": "Evaluated",',
    ' "deadline": "2026-09-30", "url": "https://jobs.initech.test/da", "notes": "ops-heavy JD"}',
    '```',
    '',
    'Want me to check whether the posting is still live?',
  ].join('\n')

  const segments = splitChatContent(reply, MSG)
  assert.deepEqual(segments.map(s => s.kind), ['markdown', 'proposal', 'markdown'])
  const proposal = (segments[1] as { proposal: ChatProposal }).proposal

  const next = apply(TRACKER, proposal)
  const rows = parseApplications(next)
  assert.equal(rows.length, 2)
  const added = rows.find(r => r.company === 'Initech')!
  assert.equal(added.role, 'Data Analyst')
  assert.equal(added.score, '7.8/10')
  assert.equal(added.status, 'Evaluated')
  assert.equal(added.deadline, '2026-09-30')
  assert.equal(added.notes, 'ops-heavy JD')
  assert.match(added.report, /tier-2/)   // 7.8 lands in the T2 band

  // The listing that was already tracked keeps every cell.
  const acme = rows.find(r => r.company === 'Acme')!
  assert.equal(acme.status, 'Applied')
  assert.equal(acme.notes, 'emailed Jane')

  // Confirming the same card twice can't duplicate the listing.
  assert.equal(apply(next, proposal), next)
  assert.equal(parseApplications(apply(next, proposal)).length, 2)
})

test('a status fence moves an existing row and refuses an untracked one', () => {
  const move = '```starpath:status\n{"company":"Acme","role":"ML Eng","status":"Interview"}\n```'
  const proposal = (splitChatContent(move, MSG)[0] as { proposal: ChatProposal }).proposal
  const next = apply(TRACKER, proposal)
  assert.equal(parseApplications(next).find(r => r.company === 'Acme')!.status, 'Interview')

  const ghost = '```starpath:status\n{"company":"Nobody","role":"Nothing","status":"Offer"}\n```'
  const missing = (splitChatContent(ghost, MSG)[0] as { proposal: ChatProposal }).proposal
  assert.throws(() => apply(TRACKER, missing), /not tracked/)
})

test('tierForProposal mirrors the DB score bands', () => {
  const at = (scoreValue?: number, status?: ApplyProposal['status']): string =>
    tierForProposal({ kind: 'apply', company: 'A', role: 'B', scoreValue, status })
  assert.equal(at(9.4), 'T1')
  assert.equal(at(9.0), 'T1')
  assert.equal(at(8.9), 'T2')
  assert.equal(at(7.0), 'T2')
  assert.equal(at(6.9), 'T3')
  assert.equal(at(undefined), 'T4')
  assert.equal(at(9.5, 'SKIP'), 'T4')
})

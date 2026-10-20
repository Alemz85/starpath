// What the user did with the chat's cards since the agent last spoke.
//
// A Confirm/Dismiss lands on the message in the session file; the agent's own
// CLI session never sees it. Without this, the next reply can re-propose a
// move the user already made ("want me to mark Acme rejected?") or assume a
// dismissed one went through. So the main process prefixes the next prompt
// with one line built here — the persisted user message stays exactly what
// the user typed.
//
// Pure and alias-free at runtime (see the dependency rule in `./proposals`).

import type { ChatSession } from './types'

/** Decisions listed in one digest; any beyond are counted, not spelled out. */
export const MAX_DIGEST_ITEMS = 8

const PREFIX = 'Card decisions since your last reply'

/**
 * The decisions made after the latest assistant message was written, oldest
 * first, as one line — or null when there are none. A decision is always
 * stamped after the message it sits on, and the cards are locked while a
 * reply is generating, so "after the latest reply" is exactly "not yet seen".
 */
export function cardDecisionDigest(session: Pick<ChatSession, 'messages'> | null): string | null {
  if (!session) return null
  const lastReply = [...session.messages].reverse().find(m => m.role === 'assistant')
  if (!lastReply) return null
  const since = lastReply.ts

  const items: Array<{ at: string; text: string }> = []
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.proposalDecisions) continue
    for (const decision of Object.values(message.proposalDecisions)) {
      if (!decision || typeof decision.at !== 'string' || !(decision.at > since)) continue
      const detail = (decision.detail ?? '').replace(/\s+/g, ' ').trim()
      items.push({
        at: decision.at,
        text: detail || (decision.status === 'applied' ? 'confirmed a card' : 'dismissed a card'),
      })
    }
  }
  if (items.length === 0) return null

  items.sort((a, b) => a.at.localeCompare(b.at))
  const shown = items.slice(0, MAX_DIGEST_ITEMS).map(i => i.text)
  const more = items.length - shown.length
  return `[${PREFIX}: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.]`
}

/** The prompt the agent receives: the digest line, then what the user typed. */
export function withCardDigest(prompt: string, session: Pick<ChatSession, 'messages'> | null): string {
  const digest = cardDecisionDigest(session)
  return digest ? `${digest}\n\n${prompt}` : prompt
}

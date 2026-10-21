import type { AgentMessage } from '@/lib/messages'

// What the chat's message card shows of a Messages item: the one lookup and the
// plain-text excerpt of its markdown body. Pure.

/** The message with this id, or null. Exact id only: the agent copies it from
 *  `npm run messages -- list`, so a guess matches nothing. */
export function findMessageById(messages: readonly AgentMessage[], id: string): AgentMessage | null {
  const wantedId = id.trim()
  return messages.find(m => m.id === wantedId) ?? null
}

export const MESSAGE_EXCERPT_CHARS = 220

/** The body as one line of plain text, cut on a word edge. Markdown marks that
 *  would read as noise on a card (links, emphasis, headings, bullets, code
 *  fences) are dropped; the full text stays in Messages. */
export function messageExcerpt(body: string, max = MESSAGE_EXCERPT_CHARS): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // A list item ends like a sentence, so items don't run together.
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*?)\s*$/gm, (_, item: string) => (/[.!?:;]$/.test(item) ? item : `${item};`))
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '.')
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const edge = cut.lastIndexOf(' ')
  return `${(edge > max * 0.6 ? cut.slice(0, edge) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`
}

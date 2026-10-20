'use client'

import { createContext, useContext } from 'react'

/** What a chat card can ask the Chat view to do for it. The view owns the
 *  report sheet, so a card asks for it rather than mounting its own. */
export interface ChatCardActions {
  openReport(company: string, role: string): void
}

const NOOP: ChatCardActions = { openReport: () => {} }

export const ChatCardContext = createContext<ChatCardActions>(NOOP)

export function useChatCardActions(): ChatCardActions {
  return useContext(ChatCardContext)
}

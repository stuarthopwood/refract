import { useChatAreaAnnouncer } from '../features/chat/chatAreaAnnouncer'
import { useChatScrollStore } from './scroll-store'
import { useSplitStore } from './split-store'

// A tool moved the Session to another Conversation (#1861). The transcript already rides the backend's
// patch reset, so this drops the old Conversation's scroll memory (a fetched snapshot could overwrite the first prompt row)
// and tells screen-reader users (WCAG 4.1.3); the payload can't tell a new Conversation from a switch, so the wording is neutral.
export function handleConversationChanged(sessionId: string): void {
  useChatScrollStore.getState().clear(sessionId)
  if (useSplitStore.getState().paneSessionIds.includes(sessionId)) {
    useChatAreaAnnouncer.getState().announce('Conversation changed')
  }
}

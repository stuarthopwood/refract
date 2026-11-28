import { useChatAreaAnnouncer } from '../features/chat/chatAreaAnnouncer'
import { useChatScrollStore } from './scroll-store'
import { useSplitStore } from './split-store'
import { useSubagentPanelStore } from './subagent-store'
import { useViewStore } from './view-store'

// A tool moved the Session to another Conversation (#1861). The transcript already rides the backend's
// patch reset, so this drops the old Conversation's scroll memory (a fetched snapshot could overwrite the first prompt row)
// and tells screen-reader users (WCAG 4.1.3); the payload can't tell a new Conversation from a switch, so the wording is neutral.
// Only the chat view shows panes, so any other view stays silent.
export function handleConversationChanged(sessionId: string): void {
  useChatScrollStore.getState().clear(sessionId)
  // Main also clears the Session's subagents, so the panel must not keep streams of the old Conversation.
  useSubagentPanelStore.getState().resetForNewConversation(sessionId)
  const paneShown = useSplitStore.getState().paneSessionIds.includes(sessionId)
  if (paneShown && useViewStore.getState().view === 'chat') {
    useChatAreaAnnouncer.getState().announce('Conversation changed')
  }
}

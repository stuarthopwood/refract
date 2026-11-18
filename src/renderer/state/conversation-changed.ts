import { useChatScrollStore } from './scroll-store'

// A tool moved the Session to another Conversation (#1861). The transcript already rides the backend's
// patch reset, so this only drops the old Conversation's scroll memory; a fetched snapshot could overwrite the first prompt row.
export function handleConversationChanged(sessionId: string): void {
  useChatScrollStore.getState().clear(sessionId)
}

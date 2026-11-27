// The two Conversation switches (start a new one, open an earlier one), shared by the chat header's
// switcher and the Session row's nested list so both clear scroll state and reattach the same way.
import { notify, useChatScrollStore } from '@/state'
import { applySnapshot } from './applySnapshot'
import { emitConversationsChanged } from './conversationChanges'

/** Resolves true when the switch succeeded; a failure has already been reported through `notify`. */
export async function startNewConversation(sessionId: string): Promise<boolean> {
  // Snapshot first so a failed switch can put back exactly what it removed (only if nothing newer
  // has been recorded for this Session meanwhile).
  const previousScroll = useChatScrollStore.getState().bySession[sessionId]
  useChatScrollStore.getState().clear(sessionId)
  useChatScrollStore.getState().setInFlight(sessionId, true)
  try {
    const result = await window.refract.conversations.startNew(sessionId)
    if (!result.ok) {
      useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
      notify(result.error)
      return false
    }
    useChatScrollStore.getState().clear(sessionId)
    applySnapshot(sessionId, result.value)
    emitConversationsChanged(sessionId)
    return true
  } finally {
    useChatScrollStore.getState().setInFlight(sessionId, false)
  }
}

export async function switchToConversation(sessionId: string, file: string): Promise<boolean> {
  // Clear BEFORE awaiting below (not after), same reasoning as `startNewConversation`.
  useChatScrollStore.getState().clear(sessionId)
  useChatScrollStore.getState().setInFlight(sessionId, true)
  try {
    const result = await window.refract.conversations.open(sessionId, file)
    if (!result.ok) {
      notify(result.error)
      return false
    }
    useChatScrollStore.getState().clear(sessionId)
    applySnapshot(sessionId, result.value)
    emitConversationsChanged(sessionId)
    return true
  } finally {
    useChatScrollStore.getState().setInFlight(sessionId, false)
  }
}

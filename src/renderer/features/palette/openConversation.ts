import { applySnapshot } from '@/features/chat/applySnapshot'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { notify, useChatScrollStore } from '@/state'
import type { SessionStatus } from '../../../shared/model'

/** Switches a Session to another Conversation; only an idle or stopped Session may switch, as in the Conversation switcher. */
export async function openConversation(sessionId: string, file: string, status: SessionStatus | undefined): Promise<void> {
  if (status !== 'idle' && status !== 'stopped') {
    useChatAreaAnnouncer.getState().announce('Wait for the Session to finish before switching Conversations.')
    return
  }
  // Cleared before the await so the old Conversation's scroll position is never restored onto the new one.
  useChatScrollStore.getState().clear(sessionId)
  useChatScrollStore.getState().setInFlight(sessionId, true)
  try {
    const result = await window.refract.conversations.open(sessionId, file)
    if (!result.ok) {
      notify(result.error)
      return
    }
    useChatScrollStore.getState().clear(sessionId)
    applySnapshot(sessionId, result.value)
  } finally {
    useChatScrollStore.getState().setInFlight(sessionId, false)
  }
}

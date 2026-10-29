import { useChatAreaAnnouncer } from '../chat/chatAreaAnnouncer'
import { useChatNavStore, type ScrollBridgeJumpOptions } from '@/state/chat-nav-store'
import { messagePositionAnnouncement } from './messageIndex'

export interface JumpToMessageOptions extends ScrollBridgeJumpOptions {
  /** Skip the polite "Message N of M" announcement. Defaults to announcing once. */
  announce?: boolean
}

/** The one function every chat-navigation feature calls to move the chat to a message. Reveals a
 * windowed-out turn, scrolls, runs the landing correction, detaches from autoscroll, highlights
 * the row and announces "Message N of M". Keyboard focus is left where it was. Returns false when
 * the Session has no mounted transcript or the message is unknown. */
export function jumpToMessage(sessionId: string, messageId: string, options?: JumpToMessageOptions): boolean {
  const entry = useChatNavStore.getState().bySession[sessionId]
  if (!entry?.bridge) return false
  if (!entry.bridge.jump(messageId, options)) return false
  if (options?.announce !== false) {
    const text = messagePositionAnnouncement(entry.index, messageId)
    if (text) useChatAreaAnnouncer.getState().announce(text)
  }
  return true
}

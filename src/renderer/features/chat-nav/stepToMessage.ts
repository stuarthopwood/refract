import { useChatNavStore } from '@/state/chat-nav-store'
import { useChatAreaAnnouncer } from '../chat/chatAreaAnnouncer'
import { jumpToMessage } from './jumpToMessage'
import { resolveStepTarget, type StepDirection } from './messageIndex'

/** Moves the chat to the previous or next message relative to the topmost visible one. At either
 * end there is nowhere to go, so it announces "First message" / "Last message" instead. */
export function stepToMessage(sessionId: string, direction: StepDirection): boolean {
  const entry = useChatNavStore.getState().bySession[sessionId]
  if (!entry?.bridge) return false
  const currentId = entry.view.currentMessageId
  const target = resolveStepTarget({
    direction,
    orderedIds: entry.index.map((message) => message.id),
    currentId,
    currentTopOffset: currentId === null ? 0 : (entry.bridge.getMessageTopOffset(currentId) ?? 0),
    tolerancePx: 2
  })
  if (!target) {
    useChatAreaAnnouncer.getState().announce(direction === 'previous' ? 'First message' : 'Last message')
    return false
  }
  return jumpToMessage(sessionId, target.id)
}

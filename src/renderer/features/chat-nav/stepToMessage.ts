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
  const canScroll =
    direction === 'previous'
      ? entry.view.scrollable.start || entry.bridge.getHiddenTurnCount() > 0
      : entry.view.scrollable.end
  const target = canScroll
    ? resolveStepTarget({
        direction,
        orderedIds: entry.index.map((message) => message.id),
        currentId,
        currentTopOffset:
          currentId === null || (direction === 'previous' && !entry.view.scrollable.start)
            ? 0
            : (entry.bridge.getMessageTopOffset(currentId) ?? 0),
        tolerancePx: 2
      })
    : null
  if (!target) {
    useChatAreaAnnouncer.getState().announce(direction === 'previous' ? 'First message' : 'Last message')
    return false
  }
  return jumpToMessage(sessionId, target.id)
}

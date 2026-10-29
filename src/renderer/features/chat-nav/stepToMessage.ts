import { useChatNavStore } from '@/state/chat-nav-store'
import { jumpToMessage } from './jumpToMessage'
import { resolveStepTarget } from './messageIndex'

export type StepDirection = 'previous' | 'next'

/** Moves the chat to the previous or next message relative to the topmost visible one. */
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
  return target ? jumpToMessage(sessionId, target.id) : false
}

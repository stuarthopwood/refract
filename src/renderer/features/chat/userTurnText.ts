import type { TranscriptItem } from '../../../shared/model'

type UserTurn = Pick<Extract<TranscriptItem, { kind: 'user' }>, 'text' | 'source'>

export const CHECKLIST_COMPLETE_COPY = 'Asked the agent to complete this step'

/**
 * The words a user turn shows. A complete click's stored text is the agent-facing instruction, so
 * the bubble, outline and Find all say what the click did instead; keyed on the source, not on
 * the text being empty.
 */
export function userTurnText(item: UserTurn): string {
  const { source } = item
  return source?.kind === 'checklist-item' && source.action === 'complete' ? CHECKLIST_COMPLETE_COPY : item.text
}

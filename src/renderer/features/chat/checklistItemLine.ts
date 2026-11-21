import type { SessionChecklist } from '@/state/checklist-store'

export type ChecklistItemLine =
  | { kind: 'item'; position: number; text: string }
  | { kind: 'removed' }
  | { kind: 'replaced' }
  | { kind: 'unknown' }

/**
 * What the chat line says about the item a turn was sent for. The source carries only ids, so the
 * words come from the live checklist; until it is known the line must not guess a number.
 */
export function resolveChecklistItemLine(
  state: Pick<SessionChecklist, 'checklist' | 'loaded' | 'error'>,
  checklistId: string,
  itemId: string
): ChecklistItemLine {
  const { checklist } = state
  if (!state.loaded) return { kind: 'unknown' }
  // A failed read says nothing about the item, so it is not "removed".
  if (checklist === null) return state.error !== null ? { kind: 'unknown' } : { kind: 'removed' }
  if (checklist.id !== checklistId) return { kind: 'replaced' }
  const index = checklist.items.findIndex((item) => item.id === itemId)
  if (index === -1) return { kind: 'removed' }
  return { kind: 'item', position: index + 1, text: checklist.items[index]!.text }
}

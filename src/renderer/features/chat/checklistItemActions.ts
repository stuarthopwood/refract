import { selectSessionChecklist, useChecklistStore } from '@/state/checklist-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'

/** Only the focused Session is hydrated app-wide, so a card in the other split pane asks for its own checklist once. */
export function hydrateIfUnseen(sessionId: string): void {
  const store = useChecklistStore.getState()
  if (selectSessionChecklist(store, sessionId).seq === 0) void store.hydrate(sessionId)
}

/** Activates the card's own Session, then opens the panel and asks it to reveal the item. */
export function showInChecklist(sessionId: string, checklistId: string, itemId: string): void {
  useSplitStore.getState().replaceFocused(sessionId)
  useRightPaneStore.getState().openPanel('checklist', { focus: false })
  useChecklistStore.getState().requestReveal({ sessionId, checklistId, itemId })
}

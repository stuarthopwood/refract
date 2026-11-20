import { useChecklistStore } from './checklist-store'
import { useRightPaneStore } from './right-pane-store'
import { frontSessionIdOf, useSplitStore } from './split-store'

/** Feeds `checklist:update` into the checklist store, opens the panel for an agent-created checklist, and hydrates whichever Session comes to the front. Returns the disposer. */
export function initChecklistSubscription(): () => void {
  const stopUpdates = window.refract.checklist.onUpdate((payload) => {
    useChecklistStore.getState().applyUpdate(payload)
    if (payload.opened !== true) return
    if (payload.sessionId !== frontSessionIdOf(useSplitStore.getState())) return
    // `openPanel` re-selects the tab and drops the document tab, so an already-open panel is left alone.
    if (useRightPaneStore.getState().openPanelIds.includes('checklist')) return
    useRightPaneStore.getState().openPanel('checklist', { focus: false })
  })

  let hydrated: string | null = null
  const hydrateFront = (): void => {
    const front = frontSessionIdOf(useSplitStore.getState())
    if (front === hydrated) return
    hydrated = front
    if (front !== null) void useChecklistStore.getState().hydrate(front)
  }
  const stopSplit = useSplitStore.subscribe(hydrateFront)
  hydrateFront()
  return () => {
    stopUpdates()
    stopSplit()
  }
}

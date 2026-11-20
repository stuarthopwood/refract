import { useChecklistStore } from './checklist-store'
import { useRightPaneStore } from './right-pane-store'
import { useSessionsStore } from './sessions-store'
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

  // Host tools are registered while the agent launches, after a new front Session was first hydrated, so a refusal
  // would never reach the panel. A status change marks every launch and relaunch, so refetch then.
  const frontStatus = (): string => {
    const front = frontSessionIdOf(useSplitStore.getState())
    return `${front}:${useSessionsStore.getState().sessions.find((session) => session.id === front)?.status}`
  }
  let lastStatus = frontStatus()
  const stopStatus = useSessionsStore.subscribe(() => {
    const status = frontStatus()
    if (status === lastStatus) return
    lastStatus = status
    const front = frontSessionIdOf(useSplitStore.getState())
    if (front !== null) void useChecklistStore.getState().hydrate(front)
  })
  return () => {
    stopUpdates()
    stopSplit()
    stopStatus()
  }
}

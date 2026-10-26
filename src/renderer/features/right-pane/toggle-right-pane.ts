// Spec 024 FR-001 to FR-003: the one collapse/expand action shared by the rail's toggle button and
// the Ctrl+Shift+B shortcut, including the focus rules (collapsing with focus inside the pane
// moves it to the active panel's rail button; expanding moves it into the active panel's content,
// or the launcher when no panel is open).
import { useRightPaneStore } from '@/state'

export function toggleRightPane(): void {
  const store = useRightPaneStore.getState()
  const wasOpen = store.open
  const focusWasInside = Boolean(document.activeElement?.closest('[data-right-pane-shell]'))
  const { activePanelId } = store
  store.toggleCollapsed()
  if (wasOpen && !focusWasInside) return
  requestAnimationFrame(() => {
    if (wasOpen) {
      const railButton = activePanelId ? document.querySelector<HTMLElement>(`[data-rail-button="${activePanelId}"]`) : null
      ;(railButton ?? document.querySelector<HTMLElement>('[data-rail-toggle]'))?.focus()
      return
    }
    const target =
      document.querySelector<HTMLElement>('[data-right-pane-content]') ??
      document.querySelector<HTMLElement>('[data-panel-launcher] button')
    target?.focus()
  })
}

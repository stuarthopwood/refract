import { useMemo } from 'react'
import { useRightPaneStore } from '@/state'
import { HOSTED_PANELS, type HostedPanelDescriptor, type PanelId } from './panel-registry'

// Issue #730 (spec 001 FR-112 to FR-116): the user's panel order, read by the icon rail and the
// launcher. The saved array is raw (it may hold ids this build does not register, and lack ids
// for panels added since it was saved); every read merges it with the default order.

export const DEFAULT_PANEL_ORDER: PanelId[] = HOSTED_PANELS.map((panel) => panel.id)

/** Saved ids first (unknown ones kept in place); a default panel missing from `saved` goes
 * right after the nearest earlier default panel that is present, or first if none is. */
export function mergePanelOrder(saved: readonly string[], defaults: readonly string[] = DEFAULT_PANEL_ORDER): string[] {
  const result = [...new Set(saved)]
  defaults.forEach((id, index) => {
    if (result.includes(id)) return
    let at = 0
    for (let before = index - 1; before >= 0; before -= 1) {
      const found = result.indexOf(defaults[before] ?? '')
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    result.splice(at, 0, id)
  })
  return result
}

/** The registered panels in the merged order. */
export function orderPanels(saved: readonly string[]): HostedPanelDescriptor[] {
  const byId = new Map<string, HostedPanelDescriptor>(HOSTED_PANELS.map((panel) => [panel.id, panel]))
  const ordered: HostedPanelDescriptor[] = []
  for (const id of mergePanelOrder(saved)) {
    const panel = byId.get(id)
    if (panel) ordered.push(panel)
  }
  return ordered
}

export function useOrderedPanels(): HostedPanelDescriptor[] {
  const panelOrder = useRightPaneStore((s) => s.panelOrder)
  return useMemo(() => orderPanels(panelOrder), [panelOrder])
}

/** Saves a user move: `visibleIds` is the new order of the registered panels; unregistered saved
 * ids keep their slots in the merged array. */
export function savePanelOrder(visibleIds: readonly string[]): void {
  const { panelOrder, setPanelOrder } = useRightPaneStore.getState()
  const registered = new Set<string>(DEFAULT_PANEL_ORDER)
  let next = 0
  setPanelOrder(mergePanelOrder(panelOrder).map((id) => (registered.has(id) ? (visibleIds[next++] ?? id) : id)))
}

export function resetPanelOrder(): void {
  useRightPaneStore.getState().setPanelOrder([])
}

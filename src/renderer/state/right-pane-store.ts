import { create } from 'zustand'
import type { PanelId } from '../features/right-pane/panel-registry'

// Spec 013 (data-model.md `RightPaneState`, FR-002): the single owner of the right pane's own
// open/collapsed state, its rendered width, which hosted panels are open, their tab order, and
// which one is active. No hosted panel (including the migrated Subagents panel,
// `subagent-store.ts`) manages its own open flag any more -- that role moved here. This store
// never imports a hosted panel's own store (research.md decision 3); panel-specific binding and
// cleanup live in `features/right-pane/hosted-panel-actions.ts` instead, which imports both.

export const RIGHT_PANE_DEFAULT_WIDTH_PX = 320
export const RIGHT_PANE_MIN_WIDTH_PX = 240
export const RIGHT_PANE_MAX_WIDTH_PX = 520

interface RightPaneState {
  /** The pane itself, collapsed or not (FR-003, FR-004). Collapsing never clears
   * `openPanelIds` -- reopening within the same session restores the same tabs. */
  open: boolean
  /** Current rendered width in pixels; default 320px (FR-004). */
  widthPx: number
  /** Ordered; this is the tab order once two or more are open (FR-008). */
  openPanelIds: PanelId[]
  /** Which open panel is shown; `null` only when `openPanelIds` is empty (the launcher). */
  activePanelId: PanelId | null
  /** Opens the pane if collapsed; adds `id` if absent; makes it active (FR-005). */
  openPanel(id: PanelId): void
  /** Removes `id`; if it was active, activates the new last id, or `null` if `openPanelIds` is
   * now empty (FR-009) -- never collapses `open`. */
  closePanel(id: PanelId): void
  /** FR-005/FR-006: `openPanel` if not open-and-active, `closePanel` if open-and-active. */
  togglePanelFromRail(id: PanelId): void
  /** The drag handle and the (PR4) width-preset buttons both call this. */
  setWidth(widthPx: number): void
  /** Generalises `App.tsx`'s existing `onResize` desync guard (research.md decision 2) from the
   * Subagents-only case to any hosted panel; called from the shell's `ResizablePanel.onResize`,
   * never from a click handler. */
  syncRenderedState(open: boolean, widthPx: number): void
}

export const useRightPaneStore = create<RightPaneState>((set, get) => ({
  open: false,
  widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX,
  openPanelIds: [],
  activePanelId: null,
  openPanel: (id) => {
    const { openPanelIds } = get()
    set({
      open: true,
      openPanelIds: openPanelIds.includes(id) ? openPanelIds : [...openPanelIds, id],
      activePanelId: id
    })
  },
  closePanel: (id) => {
    const { openPanelIds, activePanelId } = get()
    const nextIds = openPanelIds.filter((openId) => openId !== id)
    set({
      openPanelIds: nextIds,
      activePanelId: activePanelId === id ? (nextIds.length > 0 ? nextIds[nextIds.length - 1] : null) : activePanelId
    })
  },
  togglePanelFromRail: (id) => {
    const { openPanelIds, activePanelId } = get()
    if (openPanelIds.includes(id) && activePanelId === id) get().closePanel(id)
    else get().openPanel(id)
  },
  setWidth: (widthPx) => set({ widthPx }),
  syncRenderedState: (open, widthPx) => set({ open, widthPx })
}))

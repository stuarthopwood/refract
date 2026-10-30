import { create } from 'zustand'
import type { PanelId } from '../features/right-pane/panel-registry'


export const RIGHT_PANE_DEFAULT_WIDTH_PX = 320
export const RIGHT_PANE_MIN_WIDTH_PX = 240
export const RIGHT_PANE_MAX_WIDTH_PX = 520

interface RightPaneState {
  open: boolean
  widthPx: number
  openPanelIds: PanelId[]
  activePanelId: PanelId | null
  panelOrder: string[]
  sideChatFocusRequestId: number
  suppressNextContentFocus: boolean
  openPanel(id: PanelId, options?: { focus?: boolean }): void
  closePanel(id: PanelId): void
  setWidth(widthPx: number): void
  toggleCollapsed(): void
  restore(state: { open: boolean; widthPx: number; openPanelIds: PanelId[]; activePanelId: PanelId | null; panelOrder: string[] }): void
  setPanelOrder(order: string[]): void
  syncRenderedState(open: boolean, widthPx: number): void
}

export const useRightPaneStore = create<RightPaneState>((set, get) => ({
  open: false,
  widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX,
  openPanelIds: [],
  activePanelId: null,
  panelOrder: [],
  sideChatFocusRequestId: 0,
  suppressNextContentFocus: false,
  openPanel: (id, options) => {
    const { openPanelIds, activePanelId, sideChatFocusRequestId } = get()
    const focus = options?.focus ?? true
    const listsChange = !openPanelIds.includes(id) || activePanelId !== id
    set({
      open: true,
      openPanelIds: openPanelIds.includes(id) ? openPanelIds : [...openPanelIds, id],
      activePanelId: id,
      sideChatFocusRequestId: id === 'side-chat' && focus ? sideChatFocusRequestId + 1 : sideChatFocusRequestId,
      suppressNextContentFocus: listsChange ? !focus : get().suppressNextContentFocus && !focus
    })
  },
  closePanel: (id) => {
    const { openPanelIds, activePanelId } = get()
    const index = openPanelIds.indexOf(id)
    const nextIds = openPanelIds.filter((openId) => openId !== id)
    set({
      openPanelIds: nextIds,
      activePanelId:
        activePanelId === id
          ? nextIds.length > 0
            ? nextIds[Math.min(index, nextIds.length - 1)]
            : null
          : activePanelId
    })
  },
  setWidth: (widthPx) => set({ widthPx }),
  toggleCollapsed: () => set({ open: !get().open }),
  restore: (state) => set(state),
  setPanelOrder: (panelOrder) => set({ panelOrder }),
  syncRenderedState: (open, widthPx) => set({ open, widthPx })
}))

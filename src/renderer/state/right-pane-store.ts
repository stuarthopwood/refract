import { create } from 'zustand'
import type { PanelId } from '../features/right-pane/panel-registry'
import { useDocumentTabsStore, type SessionDocuments, type TabKey } from './document-tabs-store'
import { frontSessionIdOf, useSplitStore } from './split-store'

export const RIGHT_PANE_DEFAULT_WIDTH_PX = 320
export const RIGHT_PANE_MIN_WIDTH_PX = 240
/** Mirrors `WIDTH_MAX` in right_pane.rs: a ceiling against a corrupt row, not a layout cap. */
export const RIGHT_PANE_SANITY_MAX_WIDTH_PX = 4096

interface RightPaneState {
  open: boolean
  widthPx: number
  openPanelIds: PanelId[]
  /** The panel half of the selection: the last active panel, still set while a document tab is selected. The selected tab itself is derived (`resolveActiveTab`), never stored. */
  activePanelId: PanelId | null
  panelOrder: string[]
  /** Never true while `open` is false: the chat and the pane are never both hidden (FR-018). */
  chatCollapsed: boolean
  sideChatFocusRequestId: number
  suppressNextContentFocus: boolean
  openPanel(id: PanelId, options?: { focus?: boolean }): void
  closePanel(id: PanelId): void
  /** Selecting a document tab sets that Session's active document id; selecting a panel tab clears it. A panel key has no Session, so `sessionId` names the one to clear. */
  activateTab(key: TabKey, sessionId?: string | null): void
  setWidth(widthPx: number): void
  toggleCollapsed(): void
  /** Hiding the chat opens the pane. */
  setChatCollapsed(collapsed: boolean): void
  restore(state: {
    open: boolean
    widthPx: number
    openPanelIds: PanelId[]
    activePanelId: PanelId | null
    panelOrder: string[]
    chatCollapsed: boolean
  }): void
  setPanelOrder(order: string[]): void
  syncRenderedState(open: boolean, widthPx: number): void
}

const panelKey = (id: PanelId | null): TabKey | null => (id === null ? null : { kind: 'panel', id })

/** The tab selected for a Session: its active document tab, else the last active panel, else none. */
export function resolveActiveTab(sessionId: string | null, activePanelId: PanelId | null, documents: Pick<SessionDocuments, 'tabs' | 'activeId'> | undefined): TabKey | null {
  const activeId = documents?.activeId
  if (sessionId !== null && activeId != null && documents?.tabs.some((tab) => tab.id === activeId)) return { kind: 'document', sessionId, id: activeId }
  return panelKey(activePanelId)
}

/** The tab selected in the front Session's pane, derived on every read so a Session switch can never leave it stale. */
export function frontActiveTab(): TabKey | null {
  const frontSessionId = frontSessionIdOf(useSplitStore.getState())
  const documents = frontSessionId === null ? undefined : useDocumentTabsStore.getState().bySession[frontSessionId]
  return resolveActiveTab(frontSessionId, useRightPaneStore.getState().activePanelId, documents)
}

export const useRightPaneStore = create<RightPaneState>((set, get) => ({
  open: false,
  widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX,
  openPanelIds: [],
  activePanelId: null,
  panelOrder: [],
  chatCollapsed: false,
  sideChatFocusRequestId: 0,
  suppressNextContentFocus: false,
  openPanel: (id, options) => {
    const { openPanelIds, activePanelId, sideChatFocusRequestId } = get()
    const focus = options?.focus ?? true
    const listsChange = !openPanelIds.includes(id) || activePanelId !== id
    // A panel selected over the front Session's document tab drops that selection; another Session's stays.
    const frontSessionId = frontSessionIdOf(useSplitStore.getState())
    if (frontSessionId !== null) useDocumentTabsStore.getState().setActiveDocument(frontSessionId, null)
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
    const nextActive = activePanelId === id ? (nextIds[Math.min(index, nextIds.length - 1)] ?? null) : activePanelId
    // The selected document tab lives in the documents store, so it stays selected when a panel behind it closes.
    set({ openPanelIds: nextIds, activePanelId: nextActive })
  },
  activateTab: (key, sessionId) => {
    if (key.kind === 'panel') {
      if (!get().openPanelIds.includes(key.id)) return
      if (sessionId) useDocumentTabsStore.getState().setActiveDocument(sessionId, null)
      set({ activePanelId: key.id })
      return
    }
    if (!useDocumentTabsStore.getState().bySession[key.sessionId]?.tabs.some((tab) => tab.id === key.id)) return
    useDocumentTabsStore.getState().setActiveDocument(key.sessionId, key.id)
  },
  setWidth: (widthPx) => set({ widthPx }),
  toggleCollapsed: () => set({ open: !get().open, chatCollapsed: get().open ? false : get().chatCollapsed }),
  setChatCollapsed: (collapsed) => set(collapsed ? { chatCollapsed: true, open: true } : { chatCollapsed: false }),
  restore: (state) => set({ ...state, chatCollapsed: state.open && state.chatCollapsed }),
  setPanelOrder: (panelOrder) => set({ panelOrder }),
  syncRenderedState: (open, widthPx) => set({ open, widthPx, chatCollapsed: open ? get().chatCollapsed : false })
}))

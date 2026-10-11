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
  /** Gate-fix (round 2, A11y2 Medium, spec 014 FR-013): bumped every time `openPanel('side-chat')`
   * runs, whether or not it was already the active panel -- `SideChatPanel` watches this id and
   * moves focus into its own composer whenever it changes, covering the rail, the launcher, and
   * `/btw` (all three funnel through this same `openPanel` call) including the "`/btw` while
   * Side chat is already active" case a plain open-transition effect would miss. Side-chat-
   * specific (not a generic per-panel mechanism) since FR-013 only asks for this panel's own
   * composer; the other three hosted panels have no composer to focus. */
  sideChatFocusRequestId: number
  /** Opens the pane if collapsed; adds `id` if absent; makes it active (FR-005). Gate-fix
   * (round 6, Code6/A11y6/Sec6 Medium): `options.focus` defaults `true`; pass `false` for
   * `side-chat` to open (and load) the panel WITHOUT bumping `sideChatFocusRequestId` -- used
   * when a typed `/btw <question>` must keep focus (and the draft) in the main composer while
   * its history is still loading, instead of stealing focus into an empty side-chat textarea. */
  openPanel(id: PanelId, options?: { focus?: boolean }): void
  /** Removes `id`; if it was active, activates the NEIGHBOUR left in its place -- the tab at the
   * same index in the remaining order, clamped to the new last index (gate remediation, round 1
   * of PR2's own gate: three reviewers converged that "activate the last tab" desynced from
   * `PanelTabBar.tsx`'s own focus target, which always moves to the neighbour, the standard tabs
   * pattern) -- or `null` if `openPanelIds` is now empty (FR-009). Never collapses `open`. */
  closePanel(id: PanelId): void
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
  sideChatFocusRequestId: 0,
  openPanel: (id, options) => {
    const { openPanelIds, sideChatFocusRequestId } = get()
    const focus = options?.focus ?? true
    set({
      open: true,
      openPanelIds: openPanelIds.includes(id) ? openPanelIds : [...openPanelIds, id],
      activePanelId: id,
      sideChatFocusRequestId: id === 'side-chat' && focus ? sideChatFocusRequestId + 1 : sideChatFocusRequestId
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
  syncRenderedState: (open, widthPx) => set({ open, widthPx })
}))

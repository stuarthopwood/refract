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
  /** Gate-fix (round 7, Code7/A11y7/Sec7 HIGH): one-shot, set by `openPanel(id, { focus: false
   * })` and consumed (always cleared, whether or not it was actually honoured) by
   * `RightPaneShell`'s own "focus the newly opened panel's content" effect. That effect
   * otherwise moves focus into the panel's `tabIndex=-1` content wrapper for ANY genuinely new
   * open, regardless of `sideChatFocusRequestId` -- round 6's own `focus:false` only suppressed
   * the side-chat TEXTAREA'S OWN focus request (`sideChatFocusRequestId`), so `/btw`'s `!loaded`
   * path still stole focus out of the main composer whenever the pane was collapsed or the
   * side-chat tab was not already open (the common first-`/btw`-of-run case) -- WCAG 2.4.3/
   * 3.2.2, confirmed live round 7 (screenshot 05's own focus-visible outline). */
  suppressNextContentFocus: boolean
  /** Opens the pane if collapsed; adds `id` if absent; makes it active (FR-005). Gate-fix
   * (round 6, Code6/A11y6/Sec6 Medium; round 7, Code7/A11y7/Sec7 HIGH): `options.focus` defaults
   * `true`; pass `false` for `side-chat` to open (and load) the panel WITHOUT bumping
   * `sideChatFocusRequestId` OR moving focus into the panel's own content region at all -- used
   * when a typed `/btw <question>` must keep focus (and the draft) in the main composer while
   * its history is still loading, instead of stealing focus into an empty side-chat textarea
   * (or, before round 7's own fix, the panel's generic content wrapper instead). */
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
      // Gate-fix (round 8, Sec8/A11y8 Low): only set when this open/active-panel change will
      // actually make `RightPaneShell`'s own effect re-run (a genuine new open, or switching
      // which panel is active) -- when `id` was ALREADY the open, active panel (round 7's own
      // version always set it unconditionally), neither `openPanelIds` nor `activePanelId`
      // changes, so that effect never re-runs to consume (and clear) the flag; it would then
      // sit `true` until the NEXT `openPanel`/`closePanel` call, which is harmless (every real
      // open still goes through one of those and resets it first) but was needlessly imprecise.
      // Gate-fix (round 9, A11y9/Code9/Verif9 Low; wording corrected round 10, Code10/Sec10/
      // A11y10 Low -- round 9's own comment here described the wrong case): when `listsChange`
      // is false (this call can't make the consuming effect re-run), AND the previous call --
      // STILL pending in the same tick, before the effect has run -- already asked to suppress,
      // keep that pending suppression if THIS call is ALSO `{ focus: false }`, instead of
      // unconditionally overwriting it back to `false`. Round 8's own `!focus && listsChange`
      // would silently drop a pending `true` suppression if a SECOND `{ focus: false }` open of
      // the SAME already-open-and-active panel landed before the effect consumed the first one
      // -- a narrow, same-tick race, but a real one (discrete React events can batch more than
      // one dispatched update before paint). A second call with `focus: true` (the default)
      // still clears a pending suppression on purpose: that caller explicitly asked for focus,
      // so its intent wins over an earlier, still-pending `focus: false` request.
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
  syncRenderedState: (open, widthPx) => set({ open, widthPx })
}))

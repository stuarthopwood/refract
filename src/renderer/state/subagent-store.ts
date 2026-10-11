import { create } from 'zustand'
import type { TranscriptItem } from '../../shared/model'
import type { TranscriptOp } from '../../shared/ipc'
import { notify } from './notify'
import { useRightPaneStore } from './right-pane-store'

// Spec 004 FR-017 to FR-020: the selected subagent's live stream. `streams` holds every
// subagent's stream the panel has ever fetched this turn (cleared on `close`/a new turn), so
// re-selecting one already seen does not re-fetch. Spec 013 (research.md decision 3): "is this
// panel showing" moved to `right-pane-store.ts`'s `openPanelIds` -- this store only tracks which
// Session the panel's content is bound to and that Session's selected subagent/streams.

function applyOps(items: TranscriptItem[], ops: TranscriptOp[]): TranscriptItem[] {
  let next = items
  for (const op of ops) {
    if (op.op === 'reset') {
      next = op.items
      continue
    }
    const index = next.findIndex((item) => item.id === op.item.id)
    next = index === -1 ? [...next, op.item] : next.map((item, i) => (i === index ? op.item : item))
  }
  return next
}

interface SubagentPanelState {
  sessionId: string | null
  selectedId: string | null
  streams: Record<string, TranscriptItem[]>
  /** Binds the panel's content to `sessionId` -- the shell (`right-pane-store.ts`'s
   * `openPanel('subagents')`) decides whether the panel is actually showing. */
  openPanel(sessionId: string): void
  /** `restoreFocus` (default true) moves focus to the Subagents chip only when it was
   * actually inside the panel at close time -- callers closing the panel for a reason OTHER
   * than the user clicking its own Close button (a new turn starting, the visible Session
   * archiving/vanishing) pass `false` so a steal never happens. Also keeps `right-pane-
   * store.ts`'s `openPanelIds` in sync (a no-op if 'subagents' is already closed there), so
   * every existing call site stays the single place this panel's close goes through. */
  closePanel(options?: { restoreFocus?: boolean }): void
  selectSubagent(subagentId: string): Promise<void>
  applyPatch(sessionId: string, subagentId: string, ops: TranscriptOp[]): void
  reset(): void
  /** Spec 004 remediation (HIGH, code-reviewer + test-reviewer sibling case): fired by
   * readout-store.ts's `applySubagents` the instant it sees a new turn start for this panel's
   * own Session (the one place `SessionAgent` ever empties `runtime.subagents` back to `[]`).
   * Closes the panel (same as an explicit Close click, including its own focus-restore) if it
   * was actually open for this Session -- a later turn reusing a subagent name must never
   * silently inherit the previous turn's cached stream under a visually "open" panel showing a
   * list that has already moved on. Does nothing for a Session this panel isn't tracking. */
  resetForNewTurn(sessionId: string): void
  /** Spec 013 gate remediation (Critical/High): dragging the pane fully shut MUST NOT close the
   * panel (FR-003, data-model.md's collapsed-pane invariant, issue://538 "collapsing is a
   * separate action from closing") -- it keeps `sessionId`/`selectedId` bound, only stopping
   * main's live stream so a collapsed-but-bound panel isn't still being pushed patches for
   * content nobody can see. */
  suspend(): void
  /** The pane's counterpart to `suspend()`, called when it is dragged back open with this panel
   * still bound: re-subscribes and re-fetches the selected subagent's stream, since `suspend()`
   * dropped the cached copy (`selectSubagent` returns early when a stream is already cached, so
   * the cache must be cleared for this to actually re-fetch). */
  resume(): void
}

export const useSubagentPanelStore = create<SubagentPanelState>((set, get) => ({
  sessionId: null,
  selectedId: null,
  streams: {},
  openPanel: (sessionId) => {
    const { sessionId: prevSessionId } = get()
    // Gate remediation (Low/Medium, code-reviewer + security-auditor): rebinding to a different
    // Session without clearing the old one left main still forwarding the previous Session's
    // selected subagent's patches to no listener, and this store's own `selectedId`/`streams`
    // still describing that old Session underneath the new binding.
    if (prevSessionId && prevSessionId !== sessionId) {
      void window.refract.chat.setVisibleSubagent(prevSessionId, null)
      set({ sessionId, selectedId: null, streams: {} })
    } else {
      set({ sessionId })
    }
  },
  closePanel: (options) => {
    const { sessionId } = get()
    if (sessionId) void window.refract.chat.setVisibleSubagent(sessionId, null)
    // Critical remediation (a11y + test-reviewer, same root cause from two angles): `sessionId`
    // used to survive a close, so `panelSessionId && <SubagentPanel/>` kept rendering the
    // panel's real content -- Close button and every subagent row button included -- forever
    // after the first open/close, collapsed to zero width but never unmounted (react-resizable-
    // panels sets no inert/hidden/display:none on a collapsed Panel). That stranded every one of
    // those controls in the Tab order and in screen-reader browse mode. The shell (RightPaneShell)
    // also gates the content on `openPanelIds`, but clearing `sessionId` here too means no stale
    // panel state lingers for `resetForNewTurn`/the ChatPane archive-while-open guard to ever see.
    set({ sessionId: null, selectedId: null, streams: {} })
    useRightPaneStore.getState().closePanel('subagents')
    // High remediation (code-reviewer, spec-004 final confirmation pass): the readout update
    // that unmounts this panel's content is debounced, so the chip this used to focus
    // unconditionally was ALWAYS still mounted at this point, regardless of whether focus was
    // ever inside the panel to begin with -- `resetForNewTurn`'s own call path (a new turn
    // starting, e.g. right after the user sends the very message that starts it) and the
    // ChatPane archive path all close this panel for reasons that have nothing to do with the
    // user having been inside it, and every one of them now passes `restoreFocus: false` to skip
    // this outright rather than steal focus out of wherever it already was (the message box, most
    // often, the very moment the user wants to type a follow-up). The containment check below is
    // the remaining guard for this component's only other caller, the panel's own explicit Close
    // button: focus should return to the chip only if it was actually inside the panel when
    // Close was clicked. `right-pane-active-panel` is the shell's own wrapper (header + content)
    // now that the panel's Close button lives in the shell, not inside this panel's own content
    // (spec 013 T012). `hosted-panel-actions.ts`'s `closeHostedPanel` is the generalised caller
    // that falls back further (the rail button, then the launcher) when this restore doesn't
    // fire -- for example the chip isn't rendered because this turn has no subagents.
    if (options?.restoreFocus ?? true) {
      const panelEl = document.getElementById('right-pane-active-panel')
      if (panelEl?.contains(document.activeElement)) {
        document.querySelector<HTMLElement>('button[aria-label^="Open subagents panel"]')?.focus()
      }
    }
  },
  selectSubagent: async (subagentId) => {
    const { sessionId } = get()
    if (!sessionId) return
    set({ selectedId: subagentId })
    await window.refract.chat.setVisibleSubagent(sessionId, subagentId)
    if (get().streams[subagentId]) return // already fetched this turn
    const result = await window.refract.chat.subagentSnapshot(sessionId, subagentId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    // Gate remediation (Low, Code2/Sec2): a collapse (`suspend()`) racing this in-flight fetch
    // could otherwise write a stale snapshot back in AFTER suspend cleared `streams`, which
    // `resume()` would then treat as already-cached and skip re-fetching, silently dropping the
    // patches that arrived while collapsed. Only commit the result if the binding this fetch was
    // FOR is still the current one, and the pane is still open (not mid/post-collapse).
    if (get().sessionId !== sessionId || get().selectedId !== subagentId || !useRightPaneStore.getState().open) return
    set((state) => ({ streams: { ...state.streams, [subagentId]: result.value } }))
  },
  applyPatch: (sessionId, subagentId, ops) => {
    const state = get()
    if (sessionId !== state.sessionId || subagentId !== state.selectedId) return
    const current = state.streams[subagentId] ?? []
    set({ streams: { ...state.streams, [subagentId]: applyOps(current, ops) } })
  },
  reset: () => {
    // Medium remediation (code-reviewer): `closePanel()` already tells main to stop forwarding
    // the selected subagent's live patches (`chat.setVisibleSubagent(sessionId, null)`);
    // `reset()` (the Session-switch/recover path, ChatPane.tsx's `applySnapshot`) never did,
    // leaving main still queuing patches for a subagent id the panel had already walked away
    // from, for no listener.
    const { sessionId } = get()
    if (sessionId) void window.refract.chat.setVisibleSubagent(sessionId, null)
    set({ sessionId: null, selectedId: null, streams: {} })
    useRightPaneStore.getState().closePanel('subagents')
  },
  resetForNewTurn: (sessionId) => {
    const state = get()
    if (state.sessionId !== sessionId) return
    if (useRightPaneStore.getState().openPanelIds.includes('subagents')) {
      state.closePanel({ restoreFocus: false })
      return
    }
    set({ selectedId: null, streams: {} })
  },
  suspend: () => {
    const { sessionId } = get()
    if (sessionId) void window.refract.chat.setVisibleSubagent(sessionId, null)
    set({ streams: {} })
  },
  resume: () => {
    const { selectedId } = get()
    if (!selectedId) return
    // Belt-and-braces alongside the guard in `selectSubagent` above: a stale write that landed
    // between `suspend()` and this call would otherwise be mistaken for an already-fetched cache.
    set({ streams: {} })
    void get().selectSubagent(selectedId)
  }
}))

import { create } from 'zustand'
import { toast } from 'sonner'
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

// Gate remediation (Low, all four round-2/3 reviewers): a plain generation counter, not reactive
// store state -- every action that REBINDS or interrupts what `selectSubagent` is fetching FOR
// bumps it, and `selectSubagent` only commits its result if the generation is still the one it
// started under. Gate remediation (Medium, round 4): re-opening the SAME Session (no rebind) no
// longer bumps this -- doing so dropped a legitimate in-flight snapshot for no reason, leaving
// the stream rebuilt only from whatever patches happened to arrive afterward (a partial
// transcript, since the cache then looked "already fetched" to a later re-select).
let fetchSeq = 0

interface SubagentPanelState {
  sessionId: string | null
  selectedId: string | null
  streams: Record<string, TranscriptItem[]>
  /** Spec 013 gate remediation (High, round 3): true only between a real `suspend()` and its
   * matching `resume()` -- lets `resume()` no-op when nothing was ever suspended (a fresh mount
   * with a live, uninterrupted stream needs no re-fetch). Gate remediation (High, round 4):
   * re-opening the SAME Session via the rail, the chip or the launcher after a drag-collapse
   * must NOT clear this on its own -- only `resume()` (a genuine resume), `closePanel`, `reset`
   * or a rebind to a DIFFERENT Session may, since those are the only events that either resolve
   * the suspension or make it moot. */
  suspended: boolean
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
  /** The pane's counterpart to `suspend()`: re-subscribes and re-fetches the selected subagent's
   * stream. No-ops if nothing was actually suspended. `App.tsx` calls this from both its normal
   * expand branch and its mount branch (a remount, e.g. returning from Settings while the pane
   * was left open in the Pull requests view) -- gate remediation (round 4): the mount branch
   * call is itself conditional (a visible remount landing specifically in the chat view with the
   * pane store still marked open), not unconditional; this method's own `suspended` check is the
   * second, independent guard that makes either call site safe to call freely. */
  resume(): void
}

export const useSubagentPanelStore = create<SubagentPanelState>((set, get) => ({
  sessionId: null,
  selectedId: null,
  streams: {},
  suspended: false,
  openPanel: (sessionId) => {
    const { sessionId: prevSessionId } = get()
    // Gate remediation (Low/Medium, code-reviewer + security-auditor): rebinding to a different
    // Session without clearing the old one left main still forwarding the previous Session's
    // selected subagent's patches to no listener, and this store's own `selectedId`/`streams`
    // still describing that old Session underneath the new binding.
    if (prevSessionId && prevSessionId !== sessionId) {
      fetchSeq += 1
      void window.refract.chat
        .setVisibleSubagent(prevSessionId, null)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      set({ sessionId, selectedId: null, streams: {}, suspended: false })
    } else {
      // Gate remediation (High, round 4): re-opening the SAME Session (rail, chip or launcher,
      // after a drag-collapse) must leave `suspended`/`streams` exactly as `suspend()` left
      // them -- only `resume()` (called next, from the expand branch this triggers) may clear
      // `suspended` and re-fetch. Clearing it HERE instead made `resume()` see `!suspended` and
      // no-op, leaving the selected subagent marked current with an empty, never-refetched
      // stream and main still not forwarding patches.
      set({ sessionId })
    }
  },
  closePanel: (options) => {
    const { sessionId } = get()
    fetchSeq += 1
    if (sessionId) {
      void window.refract.chat
        .setVisibleSubagent(sessionId, null)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    }
    // Critical remediation (a11y + test-reviewer, same root cause from two angles): `sessionId`
    // used to survive a close, so `panelSessionId && <SubagentPanel/>` kept rendering the
    // panel's real content -- Close button and every subagent row button included -- forever
    // after the first open/close, collapsed to zero width but never unmounted (react-resizable-
    // panels sets no inert/hidden/display:none on a collapsed Panel). That stranded every one of
    // those controls in the Tab order and in screen-reader browse mode. The shell (RightPaneShell)
    // also gates the content on `openPanelIds`, but clearing `sessionId` here too means no stale
    // panel state lingers for `resetForNewTurn`/the ChatPane archive-while-open guard to ever see.
    set({ sessionId: null, selectedId: null, streams: {}, suspended: false })
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
    // Close was clicked, and only for Subagents -- it keeps first priority over the generalised
    // rail-button/launcher fallback `hosted-panel-actions.ts`'s `closeHostedPanel` applies for
    // every other case (FR-024, FR-015 unchanged). `right-pane-active-panel` is the shell's own
    // wrapper (header + content) now that the panel's Close button lives in the shell, not
    // inside this panel's own content (spec 013 T012).
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
    const seq = fetchSeq
    // Gate remediation (Low, round 4, Code4): captured BEFORE the `setVisibleSubagent` await, not
    // re-checked after it -- `applyPatch` can create a from-`[]` entry for `subagentId` while
    // that call is in flight (a patch racing ahead of the invoke reply), and re-checking the
    // cache afterward would then see that partial entry as "already fetched" and skip the real
    // snapshot, leaving the stream permanently incomplete.
    const alreadyFetched = Boolean(get().streams[subagentId])
    set({ selectedId: subagentId })
    try {
      await window.refract.chat.setVisibleSubagent(sessionId, subagentId)
      if (alreadyFetched) return
      const result = await window.refract.chat.subagentSnapshot(sessionId, subagentId)
      if (!result.ok) {
        notify(result.error)
        return
      }
      // Gate remediation (Low, round 2/3, all four reviewers): only commit if nothing moved on
      // while this fetch was in flight -- a rebind, a close, or a new turn all bump `fetchSeq`,
      // so a stale snapshot from before any of them can never land after the fact.
      if (fetchSeq !== seq || get().sessionId !== sessionId || get().selectedId !== subagentId) return
      set((state) => ({ streams: { ...state.streams, [subagentId]: result.value } }))
    } catch (err) {
      // Gate remediation (Low, round 4): both IPC calls above can reject outright (not just
      // resolve with `{ok:false}`), and every caller of this method fires it with `void`, so an
      // unhandled rejection used to leave the panel silently blank with no user-visible error.
      toast.error(err instanceof Error ? err.message : String(err))
    }
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
    fetchSeq += 1
    if (sessionId) {
      void window.refract.chat
        .setVisibleSubagent(sessionId, null)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    }
    set({ sessionId: null, selectedId: null, streams: {}, suspended: false })
    useRightPaneStore.getState().closePanel('subagents')
  },
  resetForNewTurn: (sessionId) => {
    const state = get()
    if (state.sessionId !== sessionId) return
    if (useRightPaneStore.getState().openPanelIds.includes('subagents')) {
      state.closePanel({ restoreFocus: false })
      return
    }
    fetchSeq += 1
    set({ selectedId: null, streams: {}, suspended: false })
  },
  suspend: () => {
    const { sessionId } = get()
    fetchSeq += 1
    if (sessionId) {
      void window.refract.chat
        .setVisibleSubagent(sessionId, null)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    }
    set({ streams: {}, suspended: true })
  },
  resume: () => {
    // Gate remediation (High, round 3): only do anything if this panel was genuinely suspended --
    // a fresh mount whose stream was never interrupted (e.g. a straight chat -> Settings -> chat
    // round trip, which never fires `onResize` at all) needs no re-fetch; calling `resume()`
    // on every mount regardless would otherwise waste a round trip re-fetching data that was
    // never stale. See the interface doc comment above for why `App.tsx` can call this freely
    // from two sites without duplicating this check itself.
    if (!get().suspended) return
    const { selectedId } = get()
    fetchSeq += 1
    set({ suspended: false, streams: {} })
    if (selectedId) {
      void get()
        .selectSubagent(selectedId)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    }
  }
}))

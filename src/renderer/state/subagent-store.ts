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
  /** Gate round 4 fix (issue #941, P1, HIGH): the same `toolCallId:specIndex` composite key
   * `SubagentPanel.tsx`'s own tree rows carry, kept HERE (not as that component's local
   * `useState`) so a tab-switch remount (`RightPaneShell.tsx` unmounts the panel while its tab
   * isn't active) does not lose which of two same-named rows was actually selected, falling
   * back to "a row at all" (`tabbableIndex`'s own `found === -1 ? 0` branch) instead of the real
   * one. Set alongside `selectedId` by `selectSubagent`'s own optional second argument;
   * omitting that argument (as `resume()` does) leaves this field UNCHANGED, so a suspend/
   * resume round trip (no rebind, same selection) never discards a key a prior explicit
   * selection already set. `null` means "no specific instance known" (a name-only caller, or
   * nothing selected yet) -- `SubagentPanel.tsx` falls back to the first row matching
   * `selectedId` in that case, the same ambiguous-match behaviour this field exists to avoid
   * where a real key IS available. */
  selectedKey: string | null
  streams: Record<string, TranscriptItem[]>
  /** Spec 013 gate remediation (High, round 3): true only between a real `suspend()` and its
   * matching `resume()` -- lets `resume()` no-op when nothing was ever suspended (a fresh mount
   * with a live, uninterrupted stream needs no re-fetch). Gate remediation (High, round 4):
   * re-opening the SAME Session via the rail, the chip or the launcher after a drag-collapse
   * must NOT clear this on its own -- only `resume()` (a genuine resume), `closePanel`, `reset`
   * or a rebind to a DIFFERENT Session may, since those are the only events that either resolve
   * the suspension or make it moot. */
  suspended: boolean
  /** The control that opened the panel THIS time, recorded from `openPanel`'s own
   * `options?.opener` (issue #563): closing the panel focuses this element first, when it is
   * still connected to the document, before falling back to the Subagents chip (FR-027).
   * Replaced wholesale on every `openPanel` call -- each explicit open re-establishes who
   * opened it this time -- and cleared back to `null` wherever `sessionId` itself is cleared
   * (`closePanel`, `reset`). */
  openerEl: HTMLElement | null
  /** Issue #563 gate round 2 fix (High): the prior `focusRequestId` counter was never consumed
   * or reset, so `SubagentPanel.tsx`'s own effect ran on EVERY mount while it still read > 0 --
   * stealing focus into the tree on a plain tab-switch away and back, or a remount returning
   * from Settings, long after the pre-selected open that set it. One-shot instead: `openPanel`
   * replaces this wholesale with `options.selectSubagentId` (or `null` for a plain re-open with
   * no pre-selection); `SubagentPanel.tsx`'s focus effect consumes it -- focuses the row, then
   * calls `clearPendingFocus()` -- so a later remount with the SAME still-selected agent and no
   * new pre-selected open sees `null` and does nothing. */
  pendingFocusSubagentId: string | null
  /** Gate round 3 fix (issue #941, HIGH): `pendingFocusSubagentId` alone cannot disambiguate
   * two subagents sharing the same name (`SubagentSummary.id` IS the name) -- a Stage's own
   * "Uses:" link resolves to one SPECIFIC earlier agent by `toolCallId`+`specIndex`
   * (`groupSubagentStages.ts`'s `applyDependencies`), but a shared `selectedId`/`pendingFocus-
   * SubagentId` keyed on name alone would mark or focus BOTH same-named rows. This carries the
   * same `${toolCallId}:${specIndex}` composite `SubagentPanel.tsx` now also keys its own tree
   * ROWS by, so exactly one is focused/shown selected -- the underlying stream fetch
   * (`selectSubagent`/`setVisibleSubagent`) stays name-keyed regardless (a disclosed,
   * pre-existing backend-contract limitation: two same-named agents' own RESULT content cannot
   * be independently fetched without a wire-protocol change, out of this PR's scope). */
  pendingFocusSubagentKey: string | null
  /** Clears `pendingFocusSubagentId` back to `null` once `SubagentPanel.tsx`'s focus effect has
   * consumed it (focused the row). The one-shot half of the fix above: without this, the SAME
   * non-null value would still be sitting there for the next remount to misread as a fresh
   * request. */
  clearPendingFocus(): void
  /** Binds the panel's content to `sessionId` -- the shell (`right-pane-store.ts`'s
   * `openPanel('subagents')`) decides whether the panel is actually showing. `options.opener`
   * (issue #563, FR-027) records the control to return focus to on close; `options.
   * selectSubagentId` pre-selects an agent the same way a row click would (the chat pane's
   * Stage/chain rows activating a specific agent), reusing `selectSubagent` rather than
   * duplicating its fetch logic. `options.selectSubagentKey` (gate round 3, issue #941)
   * additionally disambiguates WHICH same-named row to select/focus when one exists. */
  openPanel(sessionId: string, options?: { selectSubagentId?: string; selectSubagentKey?: string; opener?: HTMLElement | null }): void
  /** `restoreFocus` (default true) moves focus back to whichever control opened the panel only
   * when focus was actually inside the panel at close time -- callers closing the panel for a
   * reason OTHER than the user clicking its own Close button (a new turn starting, the visible
   * Session archiving/vanishing) pass `false` so a steal never happens. Prefers `openerEl`
   * (issue #563, FR-027) when it is still connected to the document, falling back to the
   * Subagents chip only when it is not (the pre-#563 target, still correct when nothing else
   * opened the panel). Also keeps `right-pane-store.ts`'s `openPanelIds` in sync (a no-op if
   * 'subagents' is already closed there), so every existing call site stays the single place
   * this panel's close goes through. */
  closePanel(options?: { restoreFocus?: boolean }): void
  /** `key` (gate round 4, issue #941, P1): the composite `toolCallId:specIndex` instance this
   * selection came from, when the caller knows it (a row's own `onFocus`, a pre-selected
   * `openPanel`) -- stored alongside `selectedId` as `selectedKey`. Omitting it (as `resume()`
   * does, re-selecting the same `selectedId` after a suspend with no new instance information)
   * leaves the EXISTING `selectedKey` unchanged; passing it explicitly (including `null`, a
   * deliberate "no specific instance known") always replaces it. */
  selectSubagent(subagentId: string, key?: string | null): Promise<void>
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
  selectedKey: null,
  streams: {},
  suspended: false,
  openerEl: null,
  pendingFocusSubagentId: null,
  pendingFocusSubagentKey: null,
  clearPendingFocus: () => set({ pendingFocusSubagentId: null, pendingFocusSubagentKey: null }),
  openPanel: (sessionId, options) => {
    const { sessionId: prevSessionId } = get()
    const openerEl = options?.opener ?? null
    // Gate round 2 fix: replaced wholesale on every call (`options.selectSubagentId` for a
    // genuine pre-selected open, `null` for a plain re-open with no pre-selection) -- never
    // bumped, so a later remount/tab-switch back with no new pre-selected open always reads
    // `null` here and `SubagentPanel.tsx`'s focus effect does nothing, instead of re-reading a
    // stale non-zero counter and stealing focus back into the tree.
    const pendingFocusSubagentId = options?.selectSubagentId ?? null
    const pendingFocusSubagentKey = options?.selectSubagentKey ?? null
    // Gate remediation (Low/Medium, code-reviewer + security-auditor): rebinding to a different
    // Session without clearing the old one left main still forwarding the previous Session's
    // selected subagent's patches to no listener, and this store's own `selectedId`/`streams`
    // still describing that old Session underneath the new binding.
    if (prevSessionId && prevSessionId !== sessionId) {
      fetchSeq += 1
      void window.refract.chat
        .setVisibleSubagent(prevSessionId, null)
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      set({
        sessionId,
        selectedId: null,
        selectedKey: null,
        streams: {},
        suspended: false,
        openerEl,
        pendingFocusSubagentId,
        pendingFocusSubagentKey
      })
    } else {
      // Gate remediation (High, round 4): re-opening the SAME Session (rail, chip or launcher,
      // after a drag-collapse) must leave `suspended`/`streams` exactly as `suspend()` left
      // them -- only `resume()` (called next, from the expand branch this triggers) may clear
      // `suspended` and re-fetch. Clearing it HERE instead made `resume()` see `!suspended` and
      // no-op, leaving the selected subagent marked current with an empty, never-refetched
      // stream and main still not forwarding patches. `openerEl` is replaced wholesale
      // regardless (issue #563): each explicit open re-establishes who opened it this time,
      // even a re-open of the same Session.
      set({ sessionId, openerEl, pendingFocusSubagentId, pendingFocusSubagentKey })
    }
    // Issue #563: a caller (the chat pane's Stage/chain rows) can open the panel pre-selected
    // on a specific agent -- reuses `selectSubagent`'s own fetch/cache logic rather than
    // duplicating it; `sessionId` above is already committed by the synchronous `set` calls
    // just above, so `selectSubagent`'s own `get().sessionId` read sees it.
    if (options?.selectSubagentId) void get().selectSubagent(options.selectSubagentId, options.selectSubagentKey ?? null)
  },
  closePanel: (options) => {
    const { sessionId, openerEl } = get()
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
    set({ sessionId: null, selectedId: null, selectedKey: null, streams: {}, suspended: false, openerEl: null, pendingFocusSubagentId: null, pendingFocusSubagentKey: null })
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
    // button: focus should return to whichever control opened it only if it was actually inside
    // the panel when Close was clicked -- it keeps first priority over the generalised
    // rail-button/launcher fallback `hosted-panel-actions.ts`'s `closeHostedPanel` applies for
    // every other case (FR-024, FR-015 unchanged). `right-pane-active-panel` is the shell's own
    // wrapper (header + content) now that the panel's Close button lives in the shell, not
    // inside this panel's own content (spec 013 T012).
    if (options?.restoreFocus ?? true) {
      const panelEl = document.getElementById('right-pane-active-panel')
      if (panelEl?.contains(document.activeElement)) {
        // Issue #563, FR-027: whichever control opened the panel THIS time takes priority over
        // the Subagents chip now that something other than the chip (the chat pane's new
        // Subagent chain row) can open it; the chip stays the fallback for whenever `openerEl`
        // is unset or has since left the document (e.g. its own row scrolled out and unmounted).
        if (openerEl?.isConnected) openerEl.focus()
        else document.querySelector<HTMLElement>('button[aria-label^="Open subagents panel"]')?.focus()
      }
    }
  },
  selectSubagent: async (subagentId, key) => {
    const { sessionId } = get()
    if (!sessionId) return
    const seq = fetchSeq
    // Gate remediation (Low, round 4, Code4): captured BEFORE the `setVisibleSubagent` await, not
    // re-checked after it -- `applyPatch` can create a from-`[]` entry for `subagentId` while
    // that call is in flight (a patch racing ahead of the invoke reply), and re-checking the
    // cache afterward would then see that partial entry as "already fetched" and skip the real
    // snapshot, leaving the stream permanently incomplete.
    const alreadyFetched = Boolean(get().streams[subagentId])
    // Gate round 4 fix (issue #941, P1): `key === undefined` means the caller (e.g. `resume()`,
    // re-selecting the same agent with no new instance information) did not resolve one --
    // leave the EXISTING `selectedKey` untouched rather than clobbering a real key a prior
    // explicit selection already set. A caller that DOES know (a row's own `onFocus`, a
    // pre-selected `openPanel`) always passes it explicitly, including `null` for "deliberately
    // no specific instance".
    set((state) => ({ selectedId: subagentId, selectedKey: key !== undefined ? key : state.selectedKey }))
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
    set({ sessionId: null, selectedId: null, selectedKey: null, streams: {}, suspended: false, openerEl: null, pendingFocusSubagentId: null, pendingFocusSubagentKey: null })
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
    set({ selectedId: null, selectedKey: null, streams: {}, suspended: false })
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

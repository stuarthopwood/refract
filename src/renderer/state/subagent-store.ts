import { create } from 'zustand'
import { toast } from 'sonner'
import type { TranscriptItem } from '../../shared/model'
import type { TranscriptOp } from '../../shared/ipc'
import { notify } from './notify'
import { useRightPaneStore } from './right-pane-store'

// Streams are cached per subagent for the turn (cleared on `close`/a new turn) so re-selecting one skips the re-fetch.
// Whether the panel shows lives in `right-pane-store.ts`; this store only binds content to a Session.

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

// Plain counter, not store state: actions that rebind or interrupt a fetch bump it, and `selectSubagent` commits
// only if it is unchanged. Re-opening the SAME Session must not bump it, or a legitimate in-flight snapshot is dropped.
let fetchSeq = 0

interface SubagentPanelState {
  sessionId: string | null
  selectedId: string | null
  /** The `toolCallId:specIndex` key of the selected tree row; kept here so a tab-switch remount keeps which same-named row was selected (#941). `resume()` leaves it unchanged. */
  selectedKey: string | null
  streams: Record<string, TranscriptItem[]>
  /** True between `suspend()` and `resume()`; re-opening the same Session must not clear it, only resume, close, reset or a rebind. */
  suspended: boolean
  /** The control that opened the panel this time; close refocuses it when still connected (#563). Cleared with `sessionId`. */
  openerEl: HTMLElement | null
  /** One-shot focus request set by `openPanel`; the panel's focus effect consumes it via `clearPendingFocus()` so a later remount doesn't steal focus (#563). */
  pendingFocusSubagentId: string | null
  /** Composite `toolCallId:specIndex` of the row to focus; ids are names, so same-named subagents need it to pick one row. The stream fetch stays name-keyed (#941). */
  pendingFocusSubagentKey: string | null
  /** Resets the one-shot focus request once consumed, so a remount doesn't misread it as fresh. */
  clearPendingFocus(): void
  /** Binds the panel to `sessionId`; `options.selectSubagentId`/`Key` pre-select an agent like a row click, and `opener` is refocused on close (#563). */
  openPanel(sessionId: string, options?: { selectSubagentId?: string; selectSubagentKey?: string; opener?: HTMLElement | null }): void
  /** Closes the panel; `restoreFocus` (default true) refocuses the opener (else the Subagents chip) only if focus was inside, so non-user closes pass `false`. */
  closePanel(options?: { restoreFocus?: boolean }): void
  /** Selects a subagent; `key` is its row instance, and omitting it keeps the existing `selectedKey` (`null` clears it). */
  selectSubagent(subagentId: string, key?: string | null): Promise<void>
  applyPatch(sessionId: string, subagentId: string, ops: TranscriptOp[]): void
  reset(): void
  /** Closes the panel when a new turn starts for its Session, so a reused subagent name never inherits the previous turn's cached stream. No-op for other Sessions. */
  resetForNewTurn(sessionId: string): void
  /** Stops main's live stream when the pane is dragged shut, keeping the binding: collapsing is not closing. */
  suspend(): void
  /** Re-subscribes and re-fetches the selected stream after `suspend()`; no-op if not suspended, so callers may call it freely. */
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
    // Replaced on every call (never bumped) so a later remount reads `null` and doesn't steal focus.
    const pendingFocusSubagentId = options?.selectSubagentId ?? null
    const pendingFocusSubagentKey = options?.selectSubagentKey ?? null
    // Rebinding must clear the old Session's selection and main's forwarding to it.
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
      // Re-opening the SAME Session must leave `suspended`/`streams` as `suspend()` left them: clearing here makes `resume()` no-op, leaving an empty never-refetched stream.
      set({ sessionId, openerEl, pendingFocusSubagentId, pendingFocusSubagentKey })
    }
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
    // Clearing `sessionId` unmounts the panel content; a collapsed Panel is never inert, so stale controls would stay in the Tab order.
    set({ sessionId: null, selectedId: null, selectedKey: null, streams: {}, suspended: false, openerEl: null, pendingFocusSubagentId: null, pendingFocusSubagentKey: null })
    useRightPaneStore.getState().closePanel('subagents')
    // Refocus only when focus was inside the panel, so non-user closes (new turn, archive) never steal it.
    if (options?.restoreFocus ?? true) {
      const panelEl = document.getElementById('right-pane-active-panel')
      if (panelEl?.contains(document.activeElement)) {
        // The opener takes priority; the chip is the fallback when it has left the document.
        if (openerEl?.isConnected) openerEl.focus()
        else document.querySelector<HTMLElement>('button[aria-label^="Open subagents panel"]')?.focus()
      }
    }
  },
  selectSubagent: async (subagentId, key) => {
    const { sessionId } = get()
    if (!sessionId) return
    const seq = fetchSeq
    // Captured before the await: a patch racing ahead can create a partial entry that would otherwise look already fetched.
    const alreadyFetched = Boolean(get().streams[subagentId])
    // `undefined` key keeps the existing `selectedKey`; callers that know the instance pass it, `null` included.
    set((state) => ({ selectedId: subagentId, selectedKey: key !== undefined ? key : state.selectedKey }))
    try {
      await window.refract.chat.setVisibleSubagent(sessionId, subagentId)
      if (alreadyFetched) return
      const result = await window.refract.chat.subagentSnapshot(sessionId, subagentId)
      if (!result.ok) {
        notify(result.error)
        return
      }
      // Drop a stale snapshot if a rebind, close or new turn happened mid-fetch.
      if (fetchSeq !== seq || get().sessionId !== sessionId || get().selectedId !== subagentId) return
      set((state) => ({ streams: { ...state.streams, [subagentId]: result.value } }))
    } catch (err) {
      // Callers fire this with `void`, so a rejected IPC call must surface here.
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
    // Like `closePanel()`, tell main to stop forwarding the selected subagent's patches.
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
    // A never-interrupted mount (e.g. chat -> Settings -> chat) needs no re-fetch.
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

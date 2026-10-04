import { create } from 'zustand'
import type { TranscriptItem } from '../../shared/model'
import type { TranscriptOp } from '../../shared/ipc'
import { notify } from './notify'

// Spec 004 FR-017 to FR-020: the Subagents panel's open/closed state and the selected subagent's
// live stream. `streams` holds every subagent's stream the panel has ever fetched this turn
// (cleared on `close`/a new turn), so re-selecting one already seen does not re-fetch.

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
  open: boolean
  sessionId: string | null
  selectedId: string | null
  streams: Record<string, TranscriptItem[]>
  openPanel(sessionId: string): void
  closePanel(): void
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
}

export const useSubagentPanelStore = create<SubagentPanelState>((set, get) => ({
  open: false,
  sessionId: null,
  selectedId: null,
  streams: {},
  openPanel: (sessionId) => set({ open: true, sessionId }),
  closePanel: () => {
    const { sessionId } = get()
    if (sessionId) void window.refract.chat.setVisibleSubagent(sessionId, null)
    // Critical remediation (a11y + test-reviewer, same root cause from two angles): `sessionId`
    // used to survive a close, so `panelSessionId && <SubagentPanel/>` (App.tsx) kept rendering
    // the panel's real content -- Close button and every subagent row button included -- forever
    // after the first open/close, collapsed to zero width but never unmounted (react-resizable-
    // panels sets no inert/hidden/display:none on a collapsed Panel). That stranded every one of
    // those controls in the Tab order and in screen-reader browse mode. App.tsx now also gates
    // the content on `panelOpen`, but clearing `sessionId` here too means no stale panel state
    // lingers for `resetForNewTurn`/the ChatPane archive-while-open guard to ever see.
    set({ open: false, sessionId: null, selectedId: null, streams: {} })
    // T024 live-finding fix (FR-020, WCAG 2.1 AA 2.4.3): the panel stays permanently mounted,
    // collapsed to zero width (App.tsx, T021's own note), so a focused element inside it (the
    // Close button itself, most often) is never unmounted or blurred by the collapse -- without
    // this, keyboard focus was silently stranded on a now off-screen, clipped button, matching
    // `focusSessionsNav`'s own always-connected-fallback pattern (`lib/focus.ts`), moved here
    // (rather than only in `SubagentPanel.tsx`'s own handler) so every `closePanel()` caller gets
    // the same return-focus behaviour.
    document.querySelector<HTMLElement>('button[aria-label^="Open subagents panel"]')?.focus()
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
    set({ open: false, sessionId: null, selectedId: null, streams: {} })
  },
  resetForNewTurn: (sessionId) => {
    const state = get()
    if (state.sessionId !== sessionId) return
    if (state.open) {
      state.closePanel()
      return
    }
    set({ selectedId: null, streams: {} })
  }
}))

import { create } from 'zustand'
import type { SplitLayout } from '../../shared/model'

// Spec 005 (data-model.md "Held in memory... Split"): generalises the single `visibleSessionId`
// (sessions-store.ts, removed by T012) into the per-pane Split. `paneSessionIds` holds 1 element
// for today's single-pane behaviour, 2 for an open split; there is no 0-vs-1-vs-2 special type,
// just an array, matching data-model.md's own `SplitState` shape exactly.

interface SplitState {
  /** 1 element = single pane; 2 = split. Index 0 is the left/first pane. */
  paneSessionIds: string[]
  /** Index into paneSessionIds. Meaningless (ignored) when paneSessionIds.length === 1. */
  focusedIndex: number
  /** 0-100; meaningless when paneSessionIds.length === 1. */
  dividerPercent: number
  /** Session ids whose pane was populated by restoring a persisted split and has not yet been
   * opened by a real user action (research.md Decision 4). */
  pristineIds: Set<string>
  /** "Open in split" / Ctrl+click (FR-001, FR-009, FR-012, research.md Decision 7). */
  openInSplit(sessionId: string): void
  /** A plain session-row click (FR-008, FR-009). */
  replaceFocused(sessionId: string): void
  /** Clicking or typing inside a pane (FR-006), or the keyboard focus-move command/button (FR-007,
   * caller computes the other index). */
  focusPane(index: number): void
  /** Closing one pane's control (FR-011, FR-013): the other becomes the sole pane, full width. */
  closePane(index: number): void
  /** `ResizablePanelGroup`'s `onLayoutChanged` (research.md Decision 5): always updates the live
   * value; persists (debounced ~300ms) only when `isUserInteraction` is true, never for a
   * programmatic layout set (initial mount, a restored split). */
  setDividerPercent(percent: number, options?: { isUserInteraction: boolean }): void
  /** Clears one pane's pristine flag the moment a real action opens that session (research.md
   * Decision 4): MessageInput's notStarted-send branch, or any targeting action below. */
  markOpened(sessionId: string): void
  /** App start (FR-014): seeds a persisted 2-session split, marks both pristine, and tells main
   * which sessions are visible -- never opens (starts) either agent. */
  restoreFromSettings(split: SplitLayout | null): void
  /** FR-016: a session being deleted (not just archived) closes its own pane, leaving the other
   * at full width. Called after every `sessions.list()` refresh with the current full id set. */
  pruneDeleted(existingIds: Set<string>): void
}

export const useSplitStore = create<SplitState>((set, get) => {
  // Tells main which sessions are currently shown (contracts/ipc.md `sessions.setVisible`), so
  // unread-clearing, transcript-patch forwarding, and spec 004's readout/subagent forwarding all
  // reach every visible pane, not just one.
  function syncVisible(paneSessionIds: string[]): void {
    window.refract.sessions.setVisible(paneSessionIds).then(
      (result) => {
        if (!result.ok) console.error('sessions.setVisible failed', result.error)
      },
      (err: unknown) => console.error('sessions.setVisible threw', err)
    )
  }

  // Browser `setTimeout` (this is renderer/DOM code, not Node) returns a numeric handle.
  let persistTimer: number | undefined

  // data-model.md "Rules": split is written whenever the pane arrangement changes for a reason
  // that should survive a restart -- every discrete action below persists immediately;
  // `setDividerPercent` is the one caller that asks for the ~300ms-debounced form.
  function persist(immediate = true): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const run = (): void => {
      const { paneSessionIds, dividerPercent, focusedIndex } = get()
      const [first, second] = paneSessionIds
      const layout: SplitLayout | null =
        paneSessionIds.length === 2 && first !== undefined && second !== undefined
          ? { sessionIds: [first, second], dividerPercent, focusedIndex: focusedIndex === 1 ? 1 : 0 }
          : null
      window.refract.settings.setSplit(layout).then(
        (result) => {
          if (!result.ok) console.error('settings.setSplit failed', result.error)
        },
        (err: unknown) => console.error('settings.setSplit threw', err)
      )
    }
    if (immediate) run()
    else persistTimer = setTimeout(run, 300)
  }

  function withoutPristine(sessionId: string): Set<string> {
    const pristineIds = new Set(get().pristineIds)
    pristineIds.delete(sessionId)
    return pristineIds
  }

  /** Builds the two-pane `[A, B]` array for a replace, given which index is being replaced;
   * `noUncheckedIndexedAccess`-safe -- callers already know `paneSessionIds.length === 2` here,
   * this just proves it to the type checker without a blind non-null assertion. */
  function replaceAt(paneSessionIds: string[], index: 0 | 1, sessionId: string): string[] | null {
    const [first, second] = paneSessionIds
    if (first === undefined || second === undefined) return null
    return index === 0 ? [sessionId, second] : [first, sessionId]
  }

  return {
    paneSessionIds: [],
    focusedIndex: 0,
    dividerPercent: 50,
    pristineIds: new Set<string>(),

    openInSplit: (sessionId) => {
      const { paneSessionIds, focusedIndex } = get()
      const pristineIds = withoutPristine(sessionId)

      if (paneSessionIds.length < 2) {
        const existing = paneSessionIds[0]
        if (existing === sessionId) {
          set({ pristineIds })
          return
        }
        const next = existing ? [existing, sessionId] : [sessionId]
        set({ paneSessionIds: next, pristineIds })
        syncVisible(next)
        persist()
        return
      }

      const unfocusedIndex = focusedIndex === 0 ? 1 : 0
      if (sessionId === paneSessionIds[focusedIndex]) {
        // research.md Decision 7: already the focused pane -- no-op.
        set({ pristineIds })
        return
      }
      if (sessionId === paneSessionIds[unfocusedIndex]) {
        // FR-009: already the unfocused pane -- focus it instead of duplicating.
        set({ focusedIndex: unfocusedIndex, pristineIds })
        persist()
        return
      }
      // FR-012: replace the unfocused pane; the focused pane and its session are unchanged.
      const next = replaceAt(paneSessionIds, unfocusedIndex, sessionId)
      if (!next) return
      set({ paneSessionIds: next, pristineIds })
      syncVisible(next)
      persist()
    },

    replaceFocused: (sessionId) => {
      const { paneSessionIds, focusedIndex } = get()
      const pristineIds = withoutPristine(sessionId)

      if (paneSessionIds.length < 2) {
        if (paneSessionIds[0] === sessionId) {
          set({ pristineIds })
          return
        }
        const next = [sessionId]
        set({ paneSessionIds: next, pristineIds })
        syncVisible(next)
        persist()
        return
      }

      const unfocusedIndex = focusedIndex === 0 ? 1 : 0
      if (sessionId === paneSessionIds[focusedIndex]) {
        set({ pristineIds })
        return
      }
      if (sessionId === paneSessionIds[unfocusedIndex]) {
        // FR-009: already shown in the other pane -- focus it instead of duplicating.
        set({ focusedIndex: unfocusedIndex, pristineIds })
        persist()
        return
      }
      // FR-008: replaces whatever the focused pane showed; the unfocused pane is unaffected.
      const next = replaceAt(paneSessionIds, focusedIndex === 0 ? 0 : 1, sessionId)
      if (!next) return
      set({ paneSessionIds: next, pristineIds })
      syncVisible(next)
      persist()
    },

    focusPane: (index) => {
      if (get().paneSessionIds.length !== 2) return
      if (get().focusedIndex === index) return
      set({ focusedIndex: index })
      persist()
    },

    closePane: (index) => {
      const { paneSessionIds } = get()
      if (paneSessionIds.length !== 2) return
      const survivor = index === 0 ? paneSessionIds[1] : paneSessionIds[0]
      if (survivor === undefined) return
      const next = [survivor]
      set({ paneSessionIds: next, focusedIndex: 0 })
      syncVisible(next)
      persist()
    },

    setDividerPercent: (percent, options) => {
      set({ dividerPercent: percent })
      if (options?.isUserInteraction) persist(false)
    },

    markOpened: (sessionId) => {
      if (!get().pristineIds.has(sessionId)) return
      set({ pristineIds: withoutPristine(sessionId) })
    },

    restoreFromSettings: (split) => {
      if (!split) return
      const paneSessionIds = [...split.sessionIds]
      set({
        paneSessionIds,
        focusedIndex: split.focusedIndex,
        dividerPercent: split.dividerPercent,
        pristineIds: new Set(split.sessionIds)
      })
      syncVisible(paneSessionIds)
    },

    pruneDeleted: (existingIds) => {
      const { paneSessionIds } = get()
      const stale = paneSessionIds.filter((id) => !existingIds.has(id))
      if (stale.length === 0) return
      if (paneSessionIds.length === 2) {
        const first = paneSessionIds[0]
        const staleIndex = first !== undefined && existingIds.has(first) ? 1 : 0
        get().closePane(staleIndex)
        return
      }
      // A single pane whose sole Session vanished (or, defensively, both gone at once): nothing
      // left to show.
      set({ paneSessionIds: [], focusedIndex: 0, pristineIds: new Set() })
      syncVisible([])
      persist()
    }
  }
})

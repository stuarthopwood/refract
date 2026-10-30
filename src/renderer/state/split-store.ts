import { create } from 'zustand'
import type { SplitLayout } from '../../shared/model'
import { useViewStore } from './view-store'

interface SplitState {
  /** 1 element = single pane; 2 = split. Index 0 is the left/first pane. */
  paneSessionIds: string[]
  /** Index into paneSessionIds. Meaningless (ignored) when paneSessionIds.length === 1. */
  focusedIndex: number
  /** 0-100; meaningless when paneSessionIds.length === 1. */
  dividerPercent: number
  /** Session ids from a restored split not yet opened by a real user action. */
  pristineIds: Set<string>
  /** Bumped only by `focusOther`, so DOM focus follows keyboard moves but not a click on the unfocused pane's row. */
  focusMoveSignal: number
  /** "Open in split" / Ctrl+click (FR-001, FR-009, FR-012). */
  openInSplit(sessionId: string): void
  /** A plain session-row click (FR-008, FR-009). */
  replaceFocused(sessionId: string): void
  /** Clicking or typing inside a pane (FR-006). */
  focusPane(index: number): void
  /** Flips focus to the other pane; a no-op when no split is open (FR-007). */
  focusOther(): void
  /** Closes a pane; the other becomes the sole pane. Closing the only pane lands on the empty state (#621). */
  closePane(index: number): void
  /** Always updates the live value; persists (debounced ~300ms) only when `isUserInteraction` is true. */
  setDividerPercent(percent: number, options?: { isUserInteraction: boolean }): void
  /** Clears one pane's pristine flag once a real action opens that session. */
  markOpened(sessionId: string): void
  /** App start (FR-014): seeds a persisted split, marking both sessions pristine without starting them. */
  restoreFromSettings(split: SplitLayout | null): void
  /** FR-016: closes the panes of deleted sessions; called after every `sessions.list()` refresh. */
  pruneDeleted(existingIds: Set<string>): void
}

/** Split-view pane state: which sessions are shown, focus, and divider position. */
export const useSplitStore = create<SplitState>((set, get) => {
  // `App.tsx` is the sole caller of `sessions.setVisible`: a store-driven call would clear unread
  // on a pane hidden by the narrow-window collapse (FR-018).

  let persistTimer: number | undefined

  // Discrete actions persist immediately; `setDividerPercent` asks for the debounced form.
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
    else
      persistTimer = setTimeout(() => {
        persistTimer = undefined
        run()
      }, 300)
  }

  // Flush a pending debounced write on window close, but only if one is pending: an
  // unconditional persist could overwrite a valid on-disk split with `null` when none was restored.
  if (typeof window !== 'undefined') {
    const flushPending = () => {
      if (persistTimer) persist()
    }
    window.addEventListener('beforeunload', flushPending)
    window.addEventListener('pagehide', flushPending)
  }

  function withoutPristine(sessionId: string): Set<string> {
    const pristineIds = new Set(get().pristineIds)
    pristineIds.delete(sessionId)
    return pristineIds
  }

  /** Builds the replaced two-pane array; returns null unless both panes exist (satisfies `noUncheckedIndexedAccess`). */
  function replaceAt(paneSessionIds: string[], index: 0 | 1, sessionId: string): string[] | null {
    const [first, second] = paneSessionIds
    if (first === undefined || second === undefined) return null
    return index === 0 ? [sessionId, second] : [first, sessionId]
  }

  // Shared by `openInSplit` and `replaceFocused`: `mode` decides whether a new session opens a
  // second pane or replaces the lone one. Every path that focuses a session funnels through here,
  // so the view returns to chat unconditionally, even on the no-op branches below; otherwise a
  // session opened while Pull Requests shows would stay hidden.
  function targetSession(sessionId: string, replaceIndex: 0 | 1, mode: 'split' | 'replace'): void {
    if (['pull-requests', 'home'].includes(useViewStore.getState().view)) useViewStore.getState().openChat()
    const { paneSessionIds, focusedIndex } = get()
    const pristineIds = withoutPristine(sessionId)

    if (paneSessionIds.length < 2) {
      const existing = paneSessionIds[0]
      if (existing === sessionId) {
        set({ pristineIds })
        return
      }
      const next = mode === 'split' && existing ? [existing, sessionId] : [sessionId]
      set({ paneSessionIds: next, pristineIds })
      persist()
      return
    }

    const unfocusedIndex = focusedIndex === 0 ? 1 : 0
    if (sessionId === paneSessionIds[focusedIndex]) {
      set({ pristineIds })
      return
    }
    if (sessionId === paneSessionIds[unfocusedIndex]) {
      // FR-009: focus the existing pane instead of duplicating.
      set({ focusedIndex: unfocusedIndex, pristineIds })
      persist()
      return
    }
    const next = replaceAt(paneSessionIds, replaceIndex, sessionId)
    if (!next) return
    set({ paneSessionIds: next, pristineIds })
    persist()
  }

  return {
    paneSessionIds: [],
    focusedIndex: 0,
    dividerPercent: 50,
    pristineIds: new Set<string>(),
    focusMoveSignal: 0,

    openInSplit: (sessionId) => {
      const { focusedIndex } = get()
      targetSession(sessionId, focusedIndex === 0 ? 1 : 0, 'split')
    },

    replaceFocused: (sessionId) => {
      const { focusedIndex } = get()
      targetSession(sessionId, focusedIndex === 0 ? 0 : 1, 'replace')
    },

    focusPane: (index) => {
      if (get().paneSessionIds.length !== 2) return
      if (get().focusedIndex === index) return
      set({ focusedIndex: index })
      persist()
    },

    focusOther: () => {
      const { paneSessionIds, focusedIndex, focusMoveSignal } = get()
      if (paneSessionIds.length !== 2) return
      set({ focusedIndex: focusedIndex === 0 ? 1 : 0, focusMoveSignal: focusMoveSignal + 1 })
      persist()
    },

    closePane: (index) => {
      const { paneSessionIds, pristineIds } = get()
      if (paneSessionIds.length === 2) {
        const survivor = index === 0 ? paneSessionIds[1] : paneSessionIds[0]
        if (survivor === undefined) return
        set({ paneSessionIds: [survivor], focusedIndex: 0 })
        persist()
        return
      }
      if (paneSessionIds.length !== 1) return
      const closedId = paneSessionIds[0]
      set({
        paneSessionIds: [],
        focusedIndex: 0,
        pristineIds: closedId === undefined ? pristineIds : withoutPristine(closedId)
      })
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
    },

    // Filters by `existingIds` so 0, 1 or 2 stale ids (e.g. removing a Repository) clear in one pass.
    pruneDeleted: (existingIds) => {
      const { paneSessionIds, pristineIds } = get()
      const next = paneSessionIds.filter((id) => existingIds.has(id))
      if (next.length === paneSessionIds.length) return
      set({
        paneSessionIds: next,
        focusedIndex: 0,
        pristineIds: new Set([...pristineIds].filter((id) => next.includes(id)))
      })
      persist()
    }
  }
})

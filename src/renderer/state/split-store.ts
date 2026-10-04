import { create } from 'zustand'
import type { SplitLayout } from '../../shared/model'
import { useViewStore } from './view-store'

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
  /** Quality-gate remediation (code-reviewer, round 2, Medium): bumped only by `focusOther` (the
    * Ctrl+Shift+\ chord and the divider's focus-move button), never by `focusPane` or any
    * `targetSession` branch (a plain/Ctrl click, "Open in split", a notification). ChatPane's
    * real-DOM-focus-follows effect keys off a CHANGE in this value, not every `focusedIndex`
    * flip, so a click on the row already shown in the unfocused pane (FR-009: focuses it without
    * moving DOM focus) can no longer yank keyboard focus out of the session list. */
  focusMoveSignal: number
  /** "Open in split" / Ctrl+click (FR-001, FR-009, FR-012, research.md Decision 7). */
  openInSplit(sessionId: string): void
  /** A plain session-row click (FR-008, FR-009). */
  replaceFocused(sessionId: string): void
  /** Clicking or typing inside a pane (FR-006). */
  focusPane(index: number): void
  /** The keyboard focus-move command/button (FR-007): flips to whichever pane is not currently
    * focused; a no-op when a split is not open. */
  focusOther(): void
  /** Closing one pane's control (FR-011, FR-013): the other becomes the sole pane, full width. */
  closePane(index: number): void
  /** `ResizablePanelGroup`'s `onLayoutChanged` (research.md Decision 5): always updates the live
    * value; persists (debounced ~300ms) only when `isUserInteraction` is true, never for a
    * programmatic layout set (initial mount, a restored split). */
  setDividerPercent(percent: number, options?: { isUserInteraction: boolean }): void
  /** Clears one pane's pristine flag the moment a real action opens that session (research.md
    * Decision 4): MessageInput's notStarted-send branch, or any targeting action below. */
  markOpened(sessionId: string): void
  /** App start (FR-014): seeds a persisted 2-session split, marks both pristine -- never opens
    * (starts) either agent. Round 3 (code-reviewer, Low): no longer tells main which sessions are
    * visible itself; `App.tsx`'s own rendered-panes effect is the SOLE caller of
    * `sessions.setVisible` now, reacting to the `paneSessionIds` state this sets. */
  restoreFromSettings(split: SplitLayout | null): void
  /** FR-016: a session being deleted (not just archived) closes its own pane, leaving the other
    * at full width. Called after every `sessions.list()` refresh with the current full id set. */
  pruneDeleted(existingIds: Set<string>): void
}

export const useSplitStore = create<SplitState>((set, get) => {
  // Round 3 (code-reviewer/test-reviewer, Medium): `syncVisible` used to live here and get
  // called by every action below with the full `paneSessionIds` array -- correct only while
  // both panes are genuinely on screen. During the narrow-window collapse, main's
  // `sessions.setVisible` clears unread (and resets the transcript) for every id made newly
  // visible IMMEDIATELY, so a store-driven call sending both ids re-cleared the truly-hidden
  // pane's unread flag before App.tsx's own narrowing effect could correct it, reopening the
  // exact FR-018 hole that effect exists to close. `App.tsx` is now the SOLE caller of
  // `sessions.setVisible`, derived from what it actually renders (`paneSessionIds`, `isSplit`,
  // `canShowSplit`, `frontSessionId`) -- every call below that used to call `syncVisible` no
  // longer does; that effect picks up the very same state changes after this store commits them.

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
    else
      persistTimer = setTimeout(() => {
        // Round 3 (code-reviewer, Low): never cleared the handle back to `undefined` here, so
        // `flushPending`'s `if (persistTimer)` guard below stayed truthy (a stale, already-fired
        // handle) long after a completed drag, making it try to flush on every later close.
        persistTimer = undefined
        run()
      }, 300)
  }

  // Quality-gate remediation (test-reviewer, round 2, Low; SC-003): `setDividerPercent`'s ~300ms
  // debounce can lose a drag made just before the app quits -- a user drags the divider, then
  // closes the window inside that window, and the pending timer's own write never runs. Flushes
  // immediately (synchronously, before the page is torn down) on both events Chromium/Electron
  // fire for a closing window.
  // Quality-gate remediation (security-auditor, round 3, Low): only flush when a debounced write
  // is genuinely pending -- calling `persist()` unconditionally on every close would also fire
  // when nothing was waiting (e.g. this launch's `sessionsLoad.ok` was false, so the split was
  // never restored at all, per init-stores.ts's own comment), overwriting a perfectly valid
  // on-disk split with `null` just because the user quit, not because they changed anything.
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

  /** Builds the two-pane `[A, B]` array for a replace, given which index is being replaced;
    * `noUncheckedIndexedAccess`-safe -- callers already know `paneSessionIds.length === 2` here,
    * this just proves it to the type checker without a blind non-null assertion. */
  function replaceAt(paneSessionIds: string[], index: 0 | 1, sessionId: string): string[] | null {
    const [first, second] = paneSessionIds
    if (first === undefined || second === undefined) return null
    return index === 0 ? [sessionId, second] : [first, sessionId]
  }

  // Quality-gate remediation (code-reviewer, Medium, DRY): `openInSplit` and `replaceFocused`
  // shared every branch of data-model.md's transition table except which pane a genuinely-new
  // session replaces -- the unfocused pane (FR-012) or the focused one (FR-008) -- AND, while
  // only one pane is open, whether a genuinely-new session opens a second pane (openInSplit)
  // or replaces the lone pane in place (replaceFocused). Second remediation round
  // (code-reviewer, Critical): the first version of this DRY merge dropped that single-pane
  // distinction entirely and always opened a split, turning every plain single-pane session
  // click into an unwanted split -- mode restores it explicitly.
  //
  // Third remediation round (code-reviewer/a11y, High): round 2 only returned the view to
  // 'chat' from three callsites that happened to call `openInSplit`/`replaceFocused` directly
  // (SessionList.tsx's row click, Ctrl+click, "Open in split"). Every OTHER path that focuses a
  // session -- the per-repository "+" quick-create, NewSessionDialog's submit, and main's
  // `onUiOpenSession` (notification click / startup split-recovery) -- all funnel through
  // `sessions-store.ts`'s `create` or `init-stores.ts`, which both call `replaceFocused` too,
  // but the per-callsite guard those paths lack left a Session created or opened that way
  // hidden behind the Pull Requests panel: a genuine dead end. `targetSession` is the one
  // function BOTH `openInSplit` and `replaceFocused` funnel through, so every current and
  // future caller of either gets this for free. Any call here means a user action intends to
  // see a specific session's chat right now, including the "already focused, no-op for pane
  // arrangement" branches below -- so the view switch happens unconditionally, before those
  // early returns, not only on the branches that actually change `paneSessionIds`.
  function targetSession(sessionId: string, replaceIndex: 0 | 1, mode: 'split' | 'replace'): void {
    if (useViewStore.getState().view === 'pull-requests') useViewStore.getState().openChat()
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

    // Spec 005 (data-model.md): replaces the unfocused pane; the focused pane and its session are unchanged.
    openInSplit: (sessionId) => {
      const { focusedIndex } = get()
      targetSession(sessionId, focusedIndex === 0 ? 1 : 0, 'split')
    },

    // Spec 005 (data-model.md): replaces whatever the focused pane showed; the unfocused pane is unaffected.
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
      const { paneSessionIds } = get()
      if (paneSessionIds.length !== 2) return
      const survivor = index === 0 ? paneSessionIds[1] : paneSessionIds[0]
      if (survivor === undefined) return
      const next = [survivor]
      set({ paneSessionIds: next, focusedIndex: 0 })
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

    // Quality-gate remediation (code-reviewer, Medium): the previous `closePane`-based
    // implementation only ever dropped ONE stale id -- when BOTH panes' sessions vanished at
    // once (e.g. removing a Repository deletes every one of its Sessions in one step), the
    // survivor it kept (`paneSessionIds[1]` after `closePane(0)`) was ALSO stale, leaving an
    // orphan id stuck in `paneSessionIds`/`setVisible` until the next list refresh. Now filters
    // by `existingIds` directly, so 0, 1, or 2 stale ids are all handled in one pass.
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

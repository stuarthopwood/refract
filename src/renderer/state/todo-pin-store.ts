import { create } from 'zustand'

// Issue #700/#701 slice (a): per-Session pin/collapse state for the pinned todo panel --
// non-persisted, in-memory only (same convention as `stage-toggle-store.ts`'s own `bySession`
// shape and its doc comment's reasoning: reset by a full app restart, never written to
// `settings.json`). `pinned` (decision item 1: the Todo pill's own click toggles this, and the
// panel's own Unpin button) and `collapsed` (decision item 5: "collapsed is per Session and
// separate from the pin") are two independent per-Session booleans -- #701 slice (c)'s
// `pinTodoByDefault` SETTING seeds `pinned`'s initial value for a Session that has never been
// toggled; that seeding is out of scope for this slice, which defaults every Session to unpinned.
interface TodoPinState {
  pinnedBySession: Record<string, boolean>
  collapsedBySession: Record<string, boolean>
  setPinned(sessionId: string, pinned: boolean): void
  togglePinned(sessionId: string): void
  setCollapsed(sessionId: string, collapsed: boolean): void
}

export const useTodoPinStore = create<TodoPinState>((set, get) => ({
  pinnedBySession: {},
  collapsedBySession: {},
  setPinned: (sessionId, pinned) => set({ pinnedBySession: { ...get().pinnedBySession, [sessionId]: pinned } }),
  togglePinned: (sessionId) => {
    const current = get().pinnedBySession[sessionId] ?? false
    set({ pinnedBySession: { ...get().pinnedBySession, [sessionId]: !current } })
  },
  setCollapsed: (sessionId, collapsed) => set({ collapsedBySession: { ...get().collapsedBySession, [sessionId]: collapsed } })
}))

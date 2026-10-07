import { create } from 'zustand'

/** One pane's last-known transcript scroll position for a Session, recorded continuously while
 * its `Transcript` is mounted and visible (`Transcript.tsx`'s viewport scroll handler), so a
 * Session switch away and back restores exactly what the developer left (issue #485, spec 001 US5
 * acceptance scenario 3 and its Clarification, Stuart 2026-10-06): lands at the end by default,
 * restoring the previous position only when the developer had scrolled away from the end
 * ("detached") before leaving. Renderer-lifetime only, not persisted to disk -- nothing in spec
 * 001 requires scroll position to survive an app restart (US4's own acceptance scenarios list what
 * a restart must restore, and scroll position is not among them), and every Conversation already
 * has a natural resting place -- its end -- to fall back to on a cold start.
 */
export interface SessionScrollState {
  /** Whether the viewport was at (or within tolerance of) the end when last recorded. */
  atEnd: boolean
  /** The raw viewport `scrollTop` when last recorded; read back only when `atEnd` is false. */
  scrollTop: number
}

interface ScrollMemoryState {
  bySession: Record<string, SessionScrollState>
  record(sessionId: string, state: SessionScrollState): void
  /** Called on an explicit Conversation switch (`ChatPane.tsx`'s `applySnapshot`, from
   * `ConversationSwitcher.tsx`): the newly-shown Conversation has never been "left" by the
   * developer and has its own content height, so it must land at the end like any other
   * never-visited view, not reuse an offset that applied to the Session's previous Conversation. */
  clear(sessionId: string): void
  /** Quality-gate remediation (round 2, 2026-10-07): every `clear` call site below clears
   * speculatively BEFORE its own async switch call resolves, so a landing effect racing the
   * same event stream never reads a stale pre-switch offset (clearing only after `await`ing is
   * too late -- main can emit the reset patch, and the Transcript can read the clear, before the
   * renderer-side promise even settles). A switch that then FAILS must put back exactly what it
   * removed, but only if nothing newer has been recorded for this Session in the meantime (e.g.
   * the developer already scrolled the still-showing old Conversation, or landed on yet another
   * switch); restoring unconditionally could clobber that newer entry with a stale one. */
  restoreIfAbsent(sessionId: string, previous: SessionScrollState | undefined): void
}

export const useChatScrollStore = create<ScrollMemoryState>((set, get) => ({
  bySession: {},
  record: (sessionId, state) => set({ bySession: { ...get().bySession, [sessionId]: state } }),
  clear: (sessionId) => {
    if (!(sessionId in get().bySession)) return
    const bySession = { ...get().bySession }
    delete bySession[sessionId]
    set({ bySession })
  },
  restoreIfAbsent: (sessionId, previous) => {
    if (!previous) return
    if (sessionId in get().bySession) return
    set({ bySession: { ...get().bySession, [sessionId]: previous } })
  }
}))

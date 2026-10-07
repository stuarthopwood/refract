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
  /** Finding 7 (gate fixes 4): called speculatively BEFORE each of the four call sites' own
   * switch-triggering IPC call -- `ChatPane.tsx`'s `handleStartNewConversation`,
   * `ConversationSwitcher.tsx`'s `handleNewConversation`/`handleOpenConversation`, and
   * `MessageInput.tsx`'s typed `/new` -- never from `applySnapshot` itself (corrected from the
   * prior, inaccurate doc here). The newly-shown Conversation has never been "left" by the
   * developer and has its own content height, so it must land at the end like any other
   * never-visited view, not reuse an offset that applied to the Session's previous Conversation;
   * clearing BEFORE (not after) awaiting avoids a landing effect racing the same event stream
   * from reading a stale pre-switch offset (gate fixes 2). Three of those four call sites also
   * clear a SECOND time, right before applying a successful switch's snapshot (finding 4, gate
   * fixes 4): a scroll made on the still-visible OLD Conversation during the await would
   * otherwise leave a detached position here that the brand-new Conversation wrongly inherits. */
  clear(sessionId: string): void
  /** Called on a FAILED switch to put back exactly what the matching `clear()` call above
   * removed, but only if nothing newer has been recorded for this Session in the meantime (e.g.
   * the developer already scrolled the still-showing old Conversation, or landed on yet another
   * switch); restoring unconditionally could clobber that newer entry with a stale one. Finding
   * 3 (gate fixes 4): deliberately NOT called by `ConversationSwitcher.tsx`'s
   * `handleOpenConversation` -- see its own comment for why a failed `conversations.open` always
   * lands at the end instead of attempting (and usually losing the race to) a restore. */
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

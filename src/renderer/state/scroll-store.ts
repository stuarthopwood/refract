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
  /** Quality-gate finding (code review, High): per-session flag set by a switch-triggering call
   * site the instant it clears this Session's memory, BEFORE its own IPC/`chat.send` call --
   * `record` below becomes a no-op for this session while set, so a scroll on the still-visible
   * OLD Conversation during the in-flight window can never write a detached position back into
   * this store for the Session that the brand-new Conversation would otherwise inherit. Replaces
   * the previous "clear a SECOND time, right before applying the snapshot" pattern for the three
   * call sites that apply a returned `SessionSnapshot` themselves (still kept as defense-in-depth
   * below) -- and is the ONLY fix available to `MessageInput.tsx`'s typed `/new`, whose reset
   * reaches the renderer as an ordinary `transcript:patch` on the same event stream its own
   * `chat.send` call races against, never as a snapshot that call site could clear-then-apply
   * itself. Always released in the caller's own `finally`, success or failure. */
  inFlight: Record<string, number>
  /** `true` begins one in-flight switch for the Session, `false` ends one: a counter, so two
   * overlapping calls (the banner's "Start new conversation" plus the switcher's "New") cannot
   * release each other's guard early. */
  setInFlight(sessionId: string, value: boolean): void
  record(sessionId: string, state: SessionScrollState): void
  /** Called speculatively BEFORE each of the four call sites' own switch-triggering IPC call --
   * `ChatPane.tsx`'s `handleStartNewConversation`, `ConversationSwitcher.tsx`'s
   * `handleNewConversation`/`handleOpenConversation`, and `MessageInput.tsx`'s typed `/new`. The
   * newly-shown Conversation has never been "left" by the developer and has its own content
   * height, so it must land at the end like any other never-visited view, not reuse an offset
   * that applied to the Session's previous Conversation; clearing BEFORE (not after) awaiting
   * avoids a landing effect racing the same event stream from reading a stale pre-switch offset
   * (gate fixes 2). Three of those four call sites also clear a SECOND time, right before
   * applying a successful switch's snapshot (finding 4, gate fixes 4) -- now redundant with
   * `inFlight` above (which already prevents any write during the await) but kept as
   * defense-in-depth against a future call site that forgets to set it. */
  clear(sessionId: string): void
  /** Called on a FAILED switch to put back exactly what the matching `clear()` call above
   * removed, but only if nothing newer has been recorded for this Session in the meantime (e.g.
   * the developer already scrolled the still-showing old Conversation, or landed on yet another
   * switch); restoring unconditionally could clobber that newer entry with a stale one. Finding
   * 3 (gate fixes 4): deliberately NOT called by `ConversationSwitcher.tsx`'s
   * `handleOpenConversation` -- see its own comment for why a failed `conversations.open` always
   * lands at the end instead of attempting (and usually losing the race to) a restore. */
  restoreIfAbsent(sessionId: string, previous: SessionScrollState | undefined): void
  /** Issue #457 quality-gate fix (code review, Medium): toggling a transcript-display switch
   * unmounts and remounts every pane's `Transcript` (the Settings screen replaces the whole chat
   * area, `App.tsx`), and a remembered "detached" (not-at-end) raw `scrollTop` was recorded
   * against the OLD row layout -- restoring it into the new, now shorter-or-taller layout lands on
   * unrelated content instead of where the developer actually left off. Clearing every pane's
   * memory here makes each one fall back to #485's own default (the end), the same "never visited
   * this layout before" treatment a brand-new Conversation already gets. */
  clearAll(): void
}

export const useChatScrollStore = create<ScrollMemoryState>((set, get) => ({
  bySession: {},
  inFlight: {},
  setInFlight: (sessionId, value) => {
    const inFlight = { ...get().inFlight }
    const next = (inFlight[sessionId] ?? 0) + (value ? 1 : -1)
    if (next > 0) inFlight[sessionId] = next
    else delete inFlight[sessionId]
    set({ inFlight })
  },
  record: (sessionId, state) => {
    if (get().inFlight[sessionId]) return
    set({ bySession: { ...get().bySession, [sessionId]: state } })
  },
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
  },
  clearAll: () => set({ bySession: {} })
}))

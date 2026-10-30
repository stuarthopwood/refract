import { create } from 'zustand'

/** One pane's last transcript scroll position for a Session, restored on switch back only when `atEnd` was false.
 * Renderer-lifetime only: a cold start lands at the end. */
export interface SessionScrollState {
  /** Whether the viewport was at (or within tolerance of) the end when last recorded. */
  atEnd: boolean
  /** The raw viewport `scrollTop` when last recorded; read back only when `atEnd` is false. */
  scrollTop: number
}

interface ScrollMemoryState {
  bySession: Record<string, SessionScrollState>
  /** Per-session flag set by a switch-triggering call site before its IPC call: `record` is a no-op while set,
   * so scrolling the old Conversation cannot write a detached position the new one would inherit. Release in `finally`. */
  inFlight: Record<string, number>
  /** `true` begins one in-flight switch, `false` ends one; a counter so overlapping calls cannot release each other's guard. */
  setInFlight(sessionId: string, value: boolean): void
  record(sessionId: string, state: SessionScrollState): void
  /** Called before a switch-triggering IPC call so the new Conversation lands at the end, not at the old offset.
   * A second clear before applying a snapshot is defense-in-depth behind `inFlight`. */
  clear(sessionId: string): void
  /** Restores what `clear()` removed after a failed switch, only if nothing newer was recorded meanwhile. */
  restoreIfAbsent(sessionId: string, previous: SessionScrollState | undefined): void
  /** Clears every pane's memory when a display toggle remounts `Transcript`: a stale detached `scrollTop` would land on unrelated content (#457). */
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

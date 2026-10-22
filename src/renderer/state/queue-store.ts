import { create } from 'zustand'

interface SessionQueue {
  followUp: string[]
  steering: string[]
}

/** Issue #744 (spec 009 FR-042): the text OMP's `queue_update` lists for a queued message that
 * carries images and no text (probed on OMP 18.12.5, 2026-10-22). Its `remove_queued_message`/
 * `promote_queued_message` match that message by the empty string it was sent with, not this. */
export const IMAGE_ONLY_QUEUE_TEXT = '[Image]'

interface QueueState {
  bySession: Record<string, SessionQueue>
  /** Issue #744: the image names of this Session's one queued image-only follow-up, for its chip
   * label. Dropped as soon as a `queue_update` no longer lists `IMAGE_ONLY_QUEUE_TEXT`. */
  imageOnlyBySession: Record<string, readonly string[]>
  apply(sessionId: string, followUp: string[], steering: string[]): void
  setImageOnly(sessionId: string, names: readonly string[] | null): void
}

// Stable reference for a Session with no queue entry yet, so a selector never returns a fresh
// object on every call (a fresh `{}` would break useSyncExternalStore's snapshot stability and
// cause an infinite re-render loop; same pattern as pending-requests-store's `[]` default).
export const EMPTY_QUEUE: SessionQueue = { followUp: [], steering: [] }

// The queued-message chips, keyed per Session (contracts/ipc.md `queue:update`), so a patch for a
// background Session can never clear the visible Session's chips: the old shape stored one
// `sessionId` plus one `followUp`/`steering` pair, so the last `queue:update` received for ANY
// Session silently overwrote whichever Session's chips were on screen.
export const useQueueStore = create<QueueState>((set, get) => ({
  bySession: {},
  imageOnlyBySession: {},
  apply: (sessionId, followUp, steering) => {
    const imageOnlyQueued = followUp.includes(IMAGE_ONLY_QUEUE_TEXT) || steering.includes(IMAGE_ONLY_QUEUE_TEXT)
    const imageOnly = get().imageOnlyBySession
    set({ bySession: { ...get().bySession, [sessionId]: { followUp, steering } } })
    if (imageOnly[sessionId] && !imageOnlyQueued) get().setImageOnly(sessionId, null)
  },
  setImageOnly: (sessionId, names) => {
    const next = { ...get().imageOnlyBySession }
    if (names) next[sessionId] = names
    else delete next[sessionId]
    set({ imageOnlyBySession: next })
  }
}))

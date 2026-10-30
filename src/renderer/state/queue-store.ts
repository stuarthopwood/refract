import { create } from 'zustand'

interface SessionQueue {
  followUp: string[]
  steering: string[]
}

export const IMAGE_ONLY_QUEUE_TEXT = '[Image]'

interface QueueState {
  bySession: Record<string, SessionQueue>
  imageOnlyBySession: Record<string, readonly string[]>
  apply(sessionId: string, followUp: string[], steering: string[]): void
  setImageOnly(sessionId: string, names: readonly string[] | null): void
}

export const EMPTY_QUEUE: SessionQueue = { followUp: [], steering: [] }

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

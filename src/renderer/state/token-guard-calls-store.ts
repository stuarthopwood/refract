import { create } from 'zustand'
import { useChatScrollStore } from './scroll-store'
import type { TokenGuardCalls } from '../../shared/tokenGuard'

// #1212: model calls in each Session's current Conversation (`token-guard:calls`), the pane
// banner's dismissal, and the Hand off flow's own busy/error state. Per Session, replaced when a
// new Conversation id arrives.
export interface CallsEntry {
  conversationId: string
  calls: number
  /** Call count at which the 500-call banner was dismissed (it returns 100 calls later). */
  bannerDismissedAt: number | null
}

interface CallsState {
  bySession: Record<string, CallsEntry>
  handingOff: Record<string, boolean>
  handoffError: Record<string, string | null>
  setCalls(payload: TokenGuardCalls): void
  dismissBanner(sessionId: string): void
  dismissHandoffError(sessionId: string): void
  handOff(sessionId: string): Promise<void>
}

export const useTokenGuardCallsStore = create<CallsState>((set, get) => ({
  bySession: {},
  handingOff: {},
  handoffError: {},
  setCalls: ({ sessionId, conversationId, calls }) =>
    set((s) => {
      const previous = s.bySession[sessionId]
      const sameConversation = previous?.conversationId === conversationId
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { conversationId, calls, bannerDismissedAt: sameConversation ? previous.bannerDismissedAt : null }
        }
      }
    }),
  dismissBanner: (sessionId) =>
    set((s) => {
      const entry = s.bySession[sessionId]
      if (!entry) return s
      return { bySession: { ...s.bySession, [sessionId]: { ...entry, bannerDismissedAt: entry.calls } } }
    }),
  dismissHandoffError: (sessionId) => set((s) => ({ handoffError: { ...s.handoffError, [sessionId]: null } })),
  handOff: async (sessionId) => {
    if (get().handingOff[sessionId]) return
    set((s) => ({ handingOff: { ...s.handingOff, [sessionId]: true }, handoffError: { ...s.handoffError, [sessionId]: null } }))
    // Blocks scroll recording across the whole in-flight window, like a manual new Conversation.
    useChatScrollStore.getState().setInFlight(sessionId, true)
    let failure: string | null = null
    try {
      const result = await window.refract.tokenGuard.handoff(sessionId)
      if (!result.ok) failure = result.error.message
      else if (!result.value.ok) failure = result.value.reason
      else useChatScrollStore.getState().clear(sessionId)
    } catch (err) {
      failure = err instanceof Error ? err.message : 'Hand off failed.'
    } finally {
      useChatScrollStore.getState().setInFlight(sessionId, false)
      set((s) => ({ handingOff: { ...s.handingOff, [sessionId]: false }, handoffError: { ...s.handoffError, [sessionId]: failure } }))
    }
  }
}))

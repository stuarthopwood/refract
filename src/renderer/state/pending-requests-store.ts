import { create } from 'zustand'
import type { PendingRequest } from '../../shared/model'

interface PendingRequestsState {
  bySession: Record<string, PendingRequest[]>
  setForSession(sessionId: string, requests: PendingRequest[]): void
  add(sessionId: string, request: PendingRequest): void
  resolve(sessionId: string, requestId: string): void
}

// Approval and question cards, kept per Session so they survive a Session switch
// (contracts/ipc.md `request:pending` / `request:resolved`).
export const usePendingRequestsStore = create<PendingRequestsState>((set, get) => ({
  bySession: {},
  setForSession: (sessionId, requests) => set({ bySession: { ...get().bySession, [sessionId]: requests } }),
  add: (sessionId, request) => {
    const current = get().bySession[sessionId] ?? []
    set({ bySession: { ...get().bySession, [sessionId]: [...current, request] } })
  },
  resolve: (sessionId, requestId) => {
    const current = get().bySession[sessionId] ?? []
    set({
      bySession: { ...get().bySession, [sessionId]: current.filter((request) => request.requestId !== requestId) }
    })
  }
}))

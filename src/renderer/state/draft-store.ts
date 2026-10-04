import { create } from 'zustand'
import { EMPTY_ATTACHMENTS } from '../features/chat/attachments'
import type { AttachmentsState } from '../features/chat/attachments'

// Spec 010: the in-progress message box draft and its spec-009 pending attachments, held here
// instead of MessageInput.tsx's own local useState so neither unmounting (a ChatPane.tsx
// `key={sessionId}` Session switch, or App.tsx's Settings view-swap) ever discards them. Same
// `bySession: Record<string, T>` shape as queue-store.ts/commands-store.ts/
// pending-requests-store.ts; unlike those, nothing here is ever pushed from main (a draft only
// ever changes because the developer typed or pasted something in this renderer), so this store
// has no entry in init-stores.ts.

export interface Draft {
  text: string
  attachments: AttachmentsState
}

// Stable reference for a Session with no draft yet, so a selector never returns a fresh object on
// every call (a fresh `{}` literal would break useSyncExternalStore's snapshot stability and cause
// an infinite re-render loop -- same reasoning queue-store's EMPTY_QUEUE/readout-store's
// EMPTY_READOUT document). Reuses attachments.ts's own EMPTY_ATTACHMENTS rather than duplicating
// the empty shape.
export const EMPTY_DRAFT: Draft = { text: '', attachments: EMPTY_ATTACHMENTS }

interface DraftState {
  bySession: Record<string, Draft>
  setText(sessionId: string, text: string): void
  setAttachments(sessionId: string, updater: AttachmentsState | ((prev: AttachmentsState) => AttachmentsState)): void
  /** Send-success clearing (spec 009 FR-007, spec 010 FR-005): resets both text and attachments
   * back to empty in one atomic update, replacing what used to be two separate `setText('')`/
   * `setAttachments(EMPTY_ATTACHMENTS)` calls in MessageInput.tsx. */
  clear(sessionId: string): void
}

export const useDraftStore = create<DraftState>((set, get) => ({
  bySession: {},
  setText: (sessionId, text) => {
    const current = get().bySession[sessionId] ?? EMPTY_DRAFT
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, text } } })
  },
  setAttachments: (sessionId, updater) => {
    const current = get().bySession[sessionId] ?? EMPTY_DRAFT
    const attachments = typeof updater === 'function' ? updater(current.attachments) : updater
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, attachments } } })
  },
  clear: (sessionId) => {
    set({ bySession: { ...get().bySession, [sessionId]: EMPTY_DRAFT } })
  }
}))

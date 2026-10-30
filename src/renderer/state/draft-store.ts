import { create } from 'zustand'
import { EMPTY_ATTACHMENTS } from '../features/chat/attachments'
import type { AttachmentsState } from '../features/chat/attachments'

// The in-progress message draft and pending attachments, held here so unmounting (a Session switch or
// Settings view-swap) never discards them. Nothing is pushed from main, so init-stores has no entry. (#010)

export interface Draft {
  text: string
  attachments: AttachmentsState
  // Shared between MessageInput and ChatPane's drag-and-drop; `seq` forces a fresh DOM node for a repeated message. (#514, #598)
  attachmentAnnouncement: { seq: number; message: string } | null
  // Background image reads aren't awaited, so `handleSend` refuses while this is above 0 or the image lands on the next draft. (#723)
  pendingAttachmentReads: number
}

// Stable reference so a selector never returns a fresh object (which would loop useSyncExternalStore).
export const EMPTY_DRAFT: Draft = { text: '', attachments: EMPTY_ATTACHMENTS, attachmentAnnouncement: null, pendingAttachmentReads: 0 }

interface DraftState {
  bySession: Record<string, Draft>
  setText(sessionId: string, text: string): void
  setAttachments(sessionId: string, updater: AttachmentsState | ((prev: AttachmentsState) => AttachmentsState)): void
  /** Resets text and attachments to empty in one atomic update (send success). */
  clear(sessionId: string): void
  /** Announces an attachment event via the shared live region; monotonic `seq` forces a fresh DOM node. */
  announceAttachment(sessionId: string, message: string): void
  /** See `Draft.pendingAttachmentReads`. */
  incrementPendingAttachmentReads(sessionId: string): void
  decrementPendingAttachmentReads(sessionId: string): void
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
  // The in-flight read counter survives a clear; resetting it would reopen the Enter-mid-read race. (#723)
  clear: (sessionId) => {
    const current = get().bySession[sessionId]
    set({ bySession: { ...get().bySession, [sessionId]: { ...EMPTY_DRAFT, pendingAttachmentReads: current?.pendingAttachmentReads ?? 0 } } })
  },
  announceAttachment: (sessionId, message) => {
    const current = get().bySession[sessionId] ?? EMPTY_DRAFT
    const seq = (current.attachmentAnnouncement?.seq ?? 0) + 1
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, attachmentAnnouncement: { seq, message } } } })
  },
  incrementPendingAttachmentReads: (sessionId) => {
    const current = get().bySession[sessionId] ?? EMPTY_DRAFT
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, pendingAttachmentReads: current.pendingAttachmentReads + 1 } } })
  },
  decrementPendingAttachmentReads: (sessionId) => {
    const current = get().bySession[sessionId] ?? EMPTY_DRAFT
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, pendingAttachmentReads: Math.max(0, current.pendingAttachmentReads - 1) } } })
  }
}))

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
  // #514/#432: shared between MessageInput.tsx's own paste-time attach/remove announcements and
  // ChatPane.tsx's drag-and-drop handler (#432), which has no reason to touch this component's
  // internals otherwise -- both read/write the SAME per-session live region through this field
  // and the `announceAttachment` action below, instead of MessageInput keeping it as private
  // state ChatPane could never reach. `seq` forces a fresh DOM node even when `message` repeats
  // (a11y fix #598: a repeated identical announcement must still re-render the live region).
  attachmentAnnouncement: { seq: number; message: string } | null
  // PR #723 gate round 1 fix (Code1 Medium): a background path/drop image read (the mixed-paste
  // branch in `MessageInput.tsx`, and every drop in `ChatPane.tsx`) is NOT awaited by whatever
  // triggered it -- the rest of the app, including Enter-to-send, keeps running while the IPC
  // round trip is in flight. Without this counter, pressing Enter mid-read sends the message
  // WITHOUT the image (which then lands on the NEXT draft instead), or a late-arriving result
  // during an in-flight send's own `await` can be silently dropped. Incremented before a
  // background/drop read starts, decremented in its own `finally`; `handleSend` refuses while
  // this is above 0 for the session, the same way it already refuses while `disabled`/`starting`.
  pendingAttachmentReads: number
}

// Stable reference for a Session with no draft yet, so a selector never returns a fresh object on
// every call (a fresh `{}` literal would break useSyncExternalStore's snapshot stability and cause
// an infinite re-render loop -- same reasoning queue-store's EMPTY_QUEUE/readout-store's
// EMPTY_READOUT document). Reuses attachments.ts's own EMPTY_ATTACHMENTS rather than duplicating
// the empty shape.
export const EMPTY_DRAFT: Draft = { text: '', attachments: EMPTY_ATTACHMENTS, attachmentAnnouncement: null, pendingAttachmentReads: 0 }

interface DraftState {
  bySession: Record<string, Draft>
  setText(sessionId: string, text: string): void
  setAttachments(sessionId: string, updater: AttachmentsState | ((prev: AttachmentsState) => AttachmentsState)): void
  /** Send-success clearing (spec 009 FR-007, spec 010 FR-005): resets both text and attachments
   * back to empty in one atomic update, replacing what used to be two separate `setText('')`/
   * `setAttachments(EMPTY_ATTACHMENTS)` calls in MessageInput.tsx. */
  clear(sessionId: string): void
  /** #514/#432: announces an attachment-related event (attached, removed, collapsed into a
   * chip...) through the shared sr-only live region `MessageInput.tsx` renders for this session.
   * Monotonic `seq` so a repeated identical message still forces a fresh DOM node (a11y fix
   * #598), matching the exact behaviour the message-local implementation this replaces had. */
  announceAttachment(sessionId: string, message: string): void
  /** See `Draft.pendingAttachmentReads`'s own doc comment. */
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
  clear: (sessionId) => {
    set({ bySession: { ...get().bySession, [sessionId]: EMPTY_DRAFT } })
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

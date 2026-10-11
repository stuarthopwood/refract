import { create } from 'zustand'
import { toast } from 'sonner'
import type { SideChatRecord } from '../../shared/frames'

// Spec 014 data-model.md `SideChatThreadState`: per-Session side-chat thread state, rebuilt fresh
// on every launch (no renderer-side persistence) -- `get_btw_history` is the single source of
// truth for anything older than this app run (FR-004), same reasoning `right-pane-store.ts` uses
// for its own non-persisted state. Keyed per Session (research.md decision 6, mirrors
// `subagent-store.ts`'s own per-id keying), not single-Session-at-a-time like the main
// transcript, since a thread must survive its owning pane losing focus (Edge Cases: closing the
// panel never cancels an in-flight question).

interface SideChatSessionState {
  records: SideChatRecord[]
  /** The record id the NEXT question should carry as `recordId`, or undefined for a fresh topic
   * (FR-003). Set to the latest record's own id after every send; cleared by `clearThread`. */
  activeTopicRecordId: string | undefined
  /** True while a `btw` request for this Session has been sent and no terminal `btw_record`
   * (complete/cancelled/error/interrupted) has arrived yet (FR-005). */
  running: boolean
}

const EMPTY_SESSION_STATE: SideChatSessionState = { records: [], activeTopicRecordId: undefined, running: false }

interface SideChatThreadState {
  bySession: Record<string, SideChatSessionState>
  loadHistory(sessionId: string): Promise<void>
  ask(sessionId: string, question: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  clearThread(sessionId: string): void
  /** Applies a `btw_delta` (`delta` set) or terminal `btw_record` (`record` set) arriving over
   * `onSideChatPatch`. */
  applyPatch(sessionId: string, patch: { delta?: string; record?: SideChatRecord }): void
}

function isRunningStatus(status: SideChatRecord['status']): boolean {
  return status === 'running'
}

export const useSideChatStore = create<SideChatThreadState>((set, get) => ({
  bySession: {},

  async loadHistory(sessionId) {
    const result = await window.refract.sideChat.getHistory(sessionId)
    if (!result.ok) {
      toast.error(`Could not load side chat history: ${result.error.message}`)
      return
    }
    const records = result.value
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          records,
          activeTopicRecordId: records.at(-1)?.id,
          running: records.some((record) => isRunningStatus(record.status))
        }
      }
    }))
  },

  async ask(sessionId, question) {
    const before = get().bySession[sessionId] ?? EMPTY_SESSION_STATE
    const recordId = before.activeTopicRecordId
    // FR-005: `running` becomes true the moment the request is sent, not only once this call
    // resolves -- an in-flight `ask` already means the panel must show "Thinking".
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...before, running: true } } }))
    const result = await window.refract.sideChat.ask(sessionId, question, recordId)
    if (!result.ok) {
      set((state) => ({
        bySession: { ...state.bySession, [sessionId]: { ...(state.bySession[sessionId] ?? before), running: false } }
      }))
      toast.error(`Side question failed: ${result.error.message}`)
      throw new Error(result.error.message)
    }
    // Seeds a `running` placeholder record under the real id the request just returned, so the
    // panel has something to render even before any SIDE_CHAT_PATCH names it.
    const newRecordId = result.value.recordId
    set((state) => {
      const current = state.bySession[sessionId] ?? before
      const records = current.records.some((record) => record.id === newRecordId)
        ? current.records
        : [...current.records, { id: newRecordId, status: 'running' as const, question }]
      return { bySession: { ...state.bySession, [sessionId]: { records, activeTopicRecordId: newRecordId, running: true } } }
    })
  },

  async cancel(sessionId) {
    const result = await window.refract.sideChat.cancel(sessionId)
    if (!result.ok) {
      toast.error(`Could not cancel the side question: ${result.error.message}`)
    }
  },

  clearThread(sessionId) {
    set((state) => {
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
  },

  applyPatch(sessionId, patch) {
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      if (patch.record) {
        const record = patch.record
        const index = existing.records.findIndex((candidate) => candidate.id === record.id)
        const records =
          index === -1 ? [...existing.records, record] : existing.records.map((candidate, i) => (i === index ? record : candidate))
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: { records, activeTopicRecordId: record.id, running: isRunningStatus(record.status) }
          }
        }
      }
      if (patch.delta !== undefined) {
        // Single-flight (contracts/ipc.md): one side question runs per Session at a time, so a
        // delta always extends whichever record is currently `running` -- no `recordId` is
        // carried at the patch level (data-model.md `applyPatch`).
        const delta = patch.delta
        const index = existing.records.findIndex((candidate) => isRunningStatus(candidate.status))
        const target = index === -1 ? undefined : existing.records[index]
        if (!target) return state
        const nextRecord: SideChatRecord = { ...target, answer: (target.answer ?? '') + delta }
        const records = existing.records.map((candidate, i) => (i === index ? nextRecord : candidate))
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, records } } }
      }
      return state
    })
  }
}))

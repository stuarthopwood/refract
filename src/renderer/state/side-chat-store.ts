import { create } from 'zustand'
import { toast } from 'sonner'
import type { SideChatRecord } from '../../shared/frames'

/** Shared wording for the "side chat history is still loading" hint and the `/btw` toast. */
export const SIDE_CHAT_LOADING_HINT = 'Side chat is still loading its history.'

// Per-Session thread state, rebuilt on every launch; `get_btw_history` is the source of truth for older history.

// Bumped by `clearThread`, outside the deleted entry so it survives; in-flight `loadHistory`/`ask` skip their `set` if it changed, so a Conversation change never resurrects old state.
const epochBySession = new Map<string, number>()

function bumpSideChatEpoch(sessionId: string): number {
  const next = (epochBySession.get(sessionId) ?? 0) + 1
  epochBySession.set(sessionId, next)
  return next
}

function currentSideChatEpoch(sessionId: string): number {
  return epochBySession.get(sessionId) ?? 0
}

interface SideChatSessionState {
  records: SideChatRecord[]
  /** The record id the next question carries as `recordId` (undefined = fresh topic); moves only when a record completes. */
  activeTopicRecordId: string | undefined
  /** True while any record is `running`; always recomputed from `records`, never hard-coded. */
  running: boolean
  /** True once `loadHistory` has succeeded this app run; stays false on a failed load so the next render retries. */
  loaded: boolean
  /** Set when `loadHistory` fails for a reason other than `agent-not-running`; cleared when a load starts again. */
  loadError: boolean
}

const EMPTY_SESSION_STATE: SideChatSessionState = {
  records: [],
  activeTopicRecordId: undefined,
  running: false,
  loaded: false,
  loadError: false
}

interface SideChatThreadState {
  bySession: Record<string, SideChatSessionState>
  loadHistory(sessionId: string): Promise<void>
  ask(sessionId: string, question: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  clearThread(sessionId: string): void
  /** Starts a new topic and clears the displayed thread without dropping `loaded` or refetching (no delete RPC exists, so a refetch would restore it).
   * Bumps `epochBySession` so a late `ask` reply cannot re-append a stuck "Thinking" row. A later reload restores history and continues the newest topic. */
  clearDisplayedThread(sessionId: string): void
  /** Applies a `btw_delta`, a terminal `btw_record`, or a history save-failure `notice` from `onSideChatPatch`. */
  applyPatch(sessionId: string, patch: { delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }): void
  /** Marks `running` records `interrupted` once the agent process exits, since no terminal patch will arrive; no-op if none. */
  reconcileInterrupted(sessionId: string): void
}

function isRunningStatus(status: SideChatRecord['status']): boolean {
  return status === 'running'
}

function computeRunning(records: SideChatRecord[]): boolean {
  return records.some((record) => isRunningStatus(record.status))
}
function stripInternalPrefix(message: string): string {
  // Internal `SessionAgent <uuid>:` / `OmpProcess:` prefixes must not leak into user-facing toasts.
  return message.replace(/^(SessionAgent [^:]+|OmpProcess):\s*/, '')
}

export const useSideChatStore = create<SideChatThreadState>((set, get) => ({
  bySession: {},

  async loadHistory(sessionId) {
    // Captured before the await; a Conversation change bumps it, and the stale result must not be applied.
    const epoch = currentSideChatEpoch(sessionId)
    // Clear a stale loadError as soon as a retry starts.
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing?.loadError) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, loadError: false } } }
    })
    const result = await window.refract.sideChat.getHistory(sessionId)
    if (epoch !== currentSideChatEpoch(sessionId)) {
      // Stale result dropped; retry for the current Conversation, since the panel's load effect would not re-fire (`loaded` stays false). Each call captures its own epoch, so this cannot loop.
      if (!get().bySession[sessionId]?.loaded) void get().loadHistory(sessionId)
      return
    }
    if (!result.ok) {
      // `agent-not-running` is not "no history": keep `loaded` false so the panel retries, and show no toast.
      if (result.error.code === 'agent-not-running') return
      // Any other failure will not resolve itself; `loadError` lets the panel hint say so.
      set((state) => {
        const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, loadError: true } } }
      })
      toast.error(`Could not load side chat history: ${stripInternalPrefix(result.error.message)}`)
      return
    }
    const fetched = result.value
    // The history is flattened root-first, oldest topic first; only a root row has `id === topicId`.
    // Continue the last root's `id` as `recordId` (`leafId` is rejected by OMP, and follow-up synthetic ids must never be sent back).
    const lastRoot = [...fetched].reverse().find((record) => record.id === record.topicId)
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      // Merge, never replace: a question asked after this fetch started must survive a slower reply, and OMP can return a `running`
      // record that already settled live. The existing copy wins when newer or terminal-vs-running; otherwise the fetched copy wins.
      const existingById = new Map(existing.records.map((record) => [record.id, record]))
      const merged = fetched.map((record) => {
        const current = existingById.get(record.id)
        if (!current) return record
        const currentIsAuthoritative =
          (current.updatedAt ?? 0) >= (record.updatedAt ?? 0) || (current.status !== 'running' && record.status === 'running')
        return currentIsAuthoritative ? current : record
      })
      const mergedIds = new Set(merged.map((record) => record.id))
      const onlyInExisting = existing.records.filter((record) => !mergedIds.has(record.id))
      const finalRecords = [...merged, ...onlyInExisting]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            records: finalRecords,
            activeTopicRecordId: existing.activeTopicRecordId ?? lastRoot?.topicId ?? lastRoot?.id,
            running: computeRunning(finalRecords),
            loaded: true,
            loadError: false
          }
        }
      }
    })
  },

  async ask(sessionId, question) {
    const before = get().bySession[sessionId] ?? EMPTY_SESSION_STATE
    const recordId = before.activeTopicRecordId
    // Captured before the await so a Conversation change in flight cannot resurrect the old Conversation's state.
    const epoch = currentSideChatEpoch(sessionId)
    // `running` is set when the request is sent so the panel shows "Thinking" while in flight.
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...before, running: true } } }))
    const result = await window.refract.sideChat.ask(sessionId, question, recordId)
    const stale = epoch !== currentSideChatEpoch(sessionId)
    if (!result.ok) {
      // The question belonged to the Conversation just left: no toast and no `set` (its entry is gone).
      if (stale) return
      set((state) => {
        const current = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              ...current,
              running: computeRunning(current.records),
              // Only a genuine "Unknown /btw topic" rejection means the id is bad; other failures keep the topic so a resend works.
              activeTopicRecordId:
                current.activeTopicRecordId === recordId && /Unknown \/btw topic/.test(result.error.message)
                  ? undefined
                  : current.activeTopicRecordId
            }
          }
        }
      })
      // Strip OMP's `btw failed: ` prefix and render the unknown-topic rejection in plain English.
      const cleaned = stripInternalPrefix(result.error.message).replace(/^btw failed:\s*/, '')
      const friendly = /Unknown \/btw topic/.test(cleaned) ? 'That topic is no longer available. Send again to start a new one.' : cleaned
      toast.error(`Side question failed: ${friendly}`)
      throw new Error(result.error.message)
    }
    if (stale) return
    // A terminal `btw_record` can settle this record before the reply lands; the already-patched copy must win.
    const response = result.value.record
    set((state) => {
      const current = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      const alreadyPatched = current.records.find((record) => record.id === response.id)
      const records = alreadyPatched ? current.records : [...current.records, response]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...current, records, running: computeRunning(records) }
        }
      }
    })
  },

  async cancel(sessionId) {
    const result = await window.refract.sideChat.cancel(sessionId)
    if (!result.ok) {
      toast.error(`Could not cancel the side question: ${stripInternalPrefix(result.error.message)}`)
    }
  },

  clearThread(sessionId) {
    // Bump before the delete so in-flight loads/asks skip their `set`.
    bumpSideChatEpoch(sessionId)
    set((state) => {
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
  },

  clearDisplayedThread(sessionId) {
    // The epoch bump makes a still-in-flight `ask` stale, so its late reply cannot re-append a stuck "Thinking" row; it never retriggers a reload.
    bumpSideChatEpoch(sessionId)
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...existing, records: [], activeTopicRecordId: undefined, running: false }
        }
      }
    })
  },

  reconcileInterrupted(sessionId) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      const hasRunning = existing.records.some((record) => record.status === 'running')
      // No-op when nothing is running, so an `ask` that set `running` but has no record yet is not re-enabled mid-flight.
      if (!hasRunning) return state
      const records = existing.records.map((record) =>
        record.status === 'running' ? { ...record, status: 'interrupted' as const } : record
      )
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...existing, records, running: false }
        }
      }
    })
  },

  applyPatch(sessionId, patch) {
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      if (patch.notice !== undefined) {
        // A history save failure is only toasted; records are untouched.
        toast.error(`Side chat: ${stripInternalPrefix(patch.notice)}`)
        return state
      }
      if (patch.record) {
        const record = patch.record
        const index = existing.records.findIndex((candidate) => candidate.id === record.id)
        // An unseen record arriving before history loads belongs to the Conversation just left; wait for `loadHistory`.
        if (index === -1 && !existing.loaded) return state
        const records =
          index === -1 ? [...existing.records, record] : existing.records.map((candidate, i) => (i === index ? record : candidate))
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              ...existing,
              records,
              // Only a complete answer is continued from; use `topicId` (the root id), the only valid `recordId` for a follow-up.
              activeTopicRecordId: record.status === 'complete' ? (record.topicId ?? record.id) : existing.activeTopicRecordId,
              running: computeRunning(records)
            }
          }
        }
      }
      if (patch.delta !== undefined && patch.recordId !== undefined) {
        // A delta's `recordId` is always the topic's root id (even for a follow-up), so match by `topicId` + running.
        const delta = patch.delta
        const topicId = patch.recordId
        const index = existing.records.findIndex((candidate) => candidate.topicId === topicId && candidate.status === 'running')
        if (index === -1) return state
        const target = existing.records[index]
        if (!target) return state
        const nextRecord: SideChatRecord = { ...target, answer: (target.answer ?? '') + delta }
        const records = existing.records.map((candidate, i) => (i === index ? nextRecord : candidate))
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, records } } }
      }
      return state
    })
  }
}))

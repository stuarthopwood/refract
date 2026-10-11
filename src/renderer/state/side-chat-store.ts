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
   * (FR-003). Gate-fix (round 2, Code2 Medium): only ever moves when a record reaches
   * `status: 'complete'` (`applyPatch`) -- an error or a cancelled record is never "the prior
   * answer" FR-003 means to continue from. Cleared by `clearThread`. */
  activeTopicRecordId: string | undefined
  /** True while at least one record for this Session has `status: 'running'` (FR-005).
   * Gate-fix (round 2, Code2/Sec2/Verif2 HIGH): recomputed from `records` on every change, never
   * hard-coded -- the old code force-set this `true` at the end of `ask()` even when a faster
   * terminal `btw_record` had already arrived and correctly cleared it, leaving the panel stuck
   * on "Thinking" forever. */
  running: boolean
  /** True once `loadHistory` has succeeded at least once for this Session this app run
   * (gate-fix round 2, Code2/Sec2 Medium: replaces a per-component `useRef`, which re-fired on
   * every remount -- A -> B -> A reloaded history every time, contradicting FR-004's "once per
   * Session per app run"). Stays `false` on a failed load (for example `agent-not-running`
   * before the Session's process has started) so the next render's effect retries instead of
   * silently treating "could not load yet" as "there is no history". */
  loaded: boolean
}

const EMPTY_SESSION_STATE: SideChatSessionState = {
  records: [],
  activeTopicRecordId: undefined,
  running: false,
  loaded: false
}

interface SideChatThreadState {
  bySession: Record<string, SideChatSessionState>
  loadHistory(sessionId: string): Promise<void>
  ask(sessionId: string, question: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  clearThread(sessionId: string): void
  /** Applies a `btw_delta` (`delta` + `recordId` set) or terminal `btw_record` (`record` set)
   * arriving over `onSideChatPatch`. */
  applyPatch(sessionId: string, patch: { delta?: string; recordId?: string; record?: SideChatRecord }): void
}

function isRunningStatus(status: SideChatRecord['status']): boolean {
  return status === 'running'
}

function computeRunning(records: SideChatRecord[]): boolean {
  return records.some((record) => isRunningStatus(record.status))
}

export const useSideChatStore = create<SideChatThreadState>((set, get) => ({
  bySession: {},

  async loadHistory(sessionId) {
    const result = await window.refract.sideChat.getHistory(sessionId)
    if (!result.ok) {
      // Gate-fix (round 2, Code2/Sec2 Medium): a Session whose process has not started yet
      // throws `agent-not-running` here -- that is NOT "this Session has no side-chat history",
      // so `loaded` must stay `false` (the panel's own effect retries once the Session starts)
      // and no raw internal error text reaches the user as a toast.
      if (result.error.code === 'agent-not-running') return
      toast.error(`Could not load side chat history: ${result.error.message}`)
      return
    }
    const fetched = result.value
    // Spec 014 (live correction, 2026-10-11): `get_btw_history` is one entry per independent
    // topic, flattened root-first then its own follow-ups in order (`SessionAgent.
    // flattenBtwHistory`) -- only a flattened ROOT row carries `leafId` (a non-root follow-up
    // has no real OMP id of its own to continue from). The topic to continue is the LAST root in
    // the list (the most recently started topic), never the last flattened row itself -- a
    // follow-up's own synthetic `${root.id}.${index}` key must never be sent back as `recordId`.
    const lastRoot = [...fetched].reverse().find((record) => record.leafId !== undefined)
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      // Gate-fix (round 2, Code2 Medium): merge, never replace outright -- a question asked
      // (or still running) after this fetch started must survive a slower `get_btw_history`
      // reply landing afterward. Any record `fetched` already has (by id) wins (it is OMP's own
      // authoritative history); a still-running or newly-seeded record not yet reflected in
      // `fetched` is kept alongside it.
      const fetchedIds = new Set(fetched.map((record) => record.id))
      const merged = [...fetched, ...existing.records.filter((record) => !fetchedIds.has(record.id))]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            records: merged,
            activeTopicRecordId: existing.activeTopicRecordId ?? lastRoot?.leafId,
            running: computeRunning(merged),
            loaded: true
          }
        }
      }
    })
  },

  async ask(sessionId, question) {
    const before = get().bySession[sessionId] ?? EMPTY_SESSION_STATE
    const recordId = before.activeTopicRecordId
    // FR-005: `running` becomes true the moment the request is sent, not only once this call
    // resolves -- an in-flight `ask` already means the panel must show "Thinking".
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...before, running: true } } }))
    const result = await window.refract.sideChat.ask(sessionId, question, recordId)
    if (!result.ok) {
      set((state) => {
        const current = state.bySession[sessionId] ?? before
        return { bySession: { ...state.bySession, [sessionId]: { ...current, running: computeRunning(current.records) } } }
      })
      toast.error(`Side question failed: ${result.error.message}`)
      throw new Error(result.error.message)
    }
    // Gate-fix (round 2, Code2/Sec2/Verif2 HIGH): the response now carries the record's OWN
    // status, not just its id -- a terminal `btw_record` for this same question can race this
    // call's own reply back over `SIDE_CHAT_PATCH` (`applyPatch`, below) and settle it FIRST; in
    // that case the already-patched (possibly terminal) record must win, never be clobbered back
    // to a stale `running` placeholder. `running` is always recomputed from the real records
    // array afterward, never hard-coded.
    const response = result.value.record
    set((state) => {
      const current = state.bySession[sessionId] ?? before
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
            [sessionId]: {
              ...existing,
              records,
              // Gate-fix (round 2, Code2 Medium): only a 'complete' answer is the prior answer
              // the next question should continue from -- an error or a cancelled record must
              // never become the next question's own `recordId`.
              activeTopicRecordId: record.status === 'complete' ? record.id : existing.activeTopicRecordId,
              running: computeRunning(records)
            }
          }
        }
      }
      if (patch.delta !== undefined && patch.recordId !== undefined) {
        // Gate-fix (round 2, Code2 Medium): matches the delta to the record OMP itself named,
        // never "whichever record happens to have status running" -- a stale running row left
        // by a crashed process could otherwise receive another question's own streamed text.
        const delta = patch.delta
        const targetId = patch.recordId
        const index = existing.records.findIndex((candidate) => candidate.id === targetId)
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

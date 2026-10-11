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
  /** Gate-fix (round 3, Code3/A11y3 Medium): called when the Session leaves a live state (its
   * agent process exited) -- a `running` record left as-is would block Send/Retry/`/btw`
   * forever, since no terminal `btw_delta`/`btw_record` will ever arrive for it now (the
   * process that would have sent one is gone). Marks any such record `interrupted` and
   * recomputes `running`; a no-op if nothing was running. */
  reconcileInterrupted(sessionId: string): void
}

function isRunningStatus(status: SideChatRecord['status']): boolean {
  return status === 'running'
}

function computeRunning(records: SideChatRecord[]): boolean {
  return records.some((record) => isRunningStatus(record.status))
}
function stripInternalPrefix(message: string): string {
  // Gate-fix (round 3, Sec3 LOW): `SessionAgent.ts`'s own thrown errors are prefixed
  // `SessionAgent <uuid>: ...` for its OWN logs -- an internal implementation detail that must
  // never leak into a user-facing toast.
  return message.replace(/^SessionAgent [^:]+:\s*/, '')
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
    // `get_btw_history` is one entry per independent topic, flattened root-first then its own
    // follow-ups in order (`SessionAgent.flattenBtwHistory`); only a flattened ROOT row carries
    // an `id` and `leafId` of its own (a non-root follow-up has no real OMP id to continue
    // from). Gate-fix (round 3, Code3/Verif3 HIGH): `leafId` is NOT the continuation key --
    // live-tested against a RESTARTED omp process (scratch verification, 2026-10-11) sending a
    // completed thread's own `id` as `recordId` succeeded (`ok: true`, the new question landed
    // as a third follow-up of the same topic); sending that same thread's `leafId` instead
    // failed every time with "Unknown /btw topic". `BtwHistoryThread.leafId` tracks something
    // else inside OMP's own model, never a value `btw`'s `recordId` accepts back. The topic to
    // continue is the LAST root in the list (the most recently started topic), never the last
    // flattened row itself -- a follow-up's own synthetic `${root.id}.${index}` key must never
    // be sent back as `recordId` either (only a flattened ROOT row's own `id` is genuine).
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
            activeTopicRecordId: existing.activeTopicRecordId ?? lastRoot?.id,
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
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              ...current,
              running: computeRunning(current.records),
              // Gate-fix (round 3, Verif3 HIGH safety net): a `recordId` that was just sent and
              // rejected (for any reason -- not only the restart/leafId case this round fixed)
              // must never be retried forever; if nothing else already changed it meanwhile,
              // clear it so the NEXT question starts a fresh topic (Spec 014's own documented
              // fallback) instead of looping on the same rejected id, which otherwise locked
              // every later Send/Retry/`/btw` for this Session permanently.
              activeTopicRecordId: current.activeTopicRecordId === recordId ? undefined : current.activeTopicRecordId
            }
          }
        }
      })
      toast.error(`Side question failed: ${stripInternalPrefix(result.error.message)}`)
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
      toast.error(`Could not cancel the side question: ${stripInternalPrefix(result.error.message)}`)
    }
  },

  clearThread(sessionId) {
    set((state) => {
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
  },

  reconcileInterrupted(sessionId) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      const hasRunning = existing.records.some((record) => record.status === 'running')
      if (!hasRunning && !existing.running) return state
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

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
  /** Applies a `btw_delta` (`delta` + `recordId` set), a terminal `btw_record` (`record` set),
   * or a btw-history save-failure notice (`notice` set, gate-fix round 4, Code4 Medium) arriving
   * over `onSideChatPatch`. */
  applyPatch(sessionId: string, patch: { delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }): void
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
      toast.error(`Could not load side chat history: ${stripInternalPrefix(result.error.message)}`)
      return
    }
    const fetched = result.value
    // `get_btw_history` is one entry per independent topic, flattened root-first then its own
    // follow-ups in order (`SessionAgent.flattenBtwHistory`, which sorts topics OLDEST first,
    // gate-fix round 4, Code4/Verif4 HIGH -- OMP's own `get_btw_history` itself returns them
    // newest first); only a flattened ROOT row carries `leafId` and a non-synthetic `id` (a
    // non-root follow-up has no real OMP id of its own). Gate-fix (round 3, Code3/Verif3 HIGH):
    // `leafId` is NOT the continuation key -- live-tested against a RESTARTED omp process
    // sending a completed thread's own `id` as `recordId` succeeded; `leafId` was rejected
    // every time with "Unknown /btw topic" (it is the MAIN session's own leaf entry id at topic
    // creation, unrelated to `btw` continuation -- round 4, Code4 LOW). The topic to continue is
    // the LAST root in the (now correctly oldest-first) list -- the most recently STARTED topic,
    // never the last flattened row itself -- a follow-up's own synthetic `${root.id}.${index}`
    // key must never be sent back as `recordId` either; `topicId` (equal to the root's own `id`
    // for a root row) is the one canonical field for that, gate-fix round 4, Code4/Verif4
    // CRITICAL.
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
            activeTopicRecordId: existing.activeTopicRecordId ?? lastRoot?.topicId ?? lastRoot?.id,
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
              // Gate-fix (round 3, Verif3 HIGH safety net; narrowed round 4, Code4/Verif4
              // MEDIUM): clearing on ANY failure also wiped the topic for a transient
              // "still running"/`agent-not-running`/save-failure rejection, unrelated to the
              // restart/wrong-id case this is meant for -- only a genuine "Unknown /btw topic"
              // rejection (confirmed live, round 3: the exact OMP wording for a rejected
              // `recordId`) means the id itself is actually bad; every other failure leaves the
              // topic as-is so the SAME question (or Retry) can simply be sent again.
              activeTopicRecordId:
                current.activeTopicRecordId === recordId && /Unknown \/btw topic/.test(result.error.message)
                  ? undefined
                  : current.activeTopicRecordId
            }
          }
        }
      })
      // Gate-fix (round 4, Code4 LOW): strips OMP's own `btw failed: ` prefix too (not just the
      // `SessionAgent <uuid>: ` one), and renders the "Unknown /btw topic" rejection in plain
      // English -- a raw hex topic id in a toast means nothing to the developer.
      const cleaned = stripInternalPrefix(result.error.message).replace(/^btw failed:\s*/, '')
      const friendly = /Unknown \/btw topic/.test(cleaned) ? 'That topic is no longer available; starting a new one.' : cleaned
      toast.error(`Side question failed: ${friendly}`)
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
      // Gate-fix (round 4, Verif4 LOW): a no-op, `running` included, when nothing is actually
      // running -- the old code forced `running: false` even when an `ask` call had already set
      // it `true` synchronously but no record had landed yet, which re-enabled Send mid-flight
      // for a call that was still genuinely in progress (and will correctly settle itself via
      // `ask`'s own failure branch if the process really is gone).
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
        // Gate-fix (round 4, Code4 Medium, constitution II/FR-010): a btw-history save failure
        // -- never written into any transcript, shown exactly like every other side-chat
        // failure (a toast only); the records themselves are untouched.
        toast.error(`Side chat: ${stripInternalPrefix(patch.notice)}`)
        return state
      }
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
              // never become the next question's own `recordId`. Gate-fix (round 4, Code4/Verif4
              // CRITICAL): `topicId` (the thread's own root id), not this record's own flattened
              // `id` -- for a follow-up turn those differ, and only the topic's root id is ever
              // a valid `recordId`.
              activeTopicRecordId: record.status === 'complete' ? (record.topicId ?? record.id) : existing.activeTopicRecordId,
              running: computeRunning(records)
            }
          }
        }
      }
      if (patch.delta !== undefined && patch.recordId !== undefined) {
        // Gate-fix (round 2, Code2 Medium; round 4, Code4/Verif4 CRITICAL): a `btw_delta`'s own
        // `recordId` is always the TOPIC's root id, never the latest turn's own flattened id
        // (confirmed live: a follow-up's delta still names the root) -- matches by `topicId` +
        // `status: 'running'` instead of a plain id match, which could never find a follow-up's
        // own row at all (its flattened id never equals the root id a delta actually carries).
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

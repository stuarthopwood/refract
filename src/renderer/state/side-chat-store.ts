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

// Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): a Conversation-change race -- a `loadHistory`
// or `ask` call still in flight when `clearThread` runs (a `sideChatConversationChanged` event,
// or a rapid consecutive switch) -- must never resurrect the just-left Conversation's state.
// Kept as a plain module-level map, OUTSIDE `SideChatSessionState`/`clearThread`'s own deleted
// entry, so the epoch itself survives the delete; `loadHistory`/`ask` capture it before their one
// `await` and skip their own `set` entirely if it changed underneath them.
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
  /** Gate-fix (round 5, A11y5 LOW): set when `loadHistory` fails for a reason OTHER than
   * `agent-not-running` (a genuine `get_btw_history` failure that will not resolve itself once
   * the Session starts) -- the panel's own `!loaded` hint text must not keep telling the
   * developer side chat "is available once the Session is running" when the real problem is
   * that history could not be loaded at all. Cleared whenever a load attempt starts again. */
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
  // Gate-fix (round 3, Sec3 LOW; extended round 5, Sec5 LOW): `SessionAgent.ts`'s own thrown
  // errors are prefixed `SessionAgent <uuid>: ...`; `OmpProcess`'s own rejections (a request
  // that timed out, or the process exiting mid-request) are prefixed `OmpProcess: ...` -- both
  // are internal implementation details that must never leak into a user-facing toast.
  return message.replace(/^(SessionAgent [^:]+|OmpProcess):\s*/, '')
}

export const useSideChatStore = create<SideChatThreadState>((set, get) => ({
  bySession: {},

  async loadHistory(sessionId) {
    // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): captured before the one `await` below;
    // if a Conversation change (`clearThread`) bumps it before this resolves, the fetched copy
    // belongs to a Conversation that no longer exists in the store and must never be applied --
    // see `epochBySession`'s own doc comment.
    const epoch = currentSideChatEpoch(sessionId)
    // Gate-fix (round 6, A11y6/Sec6 LOW): matches this field's own doc comment ("cleared
    // whenever a load attempt starts again") -- previously only cleared on a SUCCESSFUL load,
    // so a retry after a permanent failure kept showing the stale "could not be loaded" hint
    // for the whole time the new attempt was still in flight.
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing?.loadError) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, loadError: false } } }
    })
    const result = await window.refract.sideChat.getHistory(sessionId)
    if (epoch !== currentSideChatEpoch(sessionId)) return
    if (!result.ok) {
      // Gate-fix (round 2, Code2/Sec2 Medium): a Session whose process has not started yet
      // throws `agent-not-running` here -- that is NOT "this Session has no side-chat history",
      // so `loaded` must stay `false` (the panel's own effect retries once the Session starts)
      // and no raw internal error text reaches the user as a toast.
      if (result.error.code === 'agent-not-running') return
      // Gate-fix (round 5, A11y5 LOW): any OTHER failure is a genuine load error that will not
      // resolve itself once the Session starts -- `loadError` lets the panel's own hint say so
      // instead of repeating the "available once running" text forever.
      set((state) => {
        const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, loadError: true } } }
      })
      toast.error(`Could not load side chat history: ${stripInternalPrefix(result.error.message)}`)
      return
    }
    const fetched = result.value
    // `get_btw_history` is one entry per independent topic, flattened root-first then its own
    // follow-ups in order (`SessionAgent.flattenBtwHistory`, which sorts topics OLDEST first,
    // gate-fix round 4, Code4/Verif4 HIGH -- OMP's own `get_btw_history` itself returns them
    // newest first); only a flattened ROOT row's own `id` equals its own `topicId` (a non-root
    // follow-up's `topicId` points at its own root instead). Gate-fix (round 3, Code3/Verif3
    // HIGH): `leafId` is NOT the continuation key -- live-tested against a RESTARTED omp
    // process sending a completed thread's own `id` as `recordId` succeeded; `leafId` was
    // rejected every time with "Unknown /btw topic" (it is the MAIN session's own leaf entry id
    // at topic creation, unrelated to `btw` continuation -- round 4, Code4 LOW). Gate-fix (round
    // 5, Code5 LOW): found via `id === topicId`, not `leafId !== undefined` -- OMP's own schema
    // allows `leafId: string | null`, so the old predicate worked only by accident. The topic to
    // continue is the LAST root in the (now correctly oldest-first) list -- the most recently
    // STARTED topic, never the last flattened row itself -- a follow-up's own synthetic
    // `${root.id}.${index}` key must never be sent back as `recordId` either; `topicId` is the
    // one canonical field for that, gate-fix round 4, Code4/Verif4 CRITICAL.
    const lastRoot = [...fetched].reverse().find((record) => record.id === record.topicId)
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      // Gate-fix (round 2, Code2 Medium; round 5, Verif5 MEDIUM): merge, never replace outright
      // -- a question asked (or still running) after this fetch started must survive a slower
      // `get_btw_history` reply landing afterward. OMP's own history reply can include an
      // in-flight (`running`) record for a turn that has ALREADY settled live by the time this
      // reply arrives (the likeliest trigger: `/btw` from the main composer opens the panel,
      // starting `loadHistory` and `ask` together) -- blindly letting the fetched copy win would
      // put a stale `running`/empty-answer row back over one `applyPatch` already completed,
      // re-stalling the panel on "Thinking" and discarding any text already streamed into it.
      // For an id present in both, the store's own existing copy wins whenever it is NEWER
      // (`updatedAt`) or already terminal while the fetched copy is still `running`; otherwise
      // the fetched copy (OMP's own authoritative history) wins, same as before. A record not
      // yet reflected in `fetched` at all (brand new, or still running) is kept alongside it.
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
    // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): captured before the one `await` below --
    // see `epochBySession`'s own doc comment. A side question still in flight when the
    // Conversation changes must never resurrect the just-left Conversation's state once it
    // settles.
    const epoch = currentSideChatEpoch(sessionId)
    // FR-005: `running` becomes true the moment the request is sent, not only once this call
    // resolves -- an in-flight `ask` already means the panel must show "Thinking".
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...before, running: true } } }))
    const result = await window.refract.sideChat.ask(sessionId, question, recordId)
    const stale = epoch !== currentSideChatEpoch(sessionId)
    if (!result.ok) {
      if (!stale) {
        set((state) => {
          const current = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
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
                // `recordId`) means the id itself is actually bad; every other failure leaves
                // the topic as-is so the SAME question (or Retry) can simply be sent again.
                activeTopicRecordId:
                  current.activeTopicRecordId === recordId && /Unknown \/btw topic/.test(result.error.message)
                    ? undefined
                    : current.activeTopicRecordId
              }
            }
          }
        })
      }
      // Gate-fix (round 4, Code4 LOW): strips OMP's own `btw failed: ` prefix too (not just the
      // `SessionAgent <uuid>: ` one), and renders the "Unknown /btw topic" rejection in plain
      // English -- a raw hex topic id in a toast means nothing to the developer.
      const cleaned = stripInternalPrefix(result.error.message).replace(/^btw failed:\s*/, '')
      const friendly = /Unknown \/btw topic/.test(cleaned) ? 'That topic is no longer available. Send again to start a new one.' : cleaned
      toast.error(`Side question failed: ${friendly}`)
      throw new Error(result.error.message)
    }
    if (stale) return
    // Gate-fix (round 2, Code2/Sec2/Verif2 HIGH): the response now carries the record's OWN
    // status, not just its id -- a terminal `btw_record` for this same question can race this
    // call's own reply back over `SIDE_CHAT_PATCH` (`applyPatch`, below) and settle it FIRST; in
    // that case the already-patched (possibly terminal) record must win, never be clobbered back
    // to a stale `running` placeholder. `running` is always recomputed from the real records
    // array afterward, never hard-coded.
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
    // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): bumped BEFORE the delete below, so any
    // `loadHistory`/`ask` call already in flight for this Session's just-left Conversation sees
    // a changed epoch and skips its own `set` instead of resurrecting the deleted entry.
    bumpSideChatEpoch(sessionId)
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
        // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH, defense in depth): a record this
        // Session's thread has never seen (`index === -1`), arriving while `!loaded` (history
        // has not loaded for the CURRENT Conversation yet, most likely right after a
        // Conversation change), belongs to the Conversation just left -- appending it here
        // would leak it into the new Conversation's still-loading thread instead of waiting for
        // `loadHistory`'s own authoritative fetch.
        if (index === -1 && !existing.loaded) return state
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

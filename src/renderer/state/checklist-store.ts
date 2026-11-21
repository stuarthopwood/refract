import { create } from 'zustand'
import type { Checklist, ItemStatus } from '../../shared/checklist'
import type { ChecklistUpdatePayload } from '../../shared/ipc-checklist'
import { describeAgentChange, openedAnnouncement, REPLACED_ANNOUNCEMENT } from '../features/right-pane/checklist/checklist-announcements'
import { needsValueToTick } from '../features/right-pane/checklist/checklist-tick'

/** Why the Rust side declined an item change, with the status the agent holds the item at now. */
export interface ItemRefusal {
  code: string
  message: string
  /** What the developer tried: ticking an open item or unticking a completed one. */
  op: 'tick' | 'untick'
  /** The item's status in the checklist the refusal returned; the `item_changed` sentence names it. */
  status?: ItemStatus
}

/** The one-shot request #2014 sets to scroll to and flash an item. */
export interface RevealRequest {
  sessionId: string
  checklistId: string
  itemId: string
}

/** A line for the panel's live region; `at` lets the panel drop one it mounted too late to be news. */
export interface ChecklistAnnouncement {
  message: string
  at: number
}

/** What the panel shows for one Session. */
export interface SessionChecklist {
  checklist: Checklist | null
  toolUnavailable: boolean
  /** False until the first `checklist.get` answers, so "no checklist yet" is never shown while loading. */
  loaded: boolean
  error: string | null
  /** The code of the failed `checklist.get`, so the panel can tell a missing tool from a failed read. */
  errorCode: string | null
  /** Item ids with a `checklist.mutate` in flight. */
  pending: Record<string, true>
  refusals: Record<string, ItemRefusal>
  announcement: ChecklistAnnouncement | null
  /** Checklist ids an agent replaced; a late `get` or an old payload must not bring one back. */
  supersededIds: string[]
  /** Bumped when a `get` starts and when an agent update lands, so only the newest `get` still applies. */
  seq: number
}

interface ChecklistState {
  bySession: Record<string, SessionChecklist>
  revealRequest: RevealRequest | null
  /** Stores one `checklist:update`; false when its rev is not above the one held for that checklist. */
  applyUpdate: (payload: ChecklistUpdatePayload) => boolean
  hydrate: (sessionId: string) => Promise<void>
  /** Drops the state of Sessions that are gone, so a late result cannot bring one back. */
  pruneSessions: (keepIds: ReadonlySet<string>) => void
  /** Ticks the item, or unticks it when it is complete; never changes the row before the result. */
  mutateItem: (sessionId: string, itemId: string) => Promise<void>
  takeAnnouncement: (sessionId: string) => ChecklistAnnouncement | null
  requestReveal: (request: RevealRequest) => void
  clearReveal: () => void
}

const EMPTY: SessionChecklist = { checklist: null, toolUnavailable: false, loaded: false, error: null, errorCode: null, pending: {}, refusals: {}, announcement: null, supersededIds: [], seq: 0 }

/** The state for a Session, or the shared empty state before anything arrived. */
export const selectSessionChecklist = (state: Pick<ChecklistState, 'bySession'>, sessionId: string | null): SessionChecklist =>
  (sessionId === null ? undefined : state.bySession[sessionId]) ?? EMPTY

/** Refusals survive only while the item they describe is unchanged. */
function keepRefusals(refusals: Record<string, ItemRefusal>, held: Checklist | null, incoming: Checklist): Record<string, ItemRefusal> {
  if (held === null || held.id !== incoming.id) return {}
  const kept: Record<string, ItemRefusal> = {}
  for (const [id, refusal] of Object.entries(refusals)) {
    const before = held.items.find((item) => item.id === id)
    const after = incoming.items.find((item) => item.id === id)
    if (before !== undefined && after !== undefined && before.rev === after.rev) kept[id] = refusal
  }
  return Object.keys(kept).length === Object.keys(refusals).length ? refusals : kept
}

function agentAnnouncement(held: Checklist | null, incoming: Checklist, opened: boolean): string | null {
  if (held === null) return opened ? openedAnnouncement(incoming) : null
  if (held.id !== incoming.id) return REPLACED_ANNOUNCEMENT
  return describeAgentChange(held, incoming)
}

export const useChecklistStore = create<ChecklistState>((set, get) => {
  const patch = (sessionId: string, change: (current: SessionChecklist) => Partial<SessionChecklist>): void =>
    set((state) => {
      const current = selectSessionChecklist(state, sessionId)
      const delta = change(current)
      const keys = Object.keys(delta) as (keyof SessionChecklist)[]
      if (keys.every((key) => Object.is(delta[key], current[key]))) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...current, ...delta } } }
    })

  /** Applies a checklist when it supersedes the held one; `announceAs` is set only for agent-driven updates. */
  const accept = (sessionId: string, incoming: Checklist, announceAs: { opened: boolean } | null): boolean => {
    const { checklist: held, supersededIds } = selectSessionChecklist(get(), sessionId)
    if (supersededIds.includes(incoming.id)) return false
    // Another checklist always replaces the held one; the same one only with a higher rev.
    if (held !== null && held.id === incoming.id && incoming.rev <= held.rev) return false
    const message = announceAs === null ? null : agentAnnouncement(held, incoming, announceAs.opened)
    const replacedId = held !== null && held.id !== incoming.id ? held.id : null
    patch(sessionId, (current) => ({
      checklist: incoming,
      // The agent only reaches a checklist it was allowed to call, so an update proves the tool works.
      toolUnavailable: announceAs === null ? current.toolUnavailable : false,
      loaded: true,
      error: null,
      errorCode: null,
      pending: replacedId !== null ? {} : current.pending,
      refusals: keepRefusals(current.refusals, held, incoming),
      supersededIds: replacedId !== null ? [...current.supersededIds, replacedId] : current.supersededIds,
      seq: announceAs === null ? current.seq : current.seq + 1,
      // Two quick updates merge, so the live region never drops the first.
      announcement: message === null ? current.announcement : { message: current.announcement === null ? message : `${current.announcement.message}. ${message}`, at: Date.now() }
    }))
    return true
  }

  return {
    bySession: {},
    revealRequest: null,
    applyUpdate: ({ sessionId, checklist, by, opened }) => accept(sessionId, checklist, by === 'agent' ? { opened: opened === true } : null),
    hydrate: async (sessionId) => {
      patch(sessionId, (current) => ({ seq: current.seq + 1 }))
      const seq = selectSessionChecklist(get(), sessionId).seq
      const result = await window.refract.checklist.get(sessionId)
      // An answer is stale once a newer `get` started or the agent updated meanwhile, and moot once the Session is gone.
      const now = get().bySession[sessionId]
      if (now === undefined || now.seq !== seq) return
      if (!result.ok) {
        patch(sessionId, () => ({ loaded: true, toolUnavailable: false, error: result.error.message, errorCode: result.error.code }))
        return
      }
      const { checklist, toolUnavailable } = result.value
      if (checklist !== null) accept(sessionId, checklist, null)
      patch(sessionId, () => ({ toolUnavailable, loaded: true, error: null, errorCode: null }))
    },
    mutateItem: async (sessionId, itemId) => {
      const current = selectSessionChecklist(get(), sessionId)
      const checklist = current.checklist
      const item = checklist?.items.find((candidate) => candidate.id === itemId)
      if (checklist === null || item === undefined || current.pending[itemId]) return
      const complete = item.status === 'complete'
      // Rust refuses a completion without a value; asking would only produce an error the row already explains.
      if (needsValueToTick(item)) return
      const status: ItemStatus = complete ? (item.previousStatus ?? 'upcoming') : 'complete'
      const op: ItemRefusal['op'] = complete ? 'untick' : 'tick'
      const withoutPending = (state: SessionChecklist): Record<string, true> => {
        const { [itemId]: _done, ...rest } = state.pending
        return rest
      }
      const withoutRefusal = (refusals: Record<string, ItemRefusal>): Record<string, ItemRefusal> => {
        if (!(itemId in refusals)) return refusals
        const { [itemId]: _cleared, ...rest } = refusals
        return rest
      }
      patch(sessionId, (state) => ({ pending: { ...state.pending, [itemId]: true }, refusals: withoutRefusal(state.refusals) }))
      // The Session and rev are captured here: a late result belongs to the Session it was sent from.
      const result = await window.refract.checklist.mutate(sessionId, checklist.id, checklist.rev, null, { op: 'setStatus', id: itemId, status })
      // A pruned Session stays gone: a late result must not recreate its entry.
      if (get().bySession[sessionId] === undefined) return
      if (!result.ok) {
        patch(sessionId, (state) => ({
          pending: withoutPending(state),
          refusals: { ...state.refusals, [itemId]: { code: result.error.code, message: result.error.message, op } }
        }))
        return
      }
      if ('error' in result.value) {
        const { error, checklist: latest } = result.value
        if (latest !== null) accept(sessionId, latest, null)
        patch(sessionId, (state) => ({
          pending: withoutPending(state),
          refusals: { ...state.refusals, [itemId]: { code: error.code, message: error.message, op, status: latest?.items.find((candidate) => candidate.id === itemId)?.status } }
        }))
        return
      }
      accept(sessionId, result.value, null)
      patch(sessionId, (state) => ({ pending: withoutPending(state) }))
    },
    takeAnnouncement: (sessionId) => {
      const { announcement } = selectSessionChecklist(get(), sessionId)
      if (announcement !== null) patch(sessionId, () => ({ announcement: null }))
      return announcement
    },
    pruneSessions: (keepIds) =>
      set((state) => {
        const gone = Object.keys(state.bySession).filter((id) => !keepIds.has(id))
        if (gone.length === 0) return state
        const bySession = Object.fromEntries(Object.entries(state.bySession).filter(([id]) => keepIds.has(id)))
        const revealRequest = state.revealRequest !== null && keepIds.has(state.revealRequest.sessionId) ? state.revealRequest : null
        return { bySession, revealRequest }
      }),
    requestReveal: (request) => set({ revealRequest: request }),
    clearReveal: () => set({ revealRequest: null })
  }
})

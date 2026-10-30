import { create } from 'zustand'
import type { Result, SessionSnapshot, SessionStatusEvent, SessionSummary } from '../../shared/ipc'
import type { Session } from '../../shared/model'
import type { SessionActivity } from '../../shared/activity'
import { notify } from './notify'
import { useSplitStore } from './split-store'
import { useGitChangesStore } from './git-changes-store'
import { useSessionListStore } from './session-list-store'

interface SessionsState {
  sessions: SessionSummary[]
  openingIds: Set<string>
  /**
   * Issue #1205: Sessions with a forced `open(id, true)` in flight -- the only open that starts an
   * agent, so the only one the "Starting agent" notice may cover.
   */
  startingIds: Set<string>
  startSeq: Record<string, number>
  creatingRepositoryIds: Set<string>
  setSessions(sessions: SessionSummary[]): void
  applyStatus(event: SessionStatusEvent): void
  /** #526: patches only this row's `activity` from `session:activity`; never refetches the list. */
  applyActivity(sessionId: string, activity: SessionActivity | null): void
  refresh(): Promise<void>
  /**
   * Omitted (every passive path: the pane's own mount-time open) never starts it: a stopped Session
   * opens history-only.
   */
  open(id: string, userAction?: boolean): Promise<SessionSnapshot | null>
  create(repositoryId: string, baseBranch: string): Promise<Result<Session>>
  rename(id: string, name: string): Promise<void>
  archive(id: string): Promise<boolean>
  restore(id: string): Promise<boolean>
  stopAgent(id: string): Promise<boolean>
  setHidden(id: string, hidden: boolean): Promise<boolean>
}

const openPromises = new Map<string, Promise<SessionSnapshot | null>>()

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  openingIds: new Set(),
  startingIds: new Set(),
  startSeq: {},
  creatingRepositoryIds: new Set(),
  setSessions: (sessions) => set({ sessions }),
  applyActivity: (sessionId, activity) => {
    if (!get().sessions.some((session) => session.id === sessionId)) return
    set({ sessions: get().sessions.map((session) => (session.id === sessionId ? { ...session, activity } : session)) })
  },
  applyStatus: (event) =>
    set({
      sessions: get().sessions.map((session) =>
        session.id === event.sessionId
          ? {
              ...session,
              status: event.status,
              stopReason: event.stopReason,
              terminatedUnexpectedly:
                event.terminatedUnexpectedly !== undefined
                  ? event.terminatedUnexpectedly
                  : event.status === 'stopped'
                    ? (session.terminatedUnexpectedly ?? false)
                    : false,
              startProgress: event.startProgress,
              unread: event.unread,
              pause: event.pause,
              launchedMode: event.launchedMode,
              pendingMode: event.pendingMode
            }
          : session
      )
    }),
  refresh: async () => {
    const result = await window.refract.sessions.list()
    if (result.ok) {
      set({ sessions: result.value })
      // a session only ever leaves this list via `sessions.delete` (archiving keeps it listed);
      // prune any pane still pointing at an id that is now gone.
      useSplitStore.getState().pruneDeleted(new Set(result.value.map((session) => session.id)))
      useGitChangesStore.getState().pruneCommitDrafts(new Set(result.value.filter((session) => !session.archivedAt).map((session) => session.id)))
    } else {
      notify(result.error)
    }
  },
  open: (id, userAction) => {
    const key = `${id}:${userAction === true}`
    const forcedKey = `${id}:true`
    if (key !== forcedKey) {
      const inFlightForced = openPromises.get(forcedKey)
      if (inFlightForced) return inFlightForced
    }
    const existing = openPromises.get(key)
    if (existing) return existing
    set({ openingIds: new Set(get().openingIds).add(id) })
    const forced = userAction === true
    if (forced) set({ startingIds: new Set(get().startingIds).add(id), startSeq: { ...get().startSeq, [id]: (get().startSeq[id] ?? 0) + 1 } })
    const promise = (async () => {
      try {
        const result = await window.refract.sessions.open(id, userAction)
        if (!result.ok) {
          notify(result.error)
          return null
        }
        return result.value
      } finally {
        const openingIds = new Set(get().openingIds)
        openingIds.delete(id)
        set({ openingIds })
        if (forced) {
          const startingIds = new Set(get().startingIds)
          startingIds.delete(id)
          set({ startingIds })
        }
        openPromises.delete(key)
      }
    })()
    openPromises.set(key, promise)
    return promise
  },
  create: async (repositoryId, baseBranch) => {
    // Issue #620, UX consult item 2 decision 6: a caller that fires while this repository's own
    // create is already in flight gets turned away here instead of issuing a second IPC round-trip
    // / worktree.
    if (get().creatingRepositoryIds.has(repositoryId)) {
      return { ok: false, error: { code: 'invalid-argument', message: 'A session is already being created for this project.' } }
    }
    set({ creatingRepositoryIds: new Set(get().creatingRepositoryIds).add(repositoryId) })
    try {
      const result = await window.refract.sessions.create({ repositoryId, baseBranch })
      if (result.ok) {
        await get().refresh()
        // Issue #1205: creating a Session is an explicit action, so it starts the agent; started
        // before the pane mounts so the pane's passive open joins this forced one.
        void get().open(result.value.id, true)
        useSplitStore.getState().replaceFocused(result.value.id)
        useSessionListStore.getState().openRepositoryGroup(repositoryId)
      }
      return result
    } finally {
      const creatingRepositoryIds = new Set(get().creatingRepositoryIds)
      creatingRepositoryIds.delete(repositoryId)
      set({ creatingRepositoryIds })
    }
  },
  rename: async (id, name) => {
    const result = await window.refract.sessions.rename(id, name)
    if (!result.ok) notify(result.error)
  },
  archive: async (id) => {
    const result = await window.refract.sessions.archive(id)
    if (!result.ok) notify(result.error)
    return result.ok
  },
  restore: async (id) => {
    // #735 decision 20, same accepted departure as `create()` above: captured before the call --
    // the Session is still in `sessions` (archived or not) either way, and its `repositoryId` never
    // changes across a restore.
    const repositoryId = get().sessions.find((session) => session.id === id)?.repositoryId
    const result = await window.refract.sessions.restore(id)
    if (!result.ok) notify(result.error)
    else if (repositoryId) useSessionListStore.getState().openRepositoryGroup(repositoryId)
    return result.ok
  },
  setHidden: async (id, hidden) => {
    const result = await window.refract.sessions.setHidden(id, hidden)
    if (!result.ok) notify(result.error)
    return result.ok
  },
  stopAgent: async (id) => {
    const result = await window.refract.sessions.stopAgent(id)
    if (!result.ok) notify(result.error)
    return result.ok
  }
}))

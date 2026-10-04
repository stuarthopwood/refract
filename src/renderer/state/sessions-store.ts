import { create } from 'zustand'
import type { Result, SessionSnapshot, SessionStatusEvent, SessionSummary } from '../../shared/ipc'
import type { Session } from '../../shared/model'
import { notify } from './notify'
import { useSplitStore } from './split-store'

interface SessionsState {
  sessions: SessionSummary[]
  /** Session ids with an `open()` call in flight (bug report point 4): lets a row/ChatPane show
   * "Starting the agent..." feedback and ignore a second click while the first is still opening. */
  openingIds: Set<string>
  setSessions(sessions: SessionSummary[]): void
  applyStatus(event: SessionStatusEvent): void
  refresh(): Promise<void>
  open(id: string): Promise<SessionSnapshot | null>
  create(repositoryId: string, baseBranch: string): Promise<Result<Session>>
  rename(id: string, name: string): Promise<void>
  archive(id: string): Promise<void>
  restore(id: string): Promise<void>
  stopAgent(id: string): Promise<void>
}

// Callers that arrive while an `open(id)` is already in flight JOIN that call instead of getting
// `null`: without this, A -> B -> A (A cold-starting) left BOTH the second `open(A)` (returns
// null because `openingIds.has(id)`) and the first (resolves with a now-stale token, also
// returns null) applying no snapshot at all, so ChatPane's stop-banner/`chat.commands` fetch and
// MessageInput's send-after-open were silently skipped.
const openPromises = new Map<string, Promise<SessionSnapshot | null>>()

// The session list (contracts/ipc.md "Sessions"). Spec 005 (tasks.md T012): which Session(s) the
// chat area shows is owned entirely by `split-store.ts` now -- this store only starts/reattaches
// an agent and returns its snapshot; visibility is set by whichever split-store action triggers
// the open, before `open()` is ever called (preserving `src/main/ipc/sessions.ts`'s existing
// ordering rule: "Visibility is NOT set here... set solely by the explicit `sessions.setVisible`
// IPC").
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  openingIds: new Set(),
  setSessions: (sessions) => set({ sessions }),
  applyStatus: (event) =>
    set({
      sessions: get().sessions.map((session) =>
        session.id === event.sessionId
          ? { ...session, status: event.status, unread: event.unread, launchedMode: event.launchedMode, pendingMode: event.pendingMode }
          : session
      )
    }),
  refresh: async () => {
    const result = await window.refract.sessions.list()
    if (result.ok) {
      set({ sessions: result.value })
      // FR-016: a session only ever leaves this list via `sessions.delete` (archiving keeps it
      // listed); prune any pane still pointing at an id that is now gone.
      useSplitStore.getState().pruneDeleted(new Set(result.value.map((session) => session.id)))
    } else {
      notify(result.error)
    }
  },
  open: (id) => {
    const existing = openPromises.get(id)
    if (existing) return existing
    set({ openingIds: new Set(get().openingIds).add(id) })
    const promise = (async () => {
      try {
        const result = await window.refract.sessions.open(id)
        if (!result.ok) {
          notify(result.error)
          return null
        }
        return result.value
      } finally {
        const openingIds = new Set(get().openingIds)
        openingIds.delete(id)
        set({ openingIds })
        openPromises.delete(id)
      }
    })()
    openPromises.set(id, promise)
    return promise
  },
  // The one create path for every entry point (the header's one-click + and the Base branch
  // picker): creates the Session, refreshes the list so its row exists, then shows it in the
  // focused pane (split-store's `replaceFocused`, the same ordinary single-target action a plain
  // row click uses -- creating a Session is never itself an "Open in split" gesture), which
  // ChatPane's per-pane effect turns into an open. Returns the result so each caller reports a
  // failure its own way (a toast for one-click, inline text in the picker).
  create: async (repositoryId, baseBranch) => {
    const result = await window.refract.sessions.create({ repositoryId, baseBranch })
    if (result.ok) {
      await get().refresh()
      useSplitStore.getState().replaceFocused(result.value.id)
    }
    return result
  },
  rename: async (id, name) => {
    const result = await window.refract.sessions.rename(id, name)
    if (!result.ok) notify(result.error)
  },
  archive: async (id) => {
    const result = await window.refract.sessions.archive(id)
    if (!result.ok) notify(result.error)
  },
  restore: async (id) => {
    const result = await window.refract.sessions.restore(id)
    if (!result.ok) notify(result.error)
  },
  stopAgent: async (id) => {
    const result = await window.refract.sessions.stopAgent(id)
    if (!result.ok) notify(result.error)
  }
}))

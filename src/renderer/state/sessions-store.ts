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
  /** `userAction` true bypasses `canAutoStart` exactly like `recover`/`restore` already do --
   * for the one case that is a genuine explicit user request through this path: MessageInput's
   * typed-send to a not-yet-started Session (quality-gate fix, issue #509). Omitted (the pane's
   * own mount-time open) keeps the existing allow-list check. */
  open(id: string, userAction?: boolean): Promise<SessionSnapshot | null>
  create(repositoryId: string, baseBranch: string): Promise<Result<Session>>
  rename(id: string, name: string): Promise<void>
  /** Post-build review fix (Phase7PostBuild/code-reviewer, Medium): resolves `result.ok` so a
   * caller only announces (or runs a focus fallback for) a genuine success, never a failure
   * already reported through `notify`'s own toast. */
  archive(id: string): Promise<boolean>
  restore(id: string): Promise<boolean>
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
// an agent and returns its snapshot; it never sets visibility itself. Round 3 (code-reviewer,
// Low): `App.tsx`'s own rendered-panes effect is the SOLE caller of `sessions.setVisible` now,
// and it runs AFTER this store's `open()` resolves (not before, as split-store/init-stores used
// to), reacting to the resulting state change like every other `useEffect` dependency (preserving
// `src/main/ipc/sessions.ts`'s existing rule: "Visibility is NOT set here... set solely by the
// explicit `sessions.setVisible` IPC").
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  openingIds: new Set(),
  setSessions: (sessions) => set({ sessions }),
  applyStatus: (event) =>
    set({
      sessions: get().sessions.map((session) =>
        session.id === event.sessionId
          ? {
              ...session,
              status: event.status,
              // Quality-gate fix (2026-10-08): `stopReason` and `terminatedUnexpectedly` used to
              // be dropped here, so the row's "Terminated unexpectedly" text (and `stopReason`
              // itself) only ever updated on the next unrelated `sessions.list()` refresh, never
              // on the live crash this event actually reports.
              stopReason: event.stopReason,
              // Quality-gate fix (cycle 2, 2026-10-08): an explicit value on the event is always
              // authoritative. Otherwise, a still-`stopped` transition (for example
              // `clearUnread()`'s own status re-emit, which carries no `terminatedUnexpectedly`
              // at all) must keep whatever this row already had -- main's own main-process flag
              // genuinely did not change just because an UNRELATED field did -- never silently
              // wipe a real crash/Resume-eligible row back to `false` until the next unrelated
              // `sessions.list()` refresh happens to correct it. A transition to a LIVE status
              // does reset to `false`: a working/idle Session is definitely not "terminated".
              terminatedUnexpectedly:
                event.terminatedUnexpectedly !== undefined
                  ? event.terminatedUnexpectedly
                  : event.status === 'stopped'
                    ? (session.terminatedUnexpectedly ?? false)
                    : false,
              // Issue #512: live while this Session's start is in flight; absent once it settles.
              startProgress: event.startProgress,
              unread: event.unread,
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
      // FR-016: a session only ever leaves this list via `sessions.delete` (archiving keeps it
      // listed); prune any pane still pointing at an id that is now gone.
      useSplitStore.getState().pruneDeleted(new Set(result.value.map((session) => session.id)))
    } else {
      notify(result.error)
    }
  },
  open: (id, userAction) => {
    // Quality-gate fix (cycle 2, 2026-10-08): keyed by `id:userAction`, not just `id` -- a
    // passive, in-flight mount-time open (no `userAction`) must never be silently joined by a
    // concurrent EXPLICIT one (MessageInput's typed-send, `userAction: true`): the passive call
    // may resolve with a still-stopped snapshot (`canAutoStart` said no) that the forced caller's
    // own `chat.send` would then fail against, having dropped its own `userAction: true` on the
    // floor entirely. Both keys still dedupe their own kind of call exactly as before.
    const key = `${id}:${userAction === true}`
    // Quality-gate fix (cycle 6, 2026-10-08, code-reviewer, Low): a passive, in-flight open
    // (no `userAction`) should join an already-in-flight FORCED open for the same session
    // instead of starting a redundant second IPC round-trip -- the forced call's own result is
    // always a safe answer for a passive caller too.
    //
    // Quality-gate fix (cycle 7, 2026-10-08, code-reviewer, Low): reworded -- the reverse must
    // never happen: a forced open must never join a passive one, whose result may be a
    // still-stopped snapshot (the passive caller's own `canAutoStart` check said no) that would
    // silently drop the forced caller's own `userAction: true` intent, exactly the hazard the
    // cycle-2 comment above this dedupe key was introduced to avoid.
    const forcedKey = `${id}:true`
    if (key !== forcedKey) {
      const inFlightForced = openPromises.get(forcedKey)
      if (inFlightForced) return inFlightForced
    }
    const existing = openPromises.get(key)
    if (existing) return existing
    set({ openingIds: new Set(get().openingIds).add(id) })
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
        openPromises.delete(key)
      }
    })()
    openPromises.set(key, promise)
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
    return result.ok
  },
  restore: async (id) => {
    const result = await window.refract.sessions.restore(id)
    if (!result.ok) notify(result.error)
    return result.ok
  },
  stopAgent: async (id) => {
    const result = await window.refract.sessions.stopAgent(id)
    if (!result.ok) notify(result.error)
  }
}))

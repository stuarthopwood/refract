import { create } from 'zustand'
import type { GitChangesSnapshot, SessionStatus } from '../../shared/model'
import type { Result } from '../../shared/ipc'

/** Mirrors `window.refract.gitChanges.list`'s own declared, already-concrete return shape
 * (`src/shared/ipc.ts`'s `RefractApi`), owned there -- this file only names it locally since
 * that contract file is the shared/IPC surface, the same local-alias pattern
 * `file-explorer-store.ts` already establishes for its own IPC call shapes. */
type ListResult = Result<{ snapshot: GitChangesSnapshot | null }>

// Spec 018 slice 1 (issue #464) data-model.md "Git changes panel renderer state": per-Session
// thread state, rebuilt fresh on every launch (no renderer-side persistence) -- `gitChanges.
// list` is the single source of truth for anything older than this app run, the same reasoning
// `file-explorer-store.ts`/`side-chat-store.ts` already use for their own per-Session state.
// Keyed per Session (a split's two panes each show their own focused Session's panel
// independently, FR-022), not single-Session-at-a-time.

interface GitChangesSessionState {
  /** `null` until the first `gitChanges.list` response arrives, or whenever the worktree is not
   * a git repository / the status read exceeded its own size cap (FR-018, FR-006 decision 8) --
   * the panel itself (a separate lane) renders its own not-available state for that case, same
   * as a genuine `error` below. */
  snapshot: GitChangesSnapshot | null
  /** True while the initial `load` or any live refresh is in flight. A mutating action (`stage`/
   * `unstage`/`stageAll`/`unstageAll`/`commit`) does NOT set this -- SC-002 requires staging or
   * unstaging a single file to update only that file's own group membership and counts, never a
   * visible full-panel reload; the panel's own row-level pending state (a separate lane) covers
   * that instead. */
  loading: boolean
  /** Plain inline `role="alert"` text naming what failed (FR-013) -- a fetch failure, or the
   * most recent mutating action's own failure (an `index.lock` collision surfaces here exactly
   * like any other git failure). `null` once a later fetch or action succeeds. Never a toast:
   * a toast closes itself, which would leave the panel's own persistent state claiming nothing
   * is wrong (same reasoning `file-explorer-store.ts`'s own root-load error state uses). */
  error: string | null
}

interface GitChangesStoreState {
  bySession: Record<string, GitChangesSessionState>
  /** Fetches the panel's full state (header + four grouped file lists) for `sessionId`. The
   * panel's own mount effect (a separate lane) calls this once on open; every mutating action
   * below also calls it again afterward (FR-015c), and both live refresh triggers (FR-015a/b,
   * wired in `init-stores.ts`) call it too. */
  load(sessionId: string): Promise<void>
  /** FR-006, FR-007: `paths` come only from the panel's own currently-rendered row(s) -- this
   * store never validates them itself, mirroring `file-explorer-store.ts`'s own trust boundary
   * (the IPC layer is where path provenance is actually enforced, contracts/ipc.md). Refetches
   * on success (FR-015c); a failure sets `error` and does NOT refetch (the stale snapshot stays
   * visible rather than silently vanishing). */
  stage(sessionId: string, paths: string[]): Promise<void>
  unstage(sessionId: string, paths: string[]): Promise<void>
  /** FR-004, 2026-10-20 fix: `group` scopes this to just that group's CURRENT status (re-read
   * server-side, never a client-supplied path list) -- the two Stage-all buttons used to be
   * wired to one combined action regardless of which group's own button was clicked. */
  stageAll(sessionId: string, group: 'changes' | 'untracked'): Promise<void>
  unstageAll(sessionId: string): Promise<void>
  /** FR-009 to FR-011: `message` is the already-composed subject+body text; this store does not
   * trim or validate it beyond what `gitChanges.commit` itself rejects (a blank message,
   * `invalid-argument`). Refetches on success, clearing the Staged group (SC-003). */
  commit(sessionId: string, message: string): Promise<void>
  /** FR-015a: the focused Session's status transitioning away from `working` refetches the
   * panel, same as the other two triggers (watcher, post-action). Wired from `init-stores.ts`'s
   * existing `onSessionStatus` subscription rather than a second Rust-side "did a turn just end"
   * mechanism (research.md decision 7: `session::agent::types::SessionStatus`'s own transition
   * is already a one-way, fire-and-forget broadcast to the renderer with no second Rust-side
   * subscriber hook -- `events::EventSink::emit_session_status`'s own doc comment states plainly
   * that Rust has no process-wide event bus to add one to). A no-op for a Session whose panel
   * has never been opened (`bySession[sessionId]` absent, FR-016: never refetch for a closed
   * panel) -- `lastKnownStatus` below is still updated regardless, so a LATER `load` call for
   * that Session starts this tracking from a clean baseline instead of comparing against
   * whatever status happened to be current before the panel ever opened. */
  handleStatusTransition(sessionId: string, status: SessionStatus): void
}

/** FR-015a's own "previous status" record: `useSessionsStore`'s own per-Session `status` field
 * is already overwritten to the NEW value by the time this store's `handleStatusTransition` runs
 * (`init-stores.ts` calls `useSessionsStore.getState().applyStatus(event)` first, in the same
 * `onSessionStatus` callback) -- reading it here would only ever see the new status, never the
 * one being transitioned AWAY FROM. This Map is this store's own independent record of what each
 * Session's status was the last time this store observed it. */
const lastKnownStatus = new Map<string, SessionStatus>()

/** Shared by every mutating action (`stage`/`unstage`/`stageAll`/`unstageAll`/`commit`): runs
 * `run`, sets `error` to a plain message on failure (FR-013, never auto-retried), and refetches
 * on success (FR-015c). A no-op for an unknown Session (nothing to update). */
async function runAction(
  sessionId: string,
  set: (fn: (state: GitChangesStoreState) => Partial<GitChangesStoreState>) => void,
  get: () => GitChangesStoreState,
  run: () => Promise<Result<void>>
): Promise<void> {
  let result: Result<void>
  try {
    result = await run()
  } catch {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, error: `That action failed` } } }
    })
    return
  }
  if (!result.ok) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, error: result.error.message } } }
    })
    return
  }
  await get().load(sessionId)
}

export const useGitChangesStore = create<GitChangesStoreState>((set, get) => ({
  bySession: {},

  async load(sessionId) {
    set((state) => {
      const existing = state.bySession[sessionId]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { snapshot: existing?.snapshot ?? null, loading: true, error: null }
        }
      }
    })
    let result: ListResult
    try {
      result = await window.refract.gitChanges.list(sessionId)
    } catch {
      set((state) => {
        const existing = state.bySession[sessionId]
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              snapshot: existing?.snapshot ?? null,
              loading: false,
              error: `Couldn't load this Session's Git changes`
            }
          }
        }
      })
      return
    }
    if (!result.ok) {
      set((state) => {
        const existing = state.bySession[sessionId]
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: { snapshot: existing?.snapshot ?? null, loading: false, error: result.error.message }
          }
        }
      })
      return
    }
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { snapshot: result.value.snapshot, loading: false, error: null }
      }
    }))
  },

  async stage(sessionId, paths) {
    if (paths.length === 0) return
    await runAction(sessionId, set, get, () => window.refract.gitChanges.stage(sessionId, paths))
  },

  async unstage(sessionId, paths) {
    if (paths.length === 0) return
    await runAction(sessionId, set, get, () => window.refract.gitChanges.unstage(sessionId, paths))
  },

  async stageAll(sessionId, group) {
    await runAction(sessionId, set, get, () => window.refract.gitChanges.stageAll(sessionId, group))
  },

  async unstageAll(sessionId) {
    await runAction(sessionId, set, get, () => window.refract.gitChanges.unstageAll(sessionId))
  },

  async commit(sessionId, message) {
    await runAction(sessionId, set, get, () => window.refract.gitChanges.commit(sessionId, message))
  },

  handleStatusTransition(sessionId, status) {
    const previous = lastKnownStatus.get(sessionId)
    lastKnownStatus.set(sessionId, status)
    if (previous === 'working' && status !== 'working' && sessionId in get().bySession) {
      void get().load(sessionId)
    }
  }
}))

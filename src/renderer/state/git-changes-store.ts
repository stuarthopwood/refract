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
   * as a genuine `loadError` below. */
  snapshot: GitChangesSnapshot | null
  /** True while the initial `load` or any live refresh is in flight. A mutating action (`stage`/
   * `unstage`/`stageAll`/`unstageAll`/`commit`) does NOT set this -- SC-002 requires staging or
   * unstaging a single file to update only that file's own group membership and counts, never a
   * visible full-panel reload; the panel's own row-level pending state (a separate lane) covers
   * that instead. */
  loading: boolean
  /** Plain inline text naming why the MOST RECENT `load` call itself failed (the IPC call threw,
   * or returned `!ok` -- a rare, genuine load-layer failure, distinct from a successful response
   * carrying a `null` snapshot, which is the normal not-available state and sets no error at
   * all). Cleared by the NEXT `load` call regardless of outcome (so it never re-announces the
   * same stale text through a background refresh that also fails the same way) -- 2026-10-20
   * gate fix: this used to share one `error` field with `actionError` below, so a background
   * refresh's own success silently wiped an unacknowledged action failure too. */
  loadError: string | null
  /** Plain inline `role="alert"` text naming why the most recent mutating action (`stage`/
   * `unstage`/`stageAll`/`unstageAll`/`commit`) failed (FR-013) -- an `index.lock` collision
   * surfaces here exactly like any other git failure. Survives a background `load` (watcher
   * ping, status transition) succeeding underneath it: `load` never touches this field, so a
   * failure stays visible and announced until the user either starts ANOTHER action (cleared at
   * the top of `runAction`, "the next user action") or dismisses it explicitly
   * (`dismissActionError`). Never a toast: a toast closes itself, which would leave the panel's
   * own persistent state claiming nothing is wrong (same reasoning `file-explorer-store.ts`'s
   * own root-load error state uses). */
  actionError: string | null
}

interface GitChangesStoreState {
  bySession: Record<string, GitChangesSessionState>
  /** Gate round 2 item 6 (#464), gate round 3 fix (#1076 MEDIUM 3): the commit box's own
   * in-progress subject/body text, kept here (not local `useState` in `GitCommitBox.tsx`, and
   * NOT inside `bySession` above) so it survives both that component unmounting AND a tab/
   * Session switch away and back -- `GitChangesPanel.tsx` (and therefore this whole feature)
   * only mounts while its own tab is the focused pane's active hosted panel, so `bySession`'s
   * own entry (and its watcher) is correctly torn down on every such switch (`forgetSession`
   * below). A draft kept inside `bySession` was torn down right along with it, silently
   * discarding a half-typed commit message on the very first tab switch -- the opposite of what
   * gate round 2 item 6 claimed. Cleared only by `pruneCommitDrafts` (Session archive/delete,
   * `sessions-store.ts`'s own `refresh()` -- the one place either lifecycle event is already
   * observed), never by `forgetSession`. */
  commitDraftsBySession: Record<string, { subject: string; body: string }>
  /** Fetches the panel's full state (header + four grouped file lists) for `sessionId`. The
   * panel's own mount effect (a separate lane) calls this once on open; every mutating action
   * below also calls it again afterward (FR-015c), and both live refresh triggers (FR-015a/b,
   * wired in `init-stores.ts`) call it too. */
  load(sessionId: string): Promise<void>
  /** FR-006, FR-007: `paths` come only from the panel's own currently-rendered row(s) -- this
   * store never validates them itself, mirroring `file-explorer-store.ts`'s own trust boundary
   * (the IPC layer is where path provenance is actually enforced, contracts/ipc.md). Refetches
   * on success (FR-015c), fired-and-forgotten rather than awaited (gate round 3, #1076 HIGH 1);
   * a failure sets `actionError` and does NOT refetch (the stale snapshot visible rather than
   * silently vanishing). Returns the action's own ok/err result directly -- callers must never
   * infer success by re-reading `actionError` from the store after an await, which races an
   * unrelated in-flight refresh (#1076 HIGH 1, falsified by Gate1076Test3: a watcher ping
   * landing mid-refresh can set or clear `actionError` for reasons that have nothing to do with
   * THIS call). */
  stage(sessionId: string, paths: string[]): Promise<Result<void>>
  unstage(sessionId: string, paths: string[]): Promise<Result<void>>
  /** FR-004, 2026-10-20 fix: `group` scopes this to just that group's CURRENT status (re-read
   * server-side, never a client-supplied path list) -- the two Stage-all buttons used to be
   * wired to one combined action regardless of which group's own button was clicked. */
  stageAll(sessionId: string, group: 'changes' | 'untracked'): Promise<Result<void>>
  unstageAll(sessionId: string): Promise<Result<void>>
  /** FR-009 to FR-011: `message` is the already-composed subject+body text; this store does not
   * trim or validate it beyond what `gitChanges.commit` itself rejects (a blank message,
   * `invalid-argument`). Refetches on success, clearing the Staged group (SC-003). */
  commit(sessionId: string, message: string): Promise<Result<void>>
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
  /** Explicit dismiss for `actionError` (the other way it can be cleared, besides starting a
   * new action) -- a no-op for an unknown Session or one with no current `actionError`. */
  dismissActionError(sessionId: string): void
  /** Gate round 2 item 6: the whole `commitDraft` object replaces the previous one -- the caller
   * (`GitCommitBox.tsx`) always passes both fields, merging in whichever one did not change
   * itself, so a stale half-update can never silently drop the other field. Writes into
   * `commitDraftsBySession` (gate round 3, #1076 MEDIUM 3) -- never into `bySession`. */
  setCommitDraft(sessionId: string, draft: { subject: string; body: string }): void
  /** Gate round 3 fix (#1076 MEDIUM 3): drops `commitDraftsBySession` entries for every session
   * id NOT in `keepIds` -- called from `sessions-store.ts`'s own `refresh()` with the current
   * set of non-archived session ids, the one place a Session's archive-or-delete is already
   * observed (a session that is deleted drops out of the list entirely; one that is merely
   * archived stays listed but is excluded from `keepIds`), so this needs no second lifecycle
   * hook of its own. A no-op for any id that was never drafted. */
  pruneCommitDrafts(keepIds: Set<string>): void
  /** Gate round 2 item 14 (FR-016): drops `sessionId`'s entire `bySession` entry -- called once
   * the LAST mount of its panel unmounts (`GitChangesPanel.tsx`'s own watcher-refcount effect
   * reaching zero, i.e. nothing else is watching it either), so a Session whose panel is fully
   * closed does not hold stale snapshot/error state in memory forever. Never touches
   * `commitDraftsBySession` (gate round 3, #1076 MEDIUM 3) -- a tab/Session switch away and back
   * re-mounts the panel and calls `forgetSession` on every such switch, which would otherwise
   * discard a half-typed commit message the instant the developer looked at another tab. Also
   * bumps `loadGeneration` (gate round 3, #1076 LOW, Gate1076Test3) so a `load` pass already in
   * flight for this session can never resurrect a forgotten entry once it resolves -- the
   * existing post-await generation check in `performLoad` already bails out once this is bumped.
   * A no-op `bySession` deletion for an unknown Session (the generation bump is harmless either
   * way). */
  forgetSession(sessionId: string): void
}

/** FR-015a's own "previous status" record: `useSessionsStore`'s own per-Session `status` field
 * is already overwritten to the NEW value by the time this store's `handleStatusTransition` runs
 * (`init-stores.ts` calls `useSessionsStore.getState().applyStatus(event)` first, in the same
 * `onSessionStatus` callback) -- reading it here would only ever see the new status, never the
 * one being transitioned AWAY FROM. This Map is this store's own independent record of what each
 * Session's status was the last time this store observed it. */
const lastKnownStatus = new Map<string, SessionStatus>()

/** Single-flight + exactly one queued NEXT pass per Session (gate round 3 fix, #1076 HIGH 1,
 * falsified by Gate1076Test3): the previous design's `load()` caller, while one pass was already
 * in flight, awaited the SAME promise as every other such caller -- a promise that only resolved
 * once an internal `while (loadRerunRequested.delete(id)) await performLoad(...)` loop had fully
 * drained every rerun requested so far. A watcher ping landing mid-refresh queued ANOTHER rerun,
 * so a commit's own `await get().load(id)` (fired from `runAction`) could be made to wait on an
 * open-ended chain of passes while files kept changing underneath it -- exactly the window a
 * working agent's own continuous worktree churn can sustain indefinitely. Now a caller whose
 * `load()` lands while one is in flight resolves once the NEXT pass that starts strictly after
 * their own call finishes -- never any pass queued by a LATER caller. A caller arriving while a
 * next pass is already queued (not yet started) joins that same queued pass: it too "starts
 * after" their call, by construction, since it has not started yet. `loadGeneration` is a
 * second, independent guard against a stale response ever being committed to state even if some
 * future caller bypasses `load()` entirely and reads `window.refract.gitChanges.list` directly,
 * or (gate round 3, #1076 LOW) `forgetSession` drops this Session's entry while a pass for it is
 * still in flight. */
const loadInFlight = new Map<string, Promise<void>>()
const loadQueued = new Map<string, { promise: Promise<void>; resolve: () => void }>()
const loadGeneration = new Map<string, number>()

/** Gate round 2 item 6: the empty `commitDraft` every brand-new session entry starts from --
 * one shared, frozen-shape literal (never mutated in place; every write replaces the whole
 * object), reused by `GitCommitBox.tsx`'s own selector fallback for a session with no draft yet
 * recorded in `commitDraftsBySession`. */
export const DEFAULT_COMMIT_DRAFT = { subject: '', body: '' }

/** Shared by every mutating action (`stage`/`unstage`/`stageAll`/`unstageAll`/`commit`): clears
 * any previous `actionError` up front (starting a new action is one of the two ways it is
 * cleared, FR-013), runs `run`, sets `actionError` to a plain message on failure (never
 * auto-retried), fires (never awaits) a refetch on success (FR-015c, gate round 3 #1076 HIGH 1 --
 * the caller must resolve the instant the action ITSELF succeeds, not whenever the subsequent
 * list refresh happens to finish), and returns the action's own `Result<void>` directly so a
 * caller never has to infer success by re-reading `actionError` after an await (the exact race
 * Gate1076Test3 falsified: an unrelated in-flight refresh can set or clear that field for
 * reasons that have nothing to do with THIS call). A no-op `Result<void>` success for an unknown
 * Session (nothing to update, nothing failed either). */
async function runAction(
  sessionId: string,
  set: (fn: (state: GitChangesStoreState) => Partial<GitChangesStoreState>) => void,
  get: () => GitChangesStoreState,
  run: () => Promise<Result<void>>
): Promise<Result<void>> {
  set((state) => {
    const existing = state.bySession[sessionId]
    if (!existing || existing.actionError === null) return state
    return { bySession: { ...state.bySession, [sessionId]: { ...existing, actionError: null } } }
  })
  let result: Result<void>
  try {
    result = await run()
  } catch {
    result = { ok: false, error: { code: 'git-failed', message: 'That action failed' } }
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, actionError: result.ok ? null : result.error.message } } }
    })
    return result
  }
  if (!result.ok) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return {
        bySession: { ...state.bySession, [sessionId]: { ...existing, actionError: result.ok ? null : result.error.message } }
      }
    })
    return result
  }
  void get().load(sessionId)
  return result
}

/** The actual IPC round trip for one `load` pass -- see `loadInFlight`/`loadQueued`/
 * `loadGeneration` above for how repeated/overlapping calls are coalesced before this ever
 * runs. */
async function performLoad(
  sessionId: string,
  set: (fn: (state: GitChangesStoreState) => Partial<GitChangesStoreState>) => void
): Promise<void> {
  const generation = (loadGeneration.get(sessionId) ?? 0) + 1
  loadGeneration.set(sessionId, generation)
  set((state) => {
    const existing = state.bySession[sessionId]
    return {
      bySession: {
        ...state.bySession,
        [sessionId]: {
          snapshot: existing?.snapshot ?? null,
          loading: true,
          loadError: null,
          actionError: existing?.actionError ?? null
        }
      }
    }
  })
  let result: ListResult
  try {
    result = await window.refract.gitChanges.list(sessionId)
  } catch {
    if (loadGeneration.get(sessionId) !== generation) return
    set((state) => {
      const existing = state.bySession[sessionId]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            snapshot: existing?.snapshot ?? null,
            loading: false,
            loadError: `Couldn't load this Session's Git changes`,
            actionError: existing?.actionError ?? null
          }
        }
      }
    })
    return
  }
  if (loadGeneration.get(sessionId) !== generation) return
  if (!result.ok) {
    set((state) => {
      const existing = state.bySession[sessionId]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            snapshot: existing?.snapshot ?? null,
            loading: false,
            loadError: result.error.message,
            actionError: existing?.actionError ?? null
          }
        }
      }
    })
    return
  }
  set((state) => {
    const existing = state.bySession[sessionId]
    return {
      bySession: {
        ...state.bySession,
        [sessionId]: {
          snapshot: result.value.snapshot,
          loading: false,
          loadError: null,
          actionError: existing?.actionError ?? null
        }
      }
    }
  })
}

export const useGitChangesStore = create<GitChangesStoreState>((set, get) => ({
  bySession: {},
  commitDraftsBySession: {},

  async load(sessionId) {
    const queued = loadQueued.get(sessionId)
    if (queued) return queued.promise

    const inFlight = loadInFlight.get(sessionId)
    if (inFlight) {
      let resolveQueued!: () => void
      const promise = new Promise<void>((resolve) => {
        resolveQueued = resolve
      })
      loadQueued.set(sessionId, { promise, resolve: resolveQueued })
      void inFlight.finally(() => {
        const next = loadQueued.get(sessionId)
        if (!next) return
        loadQueued.delete(sessionId)
        const nextPass = performLoad(sessionId, set)
        loadInFlight.set(sessionId, nextPass)
        void nextPass.finally(() => {
          if (loadInFlight.get(sessionId) === nextPass) loadInFlight.delete(sessionId)
          next.resolve()
        })
      })
      return promise
    }

    const pass = performLoad(sessionId, set)
    loadInFlight.set(sessionId, pass)
    try {
      await pass
    } finally {
      if (loadInFlight.get(sessionId) === pass) loadInFlight.delete(sessionId)
    }
  },

  async stage(sessionId, paths) {
    if (paths.length === 0) return { ok: true, value: undefined }
    return runAction(sessionId, set, get, () => window.refract.gitChanges.stage(sessionId, paths))
  },

  async unstage(sessionId, paths) {
    if (paths.length === 0) return { ok: true, value: undefined }
    return runAction(sessionId, set, get, () => window.refract.gitChanges.unstage(sessionId, paths))
  },

  async stageAll(sessionId, group) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.stageAll(sessionId, group))
  },

  async unstageAll(sessionId) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.unstageAll(sessionId))
  },

  async commit(sessionId, message) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.commit(sessionId, message))
  },

  handleStatusTransition(sessionId, status) {
    const previous = lastKnownStatus.get(sessionId)
    lastKnownStatus.set(sessionId, status)
    if (previous === 'working' && status !== 'working' && sessionId in get().bySession) {
      void get().load(sessionId)
    }
  },

  dismissActionError(sessionId) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing || existing.actionError === null) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, actionError: null } } }
    })
  },

  setCommitDraft(sessionId, draft) {
    set((state) => ({ commitDraftsBySession: { ...state.commitDraftsBySession, [sessionId]: draft } }))
  },

  pruneCommitDrafts(keepIds) {
    set((state) => {
      const entries = Object.entries(state.commitDraftsBySession).filter(([id]) => keepIds.has(id))
      if (entries.length === Object.keys(state.commitDraftsBySession).length) return state
      return { commitDraftsBySession: Object.fromEntries(entries) }
    })
  },

  forgetSession(sessionId) {
    loadGeneration.set(sessionId, (loadGeneration.get(sessionId) ?? 0) + 1)
    set((state) => {
      if (!(sessionId in state.bySession)) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
  }
}))

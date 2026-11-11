import { create } from 'zustand'
import type { GitChangesSnapshot, SessionStatus } from '../../shared/model'
import type { Result } from '../../shared/ipc'

type ListResult = Result<{ snapshot: GitChangesSnapshot | null }>


interface GitChangesSessionState {
  snapshot: GitChangesSnapshot | null
  loading: boolean
  loadError: string | null
  actionError: string | null
}

interface GitChangesStoreState {
  bySession: Record<string, GitChangesSessionState>
  commitDraftsBySession: Record<string, { subject: string; body: string }>
  /** An agent's request to show one file's diff; the mounted panel consumes it, so it survives a closed panel. */
  showFileRequestBySession: Record<string, string>
  requestShowFile(sessionId: string, path: string): void
  clearShowFileRequest(sessionId: string): void
  load(sessionId: string): Promise<void>
  /** `awaitRefresh: false` returns once git answers; the follow-up reload still runs. */
  stage(sessionId: string, paths: string[], options?: { awaitRefresh?: boolean }): Promise<Result<void>>
  unstage(sessionId: string, paths: string[], options?: { awaitRefresh?: boolean }): Promise<Result<void>>
  stageAll(sessionId: string, group: 'changes' | 'untracked'): Promise<Result<void>>
  unstageAll(sessionId: string): Promise<Result<void>>
  commit(sessionId: string, message: string): Promise<Result<void>>
  handleStatusTransition(sessionId: string, status: SessionStatus): void
  dismissActionError(sessionId: string): void
  setCommitDraft(sessionId: string, draft: { subject: string; body: string }): void
  pruneCommitDrafts(keepIds: Set<string>): void
  forgetSession(sessionId: string): void
}

const lastKnownStatus = new Map<string, SessionStatus>()

const loadInFlight = new Map<string, Promise<void>>()
const loadQueued = new Map<string, { promise: Promise<void>; resolve: () => void }>()
const loadGeneration = new Map<string, number>()

export const DEFAULT_COMMIT_DRAFT = { subject: '', body: '' }

async function runAction(
  sessionId: string,
  set: (fn: (state: GitChangesStoreState) => Partial<GitChangesStoreState>) => void,
  get: () => GitChangesStoreState,
  run: () => Promise<Result<void>>,
  options: { awaitRefresh?: boolean } = {}
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
  if (options.awaitRefresh === false) void get().load(sessionId)
  else await get().load(sessionId)
  return result
}

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
  showFileRequestBySession: {},

  requestShowFile(sessionId, path) {
    set((state) => ({ showFileRequestBySession: { ...state.showFileRequestBySession, [sessionId]: path } }))
  },

  clearShowFileRequest(sessionId) {
    set((state) => {
      if (!(sessionId in state.showFileRequestBySession)) return state
      const next = { ...state.showFileRequestBySession }
      delete next[sessionId]
      return { showFileRequestBySession: next }
    })
  },

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

  async stage(sessionId, paths, options) {
    if (paths.length === 0) return { ok: true, value: undefined }
    return runAction(sessionId, set, get, () => window.refract.gitChanges.stage(sessionId, paths), options)
  },

  async unstage(sessionId, paths, options) {
    if (paths.length === 0) return { ok: true, value: undefined }
    return runAction(sessionId, set, get, () => window.refract.gitChanges.unstage(sessionId, paths), options)
  },

  async stageAll(sessionId, group) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.stageAll(sessionId, group))
  },

  async unstageAll(sessionId) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.unstageAll(sessionId))
  },

  async commit(sessionId, message) {
    return runAction(sessionId, set, get, () => window.refract.gitChanges.commit(sessionId, message), { awaitRefresh: false })
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
    get().clearShowFileRequest(sessionId)
    set((state) => {
      if (!(sessionId in state.bySession)) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
  }
}))

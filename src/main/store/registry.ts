// Holds `registry.json`: every Repository and Session Refract knows about (data-model.md
// "registry.json"). Enforces the two uniqueness rules from data-model.md: `worktreePath` is
// unique across all Sessions, and `branch` is unique within a Repository.

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { Registry, Repository, Session } from '../../shared/model'

export type RegistryErrorCode = 'duplicate' | 'not-found' | 'has-sessions'

export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

/** Single source of truth for the `has-sessions` refusal text -- the IPC handler's pre-check and
 * the registry's own defensive guard (both exist so there is never a race between counting
 * Sessions and removing the Repository) used to word this differently; both read it from here. */
export const REPOSITORY_HAS_SESSIONS_MESSAGE = "Delete this repository's Sessions before removing it."

export class RegistryStore {
  private constructor(
    private readonly file: string,
    private data: Registry
  ) {}

  static async open(dir: string): Promise<RegistryStore> {
    const file = path.join(dir, 'registry.json')
    const data = await readJsonFile<Registry>(file, () => ({ version: 1, repositories: [], sessions: [] }))
    return new RegistryStore(file, data)
  }

  snapshot(): Registry {
    return { version: 1, repositories: [...this.data.repositories], sessions: [...this.data.sessions] }
  }

  async addRepository(r: Repository): Promise<void> {
    if (this.data.repositories.some((existing) => samePath(existing.path, r.path))) {
      throw new RegistryError('duplicate', `Repository already added: ${r.path}`)
    }
    this.data.repositories.push(r)
    await writeJsonFile(this.file, this.data)
  }

  /** Issue #480: display-name-only edit. No uniqueness check on `name` -- two repositories may
   * share a display name (the path distinguishes them in the header tooltip and details card).
   * Quality-gate fix (code-reviewer/security-auditor, Low, 2026-10-08): narrowed from
   * `Partial<Repository>` to `Pick<Repository, 'name'>` -- the wider type let a future caller
   * slip in `path` or `defaultBranch` despite this comment's own "never touches path" claim;
   * nothing else ever calls this for any other field, so the type itself is the guard now.
   * Rolls back on a failed write, the same discipline `removeRepository` below already uses:
   * memory must not keep a name the disk copy never got, or the next unrelated write would
   * silently persist it. */
  async updateRepository(id: string, patch: Pick<Repository, 'name'>): Promise<Repository> {
    const index = this.data.repositories.findIndex((r) => r.id === id)
    if (index === -1) throw new RegistryError('not-found', `Repository not found: ${id}`)
    const current = this.data.repositories[index]!
    // Only `name` is ever copied from `patch` (never a `{ ...patch }` spread): the narrowed
    // `Pick<Repository, 'name'>` parameter type is a compile-time guard against a future caller
    // passing `path`/`defaultBranch`, but a cast or an `as unknown as` could still defeat it --
    // this makes the restriction real at runtime too, not just in the type checker.
    const next: Repository = { ...current, name: patch.name }
    this.data.repositories[index] = next
    try {
      await writeJsonFile(this.file, this.data)
    } catch (err) {
      // Quality-gate fix (cycle 3, 2026-10-08, security-auditor, Low): only restores `current`
      // when the entry still shows exactly the name THIS call just set -- without that check, a
      // second rename for the same repository that completed (and persisted) while this failed
      // write's own `await` was still in flight would get silently clobbered back to the state
      // from BEFORE either call, not just this one's own attempted change undone.
      const stillIndex = this.data.repositories.findIndex((r) => r.id === id)
      if (stillIndex !== -1 && this.data.repositories[stillIndex]?.name === next.name) {
        this.data.repositories[stillIndex] = current
      }
      await writeJsonFile(this.file, this.data).catch(() => undefined)
      throw err
    }
    return next
  }

  async removeRepository(id: string): Promise<void> {
    if (!this.data.repositories.some((r) => r.id === id)) {
      throw new RegistryError('not-found', `Repository not found: ${id}`)
    }
    if (this.data.sessions.some((s) => s.repositoryId === id)) {
      throw new RegistryError('has-sessions', REPOSITORY_HAS_SESSIONS_MESSAGE)
    }
    const index = this.data.repositories.findIndex((r) => r.id === id)
    const [removed] = this.data.repositories.splice(index, 1)
    try {
      await writeJsonFile(this.file, this.data)
    } catch (err) {
      // Put the repository back into the CURRENT list, not a stale copy of it, so a repository
      // added while this write was in flight is not lost, then make one best-effort attempt to
      // save the restored data (a write queued earlier may already have saved the removal).
      if (removed && !this.data.repositories.some((r) => r.id === removed.id)) {
        this.data.repositories.splice(Math.min(index, this.data.repositories.length), 0, removed)
      }
      await writeJsonFile(this.file, this.data).catch(() => undefined)
      throw err
    }
  }

  async addSession(s: Session): Promise<void> {
    if (this.data.sessions.some((existing) => samePath(existing.worktreePath, s.worktreePath))) {
      throw new RegistryError('duplicate', `Worktree already registered: ${s.worktreePath}`)
    }
    if (this.data.sessions.some((existing) => existing.repositoryId === s.repositoryId && existing.branch === s.branch)) {
      throw new RegistryError('duplicate', `Branch already used in this repository: ${s.branch}`)
    }
    // Security remediation (Medium): closes the race where a Repository is removed while this
    // Session's worktree/branch creation was still in flight (sessions.ts/pullRequests.ts await
    // `listBranches`/`generateName`/`addWorktree` between their own existence check and this
    // call). Synchronous -- no `await` between this check and the push below -- so nothing can
    // interleave a `removeRepository` between them.
    if (!this.data.repositories.some((r) => r.id === s.repositoryId)) {
      throw new RegistryError('not-found', `Repository not found: ${s.repositoryId}`)
    }
    this.data.sessions.push(s)
    try {
      await writeJsonFile(this.file, this.data)
    } catch (err) {
      // The caller rolls back the worktree it just made on any failure here, so the Session
      // record must not outlive it: drop it by id (never restore a whole earlier array, which
      // would discard other writes made meanwhile), then make one best-effort attempt to save the
      // corrected data, because a write queued earlier may already have saved this record.
      this.data.sessions = this.data.sessions.filter((existing) => existing.id !== s.id)
      await writeJsonFile(this.file, this.data).catch(() => undefined)
      throw err
    }
  }

  async updateSession(id: string, patch: Partial<Session>): Promise<Session> {
    const index = this.data.sessions.findIndex((s) => s.id === id)
    if (index === -1) throw new RegistryError('not-found', `Session not found: ${id}`)
    const current = this.data.sessions[index]!
    const next: Session = { ...current, ...patch, id: current.id }

    if (patch.worktreePath !== undefined) {
      const clash = this.data.sessions.some((s, i) => i !== index && samePath(s.worktreePath, next.worktreePath))
      if (clash) throw new RegistryError('duplicate', `Worktree already registered: ${next.worktreePath}`)
    }
    if (patch.branch !== undefined) {
      const clash = this.data.sessions.some((s, i) => i !== index && s.repositoryId === next.repositoryId && s.branch === next.branch)
      if (clash) throw new RegistryError('duplicate', `Branch already used in this repository: ${next.branch}`)
    }

    this.data.sessions[index] = next
    await writeJsonFile(this.file, this.data)
    return next
  }

  async removeSession(id: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    await writeJsonFile(this.file, this.data)
  }

  getSession(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  getRepository(id: string): Repository | undefined {
    return this.data.repositories.find((r) => r.id === id)
  }
}

/** Case- and drive-letter-insensitive path comparison for Windows (T011 rule). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

// Holds `registry.json`: every Repository and Session Pinion knows about (data-model.md
// "registry.json"). Enforces the two uniqueness rules from data-model.md: `worktreePath` is
// unique across all Sessions, and `branch` is unique within a Repository.

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { Registry, Repository, Session } from '../../shared/model'

export type RegistryErrorCode = 'duplicate' | 'not-found'

export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

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

  async removeRepository(id: string): Promise<void> {
    this.data.repositories = this.data.repositories.filter((r) => r.id !== id)
    this.data.sessions = this.data.sessions.filter((s) => s.repositoryId !== id)
    await writeJsonFile(this.file, this.data)
  }

  async addSession(s: Session): Promise<void> {
    if (this.data.sessions.some((existing) => samePath(existing.worktreePath, s.worktreePath))) {
      throw new RegistryError('duplicate', `Worktree already registered: ${s.worktreePath}`)
    }
    if (this.data.sessions.some((existing) => existing.repositoryId === s.repositoryId && existing.branch === s.branch)) {
      throw new RegistryError('duplicate', `Branch already used in this repository: ${s.branch}`)
    }
    this.data.sessions.push(s)
    await writeJsonFile(this.file, this.data)
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

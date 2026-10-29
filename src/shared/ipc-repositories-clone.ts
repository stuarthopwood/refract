// Spec 054 (#867) contracts/ipc.md: "Add project > Clone from GitHub". Split out of `ipc.ts`
// (at its line cap): `RefractApi`'s `repositories` and `settings` members intersect these.
import type { Repository } from './model'
import type { Result } from './ipc'

export interface GitHubRepoRow {
  /** Validated owner/name. */
  nameWithOwner: string
  /** Sanitised by Rust, at most 300 characters. Render as plain text only. */
  description: string | null
  isPrivate: boolean
  updatedAt: string
  existingProjectId: string | null
}

export interface GitHubOwnerListing {
  owner: string
  kind: 'self' | 'org'
  repos: GitHubRepoRow[]
  error: { code: string; message: string } | null
}

export interface GitHubRepoListing {
  signedIn: boolean
  owners: GitHubOwnerListing[]
}

export interface CloneRequest {
  /** `owner/name` or `https://github.com/owner/name[.git][/]`; validated in Rust only. */
  source: string
  destination: string
}

export type CloneStartResult =
  | { kind: 'started'; cloneId: string; nameWithOwner: string; destination: string }
  | { kind: 'existing'; projectId: string }

export type CloneStage = 'starting' | 'receiving' | 'resolving' | 'updating' | 'adding'

export type CloneFailureCode = 'not-found-or-no-access' | 'signed-out' | 'network' | 'destination' | 'unknown'

export type CloneProgressEvent =
  | { cloneId: string; phase: 'progress'; stage: CloneStage; percent: number | null }
  | { cloneId: string; phase: 'done'; project: Repository }
  | { cloneId: string; phase: 'done-not-added'; destination: string; message: string }
  | { cloneId: string; phase: 'failed'; code: CloneFailureCode; message: string }
  | { cloneId: string; phase: 'cancelled'; cleanupFailedPath: string | null }

export interface RepositoriesCloneApi {
  /** No argument lists every owner; with `owner` only that owner is re-requested (per-owner Retry). */
  listGitHub(owner?: string): Promise<Result<GitHubRepoListing>>
  clone(request: CloneRequest): Promise<Result<CloneStartResult>>
  /** Idempotent: an unknown or finished id succeeds. */
  cloneCancel(cloneId: string): Promise<Result<void>>
  onCloneProgress(handler: (payload: CloneProgressEvent) => void): () => void
}

export interface SettingsCloneApi {
  /** An absolute existing directory, or `null` to clear. Broadcasts `settings:changed`. */
  setDefaultCloneFolder(path: string | null): Promise<Result<import('./model').Settings>>
}

declare module './model' {
  interface Settings {
    /** Spec 054 FR-035: the parent folder the Clone dialog prefills; absent or `null` when unset. */
    defaultCloneFolder?: string | null
  }
}

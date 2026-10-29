# IPC contract 054

All channels are Rust only (`src-tauri/src/ipc/repositories_clone.rs`, `settings_default_clone_folder.rs`). Types live in `src/shared/ipc-repositories-clone.ts`. Replies use the existing `Result<T>` shape (`{ ok: true, value } | { ok: false, error: { code, message } }`). Channel names keep the `repositories.*` prefix (no rename in PR 2).

## `repositories.listGitHub(owner?: string)`

With no argument it lists every owner. With `owner` (the per-owner Retry, FR-011) it re-requests only that owner and returns the same `GitHubRepoListing` holding that one owner; the owner is re-validated (FR-025).

```ts
export interface GitHubRepoRow {
  nameWithOwner: string      // validated owner/name
  description: string | null // sanitised, max 300 chars, plain text
  isPrivate: boolean
  updatedAt: string          // ISO 8601
  existingProjectId: string | null
}
export interface GitHubOwnerListing {
  owner: string
  kind: 'self' | 'org'
  repos: GitHubRepoRow[]     // up to 100, updatedAt desc
  error: { code: string; message: string } | null // per-owner failure; repos is []
}
export interface GitHubRepoListing {
  signedIn: boolean          // false: owners is []
  owners: GitHubOwnerListing[] // self first, orgs A to Z
}
```

Errors: `gh-unavailable` (gh missing), otherwise per-owner `error`.

## `repositories.clone(request)`

```ts
export interface CloneRequest {
  source: string       // owner/name or https://github.com/owner/name[.git][/]
  destination: string  // absolute path
}
export type CloneStartResult =
  | { kind: 'started'; cloneId: string; nameWithOwner: string; destination: string }
  | { kind: 'existing'; projectId: string }
```

Errors (`IpcError.code`): `invalid-argument` (source or destination invalid, with a plain-language message), `destination-not-empty`, `too-many-clones`, `gh-unavailable`, `destination-in-use` (another running clone targets it).

## `repositories.cloneCancel(cloneId: string)`

Replies `Result<void>`. Idempotent; unknown or finished ids succeed.

## Event `repositories.cloneProgress`

```ts
export type CloneStage = 'starting' | 'receiving' | 'resolving' | 'updating' | 'adding'
export type CloneProgressEvent =
  | { cloneId: string; phase: 'progress'; stage: CloneStage; percent: number | null }
  | { cloneId: string; phase: 'done'; project: Repository }
  | { cloneId: string; phase: 'done-not-added'; destination: string; message: string }
  | { cloneId: string; phase: 'failed'; code: CloneFailureCode; message: string }
  | { cloneId: string; phase: 'cancelled'; cleanupFailedPath: string | null }
export type CloneFailureCode =
  | 'not-found-or-no-access' | 'signed-out' | 'network' | 'destination' | 'unknown'
```

`message` is one of a fixed set of sentences; raw stderr never appears. Progress is throttled to 4 per second per clone; terminal phases emit exactly once.

## `settings.setDefaultCloneFolder(path: string | null)`

Accepts an absolute existing directory or `null` (clear). Replies with the full `Settings`, broadcasts `settings:changed`. `Settings` gains `defaultCloneFolder: string | null` (declared in the new shared module and merged where `Settings` is defined so `ipc.ts` does not grow). Error `invalid-argument` otherwise.

## Process rules (all handlers)

- `gh` found by `resolve_gh`; argument arrays only; no shell; no environment tokens passed.
- Argument shapes are fixed: `gh repo clone <owner/name> <destination> -- --progress`; `gh repo list <owner> --json nameWithOwner,description,isPrivate,updatedAt --limit 100`.
- Destination rules and cleanup: FR-027 and FR-029.

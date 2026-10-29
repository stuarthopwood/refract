# Data model 054

No registry change. A clone becomes a normal `Repository` record through the existing add path.

## Settings

`settings.json` gains `defaultCloneFolder?: string` (absolute path). Absent or invalid reads as `null`.

## Rust (in memory only)

- `RepoRef { owner: String, name: String }`: validated (FR-025). `nameWithOwner()` is `owner/name`.
- `CloneJob { clone_id, repo: RepoRef, destination: PathBuf (resolved, literal), created_by_us: bool, shared (exit flag, stderr tail, requested), pid }`.
- `CloneRegistry { jobs: HashMap<CloneId, Arc<CloneJob>>, destinations: HashSet<PathBuf> }`, cap 4, behind a mutex in `AppState`-adjacent state owned by `repositories_clone.rs`.
- `CloneId`: opaque string (UUID v4), never derived from user input.

## Renderer (in memory only)

- `ActiveClone { cloneId, nameWithOwner, destination, stage, percent?, status: 'running' | 'done' | 'failed' | 'cancelled', projectId?, message? }` in `clones-store.ts`.
- Dialog state: `source: { kind: 'row'; nameWithOwner } | { kind: 'paste'; text } | null`, `destination`, `saveAsDefault`, `listing` (see contract).

## State transitions (one clone)

`starting` to `receiving` to `resolving` to `updating` to `adding` to `done`; any state to `failed`; `starting` to `updating` to `cancelled` (only via cancel). Terminal states emit exactly once.

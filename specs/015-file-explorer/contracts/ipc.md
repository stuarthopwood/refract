# Contract: renderer to main additions for File explorer

Extends spec 001's `contracts/ipc.md` (the `Result<T>` envelope, error codes, constitution V) and
mirrors spec 014's `contracts/ipc.md` table format and `sideChat.*`/`SIDE_CHAT_PATCH` naming shape
(research.md decision 9: `fileExplorer.*` request names, `FILE_EXPLORER_PATCH` event, keyed by
Session id the same way `side-chat:patch` is).

## Requests

### File explorer (FR-001 to FR-006, FR-009, FR-012 to FR-018, FR-020)

| Method | Returns | Notes |
|---|---|---|
| `fileExplorer.listDirectory(sessionId, relativePath)` | `{ entries: FileTreeNode[]; truncated: number }` | Lists one directory's immediate children (FR-005, lazy-load -- never recurses). `relativePath` `''` lists the worktree root (FR-004); any other value is resolved against that Session's worktree root (reusing `resolveInWorktree`, `src/main/ipc/files.ts`, issue #610 -- research.md decision 11) and MUST stay inside it after resolving symlinks/junctions, or the call fails with `outside-worktree`, never reading outside it (FR-001, SC-002); a listing-time symlink/junction entry whose own target fails that same check is returned as `kind: 'cannot-access'` instead of being followed (spec.md Edge Cases). `truncated` (**corrected, PR #671 gate round 4**: missing from this row's own Returns column until now, though always part of the real response shape) is the count of entries past a main-side cap on how many this one directory ever returns, `0` meaning nothing was cut. `.git` itself is never returned, neither as a row inside a listing nor as `…
| `fileExplorer.readPreview(sessionId, relativePath)` | `{ preview: FilePreview }` | Reads one file's preview data (FR-012 to FR-015, FR-002/FR-003). Binary detection is by content (a NUL byte in a capped header slice, reusing `diffStat.ts`'s own `isBinary` heuristic, data-model.md), never by extension; an image is detected by magic bytes, also never by extension (FR-014). A file over the preview size cap returns `preview.kind: 'too-large'` with `size` set, never a partial read (FR-002, SC-001). Opens the file ONCE via `fs.open`/`stat`/`read` on the same handle (**PR #671 gate round 4 fix**: the earlier version `stat`'d then separately `readFile`'d the path, an unbounded-read TOCTOU window). `preview.kind: 'read-error'` (new, round 4) for a non-`ENOENT` read failure (`EACCES`/`EBUSY`) on an otherwise-existing file -- distinct from `'deleted'` (`ENOENT`), never conflated. Same path-containment check and error codes as `listDirectory` above, plus `not-found` when the path exists in the tree but the read itself fails (race with a delete -- the renderer instead prefers the `FILE_EXPLORER_PATCH`/watcher path to catch this before the user re-reads, FR-021). |
| `fileExplorer.getStatus(sessionId)` | `{ status: GitStatusMap \| null }` | Issues the single shared git-status/ignore reader (research.md decisions 2 and 6, data-model.md) once for the whole worktree; the renderer merges this into every currently-loaded node's `gitStatus` rather than calling per-path. `null` on any failure (no git repo, git unavailable, timeout) -- never thrown, mirrors `diffStat.ts`'s own never-throw-into-renderer convention; the tree still renders with no status marks in that case. Built for reuse by #464 (FR-011) -- this method's shape is intentionally generic (a full map, not scoped to the explorer's own currently-expanded paths). |
| `fileExplorer.openInVSCode(sessionId, relativePath)` | `{ opened: true } \| { opened: false }` | Resolves `Code.exe` via the dedicated fixed-install-root resolver (research.md decision 1) and spawns it with `shell: false` and an args array (`[absolutePath]`) -- never `resolveExecutable('code')` (`code.cmd`, unspawnable without a shell) and never `shell: true` (FR-016). `{ opened: false }` when no known install root resolves (FR-017); this is a normal result, not an IPC error, so the renderer can show the "VS Code not found" state inline without a toast. No silent fallback to `shell.openPath` or any other launcher. |
| `fileExplorer.reveal(sessionId, relativePath)` | `void` | **Corrected during implementation**: uses `shell.showItemInFolder`, NOT `shell.openPath` as this row originally said -- `sessions.revealWorktree`'s own `shell.openPath` pattern is safe only because it targets a Session's WHOLE WORKTREE FOLDER (a directory, nothing to execute); this method targets one arbitrary FILE, which may be agent/tool-written, so it instead reuses `sessions.revealFile`'s (issue #610) already-hardened pattern: `shell.openPath` on a file runs its own default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` would execute), the exact risk constitution V's "agent/tool/file output is untrusted" rule forbids. `shell.showItemInFolder` only ever selects the file in Explorer, never executes it. Error `outside-worktree`/`file-missing`/`worktree-missing` (reusing `resolveErrorResult`, same as `listDirectory`/`readPreview` above) when the path no longer exists or escapes the worktree. |
| `fileExplorer.copyPath(sessionId, relativePath)` | `void` | Reuses the existing `clipboard.writeText` fallback pattern (`useWorktreeActions.ts`): the renderer tries `navigator.clipboard.writeText` itself first and only calls this IPC method when the sandboxed renderer refuses it (FR-018). Writes the file's absolute path. Error `clipboard-failed`. |

No `fileExplorer.openWithDefaultApp` method exists this round (FR-019, Clarification item 11).

## Events (main to renderer)

| Event | Payload | Notes |
|---|---|---|
| `FILE_EXPLORER_PATCH` (`file-explorer:patch`) | `{ sessionId, relativePath, entries: FileTreeNode[], truncated: number }` | Pushed whenever that Session's file watcher (`fs.watch({ recursive: true })`, research.md decision 5) reports a change, debounced against a burst of rapid events (FR-020) and coalesced to one re-list of the single affected directory (`relativePath`) -- never a full tree rebuild. The renderer merges `entries` into `root` at `relativePath`, preserving every path's `expandedPaths` membership (store-side state, data-model.md) rather than resetting it, so a previously-expanded folder stays expanded (FR-020, SC-003). If `relativePath` is a directory the renderer has never fetched (not yet expanded), the patch is dropped -- nothing to merge into. `truncated` (gate-fix round 5, Code5 Medium) is that fresh listing's own truncation count, carried into the merged node instead of being discarded -- otherwise a >1000-entry folder's "N more" row disappears after its first live edit. |
| `FILE_EXPLORER_RESET` (`file-explorer:reset`) | `{ sessionId }` | **Added gate-fix round 5 (Code5 HIGH1)**: pushed when that Session's watcher hits a fatal error (watched root deleted/moved, `watchDirectory.ts`'s `onFatal`) or when `sessions.ts` drops/replaces the watcher after a successful `recreateWorktree`, an archive, or a restore. Without this the renderer kept `status: 'ready'` with a stale tree forever and never re-established a watcher. The renderer drops its entire `bySession[sessionId]` store entry so the panel's "load root once per Session" effect re-fires `listDirectory('')`, which re-seeds `loadedPaths` and re-establishes a fresh watcher. |

### Preview invalidation on delete (FR-021)

No separate event exists for this: the renderer's own `applyPatch` (data-model.md) checks whether
`preview.path` lives under the patched `relativePath` and is no longer present in the new
`entries`; if so it sets `preview.kind` to `'deleted'` locally, without an extra round trip to
`fileExplorer.readPreview`. This mirrors spec 014's own `SIDE_CHAT_INTERRUPTED` precedent of a
store-side reconciliation step rather than a dedicated per-file "it's gone" push for every
possible path.

## Error codes added

| Code | When |
|---|---|
| `outside-worktree` (existing code, from issue #610, no new one needed) | A `relativePath` (or, for `listDirectory`, a listed folder's own symlink/junction target) that resolves outside the Session's worktree root -- including through a symlink/junction, or into `.git` itself, case-insensitively, including the Windows 8.3 alias `GIT~1` (FR-001, FR-007, SC-002). |
| `file-missing` (existing code, from issue #610, no new one needed) | The resolved path no longer exists at read time (deleted between resolving and reading). |
| `worktree-missing` (existing code, from issue #610, no new one needed) | The Session's own worktree folder itself no longer exists. |
| `invalid-argument` (existing code, no new one needed) | A non-string/oversized `sessionId`/`relativePath`, a path that is not a folder (`listDirectory`) or not a file (`readPreview`), or a permissions/other read failure -- `resolveErrorResult`'s own three codes above are reserved for the containment/existence questions specifically; everything else (a wrong argument shape, or an environment-level read failure with no containment question of its own) stays `invalid-argument`, this spec's share of spec 001's existing generic code. |
| `not-found` (existing code, no new one needed) | An unknown `sessionId`. |
| `clipboard-failed` (existing code, reused from `clipboard.writeText`) | `fileExplorer.copyPath`'s own main-side clipboard write fails. |

No new error code is added for "VS Code not found" (FR-017): that is the normal
`{ opened: false }` result shape above, shown inline, never surfaced as an IPC-layer error.

## Panel registration (FR-026)

`'file-explorer'` is added to `panel-registry.ts`'s `PanelId` union and `HOSTED_PANELS` array,
alongside `subagents`/`fdb-knowledge`/`agent-builder`/`side-chat`, with `FolderTreeIcon`
(research.md decision 8, `lucide-react`) and `hasCount: false` (no live count defined for this
panel, same as `fdb-knowledge`/`agent-builder`/`side-chat`). No existing hosted panel is replaced.

## Non-IPC: the renderer's own state

`file-explorer-store.ts` (`FileExplorerSessionState`/`FileExplorerStoreState`, data-model.md)
holds the tree, expansion state, selection, preview, and git-status map PER SESSION
(research.md decision 10), mirroring `side-chat-store.ts`'s own per-Session keying -- rebuilt
fresh on every launch (no renderer-side persistence), since `fileExplorer.listDirectory`/
`getStatus` are the single source of truth for anything not already held in memory, the same
reasoning spec 014's own `contracts/ipc.md` gives for `side-chat-store.ts`. Resizing the pane or
switching panels (spec 013's shared shell) MUST NOT reset `expandedPaths`/`selectedPath`
(FR-025) -- both live on the store, keyed by Session id, independent of which panel is currently
mounted or visible.

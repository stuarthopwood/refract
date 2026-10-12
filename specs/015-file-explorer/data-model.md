# Data Model: File explorer

Mirrors `specs/014-side-chat/data-model.md`'s own structure: one section per entity, each citing
the FR-NNN(s) it exists to satisfy, followed by the renderer-side store shape.

## `FileTreeNode`

One row's data: a lazily-expanded tree node rooted at the focused chat pane's Session worktree
(FR-004). The renderer never holds file content here -- only what the tree currently shows and
which folders are expanded (spec.md Key Entities).

```ts
/** `'cannot-access'`: a symlink/junction entry whose own target fails the same path-containment
 * check every read goes through (FR-001) -- spec.md Edge Cases' "cannot access" row state,
 * never followed to find out what it actually is. */
export type FileTreeEntryKind = 'file' | 'folder' | 'cannot-access'

/** Mirrors `GitStatusMap`'s own per-path value (below); a node's own current mark, refreshed
 * alongside the tree's live-refresh cycle (FR-020) and the shared git-status reader
 * (FR-010/FR-011). `undefined` means clean/untracked-and-not-shown, never "unknown". */
export type GitStatusMark = 'modified' | 'added' | 'untracked' | 'deleted' | 'ignored'

export interface FileTreeNode {
  /** Relative to the worktree root (FR-004), POSIX-style separators (`/`), never an absolute
   * path or a path escaping the root (FR-001, checked main-side before every read). */
  path: string
  /** Last path segment; the row's own label. */
  name: string
  kind: FileTreeEntryKind
  /** Present only for `kind: 'folder'`. `undefined` until the folder's children are first
   * fetched (FR-005, lazy-load); `[]` is a valid "fetched, empty" result, distinct from
   * `undefined`'s "not fetched yet". Sorted folders-before-files, then alphabetically within
   * each group (FR-006), by the main-process reader before the renderer ever sees it. */
  children?: FileTreeNode[]
  /** Folder-only UI state, held by the renderer's own tree widget (not persisted main-side);
   * survives a live-refresh re-list (FR-020, SC-003) and a pane resize/panel switch (FR-025). */
  expanded?: boolean
  /** `.git` itself is never represented as a node at all (FR-007), regardless of this mark. */
  gitStatus?: GitStatusMark
}
```

## `FilePreview`

The currently-selected file's preview data (FR-012 to FR-015). Replaced wholesale on every
selection change; cleared to the `deleted` kind if the underlying file disappears while open
(FR-021), never left showing stale content.

```ts
export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'binary' | 'too-large' | 'deleted'

export interface FilePreview {
  path: string
  kind: FilePreviewKind
  /** Bytes on disk at read time; always present except for `kind: 'deleted'`, shown alongside
   * the "cannot preview" state for `binary`/`too-large` (FR-015, SC-001). */
  size?: number
  /** `kind: 'text'` (FR-012, rendered via the existing shared `CodeBlock`/Shiki) or
   * `kind: 'markdown'` (FR-013, rendered via the existing shared `Markdown` component by
   * default, with a Source toggle that re-renders this same string through `CodeBlock`
   * instead). Absent for every other kind. */
  content?: string
  /** `kind: 'image'` only (FR-014): base64 bytes, wrapped renderer-side into
   * `data:${mimeType};base64,${base64}` -- the identical convention
   * `attachments.ts`/`AttachmentStrip.tsx` already use for a pasted image's own `previewUrl`
   * (research.md decision 4). Detected by magic bytes, never by file extension. */
  base64?: string
  mimeType?: string
}
```

## `GitStatusMap`

The per-path result of the single shared git-status/ignore reader (research.md decisions 2 and
6), for one worktree -- built for reuse, as-is, by the future git-changes panel (#464, FR-011),
not gated on that panel's own scope.

```ts
/** Keyed by path, relative to the worktree root, matching `FileTreeNode.path`. A path absent
 * from this map is clean and not ignored; `.git` itself is never a key (FR-007). */
export type GitStatusMap = Record<string, GitStatusMark>
```

Built from one `gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])`
call (research.md decision 2): each returned XY/path pair maps to exactly one of
`modified`/`added`/`untracked`/`deleted`/`ignored` (a plain working-tree diff, never a
merge-base diff like `sessions.diffStat`'s own `diff-index`, since the explorer answers "what
does the tree look like right now", not "what changed since Base" -- research.md decision 2's own
distinction).
An ignored path is ALWAYS present in this map (the reader always asks `--ignored=matching`, so no
second git process is ever spawned when the toggle flips) -- **corrected, PR #671 gate round 4**:
the "show ignored files" toggle (FR-009) is a pure RENDERER-side row filter over the already-
complete map/tree, never a main-side filter on the map's own contents.

## Renderer store: `file-explorer-store.ts`

Mirrors `side-chat-store.ts`'s own per-Session keying (research.md decision 10): one store,
keyed by Session id, rebuilt fresh per app run (no persistence) the same way `SideChatThreadState`
is -- `fileExplorer.listDirectory`/`getStatus` are this spec's own source of truth for anything
not already held in memory.

```ts
/** The tree's own per-node view-state shape: `FileTreeNode` (above) plus the renderer-only
 * `children`/`expanded` fields, RECURSIVELY -- `file-explorer-store.ts`'s single source of truth
 * for both, exported from there (PR #671 gate fix, code-reviewer MEDIUM: six repeated,
 * non-recursive inline intersections replaced with this one named type). */
export interface ExpandableNode extends FileTreeNode {
  children?: ExpandableNode[]
  expanded?: boolean
}

export interface FileExplorerSessionState {
  /** The Session's worktree-rooted tree, built up lazily as folders expand (FR-005). `null`
   * until the root listing's first response arrives. An `ExpandableNode` -- `FileTreeNode` plus
   * `children?: ExpandableNode[]`/`expanded?: boolean`, RECURSIVELY -- not a separate
   * `expandedPaths: Set<string>` sidecar: T007 (Slice 1 implementation) found that a sidecar
   * would need a second, parallel lookup kept in sync with whatever shape the tree itself takes,
   * whereas mutating the tree node in place (structural sharing, so an unrelated branch's object
   * identity survives an unrelated directory's own fetch) is the simpler, single-source-of-truth
   * shape -- corrects this document's own original flat-Set design (PR #671 gate fix,
   * code-reviewer/verification MEDIUM). Survives a live-refresh re-list (FR-020, SC-003) and a
   * pane resize/panel switch (FR-025), same as before. */
  root: ExpandableNode | null
  /** Slice 1 (PR #671 gate fix, code-reviewer HIGH; accessibility-auditor/verification MEDIUM):
   * `'loading'` until the FIRST root-listing response for this Session this app run settles;
   * `'error'` once that response fails (stays `'error'`, with whatever `root` it already had --
   * `null` the first time -- until the user's own Retry succeeds); `'ready'` once it succeeds.
   * Replaces an original boolean-only `loaded` design that had no way to represent "the root
   * listing failed" -- the panel showed "Loading…" forever, since nothing ever flipped it to
   * anything else. */
  status: 'loading' | 'error' | 'ready'
  /** Set alongside `status: 'error'`; the already-plain-English IPC error message, rendered
   * directly in the panel's own error state. `null` otherwise. Slice 1. */
  error: string | null
  /** FR-009: off by default, synced to main on every `fileExplorer.listDirectory` call so
   * ignored entries are included/excluded in what the reader returns. Slice 2. */
  showIgnored: boolean
  /** The row currently selected/focused, for roving-tabindex (FR-022) and resize/panel-switch
   * focus retention (FR-025). `null` when nothing is selected yet. Slice 2. */
  selectedPath: string | null
  /** `GitStatusMap`, refreshed alongside the tree's own live-refresh cycle (FR-010/FR-020).
   * Slice 2. */
  gitStatus: GitStatusMap
  /** Slice 2. */
  preview: FilePreview | null
  /** True while `fileExplorer.readPreview` is in flight for `preview`'s path, so the preview
   * region can show a loading state rather than stale or empty content. Slice 2. */
  previewLoading: boolean
}

export interface FileExplorerStoreState {
  bySession: Record<string, FileExplorerSessionState>
  /** Fired by `FILE_EXPLORER_PATCH` (contracts/ipc.md); re-lists the affected directory and
   * merges its result into `root`/`gitStatus` without touching `expandedPaths` (FR-020). */
  applyPatch(sessionId: string, patch: FileExplorerPatch): void
}
```

`FileExplorerPatch` is the event payload defined in `contracts/ipc.md`.

## Non-entity modules this spec introduces (cited by FR-NNN below, no new data shape of their own)

- **VS Code resolver** (`resolveVSCodeExecutable`, research.md decision 1): resolves one of the
  three fixed Windows install roots to `Code.exe`'s absolute path, or `undefined` if none exist
  (FR-016/FR-017). Not a `FileTreeNode`/`FilePreview` field -- callers branch on `undefined`
  directly.
- **Git-status reader**: the function producing `GitStatusMap` above, reusing `gitRaw`
  (`src/main/git/git.ts`) the same way `diffStat.ts` does (FR-011).
- **Directory-listing reader**: produces one level of `FileTreeNode.children` per call, enforcing
  worktree containment (FR-001, FR-004) and the sort order (FR-006).
- **Preview reader**: produces one `FilePreview` per call, enforcing the size cap (FR-002) and
  binary detection (FR-003) by reusing `diffStat.ts`'s own `isBinary` NUL-byte heuristic against
  a capped header slice, never the file extension.
- **Live-refresh watcher**: one `fs.watch({ recursive: true })` per Session worktree
  (research.md decision 5), debounced, emitting `FILE_EXPLORER_PATCH` (FR-020).

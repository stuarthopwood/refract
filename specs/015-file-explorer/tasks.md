# Tasks: File explorer

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 013 (right pane shell, panel-registry.ts, RightPaneShell.tsx) and spec 014
(side chat, the per-Session panel-binding and renderer-store-keying precedent this spec follows)
both merged on `main` (#665, #669). Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow; AGENTS.md #605). Each
phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by
hand, on the built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on
`main`; run `pnpm check:ui-text`, `pnpm check:theme-contrast`, and `pnpm check:drag-regions` once
per full gate, not per task.

**Organization**: three slices, the same incremental-shippability reasoning specs 013/014 both
used -- shell/hosting/one-shot listing first (a visible, inert-ish tree that reads real directory
data), tree UI/keyboard/live refresh/git-status/preview second (the feature's actual day-to-day
behaviour), VS Code launch and polish last (the bridge from read-only preview to real editing,
plus the accessibility and live-verification pass before a PR is called ready). Task IDs (`T001`
onward) are local to this spec.

**GitHub issue**: issue://463 covers this spec's whole scope; no additional per-task issues filed.
Decision comment: [issuecomment-6116156748](https://github.com/stuarthopwood/refract/issues/463#issuecomment-6116156748).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US5). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Slice 0: Docs (this spec's own docs-only PR; blocks every other slice)

**Purpose**: the Spec Kit record for this feature, written before any implementation PR opens,
the same ordering spec 013/014 both used.

- [x] T001 Write `specs/015-file-explorer/spec.md`, `research.md`, `plan.md`, `data-model.md`,
  `contracts/ipc.md`, `quickstart.md`, `checklists/requirements.md`.
- [x] T002 [P] `pnpm check:indent`-equivalent scan (`node scripts/check-indent.mjs`) on every
  touched file.

**Checkpoint**: the docs-only PR merges before Slice 1 starts.

---

## Slice 1 / Phase 1: Shell, IPC contract, and one-shot directory listing (blocks Slices 2 and 3)

**Purpose**: a real, rail-reachable panel that reads the Session's actual worktree and renders a
lazily-loaded tree -- no keyboard/ARIA polish, no preview, no git status, no VS Code launch yet.
Independently verifiable (the icon appears, the panel opens, a real folder expands to its real
children), same incremental-shippability spec 013/014's own Slice 1s used.

- [x] T003 Reuse `resolveInWorktree` (`src/main/ipc/files.ts`, issue #610) -- **corrected during
  implementation**: this spec's own `plan.md`/`research.md` originally assumed a NEW helper was
  needed; `resolveInWorktree` already exists, already hardened through 5 documented quality-gate
  rounds for the exact same containment problem (research.md decision 11, added this round).
  Added a thin `resolveListTarget` wrapper in `fileExplorer.ts` (T004) that special-cases
  `relativePath === ''` (lists the worktree root itself, which the shared function deliberately
  refuses as `file-missing` -- correct for its own `revealFile` call site, wrong for this one)
  and defers to the unmodified shared function for every other value. `plan.md`/`research.md`
  updated to match (decision 11); no new containment implementation was written.
- [x] T004 [P] Add `fileExplorer.listDirectory(sessionId, relativePath)` to `src/main/ipc/`: a new
  `src/main/ipc/fileExplorer.ts` (mirrors `side-chat.ts`'s own validation/error-mapping shape) that
  resolves the Session's `worktreePath` from the registry (never the renderer, constitution V),
  calls `resolveListTarget` (T003), lists that directory's immediate children only (folders before
  files, alphabetical case-insensitive within each group per FR-006), one level deep (lazy-load,
  FR-005) -- no recursion, no git status yet (Slice 2). `.git` itself always excluded (FR-007). A
  symlink/junction entry's own `kind` is resolved via one extra `fs.stat` per such entry (follows
  the link so a symlinked folder still renders with a disclosure control); containment of
  whatever it actually points to is checked lazily, only when that entry is itself later expanded
  or previewed, never at listing time.
- [x] T005 [P] Add `IPC_REQUESTS.FILE_EXPLORER_LIST_DIRECTORY` (and a comment reserving the
  Slice-2/3 request names in `contracts/ipc.md`, so the shared `src/shared/ipc.ts` naming
  convention stays visible from this slice's own commit, even though the later requests
  themselves land with their own slice) plus `RefractApi.fileExplorer.listDirectory` and the
  `FileTreeNode` type (`src/shared/model.ts`, matching `DiffStat`'s own placement precedent, not
  `frames.ts` which is OMP-wire-frame-shaped data only) to `src/preload/index.ts`.
- [x] T006 [P] Add `'file-explorer'` to `PanelId` and a descriptor (`FolderTreeIcon`, `hasCount:
  false`, research.md decision 8) to `HOSTED_PANELS` in
  `src/renderer/features/right-pane/panel-registry.ts` (FR-026).
- [x] T007 Create `src/renderer/state/file-explorer-store.ts`: per-Session keying (research.md
  decision 10, mirrors `side-chat-store.ts`). **Differs from this task's own original plan**: a
  recursive `root: FileTreeNode | null` tree (matching data-model.md's own recursive
  `children?`/`expanded?` shape) rather than a flat `expanded: Set<string>` sidecar -- a sidecar
  would need a second, parallel lookup structure kept in sync with whatever shape the tree itself
  takes; mutating the tree node in place (`withChildrenAt`/`withExpandedToggled`, structural
  sharing so an unrelated branch's object identity survives an unrelated directory's own fetch)
  is the simpler, single-source-of-truth shape for a tree that does not yet need Slice 2's own
  virtualisation/windowing concerns. `loadDirectory(sessionId, relativePath)` fetches and expands;
  a separate `toggleExpanded(sessionId, relativePath)` flips an already-fetched folder's own
  `expanded` flag with NO re-fetch (collapsing a folder must never re-read it -- only expanding
  one for the first time does). No preview/status/patch handling yet (Slice 2).
- [x] T008 [P] Export `useFileExplorerStore` from `src/renderer/state/index.ts` (all four spots:
  import, re-export, the dev-only `RefractDevStores` interface, and its own object literal --
  matching every other store's own four-spot pattern in this file).
- [x] T009 Create `src/renderer/features/right-pane/file-explorer/FileExplorerPanel.tsx`: an
  empty-worktree/loading state plus a plain nested list (not yet the WAI-ARIA tree pattern --
  Slice 2, FR-022) wired to `useFileExplorerStore`, fetching the root on first open per Session
  (mirrors side-chat's own `loadHistory`-on-first-open effect) and lazily fetching a folder's
  children on click-to-expand (`loadDirectory` the first time, `toggleExpanded` thereafter).
- [x] T010 Edit `RightPaneShell.tsx`: one more `activePanelId === 'file-explorer'` branch rendering
  `FileExplorerPanel` (depends on T006, T009).
- [x] T011 [P] `pnpm typecheck` and `pnpm build`; fix any error before proceeding. Run
  `check:indent`, `check:ui-text`, `check:theme-contrast`, `check:drag-regions` once for the whole
  slice. **Results**: typecheck pass (both tsconfigs); vitest 376/376 (no new tests, AGENTS.md
  #605); check:indent 0 odd-indent (321 files); check:ui-text 0 leaks (371 files); check:theme-
  contrast 313/313 (no new token); check:drag-regions 0 violations (109 files); build pass.

**Checkpoint**: live-verified in an isolated scratch Electron instance (own `--user-data-dir`/CDP
port, scratch repo/registry with one seeded Session pointed at a real directory tree -- never
touching Stuart's live Sessions), named screenshots, sha256-checked, 0 duplicates. The File
explorer rail icon appears (fifth icon); the launcher lists all five panels in order; opening it
shows the worktree root's real top-level entries, folders before files; clicking a folder lazily
fetches and shows its real children; a path engineered to resolve outside the worktree (a
junction/symlink, User Story: Edge Cases) is rejected by `resolveInWorktree`, never listed.

---

## Slice 2 / Phase 2: Tree UI, keyboard, live refresh, git status, preview (User Stories 1-3, 5)

**Purpose**: the feature's actual day-to-day behaviour -- a real WAI-ARIA tree a developer can
navigate by keyboard, that stays current as the agent edits files, shows git status at a glance,
and previews every file type the spec promises.

- [ ] T012 Implement the WAI-ARIA tree pattern on `FileExplorerPanel.tsx`'s rows: `role="tree"`/
  `role="treeitem"`, `aria-expanded` on every folder row, roving `tabindex` (one tab stop for the
  whole tree), arrow-key navigation (left/right collapse-or-parent / expand-or-first-child,
  up/down between visible rows), Home/End, type-ahead, Enter opens that row's preview (FR-022).
  Virtualise each expanded folder's own children list via `react-virtuoso` (already a pinned
  dependency, research.md decision 7), capped per folder with a "N more" row past the cap (Edge
  Cases: a huge repository).
- [ ] T013 [P] Add a file-system watcher in main (`fs.watch({ recursive: true })`, research.md
  decision 5): debounced, treats every `rename` event as "re-list this event's own directory," not
  "this exact path was deleted" (Node's own documented Windows ambiguity). Emits
  `IPC_EVENTS.FILE_EXPLORER_PATCH` keyed by Session id, carrying the affected directory's fresh
  listing (FR-020).
- [ ] T014 [P] Add `onFileExplorerPatch` to preload; wire it once in `init-stores.ts` (mirrors
  every other event subscription's central-wiring location, side-chat's own precedent).
- [ ] T015 `file-explorer-store.ts`: `applyPatch(sessionId, directoryListing)` merges a patched
  directory's children in place, NEVER resets any node's `expanded` boolean for a directory the
  patch did not itself concern (FR-020, SC-003).
- [ ] T016 [P] Add a shared git-status reader to `src/main/git/` (new file, e.g. `status.ts`):
  `gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])` (research.md
  decisions 2 and 6), parsed into a per-path `GitStatusMap` (modified/added/untracked/deleted/
  ignored). Returns `null` on any failure (mirrors `diffStat.ts`'s own never-throw-into-renderer
  convention), never gated on #464's own existence (FR-011).
- [ ] T017 Add `fileExplorer.getStatus(sessionId)` IPC request/handler/preload wiring (depends on
  T016); `file-explorer-store.ts` fetches it once per directory load and on every patch, folded
  into the same loading cycle as T013/T015 (no separate poll).
- [ ] T018 Tree row status marks: icon-plus-text (or text alone), never colour alone (FR-010,
  FR-024); the "show ignored files" toggle reveals `ignored`-status rows without ever revealing
  `.git` itself (FR-007, FR-009).
- [ ] T019 [P] Add `fileExplorer.readPreview(sessionId, relativePath)` main handler: size-capped
  read (FR-002), binary detection via `diffStat.ts`'s own NUL-byte-in-a-header-slice heuristic
  (research.md decision 3, FR-003), returns a `FilePreview` (text/markdown/image/binary/
  too-large) per data-model.md.
- [ ] T020 Create the preview renderer region in `FileExplorerPanel.tsx` (or a new
  `FilePreviewPane.tsx` alongside it): text/code via the shared `CodeBlock`/Shiki with line
  numbers and a wrap toggle (FR-012); markdown via the shared `Markdown` component with a Source
  toggle (FR-013); image as a `data:${mimeType};base64,${base64}` `<img>`, the identical
  convention `attachments.ts`/`AttachmentStrip.tsx` already use (research.md decision 4, FR-014);
  binary/too-large shows the "cannot preview" panel with size and type (FR-015); a file deleted
  while previewed shows a "this file no longer exists" state (FR-021), never stale content or a
  thrown error.
- [ ] T021 [P] Run the full gate (`pnpm typecheck`, `pnpm build`, `check:indent`, `check:ui-text`,
  `check:theme-contrast`, `check:drag-regions`); fix any error before proceeding.

**Checkpoint**: live-verified in a fresh isolated scratch Electron instance (own `--user-data-dir`/
CDP port, never Stuart's live Sessions), named screenshots, sha256-checked, 0 duplicates. Keyboard
navigation exercised end-to-end (arrow keys, Home/End, Enter) with exactly one Tab stop for the
whole tree; a modified/added/untracked/deleted file each show a distinct status mark; the
`.gitignore` toggle reveals/hides ignored rows without ever revealing `.git`; a text file, a
markdown file (both renders), an image, and a binary/oversized file each preview correctly; a live
edit outside Refract (a real file add/modify/delete in the worktree) updates the tree in place
with every previously-expanded folder still expanded; a previewed file deleted live shows the
"no longer exists" state.

---

## Slice 3 / Phase 3: Open in VS Code, remaining context-menu actions, polish, final verification

**Purpose**: the bridge from read-only preview to real editing, the remaining context-menu actions,
the accessibility passes that did not fit naturally into Slice 2's own scope, and the
cross-slice gate plus live verification the assignment requires before a PR is called ready.

- [ ] T022 Add `resolveVSCodeExecutable()` (new, alongside `src/main/process/executables.ts`,
  research.md decision 1): checks `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, then
  `%ProgramFiles%\Microsoft VS Code\Code.exe`, then `%ProgramFiles(x86)%\Microsoft VS
  Code\Code.exe`; throws (or returns `undefined`, matching this module's own existing convention)
  if none exists. Never resolves via `resolveExecutable('code')` (FR-016).
- [ ] T023 [P] Add `fileExplorer.openInVSCode(sessionId, relativePath)` IPC handler: resolves the
  absolute file path via `resolveInWorktree` (T003) and the executable via T022, spawns with
  `shell: false` and an args array (FR-016); a clear `vscode-not-found` error code when T022
  resolves nothing, surfaced as a "VS Code not found" state in the renderer, never a silent
  fallback (FR-017).
- [ ] T024 [P] Add `fileExplorer.reveal(sessionId, relativePath)` and
  `fileExplorer.copyPath(sessionId, relativePath)` IPC handlers, reusing the exact pattern
  `SessionDetailsCard.tsx`'s own worktree-root "Open in file explorer"/"Copy path" buttons already
  establish (`shell.showItemInFolder`/clipboard write), scoped to the selected file's own path
  instead of the worktree root (FR-018).
- [ ] T025 Wire a row context menu (right-click and a kebab/three-dot trigger for keyboard/touch
  parity, matching this codebase's own existing row-menu conventions) and a preview-toolbar button
  group offering Open in VS Code, Reveal in File Explorer, Copy path (T023, T024) -- not "Open with
  default app" this round (FR-019).
- [ ] T026 [P] A11y polish pass: the preview region is a labelled, keyboard-scrollable region
  reachable by Tab from the tree (FR-023); resizing the pane or switching panels never loses the
  tree's focus position or expansion state (FR-025, same shared mechanism spec 013's other panels
  already use); `prefers-reduced-motion`/forced-colors checked for any new transition or token;
  `outline-none` never paired without a `focus-visible:outline-*` replacement anywhere touched this
  slice.
- [ ] T027 [P] Run the full gate (`pnpm typecheck`, `pnpm build`, existing `vitest`, `check:indent`,
  `check:ui-text`, `check:theme-contrast`, `check:drag-regions`); fix any error before proceeding.
- [ ] T028 Full [quickstart.md](quickstart.md) pass in an isolated scratch Electron instance (own
  `--user-data-dir`, never Stuart's live Sessions): every story's numbered steps, including a real
  VS Code launch (or a genuine "not found" state if VS Code is absent from the scratch machine's
  known install roots), Reveal in File Explorer, and Copy path.
- [ ] T029 Update `docs/PLAN.md` row C4 only: status, branch, PR number (minimal diff, this
  story's own row) -- "implementation complete" or "decision-blocked" wording if anything from
  Clarifications/future/open-questions.md is still open, **never** plain "done" while any such
  item remains (depends on T028 passing).

**Checkpoint**: every quickstart.md story passes; the gate commands above exit 0; `docs/PLAN.md`
row C4 reflects the real PR.

---

## Dependency summary

- Slice 0 (T001-T002, docs-only) blocks every later task -- the spec itself must land before any
  implementation PR opens.
- Slice 1 (T003-T011) depends on Slice 0 and on specs 013/014 (both merged, #665/#669).
- Slice 2 (T012-T021) depends on Slice 1 for a working tree/store to extend.
- Slice 3 (T022-T029) depends on Slice 2 for a working preview/tree to attach VS Code launch and
  the remaining context-menu actions to.

## Parallel example

Within Slice 1, T004 (main IPC handler), T005 (shared `ipc.ts`/preload), and T006
(`panel-registry.ts`) touch disjoint files and could be split across two agents if this lane ever
parallelises; this plan assumes one agent, one slice at a time, per the "one heavy build at a
time" machine constraint already in force for this session.

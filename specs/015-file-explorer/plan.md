# Implementation Plan: File explorer

**Branch**: `015-file-explorer` (work lands branches/PRs by phase, e.g.
`feat/463-file-explorer-shell` / `feat/463-file-explorer-tree-preview` /
`feat/463-file-explorer-polish`, per `docs/PLAN.md`'s existing convention) | **Date**: 2026-10-12
| **Spec**: [spec.md](spec.md) | **Input**: Feature specification from `specs/015-file-explorer/spec.md`

## Summary

Add a read-only file and folder explorer panel for the focused Session's own worktree, hosted by
spec 013's existing right-pane shell with no second extension to the shell itself. The tree lists
the worktree root's entries lazily, matches spec 014's Side chat (`/btw`) pattern for panel
registration and per-Session store keying, and reads the file system exclusively from the main
process via a new `fileExplorer.*` IPC namespace (mirroring `sideChat.*`'s own naming shape). Three
new main-process modules do the actual work: a fixed-install-root VS Code resolver (research.md
decision 1), a shared git-status/ignore reader built now for `#464`'s future reuse (research.md
decisions 2 and 6), and a directory-listing/preview reader with worktree-root path containment
(FR-001) and the existing `diffStat.ts` NUL-byte binary heuristic (research.md decision 3). A
`fs.watch`-based watcher (research.md decision 5) drives live refresh without collapsing expansion
state (FR-020).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 (as bundled with Electron
34.5.1) | **Framework**: React 19.3.0 in the renderer. Same stack as spec 013/014.
**Primary Dependencies**: none new -- `lucide-react` supplies `FolderTreeIcon` (research.md
decision 8), the existing shared `Markdown`/`CodeBlock` components render previews (FR-012/FR-013),
`react-virtuoso` (4.18.16, already pinned, research.md decision 7) virtualises the tree.
**Storage**: none. No settings.json field is added (nothing to persist across restarts: the tree's
expansion state and the current preview selection are both per-Session, in-memory only, same as
spec 014's own side-chat-store.ts).
**Testing**: none -- Refract is a prototype with no automated test suite (constitution,
Development Workflow); each story is verified by running the app per `quickstart.md`, including a
live directory listing, a live preview of a real file, and a live VS Code launch against a real
install (FR-016/FR-017).
**Target Platform**: Windows 11 only (desktop app, Electron renderer/main process), same as spec
013/014.
**Project Type**: desktop-app (Electron); adds no new process type.
**Performance Goals**: a folder expansion reads and renders its own children without a visible
stall on a worktree of typical Refract-dev size; the tree stays scrollable and keyboard-operable at
"thousands of entries" scale via the existing capped-list-per-folder + virtualisation pattern
(research.md decision 7, FR-006).
**Constraints**: every file-system read (directory listing, preview content, status, VS Code
launch) MUST happen in the main process; the renderer MUST receive raw `fs`/`git` output only
through IPC, never call a filesystem/process API directly (constitution V). Every resolved path
MUST be checked against the Session's worktree root before any disk access, including through
symlinks/junctions (FR-001, Edge Cases).
**Scale/Scope**: extends spec 013's right-pane shell with a fourth hosted panel (`file-explorer`),
alongside `subagents`/`fdb-knowledge`/`agent-builder`/`side-chat`, replacing none of them; one new
renderer store (`file-explorer-store.ts`), one new IPC area file, four new main-process modules.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design.* Constitution v1.9.0 (this spec
raises no version-change claim, per Governance's own rule: *no version bump per feature, per
clause.*).

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | No command Refract reimplements behaviour for: all file reads, git status, and the VS Code launch are local main-process operations Refract already owns (menu actions, clipboard, process spawn), not a re-implementation of anything OMP itself does. |
| II. RPC wire contract | N/A | This spec adds no OMP RPC request/response pair; `fileExplorer.*` is a Refract-internal IPC namespace only (contracts/ipc.md), the same shape as spec 014's own internal `sideChat.*` trio. |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process-spawn lifecycle is touched; the tree reads an existing Session's already-resolved worktree root. |
| IV. Evidence before design | Pass | research.md decisions 1-10 each cite an existing source file (`resolveVSCodeExecutable.ts`'s own future shape, `git.ts`'s `gitRaw`, `diffStat.ts`'s `isBinary()`, `side-chat-store.ts`'s per-Session keying, `panel-registry.ts`'s `PanelId` union) rather than a guessed API. |
| V. Electron security baseline | Pass | New IPC follows the existing typed, allowlisted `contextBridge` pattern (contracts/ipc.md); no raw Node API, filesystem path, or child-process handle crosses into the renderer; image bytes cross as a base64 `data:` URL (FR-014), matching the existing pasted-attachment convention. |
| Platform and Stack | Pass | Windows 11 only; Electron + Vite + React, strict TypeScript; no automated tests (this plan's own amendment, per `/speckit.tasks`). |
| Development Workflow | Pass | Spec Kit order followed (this plan, then quickstart.md, then `/speckit.tasks`); verified by running the app (`quickstart.md`); `pnpm typecheck` and `pnpm build` must pass before a change lands. |
| Complexity Tracking table below | Otherwise empty | No principle is bent; no new exception is introduced. |

## Project Structure

### Documentation (this feature)

```text
specs/015-file-explorer/
├── spec.md
├── research.md         # Phase 0 output -- 10 decisions
├── plan.md              # this file
├── data-model.md        # Phase 1 output -- FileTreeNode, FilePreview, GitStatusMap, store shape
├── contracts/
│   └── ipc.md           # Phase 1 output -- fileExplorer.* request/response + FILE_EXPLORER_PATCH
├── quickstart.md         # how to run and verify each story, incl. a live VS Code launch
├── checklists/
│   └── requirements.md
└── tasks.md              # produced by /speckit.tasks
```

### Source code (repository root, additions only -- Slice 1, 2, 3 as communicated)

```text
src/shared/
└── ipc.ts                       # EDIT: IPC_REQUESTS.FILE_EXPLORER_*, IPC_EVENTS.FILE_EXPLORER_PATCH,
                                  #       FileTreeNode/FilePreview/GitStatusMap type exports

src/main/
├── fs/                                           # NEW directory
│   ├── gitStatus.ts                              # NEW -- Slice 2: shared git-status/ignore reader, reuses git.ts's gitRaw (decisions 2, 6)
│   ├── listDirectory.ts                          # NEW -- Slice 1: worktree-root-contained lazy directory listing (FR-001, FR-005, FR-006)
│   ├── readPreview.ts                            # NEW -- Slice 2: preview reader, reuses diffStat.ts's isBinary()/BINARY_SNIFF_BYTES (FR-002/FR-003, decision 3)
│   └── watchDirectory.ts                         # NEW -- Slice 2: fs.watch-based live-refresh watcher, debounced (FR-020, decision 5)
├── git/
│   └── git.ts                                    # unchanged -- gitRaw() reused by gitStatus.ts, no edit
├── ipc/
│   ├── register.ts                               # EDIT: registerFileExplorer(manager) wiring + forwardEvent FILE_EXPLORER_PATCH case
│   └── fileExplorer.ts                           # NEW -- Slice 1: fileExplorer.listDirectory/getStatus handlers; Slice 2 adds readPreview + watcher wiring; Slice 3 adds openInVSCode/reveal/copyPath
└── process/
    └── executables.ts                            # EDIT -- Slice 3: adds resolveVSCodeExecutable() alongside the existing resolveExecutable()/resolvePowerShell()/taskkillPath() fixed-path resolvers (research.md decision 1), not a new file: same module, same "never trust a bare name or cwd" reasoning

src/preload/
└── index.ts                     # EDIT: exposes refract.fileExplorer.{listDirectory,readPreview,getStatus,openInVSCode,reveal,copyPath}, refract.onFileExplorerPatch

src/renderer/
├── state/
│   └── file-explorer-store.ts   # NEW -- Slice 1 (tree state) / Slice 2 (preview + git status + watcher state), per-Session keyed, mirrors side-chat-store.ts (research.md decision 10)
├── features/
│   ├── right-pane/
│   │   ├── panel-registry.ts                       # EDIT: adds 'file-explorer' to PanelId union + HOSTED_PANELS descriptor (FR-026, decision 9)
│   │   ├── RightPaneShell.tsx                      # EDIT: one more `activePanelId === 'file-explorer'` branch rendering FileExplorerPanel (decision 9 -- PanelTabBar.tsx/IconRail.tsx/PanelLauncher.tsx all already iterate HOSTED_PANELS generically, no edit needed there, same as spec 014's own side-chat addition)
│   │   └── file-explorer/                          # NEW directory
│   │       ├── FileExplorerPanel.tsx               # NEW -- Slice 1: panel shell, hosts FileTree
│   │       ├── FileTree.tsx                        # NEW -- Slice 2: react-virtuoso tree, WAI-ARIA treeview, roving tabindex (FR-022, FR-023)
│   │       ├── FileTreeRow.tsx                      # NEW -- Slice 2: single row -- icon, name, git status mark (FR-010, FR-024)
│   │       └── FilePreviewPane.tsx                 # NEW -- Slice 2: text/markdown/image/binary/too-large preview states (FR-012 to FR-015)
│   └── sessions/
│       └── SessionDetailsCard.tsx                  # unchanged -- Open in VS Code/Reveal/Copy path pattern reused, not edited (Slice 3 reuses the existing pattern, not the file)
└── state/index.ts                                  # EDIT: exports useFileExplorerStore, same convention as side-chat
```

## Slices

1. **Shell/hosting + IPC contract + one-shot directory listing.** Registers the `file-explorer`
   panel (FR-026), wires `fileExplorer.listDirectory`/`fileExplorer.getStatus` end-to-end
   (main → preload → renderer), and renders a non-interactive, non-live tree of the worktree root's
   top-level entries (User Story 1, partial). No preview, no live refresh, no git marks yet.
2. **Tree UI + keyboard + live refresh + git status marks + preview.** Full WAI-ARIA treeview
   keyboard model (FR-022/FR-023), lazy expand/collapse (FR-005), the `fs.watch` live-refresh
   watcher with expansion-state preservation (FR-020, User Story 5), git status marks (FR-010,
   User Story 3), and the full preview pane across all five detected kinds (FR-012 to FR-015,
   User Story 1 complete + User Story 2).
3. **Open in VS Code, Reveal in File Explorer, Copy path + polish.** The three context-menu/toolbar
   actions (FR-016 to FR-019, User Story 4), final live verification across every story, and this
   spec's own `docs/PLAN.md` row, status worded "implementation complete" or "decision-blocked"
   (never plain "done" while anything is open), matching spec 014's own PLAN.md row precedent.

## Complexity Tracking

*No entries -- the Constitution Check above stands with all seven rows Pass/N/A and no
unresolved violation.*

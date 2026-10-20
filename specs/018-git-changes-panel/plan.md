# Implementation Plan: Git changes panel (slice 1)

**Branch**: `018-git-changes-panel` (docs); implementation lands on an issue-named branch per
`docs/PLAN.md`'s existing convention, e.g. `feat/464-git-changes` | **Date**: 2026-10-20 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/018-git-changes-panel/spec.md`

## Summary

Add a sixth right-pane tenant, `git-changes`, hosted by the existing `panel-registry.ts`/
`RightPaneShell.tsx` shell with no shell changes beyond its own descriptor entry (research.md
decision 4). A new Rust reader shells `git status --porcelain=v2 -z --branch` (upgrading from the
File explorer panel's `v1`, which carries no branch/ahead-behind header), grouping every entry
into Conflicts/Staged/Changes/Untracked and reusing the existing `GitStatusMark` enum unchanged.
New stage/unstage/commit helpers shell `git add --`, `git restore --staged --`, and `git commit
-F -` respectively -- no helper of any of these three exists in `src-tauri/src/git/` today. The
panel is a single scrollable column (header -> groups -> rows) with a fixed commit-box footer,
per the already-run ui-architect-v3 layout consult cited in spec.md; selecting a row opens its
diff in the main-area tab via the existing `DiffView.tsx`, never inline in the hosted pane. Three
refresh triggers (status-transition, file-watcher, post-action refetch) reuse existing primitives
end to end: the `SessionStatus` transition the Status line already consumes, and `fs/watch.rs`'s
debounced `notify` watcher already shared with the File explorer panel. This is slice 1 of 3
(#464); slice 2 (AI commit message, #1060) and slice 3 (discard/amend/push+PR, #1061) are separate
specs, not touched here. Design rationale is in [research.md](research.md); the task breakdown is
in [tasks.md](tasks.md).

## Technical Context

**Language/Version**: Rust (Tauri 2 backend, `src-tauri/`) and TypeScript (`strict: true`) /
React 19 in the renderer (`src/renderer`) -- same stack as every other spec in this repository, no
new language or major version.

**Primary Dependencies**: none new. The renderer reuses `lucide-react` (`GitBranchIcon` already
imported by `SessionDetailsCard.tsx`; a conflict/alert-shaped icon already imported elsewhere,
e.g. `AlertCircleIcon` in `FileExplorerPanel.tsx`), the existing `DiffStatCounts` component
(`sessionDisplay.tsx`), the existing `GroupHeaderTrigger` component (`GroupHeader.tsx`), and the
existing `DiffView.tsx`. The Rust backend reuses `git/git.rs`'s existing `git_raw`/`git` shell
wrapper and `fs/watch.rs`'s existing `notify`-based watcher; no new crate is added to
`Cargo.toml`.

**Storage**: none added. Git's own working tree and index are the only state; the panel reads and
mutates them directly via shelled `git` commands, holding no independent cache of its own beyond
the renderer's per-Session in-memory store (research.md decision 4).

**Testing**: none written for this feature (AGENTS.md's hard prototyping rule: no new tests while
prototyping). Each user story is verified by running the app against a real worktree with staged/
unstaged/untracked/conflicted files and a real `git commit`, per `quickstart.md`-equivalent manual
steps (this spec has no separate quickstart.md, per the proportionate-size precedent of spec 014).
`pnpm typecheck`, `pnpm build`, and `cargo check` (or the repo's existing Rust build task) must
pass before a change lands on `main`.

**Target Platform**: Windows 11 only (constitution, Platform and Stack).

**Project Type**: desktop-app (Tauri 2: Rust backend process, webview renderer) -- extends the
existing right-pane shell (spec 013) and the existing git/IPC plumbing (`src-tauri/src/git/`,
`src-tauri/src/ipc/`); adds no new process type.

**Performance Goals**: from the spec: staging/unstaging a single file updates only that file's
group membership and the two affected counts, no visible full-panel reload (SC-002); an external
file-system change is reflected within the existing watcher's debounce window (SC-004, `fs/
watch.rs`'s `WATCH_DEBOUNCE_MS`, currently 200ms); a status read past the existing size cap shows
not-available rather than hanging (SC-006).

**Constraints**: every path argument to `git add`/`git restore`/`git commit` comes only from the
already-validated status map's own keys as a literal post-`--` argv entry -- never built from free
text or shell interpolation (spec.md FR-007, grill decision 5). The commit message is always piped
via stdin to `git commit -F -`, never passed as `-m` (no argv quoting/length limits, grill decision
5). The status read is capped at `status.rs`'s existing `STATUS_MAX_BUFFER_BYTES`; per-file
additions/deletions follow `diff_stat.rs`'s existing `MAX_FILES`/partial convention (spec.md
FR-018/FR-019).

**Scale/Scope**: one new Rust git-status-v2 reader plus three new mutation helpers (stage,
unstage, commit), one new IPC module registering six to eight new `gitChanges.*` commands (list,
stage, unstage, stage-all, unstage-all, commit, diff, ensure-watching/stop-watching mirroring the
File explorer panel's own watcher-lifecycle pair), one new hosted-panel descriptor and its
renderer component tree (panel shell, group list, file row, commit box, branch header), one
`panel-registry.ts` entry, the Changes chip's existing click target repointed to open this panel,
25 functional requirements across 3 user stories.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the design meets it |
| --- | --- | --- |
| I. OMP Is the Engine, Refract Is the Host | N/A | This feature never talks to OMP's RPC surface at all -- it shells `git` directly, the same way every other git-backed feature in this app already does (`git/git.rs`, `git/status.rs`, `git/diff_stat.rs`). No command is forwarded to or withheld from OMP. |
| II. RPC Wire Contract | N/A | No OMP RPC traffic originates from this feature. |
| III. Session and Process Lifecycle | PASS | The panel is keyed to the Session's own worktree path, already resolved by the existing registry lookup pattern (`ipc/file_explorer.rs`'s `session_context`); no new process-lifecycle concern. |
| IV. Evidence Before Design | PASS | This spec depends on no unverified OMP behaviour -- `omp commit` (slice 2's own mechanism) is explicitly out of this slice's scope, so nothing here needs an unverified-OMP-behaviour label. Every git-command choice (FR-001, FR-007, FR-011) is grounded directly in reading `status.rs`/`diff_stat.rs`/`git.rs`'s existing source, not inferred. |
| V. Tauri Security Baseline | PASS | No new Tauri capability grant is needed: this feature shells `git` through the same already-capability-free process-spawn path (`git::git::git_raw`) every other git-backed feature already uses -- the renderer never calls a webview-exposed plugin API directly, only the existing validated IPC command path. No new window, no new navigation target, no new CSP relaxation. |

No violation; the Complexity Tracking section below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/018-git-changes-panel/
├── spec.md
├── plan.md
├── research.md
└── tasks.md
```

### Source Code (repository root, additions to the existing layout)

```text
src-tauri/src/
├── git/
│   ├── git.rs                  # existing: git_raw/git shell wrapper -- reused unchanged
│   ├── status.rs               # existing: GitStatusMark, v1 reader (File explorer) -- enum reused, reader not reused (v1 vs v2)
│   ├── diff_stat.rs            # existing: MAX_FILES/partial convention -- pattern reused
│   └── changes_status.rs       # NEW: git status --porcelain=v2 -z --branch reader + grouping,
│                                #      plus stage/unstage/commit helpers (git add --, git restore
│                                #      --staged --, git commit -F -)
├── fs/
│   └── watch.rs                # existing: debounced notify watcher -- reused unchanged, no new file
└── ipc/
    ├── file_explorer.rs        # existing: watcher-lifecycle IPC pattern -- reused as this module's shape
    └── git_changes.rs          # NEW: gitChanges.* IPC handlers (list, stage, unstage, stageAll,
                                 #      unstageAll, commit, diff, ensureWatching, stopWatching)

src/renderer/features/right-pane/
├── panel-registry.ts           # EDIT: new 'git-changes' PanelId + HOSTED_PANELS entry
└── git-changes/
    ├── GitChangesPanel.tsx     # NEW: panel shell (header, scrollable groups region, fixed commit box)
    ├── GitChangesGroup.tsx     # NEW: one group (GroupHeaderTrigger + its rows + bulk action)
    ├── GitChangesFileRow.tsx   # NEW: one file row (status mark, DiffStatCounts badge, actions)
    └── GitCommitBox.tsx        # NEW: message field, subject counter, Commit button, inline warning/error

src/renderer/state/
└── git-changes-store.ts        # NEW: per-Session store for this panel's groups/header/loading/error,
                                 #      mirroring file-explorer-store.ts's own per-Session shape

src/shared/
├── model.ts                    # EDIT: GitChangesGroups/GitChangesHeader/GitChangesFileRow shapes
└── ipc.ts                      # EDIT: gitChanges.* request/response contracts
```

**Structure Decision**: extends the existing `src-tauri/src/git/` and `src-tauri/src/ipc/`
directories with one new file each (`changes_status.rs`, `git_changes.rs`), following the File
explorer panel's own split between a focused git/fs module and a thin IPC-wiring module
(`ipc/file_explorer.rs`'s own header comment states this convention explicitly). The renderer gets
one new feature directory, `right-pane/git-changes/`, sibling to `right-pane/file-explorer/`,
following that panel's own internal file split (panel shell, row component(s), one store).
`panel-registry.ts` gains one descriptor, no restructuring of the file itself.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

None -- the Constitution Check above has no violation.

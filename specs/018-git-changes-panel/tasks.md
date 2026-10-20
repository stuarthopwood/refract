---
description: "Task list for Git changes panel (slice 1, #464)"
---

# Tasks: Git changes panel (slice 1)

**Input**: Design documents from `specs/018-git-changes-panel/`

**Prerequisites**: plan.md, spec.md, research.md

**Tests**: omitted entirely -- AGENTS.md's hard prototyping rule forbids writing new tests while
prototyping; no task below writes a test file.

**Organization**: tasks are grouped by user story (spec.md's P1/P2/P3) so each can be implemented
and manually verified independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on another unfinished task)
- **[Story]**: which user story (US1/US2/US3) a task belongs to; Setup/Foundational/Polish tasks
  carry no story tag

## Path Conventions

Paths below are repository-root-relative, matching plan.md's Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: create the new files this feature needs, empty but present, so later tasks only ever
add to an existing file.

- [ ] T001 Create `src-tauri/src/git/changes_status.rs` with its module header comment (port
      rationale, v2-vs-v1 reasoning per research.md decision 1) and register it in
      `src-tauri/src/git/mod.rs`.
- [ ] T002 Create `src-tauri/src/ipc/git_changes.rs` with its module header comment and register
      it in `src-tauri/src/ipc/mod.rs`'s dispatcher-registration list.
- [ ] T003 [P] Create `src/renderer/features/right-pane/git-changes/` directory with empty
      `GitChangesPanel.tsx`, `GitChangesGroup.tsx`, `GitChangesFileRow.tsx`, `GitCommitBox.tsx`.
- [ ] T004 [P] Create `src/renderer/state/git-changes-store.ts`, mirroring
      `file-explorer-store.ts`'s per-Session keyed shape (empty store scaffold only).

**Checkpoint**: new files exist and compile/typecheck as empty scaffolding; no behaviour yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared git-read/IPC plumbing every user story's UI depends on.

**⚠️ CRITICAL**: no user-story task may begin until this phase is complete.

- [ ] T005 In `src-tauri/src/git/changes_status.rs`, define `GitChangesGroup` (`Conflicts |
      Staged | Changes | Untracked`), `GitChangesFileEntry` (path, folder, `GitStatusMark`,
      additions, deletions, partial flag), and `GitChangesHeader` (branch, base branch, optional
      ahead/behind pair) structs with `Serialize`, matching `src/shared/model.ts`'s planned shapes
      (T015).
- [ ] T006 In `src-tauri/src/git/changes_status.rs`, implement the `-z`-delimited `git status
      --porcelain=v2 -z --branch` output parser: header lines (`# branch.head`, `#
      branch.upstream`, `# branch.ab`) into `GitChangesHeader`, and `1 ...`/`2 ...`/`u ...`/`?
      ...` entry lines into `(path, GitStatusMark)` pairs, reusing `GitStatusMark`'s existing
      precedence rules (research.md decision 2). Cap the read at `status.rs`'s existing
      `STATUS_MAX_BUFFER_BYTES` (spec.md FR-018).
- [ ] T007 In `src-tauri/src/git/changes_status.rs`, implement grouping of every parsed entry into
      exactly one of the four `GitChangesGroup`s (spec.md FR-002), and per-file additions/
      deletions via the same `git diff --numstat` / `git diff --cached --numstat` approach
      `diff_stat.rs` already uses, applying its `MAX_FILES`/partial convention (spec.md FR-019).
- [ ] T008 In `src-tauri/src/git/changes_status.rs`, implement `stage_files(worktree_path, paths)`
      (`git add --`), `unstage_files(worktree_path, paths)` (`git restore --staged --`), and
      `commit(worktree_path, message)` (`git commit -F -`, message on stdin), each using
      `git::git::git_raw`/`git` with every path as a literal post-`--` argv entry (spec.md FR-007,
      FR-011).
- [ ] T009 In `src-tauri/src/ipc/git_changes.rs`, register `gitChanges.list`, `gitChanges.stage`,
      `gitChanges.unstage`, `gitChanges.stageAll`, `gitChanges.unstageAll`, `gitChanges.commit`,
      `gitChanges.ensureWatching`, `gitChanges.stopWatching` handlers, following
      `ipc/file_explorer.rs`'s own `session_context`/watcher-lifecycle pattern (research.md
      decision 6) -- `ensureWatching`/`stopWatching` reuse `fs/watch.rs`'s `watch_directory`
      exactly as `file_explorer.rs` already does, with no second watcher implementation.
- [ ] T010 In `src-tauri/src/ipc/git_changes.rs`, wire the watcher's `on_directory_changed`
      callback and the Session-status-transition signal (reusing `session/agent/types.rs`'s
      existing `SessionStatus`, research.md decision 7) to push a `gitChanges.*` refresh event to
      the renderer, only for Sessions with an open panel (spec.md FR-015, FR-016).
- [ ] T011 [P] In `src/shared/model.ts`, add `GitChangesGroupKind`, `GitChangesFileEntry`,
      `GitChangesHeader`, and `GitChangesSnapshot` types matching the Rust shapes from T005.
- [ ] T012 [P] In `src/shared/ipc.ts`, add the `gitChanges.*` request/response contracts matching
      the handlers registered in T009.
- [ ] T013 In `src/renderer/state/git-changes-store.ts`, implement the per-Session store: current
      `GitChangesSnapshot`, loading/error state, and actions (`load`, `stage`, `unstage`,
      `stageAll`, `unstageAll`, `commit`) that call the `gitChanges.*` IPC contracts from T012 and
      refetch after every mutating action (spec.md FR-015c).

**Checkpoint**: backend can list/stage/unstage/commit and push refresh events; renderer store can
drive all three, with no UI yet.

---

## Phase 3: User Story 1 - See and stage/unstage changes (Priority: P1) 🎯 MVP

**Goal**: a developer can open the panel, see the four groups with correct rows, and stage/
unstage per-file and in bulk.

**Independent Test**: spec.md User Story 1's own Acceptance Scenarios 1-6.

### Implementation for User Story 1

- [ ] T014 [P] [US1] In
      `src/renderer/features/right-pane/git-changes/GitChangesFileRow.tsx`, render a file row:
      name + folder, status icon+text reusing `FileExplorerPanel.tsx`'s `STATUS_MARKS` mapping,
      and a `DiffStatCounts` badge (spec.md FR-005).
- [ ] T015 [US1] In the same file, add the per-file action buttons (Stage, Unstage, Open diff,
      Open in VS Code -- reusing #463's existing shared VS Code action), wired to the store's
      `stage`/`unstage` actions and to opening `DiffView.tsx` in a main-area tab (spec.md FR-006,
      FR-008).
- [ ] T016 [US1] In
      `src/renderer/features/right-pane/git-changes/GitChangesGroup.tsx`, render one group using
      `GroupHeaderTrigger` (leading chevron, trailing `(N)` count) plus its `GitChangesFileRow`
      list, and the group's own bulk action (Stage all / Unstage all) as a tooltipped icon button
      with an accessible name including the group's name (spec.md FR-003, FR-004).
- [ ] T017 [US1] In
      `src/renderer/features/right-pane/git-changes/GitChangesPanel.tsx`, assemble the scrollable
      groups region (`flex-1 overflow-auto`) rendering the four `GitChangesGroup`s in Conflicts/
      Staged/Changes/Untracked order, reading from `git-changes-store.ts`.
- [ ] T018 [US1] In `src/renderer/features/right-pane/panel-registry.ts`, add `'git-changes'` to
      `PanelId` and a `HOSTED_PANELS` entry (icon, name, `hasCount: true`), matching the
      `file-explorer`/`side-chat` wiring pattern (spec.md FR-020).
- [ ] T019 [US1] Wire `usePanelCount('git-changes', sessionId)` to sum the currently-visible file
      rows' additions/deletions into the `{ kind: 'additions-deletions', additions, deletions }`
      shape (spec.md FR-020).
- [ ] T020 [US1] Add the panel's honest-empty-state (icon, one line, no Sample-data badge) for a
      clean worktree, and a not-available state for a status read past the size cap (spec.md
      FR-017, FR-018).

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Write and submit a commit (Priority: P2)

**Goal**: a developer can compose a message and commit staged files from the panel.

**Independent Test**: spec.md User Story 2's own Acceptance Scenarios 1-6.

### Implementation for User Story 2

- [ ] T021 [P] [US2] In
      `src/renderer/features/right-pane/git-changes/GitCommitBox.tsx`, render the fixed,
      non-scrolling footer: subject field with a live character counter, body field, and a Commit
      button (spec.md FR-009).
- [ ] T022 [US2] In the same file, disable Commit with a visible single reason when nothing is
      staged or the message is empty, and wire Ctrl+Enter (anywhere in the message field) plus the
      Commit button to the store's `commit` action, clearing the message field on success (spec.md
      FR-010, FR-011, FR-023, FR-024).
- [ ] T023 [US2] In the same file, show the quiet inline "Agent is working -- review before
      committing" warning whenever the focused Session's `SessionStatus` is `Working`, without
      disabling Commit on that basis (spec.md FR-012).
- [ ] T024 [US2] In the same file, render a plain inline `role="alert"` error naming the failure
      whenever a stage/unstage/commit action fails (including an `index.lock` collision), never
      auto-retried (spec.md FR-013).
- [ ] T025 [US2] In `GitChangesPanel.tsx`, mount `GitCommitBox.tsx` as the fixed footer under the
      scrollable groups region (ui-architect-v3 layout ruling).

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Branch/ahead-behind header and auto-refresh (Priority: P3)

**Goal**: the panel shows branch + ahead/behind and keeps itself current without manual refresh.

**Independent Test**: spec.md User Story 3's own Acceptance Scenarios 1-5.

### Implementation for User Story 3

- [ ] T026 [P] [US3] Create a `GitChangesHeader.tsx` component rendering `GitBranchIcon` + branch
      + muted "from {base}", reusing `SessionDetailsCard.tsx`'s branch-line shape, plus a
      net-new muted icon+text ahead/behind figure appended to the same row, omitted entirely when
      no upstream exists (spec.md FR-014).
- [ ] T027 [US3] Mount `GitChangesHeader.tsx` at the top of `GitChangesPanel.tsx`, above the
      scrollable groups region.
- [ ] T028 [US3] In `src/renderer/features/right-pane/git-changes/GitChangesPanel.tsx`, subscribe
      to the panel's own mount/Session-focus lifecycle to call `gitChanges.ensureWatching` on
      mount/focus and `gitChanges.stopWatching` on unmount/blur (spec.md FR-015b, FR-016),
      matching `FileExplorerPanel.tsx`'s own watcher lifecycle calls.
- [ ] T029 [US3] In `git-changes-store.ts`, subscribe to the Session-status-transition refresh
      event (T010) and refetch once per Working->(not Working) transition for a Session with an
      open panel (spec.md FR-015a).
- [ ] T030 [US3] Verify (by reading the existing Changes readout chip's component, e.g.
      `ReadoutChips.tsx`) and repoint the Changes chip (#435) to open the Git changes panel for
      that pane's focused Session (spec.md FR-021).
- [ ] T031 [US3] Confirm a second Split pane's `GitChangesPanel.tsx` instance reads its own
      pane's focused Session id independently, with no shared singleton state (spec.md FR-022).

**Checkpoint**: all three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: improvements spanning more than one user story.

- [ ] T032 [P] Verify every status/disabled/error state in the panel conveys its meaning by
      icon+text, never colour alone (spec.md SC-005), by reviewing `GitChangesFileRow.tsx`,
      `GitCommitBox.tsx`, and `GitChangesHeader.tsx` together.
- [ ] T033 [P] Confirm `pnpm typecheck` and `pnpm build` pass, and that the Rust backend builds
      cleanly (`cargo check` or the repo's existing build task) with the new
      `changes_status.rs`/`git_changes.rs` modules included.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies -- can start immediately.
- **Foundational (Phase 2)**: depends on Setup; blocks every user-story phase.
- **User Story 1 (Phase 3)**: depends on Foundational only.
- **User Story 2 (Phase 4)**: depends on Foundational; independent of User Story 1's own tasks,
  though verifying it manually needs at least one staged file (produced via User Story 1's own
  Stage action).
- **User Story 3 (Phase 5)**: depends on Foundational; independent of User Stories 1/2's own
  tasks.
- **Polish (Phase 6)**: depends on all three user-story phases being complete.

### Parallel Opportunities

- T003/T004 (Setup) run in parallel.
- T011/T012 (Foundational, shared-type files) run in parallel with each other, after T005-T010.
- T014 (US1), T021 (US2), T026 (US3) each touch a distinct new file and may be started in
  parallel once Phase 2 is complete.
- T032/T033 (Polish) run in parallel.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Manually verify against spec.md's own Acceptance Scenarios for User Story 1 -- this alone is a
   usable, demonstrable slice (see and stage/unstage changes).

### Incremental Delivery

1. Setup + Foundational -> backend/store ready, no UI.
2. + User Story 1 -> changes list + stage/unstage usable end to end.
3. + User Story 2 -> commit usable end to end.
4. + User Story 3 -> branch/ahead-behind header and auto-refresh complete the spec.
5. + Polish -> cross-cutting a11y/build verification.

## Notes

- No task writes a test file, per AGENTS.md's hard prototyping rule.
- Every task names a real, concrete file path; none is a placeholder.

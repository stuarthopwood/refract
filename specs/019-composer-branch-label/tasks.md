# Tasks: Live branch label in the composer strip

**Input**: Design documents from `specs/019-composer-branch-label/`
**Prerequisites**: plan.md, spec.md

**Tests**: None (prototyping rule, 2026-10-08); verified live on a scratch instance.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Foundational (Blocking Prerequisites)

- [X] T001 Add `src-tauri/src/session/readout_head_watch.rs`: resolve `git rev-parse --git-path HEAD` against the worktree, watch its parent directory non-recursively, filter to file name `HEAD`, debounce 150 ms, push the new branch at once (branch-only fast path), then `schedule_readout_update`; one watcher per Session in a static map, replaced on start (FR-003)
- [X] T002 Declare the module in `src-tauri/src/session/mod.rs`; start the watch from `readout::on_launch`'s first pass and stop it in `readout::on_exit` in `src-tauri/src/session/readout.rs` (FR-003)

## Phase 2: User Story 1 - See the branch the Session is really on (Priority: P1)

- [X] T003 [US1] Add `src/renderer/features/chat/ComposerBranchLabel.tsx`: reads `readout.branch` for the pane's Session; renders nothing when null; "Detached at <sha>" when detached; `GitBranchIcon` plus truncating name (FR-001, FR-002, FR-006)
- [X] T004 [US1] Render it after `ReasoningPicker` in the composer bottom row in `src/renderer/features/chat/MessageInput.tsx`, without growing that file past its baseline (FR-001, FR-006)

## Phase 3: User Story 2 - Open the Git panel from the label (Priority: P1)

- [X] T005 [US2] Make the label a `PICKER_TRIGGER_CLASS` button with accessible name "Branch: <name>. Open Git changes panel" and a Tooltip (full name, base branch, "Session branch: x" when it differs), opening `openHostedPanel('git-changes', sessionId, { opener })` (FR-004, FR-005)

## Phase 4: Polish & Cross-Cutting Concerns

- [ ] T006 Live check on a scratch instance: label shows the branch, follows a terminal `git switch -c`, reads "Detached at <sha>" on a detached HEAD, truncates a 60-character name without pushing Reasoning out, opens the Git changes panel; Dark, Obsidian and Dark (high contrast) screenshots (SC-001, SC-002, SC-003)
- [X] T007 Update `docs/PLAN.md`'s #724 row

## Dependencies & Execution Order

- T001 -> T002 (backend); T003 -> T004 -> T005 (renderer, independent of the backend because `branch` already ships on the readout); T006 after all; T007 last.

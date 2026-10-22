# Tasks: OMP settings guard

**Input**: Design documents from `specs/020-omp-settings-guard/`
**Prerequisites**: plan.md, spec.md

**Tests**: Rust unit tests for the pure logic only (Rust-lane exception); no renderer or shared tests (prototyping rule). Verified live on a scratch build.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Foundational (Blocking Prerequisites)

- [ ] T001 Widen `validate_config_key` in `src-tauri/src/omp/config.rs` to dotted identifiers and update its existing test line (FR-006)
- [ ] T002 Add `src-tauri/src/omp/config_guard.rs`: baseline (FR-001), normalise and compare (FR-004, FR-005), cached single `config list` read (FR-003), serialised run, resets via `set_config` / `set_model_role` with per-key failure capture and `info` logging (FR-006), notice types, 6 s launch timeout wrapper (FR-007)
- [ ] T003 Add the Project override scan to `config_guard.rs` (read-only, FR-008)
- [ ] T004 [P] Add `src-tauri/src/omp/config_guard_tests.rs` (normalise, per-entry record compare with extras kept, override scan) and declare both modules in `omp/mod.rs`
- [ ] T005 [P] Add the `omp-guard:reset` event: `events.rs` constant and `emit_omp_guard_reset`; `src/shared/ompSettingsGuard.ts` payload type; `IPC_EVENTS.OMP_GUARD_RESET` and `onOmpGuardReset` in `src/shared/ipc.ts`; bridge in `src/tauri-bridge/index.ts`; lane entry in `scripts/check-parity.mjs` (FR-011)

## Phase 2: User Story 1 - Drift is reset before a Session starts (Priority: P1)

- [ ] T006 [US1] Call the guard before `OmpProcess::connect` in `src-tauri/src/session/agent/launch.rs` with the Session's worktree path, never failing the launch (FR-002, FR-007)
- [ ] T007 [US1] Run the guard once from `lib.rs` setup after the window shows, keeping the pending notice for re-delivery (FR-002, plan decision 10)

## Phase 3: User Story 2 - The developer is told (Priority: P1)

- [ ] T008 [US2] Add `omp-guard-store.ts` and subscribe in `init-stores.ts`: one toast per new notice id with a Details action (FR-009)
- [ ] T009 [US2] Add `OmpGuardDetailsDialog.tsx` on the shared `Dialog` listing resets, failures and overrides; mount it in `main.tsx` (FR-009, FR-010)

## Phase 4: User Story 3 - Never blocks, never edits a Project (Priority: P1)

- [ ] T010 [US3] Surface overrides and failures in the same notice and dialog; confirm launch proceeds on timeout or failure (FR-007, FR-008)

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T011 Add `scripts/verify-1184-omp-settings-guard.mjs` (scratch agent dir, CDP, toast and Details assertions, screenshots) and run it against a scratch debug build (SC-001 to SC-004)
- [ ] T012 `pnpm ci:local`; update `docs/PLAN.md`'s #1184 row (done, PR number, item 5 moved to #691); `node scripts/check-indent.mjs`

## Dependencies & Execution Order

- T001 -> T002 -> T003; T004 and T005 parallel after T002; T006 and T007 after T002 and T005; T008 -> T009 -> T010 after T005; T011 after all; T012 last.

# Tasks: PR and issue lists refresh after a merge, close or Session write

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)
**Rules**: no new tests (prototyping); `[P]` = different files.

## Phase 1: Event contract

- [ ] T001 Add `GITHUB_CHANGED`, `GithubChangedPayload`, `onGithubChanged` to `src/shared/ipc.ts` and `src/tauri-bridge/index.ts`; extend `scripts/check-parity.mjs`.
- [ ] T002 [P] Add `GITHUB_CHANGED` and emit helpers to `src-tauri/src/events.rs`.

## Phase 2: Backend emission (US1, US2)

- [ ] T003 Emit after successful merge and close in `ipc/pull_requests` (depends on T002).
- [ ] T004 Emit from `readout_touched.rs::record_writes`, skipping comments; remove the `dead_code` allows (depends on T002).

## Phase 3: Renderer (US1, US2, US3)

- [ ] T005 [P] Create `selection-handoff.ts` helper.
- [ ] T006 Quiet refresh with selection handoff in `pull-requests-store.ts`, `issues-store.ts`, `home-store.ts` (depends on T005).
- [ ] T007 Create `github-changed-refresh.ts` scheduler and subscribe in `init-stores.ts` (depends on T001, T006).

## Phase 4: Polish

- [ ] T008 Driver `scripts/verify-tauri-1589.mjs` (`node --check` only).
- [ ] T009 CHANGELOG, PLAN.md row, "never polled" comments.
- [ ] T010 typecheck, targeted vitest, check scripts, `cargo fmt --check`.

# Tasks: Delete Session in the background

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)
**Rules**: no new tests (prototyping); `[P]` = different files, no dependency on an unfinished task. Stories: US1 background removal, US2 refusals first, US3 failures, US4 parallel and reload, US5 quit prompt.

## Phase 1: Shared contract (blocks everything)

- [ ] T001 Add `SESSION_DELETED` / `SESSION_DELETE_FAILED` constants and `emit_session_deleted` / `emit_session_delete_failed` in `src-tauri/src/events.rs` (beside `SESSION_LIST_CHANGED` and `emit_session_list_changed`).
- [ ] T002 [P] Add the two `IPC_EVENTS` entries, `sessions.deleting()`, `onSessionDeleted`, `onSessionDeleteFailed` and the updated `sessions.delete` doc in `src/shared/ipc.ts`.
- [ ] T003 Wire `sessions.deleting`, `onSessionDeleted`, `onSessionDeleteFailed` in `src/tauri-bridge/index.ts` (depends on T002).
- [ ] T004 [P] Add the new channel and events to `scripts/check-parity.mjs` beside `SESSION_LIST_CHANGED` (depends on T002).

## Phase 2: Backend background removal (US1, US2, US3, US4)

- [ ] T005 [US1] Create `src-tauri/src/ipc/sessions_lifecycle/delete_in_flight.rs`: `IN_FLIGHT` set, `is_deleting`, `deleting_ids`, `any_in_flight`, `mark`, and `start(...)` that spawns the removal task owning the write guard and `WorktreeOperationGuard` (depends on T001).
- [ ] T006 [US1] [US2] Rewrite `sessions_delete` in `src-tauri/src/ipc/sessions_lifecycle.rs` (lines 297-435): keep the checks and the agent-restart-on-refusal before the return; hand lines 400-432 to `delete_in_flight::start`; return `Ok(Value::Null)` after the checks (depends on T005).
- [ ] T007 [US4] Add the already-deleting refusal (`worktree-busy`, "This Session is already being deleted.") at the top of `sessions_delete` and in `sessions_archive`, and register `sessions.deleting` (returns `deleting_ids()`) in `src-tauri/src/ipc/sessions_lifecycle.rs` (depends on T005).
- [ ] T008 [US1] Add the same refusal to the `sessions.rename` handler (find it with `grep "sessions.rename" src-tauri/src/ipc`) (depends on T005).
- [ ] T009 [US3] In `delete_in_flight.rs`, on failure emit `sessions:delete-failed` with `{ sessionId, error: { code, message } }` using the `map_git_error` / `map_registry_error` conversions; on success emit `sessions:deleted`; both then `notify_list_changed()` (part of T005; check here that both paths unmark the id).

## Phase 3: Quit prompt (US5)

- [ ] T010 [US5] Create `src-tauri/src/shell/quit_guard.rs` (`on_close_requested`, `confirm_quit`, `QUIT_CONFIRMED`) and declare it in `src-tauri/src/shell/mod.rs` (depends on T005).
- [ ] T011 [US5] Call `shell::quit_guard::on_close_requested` from the window-event closure in `src-tauri/src/lib.rs` (lines 289-291) before `tracker.on_window_event`.
- [ ] T012 [US5] Call `confirm_quit` in `updates_install_now` in `src-tauri/src/ipc/updates.rs` (line 156) and return `Ok(Value::Null)` without exiting when declined.

## Phase 4: Renderer (US1, US3, US4)

- [ ] T013 [US4] Extend `src/renderer/state/sessions-store.ts` with `deletingIds`, `markDeleting`, `clearDeleting`, `deleteDetails`, `openDeleteDetails`, `closeDeleteDetails`; make `refresh()` also fetch `sessions.deleting()` (depends on T002, T003).
- [ ] T014 Adapt the three existing tests that call `sessions_delete` in `src-tauri/src/ipc/sessions_lifecycle_tests.rs` (around lines 329, 441, 486) to wait until `delete_in_flight::is_deleting(&id)` is false after the call; no new cases (depends on T006).
- [ ] T015 [US3] Create `src/renderer/features/sessions/deleteFailureToast.ts` (`showDeleteFailureToast`: persistent error toast, Retry as `action`, Details as `cancel`, id `delete-failed:<id>`) (depends on T013).
- [ ] T016 [US3] Subscribe to `onSessionDeleted` / `onSessionDeleteFailed` in `src/renderer/state/init-stores.ts` (line 79 area): clear the id, refresh, announce "Deleted <name>" or the failure, raise the toast (depends on T013, T015).
- [ ] T017 [US1] [US3] Update `src/renderer/features/sessions/DeleteDialog.tsx`: call `markDeleting` on success in `handleDelete` (lines 191-192) and add the `initialError` prop (depends on T013).
- [ ] T018 [US3] Create `src/renderer/features/sessions/DeleteDetailsHost.tsx` and mount it in `src/renderer/App.tsx` next to the live regions (lines 126-132) (depends on T017).
- [ ] T019 [P] [US1] Render the Deleting… state (dim, spinner, **Deleting…**, ", deleting" in the accessible name, inert click and keys) in `src/renderer/features/sessions/SessionRow.tsx` (depends on T013).
- [ ] T020 [P] [US1] Same in `src/renderer/features/sessions/SessionRowTable.tsx` (depends on T013).
- [ ] T021 [P] [US1] Make `buildSessionRowActions` in `src/renderer/features/sessions/sessionActions.ts` and its caller `useSessionRowActions.ts` return no open/rename/archive/delete actions while deleting (depends on T013).
- [ ] T022 [P] [US1] Disable the Delete entry in `src/renderer/features/chat/ChatPane.tsx` (around line 672) for a deleting Session (depends on T013).

## Phase 5: Hand-off

- [ ] T023 Update `docs/PLAN.md` row for #1591 with the delivered behaviour (permanent feature: docs change).
- [ ] T024 Gate (run by the parent once): `pnpm ci:local`, plus a live check with a large worktree: Deleting… row, parallel deletes, refusal stays in the dialog, failure toast, reload mid-delete, quit prompt.

## Dependencies

T001 -> T005 -> T006, T007, T008, T010 -> T011, T012. T002 -> T003, T004 -> T013 -> T015..T022. T014 after T006.

## Story coverage

US1: T005, T006, T017, T019-T022. US2: T006 (checks stay before return). US3: T009, T015-T018. US4: T005, T007, T013. US5: T010-T012.

## Phase 6: Convergence

Assessed 2026-11-06 against the amended spec (FR-006, FR-014 to FR-016, US3/AC1). Phases 1 to 5 are delivered in #1609 (`delete_in_flight.rs`, `quit_guard.rs`, `deleteFailureToast.ts`, `DeleteDetailsHost.tsx` exist); the findings below are the remaining gaps, all from #1722.

- [x] T025 [US3] Make `notifyPersistentError` in `src/renderer/state/notify.ts` the single persistent-error path: a text-derived toast id so an identical message replaces the open toast in place, re-announced assertively; optional `{ id, description, action, cancel }` so callers with actions can use it per FR-014 (contradicts)
- [x] T026 [US3] Route `notify()`'s default error path (`notify.ts:29`, no id today) through `notifyPersistentError` per FR-014 (contradicts)
- [x] T027 [P] [US3] Move the direct `toast.error(..., { duration: Infinity, closeButton: true })` callers to `notifyPersistentError`: `features/chat/Markdown.tsx`, `features/palette/usePaletteConversations.ts`, `features/sessions/newSessionInFocusedPane.ts` (two sites), `features/sessions/startSessionRequest.ts`, `features/sessions/useSessionRowActions.ts`, and `notifyProgress.fail` per FR-014 (partial)
- [x] T028 [US3] `features/sessions/deleteFailureToast.ts` uses `notifyPersistentError` (keeps id `delete-failed:<id>`, Retry, Details) and `state/init-stores.ts:98` drops the polite chat-area announcement so the failure is announced once, assertively, per FR-006 and US3/AC1 (contradicts)
- [x] T029 [P] Add `aria-hidden="true"` to the loading icon in `src/renderer/components/ui/sonner.tsx` per FR-015 (missing)
- [x] T030 [P] Add `closeButton: true` to `notifyProgress.info` in `src/renderer/state/notify.ts` per FR-015 (missing)
- [x] T031 [P] Replace the two duplicated "Type / to see the available commands." suffixes in `src-tauri/src/ipc/chat.rs` (lines 196, 209) with one shared constant per FR-016 (partial)
- [ ] T032 Update the #1722 row in `docs/PLAN.md`; gate: `pnpm ci:local`, then a live check that a repeated persistent error shows one toast and is announced assertively per FR-014

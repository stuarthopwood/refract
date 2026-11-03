# Implementation Plan: Delete Session in the background

**Branch**: `feat/1591-background-delete` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

## Summary

Split `sessions.delete` into a fast phase (arguments, refusal checks, agent shutdown) that returns to the renderer, and a background phase (worktree removal, Conversation deletion, registry removal) that emits `sessions:deleted` or `sessions:delete-failed`. A module-level set holds in-flight Session ids; a new `sessions.deleting` query exposes it. The renderer adds a `deletingIds` set to the sessions store, a Deleting… row state, a failure toast with Retry and Details, and a native quit prompt guards `CloseRequested` and "Update now".

## Technical Context

**Language/Version**: Rust (Tauri 2.12.3, tokio) in `src-tauri`; TypeScript + React + Tailwind in `src/renderer`
**Primary Dependencies**: `tauri-plugin-dialog` (already linked: `lib.rs:231`; `build.rs` already embeds the Common Controls v6 manifest it needs), `sonner` via `src/renderer/components/ui/sonner.tsx`
**Storage**: existing registry; in-flight set is memory only (a crash mid-delete leaves the existing #891 partial-folder state)
**Testing**: none added (prototyping phase). Existing tests must keep passing; the three that call `sessions_delete` need a one-line adaptation (see T014)
**Target Platform**: Windows/macOS/Linux desktop
**Constraints**: 600-line soft cap per file (`sessions_lifecycle.rs` is 501 lines, so the background half goes in a new file); comments say "why" only; shared components only (ADR 0003)

## Constitution Check

Checked against `.specify/memory/constitution.md` and AGENTS.md: reusable components (row state and toast use shared components; `DeleteDialog` gains a prop rather than being copied), no god files (new modules), no new tests, clean cutover (no old synchronous path left behind in the renderer). No violations.

## Project Structure

### Documentation

```text
specs/113-background-session-delete-1591/
  spec.md
  plan.md
  tasks.md
  analysis.md
```

### Source files to change (current delete path, verified on this branch)

Current path: `DeleteDialog.handleDelete` (`src/renderer/features/sessions/DeleteDialog.tsx:150-193`) awaits `window.refract.sessions.delete(id, { confirmed: true })`, which runs `sessions_delete` (`src-tauri/src/ipc/sessions_lifecycle.rs:297-435`) end to end. The dialog is mounted from `SessionRow.tsx:285`, `SessionRowTable.tsx:129`, `ChatPane.tsx:672`.

**Rust (`src-tauri/src`)**

| File | Change |
|---|---|
| `ipc/sessions_lifecycle.rs` | Rewrite `sessions_delete` (297-435): keep lines 299-331 (args, registry read), 333-373 (cancel walk, write guard, named holders, `begin_worktree_operation`, stop git watcher, agent shutdown), 375-396 (cwd-holder refusal that restarts the agent) and 398 (`remove_process_records_for_session`) in the handler. Before the checks, refuse with code `worktree-busy` ("This Session is already being deleted.") when the id is in flight. After the checks, call `delete_in_flight::start(...)`, handing it the owned `_write_guard` and `worktree_guard`, then return `Ok(Value::Null)`. Move lines 400-432 (`remove_session_worktree`, Conversation delete, registry remove, `remove_agent`, `forget_session`, `on_worktree_released`, `finish(Forgotten)`, `notify_list_changed`) into the new module. Register `sessions.deleting` next to `sessions.delete` in the register function at the top of the file. Add the in-flight refusal to `sessions_archive` as well. |
| `ipc/sessions_lifecycle/delete_in_flight.rs` (new) | `static IN_FLIGHT: LazyLock<std::sync::Mutex<HashSet<String>>>`; `pub fn is_deleting(id) -> bool`; `pub fn deleting_ids() -> Vec<String>` (sorted); `pub fn any_in_flight() -> bool`; `pub fn mark(id) -> bool` (false when already present); `pub fn start(state: AppState, session, repository, write_guard: OwnedRwLockWriteGuard<()>, worktree_guard: WorktreeOperationGuard)`. `start` marks the id, emits list-changed, and `tauri::async_runtime::spawn`s the removal; the task owns both guards, runs the moved removal steps, then `unmark`s the id and emits `sessions:deleted` (success) or `sessions:delete-failed` with `{ sessionId, error: { code, message } }` built with the same `map_git_error`/`map_registry_error` conversions the handler used, then `notify_list_changed()`. On failure the guard is dropped without `finish`, so the Explorer resets as it does today. `pub async fn wait_until_settled(id)` is not needed; tests poll `is_deleting`. |
| `ipc/sessions_lifecycle/sessions_delete_support.rs` | No change expected; reuse `is_strict_descendant_of_omp_sessions` and `delete_session_conversations` from the new module (adjust `use` paths only). |
| `events.rs` | Add `pub const SESSION_DELETED: &str = "sessions:deleted"` and `SESSION_DELETE_FAILED: &str = "sessions:delete-failed"` next to `SESSION_LIST_CHANGED` (line 11); add `emit_session_deleted(&self, id)` and `emit_session_delete_failed(&self, id, code, message)` beside `emit_session_list_changed` (about line 107), using the same `self.send` path. If the delete task has no `EventSink`, reach it through `state.session_manager` as `notify_list_changed` does. |
| `ipc/mod.rs` | Add `pub(crate) mod` wiring only if `sessions_lifecycle/` submodules are declared there. Otherwise declare `mod delete_in_flight;` in `sessions_lifecycle.rs` next to `sessions_delete_support`. |
| `ipc/updates.rs` | In `updates_install_now` (128-160), before `request_restart_after_install()` (156), call `crate::shell::quit_guard::confirm_quit(&app_handle).await`; when the user declines, return `Ok(Value::Null)` without exiting. |
| `shell/quit_guard.rs` (new), `shell/mod.rs` | `pub fn on_close_requested(window: &WebviewWindow, event: &WindowEvent)`: for `CloseRequested { api, .. }`, when `delete_in_flight::any_in_flight()` and the confirmed flag is unset, call `api.prevent_close()` and `spawn` a task that runs `confirm_quit`; on accept set a static `QUIT_CONFIRMED` `AtomicBool` and call `window.close()`. `pub async fn confirm_quit(app: &AppHandle) -> bool`: true at once when nothing is in flight or `QUIT_CONFIRMED` is set; else `tokio::task::spawn_blocking(move || app.dialog().message("A Session is still being deleted. Quit anyway?").title("Quit Refract?").buttons(MessageDialogButtons::OkCancelCustom("Quit anyway".into(), "Keep waiting".into())).blocking_show())`, the pattern used by `ipc/file_attachments.rs:219` and `ipc/repositories.rs:492`. Native, because the renderer may be mid-close. |
| `lib.rs` | In the window-event closure (289-291) call `shell::quit_guard::on_close_requested(&window_for_events, event)` before `tracker.on_window_event`. `ExitRequested` (322-349) is unchanged: once the user accepted, the existing hand-off runs. |

**Shared contract (`src/shared`, `src/tauri-bridge`, `scripts`)**

| File | Change |
|---|---|
| `src/shared/ipc.ts` | Add `SESSION_DELETED: 'sessions:deleted'` and `SESSION_DELETE_FAILED: 'sessions:delete-failed'` to `IPC_EVENTS` (near line 396). Add `deleting(): Promise<Result<string[]>>` to `sessions` (near `deleteCheck`, line 457). Add `onSessionDeleted(handler: (payload: { sessionId: string }) => void): Unsubscribe` and `onSessionDeleteFailed(handler: (payload: { sessionId: string; error: { code: IpcErrorCode; message: string } }) => void): Unsubscribe` next to `onSessionListChanged` (line 611). Update the doc of `sessions.delete` to "returns once the checks pass; removal continues in the background". |
| `src/tauri-bridge/index.ts` | Wire `sessions.deleting` through `invoke` like its siblings; add `onSessionDeleted` / `onSessionDeleteFailed` beside `onSessionListChanged` (line 454). |
| `scripts/check-parity.mjs` | Add the new channel and two events beside `SESSION_LIST_CHANGED` (line 366), following that file's existing format. |

**Renderer (`src/renderer`)**

| File | Change |
|---|---|
| `state/sessions-store.ts` | Add `deletingIds: ReadonlySet<string>`, `markDeleting(id)`, `clearDeleting(id)`; `refresh()` also calls `window.refract.sessions.deleting()` so a reload restores rows. Add `deleteDetails: { id: string; message: string } | null` with `openDeleteDetails` / `closeDeleteDetails` for the Details button. |
| `state/init-stores.ts` (line 79 area) | Subscribe to `onSessionDeleted` (clear id, `refresh()`, announce "Deleted <name>") and `onSessionDeleteFailed` (clear id, `refresh()`, announce the failure, raise the toast). |
| `features/sessions/deleteFailureToast.ts` (new) | `showDeleteFailureToast(session, error)`: `toast.error(\`Could not delete ${name}\`, { id: \`delete-failed:${id}\`, duration: Infinity, description: error.message, action: { label: 'Retry', onClick }, cancel: { label: 'Details', onClick } })`, using `toast` as `features/chat/AgentStoppedBar.tsx:24` does. Retry marks the row Deleting… then calls `sessions.delete(id, { confirmed: true })`; a refusal reopens details with that message. Details calls `openDeleteDetails`. |
| `features/sessions/DeleteDialog.tsx` | In `handleDelete` (150-193): on `response.ok`, call `markDeleting(deletingId)` before the existing `deletedRef.current = true; onOpenChange(false)` (191-192). Add prop `initialError?: string`: when set it seeds `error` and `refused` after the open effect (101-108) so Details shows the failure plus holders and leftover summary (the effect already loads both). The "Deleting…" busy label (`busyLabel`, line 208) now only covers the check phase. |
| `features/sessions/DeleteDetailsHost.tsx` (new) | Renders `<DeleteDialog>` for `deleteDetails` from the store with `open` and `initialError`; mounted once in `App.tsx` next to the live regions (126-132). |
| `features/sessions/SessionRow.tsx` and `SessionRowTable.tsx` | Read `deleting = useSessionsStore(s => s.deletingIds.has(session.id))`; when true: `opacity` dimmed, spinner (`Loader2Icon animate-spin`, as in `DeleteDialog.tsx:238`) in the state-icon slot, status line text **Deleting…**, accessible name suffix ", deleting", click/Enter/context-menu do nothing, `aria-disabled`. |
| `features/sessions/sessionActions.ts` and `useSessionRowActions.ts` | `buildSessionRowActions` takes a `deleting` flag and returns no open/rename/archive/delete actions when set. |
| `features/chat/ChatPane.tsx` (lines 640-700) | When the pane's Session is deleting, disable its Delete entry (so a second delete is not offered). |
| `App.tsx` | Mount `DeleteDetailsHost`. |

Announcements use the existing chat-area announcer (`useChatAreaAnnouncer.getState().announce`, imported as in `features/chat-nav/jumpToMessage.ts:20`), which feeds the polite live region at `App.tsx:131`.

## Data and contract notes

- `sessions.delete` errors: unchanged codes for refusals. New refusal when already deleting reuses `worktree-busy` (already in `IpcErrorCode`, `ipc.ts:87`). No new `IpcErrorCode`.
- `sessions:delete-failed` payload `{ sessionId, error: { code, message } }` mirrors the `IpcError` shape the dialog consumes (`ipc.ts:91-92`).
- Lock order: the background task keeps the write guard from the fast phase, so a Retry or a second delete cannot start a removal under it; the in-flight check gives a fast refusal instead of a 10-second guard timeout.
- A failure after the dialog closed leaves the registry entry, so the row returns to normal; a success removes it and the next `session:list-changed` refresh drops the row.
- If the process quits mid-removal, the in-flight set vanishes with it and the worktree is partial; the existing #891 Retry path cleans up.

## Risks

- `sessions_delete` is called by three existing tests (`ipc/sessions_lifecycle_tests.rs` around lines 329, 441, 486) that assert completion on return. They must wait for the in-flight set to empty (see T014).
- `app.dialog().message(...).blocking_show()` must not run on the async runtime thread (use `spawn_blocking`).
- Closing the window to confirm quit re-enters `CloseRequested`; the `QUIT_CONFIRMED` flag prevents a loop.

## Complexity Tracking

None.

# Plan: Pause mode (spec 056)

## Approach

- Backend: new `session/pause.rs` holds `PauseState {mode, held}`; `AgentState` gains one field. Hooks: `send` (hold), `handle_turn_settled` (Pausing to Paused), `status_event_locked`/`summary_fields`/`runtime_view` (emit `pause`). Registry `Session` gains `paused` and `held` fields.
- IPC: new `ipc/chat_pause.rs` registers `chat.pause`, `chat.resume`, `chat.pauseAll`, `chat.resumeAll`. `chat.send` intercepts `/pause` before the reserved check.
- Shared types: `src/shared/ipc-pause.ts` (types, module augmentation of `SessionSummary`, `SessionRuntimeView`, `SessionStatusEvent`, `RefractApi`) so `ipc.ts` and `model.ts` do not grow.
- Renderer: `displayStatus` derives `paused`; `StatusDot`, `STATUS_LABEL`, `StateIcon` get a `paused` entry. New components `PausedOverlay`, `PauseAllButton`; row context menu item via the shared context menu. Space handling in a new hook. Capped files take net-zero edits.

## Files

Rust: `session/pause.rs`, `session/agent/{mod,chat,frame,status}.rs`, `store/registry.rs`, `ipc/chat_pause.rs`, `ipc/chat.rs`, `ipc/mod.rs`. TS: `shared/ipc-pause.ts`, `shared/slash-commands.ts`, `tauri-bridge/index.ts`, `sessionDisplay.tsx`, `StatusDot.tsx`, `manageSessionsHelpers.ts`, `StatusStylePreview.tsx`, `sessions-store.ts`, `ChatPane.tsx`, `ChatHeader.tsx`, `SessionRow.tsx`, `ProfileItem`/`App.tsx`, shortcuts dialog, palette, `globals.css`. Docs: `PLAN.md`, `CONTEXT.md`. Live: `scripts/verify-056-pause-mode.mjs`.

## Analysis (cross-check)

Every FR maps to a task in tasks.md. No FR needs a new test (prototyping phase). Principle V: no new capability or permission; four registered channels with argument validation.

## Amendment 2026-11-12 (#1890)

Backend: `SessionAgent::resume` starts a stopped Session before draining held messages (`start_then_drain`); `chat_resume_all` skips archived Sessions and returns `{count, failed}`. Renderer: `pauseActions.ts` reports the failure notice, `PausedBody.tsx` shows one Resume, `triageSessions.ts` filters paused Sessions out of Stop idle for `MemoryTriageDialog.tsx`. Tests sit beside each unit (`pause.test.rs`, `triageSessions.test.ts`, `pauseActions.test.ts`).

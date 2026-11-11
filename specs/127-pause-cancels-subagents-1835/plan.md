# Plan: Pause cancels the Session's subagents (#1835)

**Spec**: `specs/127-pause-cancels-subagents-1835/spec.md` | **Issue**: #1835 | **Amends**: spec 056 (pause mode)

## Approach

Rust only; no renderer or IPC-contract change. Pause asks OMP which subagents run and cancels each; while paused, every newly started subagent is cancelled from its lifecycle frame. All of it lives in a new `pause_subagents.rs` beside `pause.rs`, so `pause.rs` (279 lines) and `mod.rs` (509 lines) stay well under the 600-line cap.

## Code to touch (file:line on `origin/main` 3cdc19cd)

- `src-tauri/src/session/agent/pause.rs`
  - `:15-22` `State`: add `cancelled: Vec<String>` (in-memory, ids Pause cancelled).
  - `:123-164` `pause()`: after the held list is set and queued messages withdrawn (`:138-160`), before `emit_status()` (`:161`), call `self.cancel_running_subagents().await` (FR-001..003, FR-008). Early return at `:128-130` keeps double-Pause a no-op.
  - `:166-192` `resume()`: clear `pause.cancelled` next to `held = None` (in `drain_held`, `:202`); one notice naming the cancelled subagents (FR-006, DC-1 decided 2026-11-11: no revive, nothing respawned).
  - `:24-36` `wire_value`: unchanged (DC-2).
- `src-tauri/src/session/agent/pause_subagents.rs` (new, `mod pause_subagents;` in `agent/mod.rs:17-32`):
  - `cancel_running_subagents(&self)`: `request_rpc({"type":"get_subagents"})` -> `data.subagents[].id`, then `cancel_subagent` per id; `cancelled:false` / `Subagent not running` ignored; failures logged (`log::warn!`) and surfaced as one notice.
  - `on_subagent_started(&self, payload)`: if `pause.held.is_some()` and payload `status == "started"`, `cancel_subagent(payload.id)`, push to `cancelled`, notice. Payload shape verified in the probe log (`Probe1835/log-cancel.jsonl` lines 205 and 358): `{"id":"SelectRattlesnake","status":"started","detached":true,...}`; a revived subagent's `started` frame has no `parentToolCallId`, so key on `id` only. `get_subagents` returns `data.subagents[].id` (log line 206), `[]` when none (line 17).
  - Tests in `pause_subagents.test.rs` via `#[path]` (house pattern: `command_wait.rs:54-56`).
- `src-tauri/src/session/agent/frame.rs`: `handle_frame` fans `subagent_lifecycle` to `session::subagents::on_frame` at `:106` (that module handles it at `subagents.rs:143`); add a `"subagent_lifecycle"` arm to the `match frame_type` (`:18-98`, before `_ => {}` at `:97`) calling `on_subagent_started`, so the enforcement is part of the agent. Do not edit `session/subagents.rs`.
- `src-tauri/src/session/agent/lane_support.rs:9-29` `request_rpc`: reused as is (no idle check, timeout arg). `lane_support.rs:34-63` `request_rpc_if_idle` is not suitable: Pause must work while a turn runs.
- `src-tauri/src/session/agent/mod.rs`: `append_notice` (`:384-385`) reused for notices; `arc()` (`:194`) only if a spawned task is needed (not planned: Pause awaits the cancels, auto-cancel runs inside the frame handler without blocking its reader; check at T004 that awaiting an RPC inside `handle_frame` cannot deadlock the frame pump, otherwise `tokio::spawn` with `self.arc()` as `subagents_progress.rs:179-190` does).
- Reused unchanged: `session/subagents_progress.rs:195-275` `apply_subagent_frame` settles `aborted` as Cancelled via `classify_progress_status` (`omp/transcript/subagent_items.rs:135`); `subscribe_to_subagent_frames` (`subagents_progress.rs:177-191`) already requests `level: "progress"`; `ipc/chat_pause.rs:44-45,64` call `pause()` for `chat.pause` / `chat.pauseAll`.
- Not touched: renderer (`ChatHeader.tsx`, `PausedBody.tsx`, `sessionDisplay.tsx`, `ipc-pause.ts`): Pausing label stays (DC-2 decided 2026-11-11).
- Docs at implement: `CONTEXT.md:51` Session status glossary (add that Pause cancels subagents), `specs/056-pause-mode/spec.md` pointer line, `docs/PLAN.md` row.

## Checks

- `cargo test` for the new test file; `pnpm ci:local` (Rust build slot, per lane brief); file-size check on touched files.
- Live check against real OMP with a scratch profile (reuse the structure of `C:/Users/shopwood/AppData/Local/Temp/Probe1835/drive.mjs`): spawn a long detached subagent, Pause, confirm `cancelled:true` and a `subagent_lifecycle` `aborted` frame, then have the parent spawn another and confirm auto-cancel. Evidence saved under the lane's evidence path.

## Risks

- A frame-handler RPC could block the frame pump (see the `mod.rs` item); mitigated by spawning.
- Pause does not abort the parent's turn, so the parent may loop re-spawning; each is cancelled (DC-5).
- Test doubles: `scripts/verify-tauri-fake-omp.mjs` does not model `get_subagents` / `cancel_subagent` (the RPC schema lists them at `scripts/fixtures/omp-schema/rpc-wire.schema.json:279,301`); unit tests use a stub process and the live check uses real OMP.

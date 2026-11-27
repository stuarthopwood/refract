# Implementation Plan: Goal and Prewalk composer modes (#1865)

**Branch**: `feat/goal-prewalk-modes-1865` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)
**Input**: spec 142 (clarified). ADRs: [0014](../../docs/adr/0014-away-mode-answers-never-cancels.md), [0015](../../docs/adr/0015-plan-mode-is-an-approval-policy.md).

## Summary

Backend: a `goal` IPC module sends OMP's `{type:"goal", op}` requests; a `session/goal.rs` hook reads `get_state.goal` and `goal_updated` frames and emits a new `GOAL_UPDATE` event; a `omp/goal_overlay.rs` writes the `--config` overlay (`goal.enabled`, `goal.continuationModes: [rpc]`). Renderer: a `goal-store.ts` holds OMP's last word per Session; `GoalPrewalkMenu` is a second `ModePill` in `ComposerModePills.tsx`; Prewalk reuses `setPrewalk` and `usePrewalkStore`. Nothing is persisted. `away.rs` and `shared/workingMode.ts` are untouched.

## Dependencies (explicit)

| Needs | From what exactly | Checked by |
|---|---|---|
| OMP `goal` RPC command, `get_state.goal`, `goal_updated` | OMP 18.17.0 spike, #1865 (2026-11-10) | T001, T002, T003 against the installed OMP |
| Overlay mechanism | `omp/plan_overlay.rs` (`write`, `render`), `omp/process_args.rs` `build_args` | T004 reads both |
| Prewalk state path | `session/prewalk.rs`, `events.rs` `PREWALK_UPDATE`, `state/prewalk-store.ts`, `features/sessions/prewalkActions.ts` | T004 |
| Request path to OMP | `session/agent/chat.rs` (`proc.request`, abort), `session/agent/commands.rs`, `ipc/chat.rs` | T004 |
| Frame hook points | `session/agent/frame.rs:117` (`prewalk::on_frame`), `session/agent/launch.rs:405` (`prewalk::on_launch`), `session/agent/sync_from_state.rs:13` | T004 |
| Away policy | `session/working_mode/away.rs`, `away.test.rs` | T022, T025 |

## Design

### Backend (`src-tauri/src`)

1. `omp/goal_overlay.rs`: `render()` returns `goal:\n  enabled: true\n  continuationModes:\n    - rpc\n`; `write(dir)` is atomic like `plan_overlay::write` (`token_guard::write_atomic_if_changed`). `omp/process_args.rs` `build_args` pushes `--config <path>` after the token-guard args; a write failure pushes a warning, not an error (spec FR-002, Clarifications). T003 may make it conditional on a launch flag.
2. `session/goal.rs` (declared in `session/mod.rs` beside `prewalk`): `state_from_value(&Value) -> Option<GoalView>` (pure, tested); `on_frame` for `goal_updated`; `on_launch` and a `sync_from_state` call for `get_state.goal`. It emits `GOAL_UPDATE` (`events.rs`, `emit_goal_update`) only on change. No file I/O.
3. `ipc/goal.rs` (declared in `ipc/mod.rs:78` area, registered at `ipc/mod.rs:220` area): `goal.create`, `goal.pause`, `goal.resume`, `goal.drop`. Each gets the Session agent as `ipc/working_mode.rs` does, refuses `create` and `resume` when the Session's working mode is Plan (`session/working_mode`), then sends `{type:"goal", op, ...}` via the Session's process request with `DEFAULT_REQUEST_TIMEOUT_MS`, mapping `success:false` to an `IpcError` carrying OMP's text. The send helper lives on `SessionAgent` in a new `session/agent/goal.rs` so Session state access stays inside `session/agent`.
4. P1 and P2 decide: whether `chat_stop` (`session/agent/chat.rs`) needs a `get_state` refresh after abort, and whether `start_new_conversation` (`session/agent/conversations.rs`) must send `op:"drop"` first.
5. `away.rs` unchanged. A goal turn's `extension_ui_request` and approval frames already pass through `working_mode::on_frame`-style handling; T022 asserts this with a scripted frame.

### IPC and renderer

- `src/shared/ipc.ts`: `IPC_METHODS` (beside `WORKING_MODE_SET: 'workingMode.set'`), `IPC_EVENTS.GOAL_UPDATE: 'goal:update'`, a `GoalView` type, `goal` API and `onGoalUpdate` on the `RefractApi`; `src/tauri-bridge/index.ts` wires both (beside `workingMode` at line 358 and `onPrewalkUpdate` at line 509).
- `state/goal-store.ts` (modelled on `state/prewalk-store.ts`), subscribed in `state/init-stores.ts` beside `onPrewalkUpdate`.
- `components/ModePill.tsx`: `ModePillItem` gains `disabled?: boolean` and `disabledReason?: string` (tooltip on the radio item). Existing callers unchanged.
- `features/chat/GoalPrewalkMenu.tsx`: items None, Goal, Prewalk; the objective dialog (`components/ui/dialog.tsx`); pause or resume and exit buttons; reads `useGoalStore`, `usePrewalkStore` and the Session's working mode. `ComposerModePills.tsx` mounts it between `WorkingModeMenu` and `ApprovalModePill`.
- Session row badge in `features/sessions/SessionRowParts.tsx` (INFERENCE: the row's badge slot lives there; T004 confirms).
- P2: `/goal` entry in `shared/slash-commands.ts` and `session/agent/commands.rs` `NATIVE_RESERVED_COMMANDS`, handled in `ipc/chat.rs`.

## Risks

- The two unproven behaviours (abort pause, `/new` carry-over) change T010 and T011; they are the first tasks and gate the rest.
- `goal.enabled: true` for all launches may expose the `goal` agent tool to Sessions that never use Goal (spec Clarifications). T003 decides launch-conditional overlay versus always-on.
- Goal and Prewalk interaction is unobserved; the picker is single-choice until a probe says otherwise.
- `--config` precedence over a user's own `goal.enabled: false` is unverified (T003).
- `session/agent/launch.rs` is 491 lines and `ipc.ts` is 716; add new code in new files, not those, to stay under the 600-line cap.

## Complexity

No constitution violation. New files: `omp/goal_overlay.rs`, `session/goal.rs`, `session/agent/goal.rs`, `ipc/goal.rs`, `state/goal-store.ts`, `features/chat/GoalPrewalkMenu.tsx`, each with a co-located test.

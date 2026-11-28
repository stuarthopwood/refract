# Tasks: Goal and Prewalk composer modes (#1865)

Each task is for a fresh, narrow worker. Constraints for all: Testing V1 (a co-located unit test for every new or changed logic; prove each guard by mutation: remove the guard, watch the test fail, restore); why-only comments; files under 600 lines; no new dependency; no builds or tests mid-task except the task's own named test. Probe tasks touch no source file and use an isolated scratch `OMP_PROFILE` and scratch dir, never Stuart's real data or global OMP config.

## Phase 0: Probes (gate)

- [ ] T001 Probe P1: with a scratch profile, the overlay file from FR-002 and `omp --mode rpc --no-session`, create a goal (`{type:"goal",op:"create",objective:"count to 50 slowly"}`), send `abort_and_restore_queue` while a turn runs, then `get_state`. Record `goal.status` (paused or not), the frames seen, and whether `resume` works. Write the result into spec.md Clarifications ("P1 result") and comment on #1865. Done: result committed in spec.md. Gates T010.
- [ ] T002 Probe P2: same setup; create a goal, then send `new_session`, then `get_state`. Record whether `goal` is `null`, and whether `drop` before `new_session` changes anything. Write "P2 result" into spec.md Clarifications and comment on #1865. Gates T011.
- [ ] T003 Probe P3 (same run, no separate harness): record (a) whether `goal.enabled: true` adds the `goal` tool to the agent's tool list for a session that never creates a goal, (b) whether `--config` wins over a scratch user config with `goal.enabled: false`, (c) what `resume` does in plan mode with a restored paused goal, (d) whether an armed `/prewalk` and an active goal coexist. Write "P3 result" in Clarifications and decide overlay always-on or launch-conditional. Gates T006, T012.
- [ ] T004 Verify dependencies and hook points; edit nothing but a short note in this file if a name differs. Confirm at `origin/main`: `omp/plan_overlay.rs` `write` and `render`; `omp/process_args.rs` `build_args`; `session/agent/frame.rs` `prewalk::on_frame`; `session/agent/launch.rs` `prewalk::on_launch`; `session/agent/sync_from_state.rs`; `ipc/working_mode.rs` `register`; `ipc/mod.rs` `working_mode::register`; `src/shared/ipc.ts` `WORKING_MODE_SET` and `PREWALK_UPDATE`; `src/tauri-bridge/index.ts` `workingMode`; the Session row badge slot (`SessionRowParts.tsx` or elsewhere); which of `ModePill`, `WorkingModeMenu`, `ComposerModePills`, `prewalk-store` already have tests. Done: note appended.

## Phase 1: Backend (after T003)

- [ ] T005 (FR-002) `src-tauri/src/omp/goal_overlay.rs` with `render()` and `write(dir)`; declare in `omp/mod.rs`. Tests `omp/goal_overlay.test.rs`: render text (exact YAML), write is idempotent and atomic, unchanged file is not rewritten.
- [ ] T006 (FR-002) `omp/process_args.rs`: push `--config <goal overlay>` in `build_args` (always, or behind the flag T003 chose); a failed write adds a warning, never an error. Tests in `omp/process_args.test.rs`: args contain the pair; a failing directory yields a warning and the launch args still build; the Plan overlay pair is still present for plan launches.
- [ ] T007 (FR-005) `src-tauri/src/session/goal.rs`: pure `state_from_value` and `on_frame`, `on_launch`, plus the `sync_from_state` call; `events.rs` `GOAL_UPDATE` and `emit_goal_update`; declare in `session/mod.rs`; hook in `session/agent/frame.rs` beside `prewalk::on_frame` and `launch.rs` beside `prewalk::on_launch`. Tests `session/goal.test.rs`: `get_state.goal` shapes (active, paused, complete, null, missing), `goal_updated` frames, emit only on change, nothing emitted for unrelated frames.
- [ ] T008 (FR-004, FR-007) `session/agent/goal.rs` (`SessionAgent::goal_request(op, args)`) and `src-tauri/src/ipc/goal.rs` (`goal.create`, `goal.pause`, `goal.resume`, `goal.drop`), registered in `ipc/mod.rs`. Tests `ipc/goal.test.rs`: argument validation, the exact request JSON per op, `success:false` text becomes `IpcError`, `create` and `resume` refused in Plan mode with the tooltip text, a Session without a process returns a typed error.
- [ ] T009 (FR-001) Cross-check: `src/shared/ipc.ts` `GoalView` type and the Rust payload match field for field (`status`, `objective`, `tokensUsed`, `tokenBudget`); fix whichever side differs from the OMP reply T001 recorded. Done: a Rust test asserts the serialized payload keys.

## Phase 2: Probe-gated behaviour

- [ ] T010 (FR-011, gated on T001) Stop and goal: if P1 shows an abort leaves the goal active, `chat_stop` in `session/agent/chat.rs` refreshes `get_state` after a successful abort so the pill follows; if it pauses, nothing is added and a test documents that the pill reads Paused from `goal_updated`. Tests `session/agent/chat.test.rs` (or the existing co-located chat test file).
- [ ] T011 (FR-011, gated on T002) New Conversation: if P2 shows `/new` carries a goal, `start_new_conversation` in `session/agent/conversations.rs` sends `drop` first and a test proves the order; if not, a test documents that `get_state.goal` is `null` afterward. Tests in the `conversations` test file.
- [ ] T012 (gated on T003) Apply the overlay decision (launch-conditional means picking Goal restarts the Session at idle via the `working_mode/mod.rs` restart path); record the decision in this file. Tests accordingly.

## Phase 3: Renderer

- [ ] T013 (FR-004, FR-005) `src/shared/ipc.ts` (`GoalView`, `GOAL_UPDATE`, methods, `RefractApi.goal`, `onGoalUpdate`) and `src/tauri-bridge/index.ts`. Test: bridge test beside the existing bridge tests for the method names and event name.
- [ ] T014 (FR-005) `src/renderer/state/goal-store.ts` modelled on `prewalk-store.ts`; subscribe in `state/init-stores.ts`. Tests `goal-store.test.ts`: apply, clear on null, per-Session isolation, unknown until OMP speaks.
- [ ] T015 (FR-008) `components/ModePill.tsx`: `disabled` and `disabledReason` on `ModePillItem`. Tests `ModePill.test.tsx`: a disabled item cannot be selected by pointer or keyboard, tooltip is rendered, existing behaviour unchanged.
- [ ] T016 (FR-003, FR-006, FR-007, FR-009, FR-015) `features/chat/GoalPrewalkMenu.tsx` and the mount in `ComposerModePills.tsx`. Behaviour: items None, Goal, Prewalk; Goal opens the objective dialog (`components/ui/dialog.tsx`); the pill label follows `useGoalStore` and `usePrewalkStore`; pause or resume and exit buttons; Goal disabled in Plan with a tooltip. Tests `GoalPrewalkMenu.test.tsx` and `ComposerModePills.test.tsx`: label from the store only, Plan disables Goal, Prewalk calls `setPrewalk`, exit calls `goal.drop`, a `success:false` reply surfaces through `notify`, accessible names.
- [ ] T017 (FR-009) Prewalk parity: one test proves the pill and the Session menu (`useSessionRowActions.ts`) read the same `usePrewalkStore` state (SC-007). Test in `features/sessions/prewalkActions.test.ts` or the pill test.
- [ ] T018 (FR-012) Session row badge for an active or paused goal (slot found in T004). Test beside that component.
- [ ] T019 (FR-013, P2 priority) `/goal <objective>` in `shared/slash-commands.ts` and `session/agent/commands.rs` `NATIVE_RESERVED_COMMANDS`, handled in `ipc/chat.rs`. Tests `slash-commands.test.ts` and `ipc/chat.test.rs`: parsed and routed to `goal.create`, not sent as text; `/prewalk` unchanged.
- [ ] T020 (FR-014) Guard test that no Vibe or Loop item exists in the picker and the slash list.
- [ ] T021 (FR-015) Accessibility test for the pill: keyboard-only open, move, select and exit; each button has an accessible name; state changes are announced through `role="status"`. Test in `GoalPrewalkMenu.test.tsx`.

## Phase 4: Away, regressions, live proof

- [ ] T022 (FR-010) Test in `session/working_mode/away.test.rs` or `session/goal.test.rs`: a scripted ask and approval frame in an Away Session with a goal active is answered by `away.rs` as without a goal.
- [ ] T023 (SC-006) Run the existing `ModePill`, `WorkingModeMenu`, `prewalk`, `prewalk-store`, `slash-commands`, `process_args` and `away` tests unchanged; fix only regressions this feature caused.
- [ ] T024 (SC-002, SC-003) Live Tauri debug build against a real OMP in a scratch profile (see skill `verify-refract-tauri-build-live` and `refract-tauri-live-check-isolation`): start, pause, resume and drop a goal; Plan disables Goal; the user's global OMP config is byte-identical before and after. Screenshots attached to the PR.
- [ ] T025 (SC-005) `git diff origin/main -- src-tauri/src/session/working_mode/away.rs src-tauri/src/session/working_mode/away.test.rs` is empty.

## Coverage

FR-001 T001, T002, T003, T009 | FR-002 T005, T006 | FR-003 T016 | FR-004 T008, T013 | FR-005 T007, T014 | FR-006 T016 | FR-007 T008, T016 | FR-008 T015 | FR-009 T016, T017 | FR-010 T022, T025 | FR-011 T010, T011 | FR-012 T018 | FR-013 T019 | FR-014 T020 | FR-015 T016, T021.
SC-001 T001 to T003 | SC-002 T024 | SC-003 T024 | SC-004 T008, T016 | SC-005 T022, T025 | SC-006 T023 | SC-007 T017.

## Phase 5: Convergence (2026-11-28, #1865 away-mode grill, FR-009 amended)

- [ ] T026 [US3] (FR-009, missing) In `src-tauri/src/session/prewalk.rs` add a `prewalk_failure(frame_type, frame) -> Option<String>` beside `state_from_frame`: a `command_output` whose text is a reply to `/prewalk` but neither "Prewalk on:", "Prewalk off:" nor "Prewalk already off" returns its text; the caller surfaces it as a notice (the renderer shows it through `notify`) and emits no `armed`. `success` is never read. Tests: new `src-tauri/src/session/prewalk.test.rs` (wired by `#[path]`): unknown-model reply with `success: true` is a failure and not `armed`; armed, off and already-off replies are not failures; an unrelated `command_output` is not a failure. Live check with a real OMP and a bad model name in a scratch profile.

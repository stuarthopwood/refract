# Tasks: Agents list, start and switch Conversations (#1861)

Phase 2 (implementation) is a separate run. Each implementation task has a co-located `*.test.rs` unit test beside the changed module, using the shared test utilities (as in `agent_tools/sessions_end.test.rs`), per `AGENTS.md` (epic #1918). The live scenario list in `plan.md` stays as the end-to-end check.

## Phase A - shared helper

- [x] T001 Add the shared helper `start_conversation_then_send(FirstMessage)` in `src-tauri/src/session/agent/start_with_message.rs` (deviation, see analysis.md); `hand_off()` calls it and keeps the `handoff-send-failed` wording.
- [x] T001t Test in `session/agent/start_with_message.test.rs`: 8 cases covering event order, note flag, failure stages, sidecar key.
- [x] T002 Extract `start_new_core` and `switch_core` into `src-tauri/src/ipc/conversations_core.rs` from the `conversations.startNew` and `conversations.open` arms; keep the IPC handlers as thin callers.
- [x] T002t Test in `ipc/conversations_core.test.rs`: `start_new_core` and `switch_core` cover started, switched, current-reloaded (no `unchanged`, see analysis.md), refused and unknown-id cases.

## Phase B - deferral slot

- [x] T003 Add `session/agent/handoff_queue.rs` with `QueuedHandoff`, `HandoffAction`, `try_queue`, `take_queued_handoff`, `clear`.
- [x] T003t Test in `session/agent/handoff_queue.test.rs`: `try_queue` accepts one action and refuses a second; `take_queued_handoff` empties the slot; `clear` empties it.
- [x] T004 Add the `queued_handoff` field to `AgentState` in `session/agent/mod.rs`.
- [x] T005 In `frame.rs` `handle_turn_settled`, take the slot after the Session is idle and spawn the run task: act, retry once, then the "Handoff failed" notice. (Written, uncompiled: the run is `SessionAgent::run_settled_handoff` in `handoff_queue.rs`, spawned from the settle.)
- [x] T005t Test in `session/agent/frame.test.rs`: settle takes the slot after idle, acts, retries once, then posts the "Handoff failed" notice.
- [x] T006 Clear the slot on `chat.stop` (`chat.rs`), `shutdown`, stop exits and `on_process_exit`; drop it when `turn_abort_requested` is set at settle. (Written, uncompiled: process exit is `handle_exit` in `frame.rs`; there is no `on_process_exit`.)
- [x] T006t Test in `session/agent/handoff_queue.test.rs` (cancellation): the slot is empty after `chat.stop`, `shutdown`, stop exits and `on_process_exit`; a queued action is dropped when `turn_abort_requested` is set at settle.

## Phase C - tools

- [x] T007 Add `agent_tools/sessions_conversations.rs`: arguments, target plan (relationship, state, conversation lookup), `ConvHost` trait, card, post-card re-check, defer or run. (Written, uncompiled.)
- [x] T007t Test in `agent_tools/sessions_conversations.test.rs`: target plan (relationship, state, lookup), fake `ConvHost`, card, post-card re-check, defer or run. (Written, uncompiled.)
- [x] T008 Add `sessions_conversations_schema.rs` and register the three names in `sessions.rs` and `router_native.rs`. (Written, uncompiled; `new_conversation` and `switch_conversation` now run the gate and `dispatch` from `sessions_conversations_flow.rs`.)
- [x] T008t Test in `agent_tools/sessions_conversations_schema.test.rs`: argument schemas and `invalid_input` bounds; registration names in `sessions.test.rs`. (Written, uncompiled.)
- [x] T009 Implement `list_conversations` over `ipc::conversations::list_conversations` with sorting, `limit` and preview clipping. (Written, uncompiled.)
- [x] T009t Test in `agent_tools/sessions_conversations.test.rs`: `list_conversations` sorting, default 20, `limit` 100 and 101, 120-character preview clip. (Written, uncompiled.)
- [x] T010 Wrap another Session's prompt with `envelope::wrap`; launch a Stopped target before the prompt. (`dispatch` in `sessions_conversations.rs`, called by `new_conversation` and `switch_conversation` in `sessions_conversations_flow.rs`; written, uncompiled.)
- [x] T010t Test in `agent_tools/sessions_conversations.test.rs`: foreign prompt is wrapped by `envelope::wrap`; a Stopped target launches before the prompt. (Through `dispatch` and the new/switch flow tests; written, uncompiled.)

## Phase D - UI and storage

- [x] T011 Event `session:conversation-changed` (Rust `SESSION_CONVERSATION_CHANGED`, deviation, see analysis.md) in `events.rs`, emitted after a started or switched Conversation (`start_conversation_then_send`, the tool switch, the queued handoff run); the renderer listener `state/conversation-changed.ts` drops the old Conversation's scroll memory and leaves the draft alone.
- [x] T011t Test in `events.rs` (`conversation_changed_event_name_and_payload_are_exact`); renderer listener test `state/conversation-changed.test.ts`.
- [x] T012 Handoff-note store (deviation, see analysis.md): the existing sidecar `store/handoff_notes.rs` stays, no registry list; the first bubble is labelled by `HandoffNoteLine` (shared `SourceTag`) in `UserMessageRow`.
- [x] T012t Tests in `store/handoff_notes.test.rs` (a missing or unreadable file reads empty, keys are file names, records accumulate) and `HandoffNoteLine.test.ts`.

## Phase E - docs and check

- [x] T013 Update `CONTEXT.md` terms and the `docs/PLAN.md` row.
- [ ] T014 Run the 15 scenarios in `plan.md` with the fake omp; keep the evidence in scratch `evidence/`.

Order: T001, T002 first; T003-T006 and T007-T010 can follow in parallel after T001-T002; T011-T012 after T005; T013-T014 last.

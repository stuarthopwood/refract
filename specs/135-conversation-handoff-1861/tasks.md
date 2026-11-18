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
- [ ] T005 In `frame.rs` `handle_turn_settled`, take the slot after the Session is idle and spawn the run task: act, retry once, then the "Handoff failed" notice.
- [ ] T005t Test in `session/agent/frame.test.rs`: settle takes the slot after idle, acts, retries once, then posts the "Handoff failed" notice.
- [ ] T006 Clear the slot on `chat.stop` (`chat.rs`), `shutdown`, stop exits and `on_process_exit`; drop it when `turn_abort_requested` is set at settle.
- [ ] T006t Test in `session/agent/handoff_queue.test.rs` (cancellation): the slot is empty after `chat.stop`, `shutdown`, stop exits and `on_process_exit`; a queued action is dropped when `turn_abort_requested` is set at settle.

## Phase C - tools

- [ ] T007 Add `agent_tools/sessions_conversations.rs`: arguments, target plan (relationship, state, conversation lookup), `ConvHost` trait, card, post-card re-check, defer or run.
- [ ] T007t Test in `agent_tools/sessions_conversations.test.rs`: target plan (relationship, state, lookup), fake `ConvHost`, card, post-card re-check, defer or run.
- [ ] T008 Add `sessions_conversations_schema.rs` and register the three names in `sessions.rs` and `router_native.rs`.
- [ ] T008t Test in `agent_tools/sessions_conversations_schema.test.rs`: argument schemas and `invalid_input` bounds; registration names in `sessions.test.rs`.
- [ ] T009 Implement `list_conversations` over `ipc::conversations::list_conversations` with sorting, `limit` and preview clipping.
- [ ] T009t Test in `agent_tools/sessions_conversations.test.rs`: `list_conversations` sorting, default 20, `limit` 100 and 101, 120-character preview clip.
- [ ] T010 Wrap another Session's prompt with `envelope::wrap`; launch a Stopped target before the prompt.
- [ ] T010t Test in `agent_tools/sessions_conversations.test.rs`: foreign prompt is wrapped by `envelope::wrap`; a Stopped target launches before the prompt.

## Phase D - UI and storage

- [ ] T011 Add `SESSION_CONVERSATION_SWITCHED` to `events.rs`, emit it after a started or switched Conversation, and listen in the renderer to reload panes and keep the draft.
- [ ] T011t Test in `events.test.rs` (or the nearest existing test file) for the event payload, and a renderer listener test beside the listener file.
- [ ] T012 Add the handoff-note list to the registry `Session` (`#[serde(default)]`) and label the first bubble through the shared chat-bubble component.
- [ ] T012t Test in `store/registry.test.rs`: a registry file without the handoff-note list loads with an empty list (`serde(default)`); renderer bubble-label test beside the component.

## Phase E - docs and check

- [ ] T013 Update `CONTEXT.md` terms and the `docs/PLAN.md` row.
- [ ] T014 Run the 15 scenarios in `plan.md` with the fake omp; keep the evidence in scratch `evidence/`.

Order: T001, T002 first; T003-T006 and T007-T010 can follow in parallel after T001-T002; T011-T012 after T005; T013-T014 last.

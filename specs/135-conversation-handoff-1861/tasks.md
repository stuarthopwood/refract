# Tasks: Agents list, start and switch Conversations (#1861)

Phase 2 (implementation) is a separate run. No new tests; the check is the live scenario list in `plan.md`.

## Phase A - shared helper

- [ ] T001 Add `start_conversation_with(first_message)` in `src-tauri/src/session/agent/handoff.rs`; move `hand_off()` lines 51-65 onto it, keeping the `handoff-send-failed` wording.
- [ ] T002 Extract `start_new_core` and `switch_core` into `src-tauri/src/ipc/conversations_core.rs` from the `conversations.startNew` and `conversations.open` arms; keep the IPC handlers as thin callers.

## Phase B - deferral slot

- [ ] T003 Add `session/agent/handoff_queue.rs` with `QueuedHandoff`, `HandoffAction`, `try_queue`, `take_queued_handoff`, `clear`.
- [ ] T004 Add the `queued_handoff` field to `AgentState` in `session/agent/mod.rs`.
- [ ] T005 In `frame.rs` `handle_turn_settled`, take the slot after the Session is idle and spawn the run task: act, retry once, then the "Handoff failed" notice.
- [ ] T006 Clear the slot on `chat.stop` (`chat.rs`), `shutdown`, stop exits and `on_process_exit`; drop it when `turn_abort_requested` is set at settle.

## Phase C - tools

- [ ] T007 Add `agent_tools/sessions_conversations.rs`: arguments, target plan (relationship, state, conversation lookup), `ConvHost` trait, card, post-card re-check, defer or run.
- [ ] T008 Add `sessions_conversations_schema.rs` and register the three names in `sessions.rs` and `router_native.rs`.
- [ ] T009 Implement `list_conversations` over `ipc::conversations::list_conversations` with sorting, `limit` and preview clipping.
- [ ] T010 Wrap another Session's prompt with `envelope::wrap`; launch a Stopped target before the prompt.

## Phase D - UI and storage

- [ ] T011 Add `SESSION_CONVERSATION_SWITCHED` to `events.rs`, emit it after a started or switched Conversation, and listen in the renderer to reload panes and keep the draft.
- [ ] T012 Add the handoff-note list to the registry `Session` (`#[serde(default)]`) and label the first bubble through the shared chat-bubble component.

## Phase E - docs and check

- [ ] T013 Update `CONTEXT.md` terms and the `docs/PLAN.md` row.
- [ ] T014 Run the 15 scenarios in `plan.md` with the fake omp; keep the evidence in scratch `evidence/`.

Order: T001, T002 first; T003-T006 and T007-T010 can follow in parallel after T001-T002; T011-T012 after T005; T013-T014 last.

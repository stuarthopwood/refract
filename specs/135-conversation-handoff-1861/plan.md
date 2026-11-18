# Implementation Plan: Agents list, start and switch Conversations

**Spec**: `specs/135-conversation-handoff-1861/spec.md`  **Issue**: #1861  **Branch**: `feat/agent-conversation-handoff`

## Summary

Add three Host tools in `src-tauri/src/agent_tools/` using the module shape #1858, #1859 and #1860 landed. Extract `start_conversation_with` in the agent's `handoff.rs`. Add one deferral slot per agent, filled by a tool call and drained when the turn settles. Add one backend event for pane switching. Rust and a small renderer change; no new dependency.

## Reused patterns (file:line, on `origin/main` 6f3a93c9)

| Need | Reuse | Where |
|---|---|---|
| Tool names and registration | `SESSION_TOOLS` list; native dispatch | `agent_tools/sessions.rs:17-26`; `agent_tools/router_native.rs:15-29`; `agent_tools/mod.rs:24` (`TOOL_PREFIX`) |
| Argument checks, unknown-key refusal | `parse_args`, `panels::validate_keys` | `agent_tools/sessions_end.rs:80-106` |
| Error codes | `INVALID_INPUT`, `DENIED`, `CANCELLED`; `NOT_FOUND`; `INVALID_TARGET`; `INVALID_STATE`; `SESSION_NOT_RUNNING` | `router.rs:19-27`; `sessions.rs`; `sessions_send.rs:15-16`; `sessions_end.rs:19` |
| Ancestor and same-Project rules | `ancestors_of`, `refuse_target` (copy the order, not the self-refusal) | `sessions_end.rs:108-165` |
| Descendants | `descendants` | `store/session_tree.rs` (imported at `sessions_end_tools.rs:19`) |
| Card, label, flatten, clip | `session_card`, `clip_line`, `labels_for`, `card_for` shape | `approval.rs:56-94`; `sessions_end.rs:177-265` |
| Card needed or not | `needs_card` pattern | `sessions_end.rs:167-175` |
| Host trait with a fake for tests | `EndHost` / `AppEndHost`, `ask`, `is_yolo` | `sessions_end.rs:267-383` |
| Check order, post-card re-check | `plan_for`, `run_with` | `sessions_end_tools.rs:1-3`, `:74`, `:315-351` |
| Envelope for another Session | `envelope::wrap(sender, from, text)` | `envelope.rs:20-27`; call site `sessions_send.rs:171-186` |
| Own tool accessors | `tool_manager`, `tool_session_id`, `tool_is_yolo`, `tool_router` | `session/agent/tool_host.rs:20-59` |
| Registry action cores shared with IPC | `archive_core`, `stop_core` precedent | `sessions_end.rs:403-417` |
| Conversation start and open | `start_new_conversation`, `open_conversation`, `start_with_conversation` | `session/agent/conversations.rs:24-27`, `:101`; `session/agent/launch.rs:154` |
| Listing | `list_conversations`, `ConversationInfo` (`pub(crate)`) | `ipc/conversations.rs:18-25`, `:275` |
| Snapshot after a switch | `build_snapshot` | `ipc/conversations.rs:27`, `:419` |
| Turn parity and settle | `turn_generation` odd mid-turn; `handle_turn_settled` | `session/agent/frame.rs:22-27`, `:188` |
| Abort flag | `turn_abort_requested` | `session/agent/mod.rs:78`; `chat.rs:149-197` |
| Status watch | `status_tx` | `session/agent/mod.rs:107` |
| Event constant and emit | `SIDE_CHAT_CONVERSATION_CHANGED` | `events.rs:37`, `:349-352` |
| Summary handoff to rewire | `hand_off()` lines 51-65 | `session/agent/handoff.rs:22-67` |

## Design

### New files

- `agent_tools/sessions_conversations.rs`: `ConvTool` enum, `parse_args`, target plan, `ConvHost` trait (like `EndHost`), run functions.
- `agent_tools/sessions_conversations_schema.rs`: the three tool schemas (mirrors `sessions_end_schema.rs`).
- `session/agent/handoff_queue.rs`: the deferral slot (below).
- `ipc/conversations_core.rs`: `start_new_core(state, id)` and `switch_core(state, id, file)`, extracted from the `conversations.startNew` and `conversations.open` arms (`ipc/conversations.rs`, handlers near `:395-421`) so the tool and the IPC handler share one path, as `archive_core` does.

### Target plan (order of checks)

1. Arguments: unknown key, wrong type, empty `prompt` or over 32 KiB, `limit` outside 1..=100: `invalid_input`.
2. Resolve `session_id` (default: caller). Unknown id or another Project: `not_found`.
3. Relationship from ids alone: `Own`, `Descendant`, `Sibling` (same Project, neither). Ancestor: `invalid_target`. Personal Agent that is not the caller: `invalid_target`.
4. State: archived or `is_deleting`: `invalid_state`; paused (`agent.is_paused()`, `pause.rs:180`): `invalid_state` ("Session is paused; resume it first"). Not for `list_conversations`, which reads in any state.
5. `switch_conversation`: the `conversation_id` must be in `list_conversations(target)`; otherwise `not_found`. The current one returns `unchanged`.
6. Card when the relationship is `Sibling` and the caller is not in `yolo`. `Own` and `Descendant` raise none. Card via `session_card` with the id first, the relationship line, and the first line of the prompt (all clipped). Denied: `denied`; closed: `cancelled`.
7. Re-run steps 2-5 after the card (the tree and state can move while it is open); a change returns `invalid_state`. No tree gate is needed: the action changes no tree link.
8. If the target is mid-turn (`turn_generation` odd, status Working or NeedsYou): queue and return `scheduled`. Otherwise run now.

### Deferral state

- **Where**: `AgentState` (`session/agent/mod.rs:58`) gains `queued_handoff: Option<QueuedHandoff>`; the type and its methods live in `handoff_queue.rs` (the `with_<lane>_state` convention at `mod.rs:79`). It lives on the target Session's agent, so a sibling target holds its own slot.
- **Shape**: `QueuedHandoff { generation: u64, action: HandoffAction, sender: Option<(String, String)> }`, with `HandoffAction::{New { prompt }, Switch { file }}`. `generation` is the `turn_generation` at queue time. `sender` is the `(name, id)` for the envelope; it is `None` for a self-handoff.
- **Queue**: `try_queue` fails with `invalid_state` ("a handoff is already queued for this turn") when the slot is full. It runs under the agent's state lock, so two calls cannot both succeed.
- **Observe the settle**: `handle_turn_settled` (`frame.rs:188`) is where a settled turn is seen. After it sets the Session idle, it takes the slot with `take_queued_handoff(generation)` and spawns one task (`tokio::spawn`; the handler must not wait on `start_new_conversation`, which needs `idle`). The task checks status is Idle and the generation is even; if a follow-up turn already started (assumption A3), it puts the action back. No polling loop; this is why it does not copy `wait_for_settle_after` (`handoff.rs:70`).
- **Cancel**: the slot is cleared in these places: the `chat.stop` path that sets `turn_abort_requested` (`chat.rs:149`), `shutdown` and `set_stopped_unless_already_stopped` (the stop exits in `frame.rs`/`mod.rs`), and `on_process_exit`. `handle_turn_settled` also drops the action when `turn_abort_requested` is still set when the settled frame arrives, so a settled frame for an aborted turn does not run it.
- **Run**: the task calls `start_conversation_with(prompt)` or `open_conversation(file)` (`conversations.rs:101`). On error it retries once. On a second failure it appends an error notice "Handoff failed: <reason>" with `append_notice` (the same call the frame handler uses for notices) and leaves the old Conversation current.
- **After a success**: emit the new event (below) and mark the Conversation as a handoff note (A4).

### `start_conversation_with`

In `handoff.rs`, add `pub async fn start_conversation_with(&self, first_message: String) -> Result<(), AgentError>`: `start_new_conversation()` then `send(first_message, None)`, returning the send error unchanged. `hand_off()` calls it with the summary text and keeps its `handoff-send-failed` wrapping at lines 57-65. The tool path passes the raw prompt (self) or the enveloped prompt (other Session). A stopped target is launched first (A5).

### First message and marker

- Self: raw prompt, plus the Conversation's file name added to the Session's handoff-note list (A4). The renderer reads the list and labels the first user bubble "Handoff note from the previous Conversation" (muted). Build the label from the existing shared chat-bubble component in `src/renderer/components/`; extend it, do not copy.
- Other Session: `envelope::wrap(caller name, caller id, prompt)` as at `sessions_send.rs:177`; the existing envelope bubble already renders it.

### Event and renderer

- `events.rs`: add `SESSION_CONVERSATION_SWITCHED = "session:conversation-switched"`, payload `{ sessionId, conversationId }`, emitted next to `events.rs:349-352`'s pattern.
- Renderer: every pane that shows `sessionId` reloads from the snapshot (`build_snapshot`, `ipc/conversations.rs:27`) and keeps its composer draft. The Conversation switcher already marks the current row.

### Tool results

- `list_conversations`: `{ session_id, conversations: [{ id, title, createdAt, isCurrent, preview }] }`, newest first. Preview clipped to 120 characters with `clip_line`-style flattening.
- `new_conversation`: `{ outcome: "started" | "scheduled", id }`. `scheduled` carries the text "scheduled: starts when this turn ends".
- `switch_conversation`: `{ outcome: "switched" | "unchanged" | "scheduled", id, conversation_id }`.

## Files expected to change

`agent_tools/{mod,router_native,sessions,sessions_conversations,sessions_conversations_schema}.rs`, `session/agent/{mod,frame,chat,handoff,handoff_queue,conversations}.rs`, `ipc/{conversations,conversations_core}.rs`, `store/registry.rs` (handoff-note list, `serde(default)`), `events.rs`, a renderer listener and bubble label, `CONTEXT.md`, `docs/PLAN.md`.

## Verification (live, fake omp, no new tests)

Run the fake-omp harness used by specs 129, 131 and 134 (see `specs/134-session-end-tools-1860/plan.md`). Scenarios:

1. List: 25 Conversations, default page is 20 newest first; `limit: 100` returns all; `limit: 101` is `invalid_input`.
2. List another Project's Session: `not_found`. List a Session in the same Project: works, no card.
3. Self `new_conversation` mid-turn: returns `scheduled`; after settle a new Conversation exists with the unchanged prompt and the handoff label; panes moved; draft kept.
4. Second self-call in the same turn: `invalid_state`.
5. Stop the turn while queued: nothing happens; the slot is empty.
6. Stop the Session while queued: nothing happens.
7. Self `switch_conversation` mid-turn: `scheduled`, then switched; to the current Conversation: `unchanged`; to a foreign id: `not_found`.
8. Deferred start where the fake omp refuses `new_session` once: retry succeeds. Refuses twice: old Conversation stays current and "Handoff failed" shows; the next agent turn sees the notice.
9. Descendant target, no card; sibling target, card (approve, deny, close); sibling with `yolo`, no card.
10. Ancestor target and Personal Agent from another Session: `invalid_target`. The Personal Agent targeting itself: allowed.
11. Paused, archived and deleting targets: `invalid_state`. Stopped sibling: launched on the new or chosen Conversation.
12. Sibling mid-turn, card approved: `scheduled`, runs on that turn's settle with the envelope wrapper; stop that turn: dropped.
13. Target archived while the card is open: `invalid_state`.
14. `/new` summary handoff (#1212) after the extraction: same Conversation start and same `handoff-send-failed` wording.
15. A card line with a bidi or newline name is flattened.

Record the harness output and screenshots under the task scratch `evidence/`; the implementation PR cites them.

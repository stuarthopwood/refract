# Feature Specification: Agents list, start and switch Conversations

**Feature Branch**: `feat/agent-conversation-handoff`
**Created**: 2026-11-18
**Status**: Clarified
**Input**: GitHub issue #1861 (P0 Agent Sessions slice 5 of 6, child of #1304). Builds on spec 124 (tool channel, #1193), spec 129 (read tools, #1858), spec 131 (create and nest, #1859), spec 134 (end tools, #1860) and the #1212 summary handoff. Overlaps #1827 (`/new <prompt>`), which reuses the helper this slice extracts. Route: specify (grill done with Stuart on 2026-11-17 and 2026-11-18).

## Clarifications

### Session 2026-11-18

Stuart's 2026-11-18 (Wave 5) comment is the latest word. Where it differs from the 2026-11-17 grill, the 2026-11-18 text wins.

- Q: Is a mid-turn target refused or deferred? -> A: Decided (Stuart, 2026-11-18): any target that is mid-turn, including the caller's own Session, is deferred. The tool returns `scheduled` at once and Refract runs the action when that turn settles. This replaces the 2026-11-17 rule that refused a Working or needs-you target with `invalid_state`. There is no `session-busy` error and no abort.
- Q: What cancels a deferred action? -> A: Decided (Stuart, 2026-11-17 and 2026-11-18): the user stopping the turn, or the Session stopping, drops it.
- Q: How many deferred actions may a Session hold? -> A: Decided (Stuart, 2026-11-17): one. A second `new_conversation` or `switch_conversation` for the same Session while one is queued returns `invalid_state` ("a handoff is already queued for this turn").
- Q: What if the deferred action fails? -> A: Decided (Stuart, 2026-11-17): Refract retries once. If the retry fails, the old Conversation stays current and gets an error notice "Handoff failed: <reason>". The agent sees the notice on its next turn.
- Q: Which targets are allowed? -> A: Decided (Stuart, 2026-11-17): the caller itself (including the Personal Agent) and its descendants need no card. Other Sessions in the same Project need a card; `yolo` skips it. Ancestors, and the Personal Agent called from another Session, return `invalid_target`. A Session in another Project, or an unknown id, returns `not_found`. `list_conversations` only reads, never raises a card, and follows the same Project rule.
- Q: Which target states are allowed? -> A: Decided (Stuart, 2026-11-17): Stopped is allowed; Refract launches the Session on the new or chosen Conversation, as the UI does. Paused returns `invalid_state` ("Session is paused; resume it first"). Archived or being deleted returns `invalid_state`. Mid-turn is deferred (see above).
- Q: What does the first message look like? -> A: Decided (Stuart, 2026-11-17): for a self-handoff, the raw prompt is sent unchanged and Refract records outside the text that it is a handoff note; the transcript shows a muted "Handoff note from the previous Conversation" label. For another Session, the prompt is wrapped in the ADR 0008 `<session-message>` envelope.
- Q: Which shared helper? -> A: Decided (Stuart, 2026-11-18): extract `start_conversation_with(prompt)` from `src-tauri/src/session/agent/handoff.rs:51-65` and move `hand_off()` onto it. #1827 reuses it later.
- Q: What does the UI do? -> A: Decided (Stuart, 2026-11-17): a new backend event moves every pane that shows the Session to the new or switched Conversation and keeps the unsent composer draft. No toast. The Conversation switcher marks the current one. Nothing extra shows while a self-handoff is queued.
- Q: What does `list_conversations` return? -> A: Decided (Stuart, 2026-11-17): newest first; each row has `id`, `title`, `createdAt`, `isCurrent` and a preview clipped to 120 characters; default page 20, optional `limit` up to 100.
- Q: Does `switch_conversation` to the current Conversation fail? -> A: Decided (Stuart, 2026-11-17): it succeeds and changes nothing. A Conversation the Session does not own returns `not_found`.
- Q: Tests? -> A: Decided (Main, 2026-11-18, after `AGENTS.md` line 36 on `origin/main`, epic #1918): co-located `*.test.rs` unit tests beside each changed module using the shared test utilities, plus the live fake-omp harness check. This replaces the earlier "no new tests" note.

### Assumptions (chosen conservatively, not settled by the grill)

- A1: A needs-you turn (waiting on an approval or question) counts as mid-turn, so it defers like a Working turn.
- A2: The deferred action is held in memory only. It does not survive a Refract restart.
- A3: If a user follow-up starts a new turn right after the settle, the deferred action waits for the next settle that leaves the Session idle.
- A4: The "handoff note" marker for a self-handoff is a per-Session list of Conversation files, stored with `#[serde(default)]` like #1859's `parent_session_id`, so it survives reload.
- A5: A stopped target given `new_conversation` is launched first and then receives the prompt; the exact IPC core to reuse is confirmed during implementation.
- A6: Tool results use the codes of specs 124, 129, 131 and 134; this slice adds no new code.
- A7: The three tools are registered for the same roles and depths as the other Session tools.

## Problem

An agent that has finished a stretch of work, or hit a long context, cannot start fresh in the same worktree on its own. The developer must type `/new` or open the switcher. Agents also cannot see which Conversations a Session has, or hand a task to a fresh Conversation in a sibling Session. This slice adds three **Host tools**: `refract_list_conversations`, `refract_new_conversation` and `refract_switch_conversation`.

## User Scenarios & Testing

### User Story 1 - Hand over to a fresh Conversation (Priority: P1)

An agent summarises its work and calls `new_conversation(prompt)` on its own Session. The tool returns `scheduled` at once. When the turn ends, Refract starts a fresh Conversation in the same Session (same worktree and branch), sends the prompt as the first message, and moves the panes to it.

**Independent Test**: With the fake omp, call the tool mid-turn, then settle the turn; the registry shows a second Conversation, the prompt is its first user message with the handoff label, and the panes follow.

**Acceptance Scenarios**:

1. **Given** the agent is mid-turn, **When** it calls `new_conversation(prompt)` for its own Session, **Then** the call returns `scheduled` and no Conversation exists yet.
2. **Given** a queued handoff, **When** the turn settles, **Then** the new Conversation starts, receives the unchanged prompt, and the panes switch.
3. **Given** a queued handoff, **When** the user stops the turn, **Then** the handoff is dropped and the Conversation stays.
4. **Given** a queued handoff, **When** the agent calls `new_conversation` or `switch_conversation` again, **Then** it gets `invalid_state`.
5. **Given** the deferred start fails twice, **When** the retry fails, **Then** the old Conversation stays current and shows "Handoff failed: <reason>".

### User Story 2 - List and switch Conversations (Priority: P1)

An agent lists its Session's Conversations and switches back to an earlier one.

**Acceptance Scenarios**:

1. **Given** a Session with 25 Conversations, **When** the agent lists with no `limit`, **Then** it gets 20, newest first, with `isCurrent` set on one.
2. **Given** a `conversation_id` the Session owns, **When** the agent calls `switch_conversation`, **Then** that Conversation becomes current (deferred when mid-turn).
3. **Given** the id of the current Conversation, **When** the agent switches to it, **Then** the call succeeds with `unchanged`.
4. **Given** an id from another Session, **When** the agent switches, **Then** it gets `not_found`.

### User Story 3 - Hand a task to another Session (Priority: P2)

An agent starts a fresh Conversation in a sibling Session with a briefing. A card names the target; `yolo` skips it. The briefing arrives inside the `<session-message>` envelope.

**Acceptance Scenarios**:

1. **Given** a sibling Session in the same Project, **When** the agent calls `new_conversation(prompt, session_id)`, **Then** a card is raised unless the caller is in `yolo`.
2. **Given** a descendant target, **When** the agent calls the tool, **Then** no card is raised.
3. **Given** the developer denies the card, **When** the call resolves, **Then** it returns `denied` and nothing changes.
4. **Given** the target is mid-turn and the card is approved, **When** the call resolves, **Then** it returns `scheduled` and the action runs when the target's turn settles.
5. **Given** the target is Stopped, **When** the agent calls the tool, **Then** Refract launches it on the new or chosen Conversation.
6. **Given** an ancestor, a Personal Agent seen from another Session, a paused, archived or deleting Session, **When** the agent calls the tool, **Then** it gets `invalid_target` or `invalid_state` as the table in the plan states.

### Edge Cases

- The target is deleted or archived while the card is open: the post-card re-check returns `invalid_state`.
- The caller's Session stops while its own handoff is queued: the handoff is dropped.
- A deferred action for another Session whose turn never ends is not run; it stays queued until the turn settles or the Session stops.
- `prompt` empty or over the size limit of `send_session_message` (32 KiB, `sessions_send.rs:18`): `invalid_input`.

## Requirements

### Functional Requirements

- **FR-001**: Three Host tools MUST exist: `refract_list_conversations(session_id?, limit?)`, `refract_new_conversation(prompt, session_id?)`, `refract_switch_conversation(session_id, conversation_id)`. A missing `session_id` means the caller's Session for the first two.
- **FR-002**: Target rules, states, approval, first message, deferral and result shapes MUST follow the Clarifications above.
- **FR-003**: `start_conversation_with(prompt)` MUST be the single path that starts a Conversation and sends its first message; `hand_off()` MUST use it.
- **FR-004**: A deferred action MUST be held per target Session, hold at most one action, and be dropped on stop, abort and shutdown.
- **FR-005**: Every refusal MUST be a tool error with a code from the shared vocabulary. No toast.
- **FR-006**: A backend event MUST tell panes which Session moved to which Conversation; the renderer keeps the composer draft.
- **FR-007**: Card text MUST be flattened and clipped with the #1860 helpers so an agent-chosen name or prompt cannot hide the action.

### Key Entities

- **Conversation**: see `CONTEXT.md`.
- **Handoff note**: the first message of a Conversation that an agent started on its own Session.
- **Queued handoff**: an action held until its target's turn settles.

## Success Criteria

- **SC-001**: Each live scenario in `plan.md` passes with the fake omp.
- **SC-002**: `hand_off()` behaves as before the extraction (the #1212 live path).
- **SC-003**: No refusal raises a toast.

## Out of Scope

- `/new <prompt>` (#1827) beyond reusing the helper.
- Deleting or renaming Conversations.
- Persisting a queued handoff across a restart.
- The Session list tree UI (#1862).

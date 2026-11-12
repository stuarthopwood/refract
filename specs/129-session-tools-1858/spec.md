# Feature Specification: Agent Session read tools and messaging

**Feature Branch**: `feat/1858-session-tools`
**Created**: 2026-11-12
**Status**: Draft
**Input**: GitHub issue #1858 (P0 Agent Sessions slice 2 of 6, child of #1304; builds on #1193 / spec 124) plus the grill with Stuart on 2026-11-12 (https://github.com/stuarthopwood/refract/issues/1858#issuecomment-6824335538). Route: specify.

## Problem

An agent in Refract can only see its own Session. It cannot find out which other Sessions exist, whether one is busy, stuck or finished, or hand one a message. Slices 3-6 of #1304 (create and nest Sessions, archive/stop, Conversation handoff, tree UI) all need an agent that can read across Sessions and talk to them.

This slice adds three **Host tools** on the #1193 **Tool channel** that reach every Session in the app: one to list Sessions, one to read a Session's status, and one to send a message to a Session. A message arrives in the target as a user turn that is visibly and structurally labelled as coming from another Session, so a Session's text is never mistaken for Stuart's own instruction or an approval.

## Decisions

### Decided (Stuart, 2026-11-12, grill)

1. **Target not running.** If the target Session is Stopped or Archived, `send_session_message` returns the `session_not_running` tool error and includes the target's status. It never starts a Session (starting belongs to the stop and resume slice, #1860). A Paused target holds the message through the existing pause hold. A busy target (Working or Needs-you) queues it as an OMP `followUp`, which is the next turn boundary.
2. **Status vocabulary.** `status` is one of `working`, `waiting-for-approval`, `idle`, `paused`, or `stopped`. A `stopped` status adds `stopReason` (`not-started`, `agent-exited`, `start-failed`, `worktree-missing`, or `stopped-on-request`). An error is reported as `stopped` with a failure reason. No `Error` variant is added to `SessionStatus`.
3. **PR.** If the target Session is running, use its readout cache. Otherwise make one on-demand `pull_request_for_branch` call, which keeps its existing backoff. The result is `{number, url}` or `null`. Only `get_session_status` looks up PRs, never `list_sessions`.
4. **Labelling.** Refract wraps the text in a fixed envelope, `<session-message from="<name>" session="<id>">…</session-message>`, and escapes any envelope tags inside the text. The transcript parser recognises the envelope on load and sets a `source` on the `TranscriptItem::User` item, so the label survives reloads because omp's session file is the source of truth. A Session message never resolves an approval card. ADR 0008 records this.
5. **Access.** Only the Root row of `tools_for` gets the three tools. The Child row stays empty; #1859 decides what Child Sessions get.
6. **`list_sessions`.** `project` matches a Project id or a Project name, case-insensitive; an unknown value returns a tool error. Each row is `{id, name, project:{id,name}, branch, status, archived, lastActivityAt}`, and the caller's own row adds `self:true`. Hidden Sessions are included with `hidden:true`. Archived Sessions appear only when `include_archived` is true. Rows carry no PR.
7. **`send_session_message` edges.** A message to the caller's own Session returns `invalid_target`. Empty text, or text over 32 KB, returns `invalid_input`. An unknown id returns `not_found`. On success the tool returns `{outcome: "sent" | "queued" | "held"}`.
8. **Loop guard.** Each sender-to-target pair can send at most 10 messages per rolling 10 minutes. Further sends return `rate_limited`. The counter lives in memory in `agent_tools/sessions.rs`.
9. **Transcript UI.** A User turn whose source is another Session shows a muted "From Session <name>" line above the bubble, built from shared components (ADR 0003). The Session name is a link that switches to the sender Session without moving keyboard focus unexpectedly. If the sender Session has been deleted, the line shows its id as plain text.

Tool errors follow the #1193 shape: `isError: true` with a `{error:{code,message}}` body, never toasts. The tools live in the new `src-tauri/src/agent_tools/sessions.rs` module to stay under the 600-line cap.

### Reused from spec 124 (not reopened)

- Host tools register per launch with `set_host_tools`, `loadMode: "essential"`, `refract_` prefix, and a `tools.approval` overlay set to `allow` so OMP never prompts for them.
- Rust checks every call against the Session id that owns the RPC stream, never a tool argument. `sessionId` in arguments is ignored.
- `tools_for(access)` is the one access table (Root row populated, Child row empty).
- Failures reach omp as `host_tool_result` with `isError: true` and a JSON text body `{ "error": code, "message": text }`; the renderer shows no toast. Results are capped at 8 KiB.
- Approval policy is `needs_approval(mutates, yolo)`. None of these tools mutate files or Session lifecycle, so none raises the card in any mode (FR-009).

### Open questions put to clarify

- [NEEDS CLARIFICATION: Tool names. The issue writes `list_sessions`, `get_session_status`, `send_session_message`; spec 124 decision 2 says Host tools carry the `refract_` prefix.]
- [NEEDS CLARIFICATION: Size. A `list_sessions` result can exceed the 8 KiB result cap when there are many Sessions; spec 124 turns oversize into `result_too_large`.]
- [NEEDS CLARIFICATION: Source of `stopped-on-request`. The grill lists it as a stop reason, but the code keeps it only as registry fields (`stopped_on_request_*`), not as an in-memory stop reason string.]

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent finds the other Sessions (Priority: P1)

An agent calls `list_sessions` and sees which Sessions exist across Projects, which is busy, and which one is itself.

**Why this priority**: every other tool needs an id, and this is where ids come from.

**Independent Test**: fake-omp tape calls `list_sessions` with and without `project` and `include_archived`; assert row shape, the `self` marker, hidden and archived handling.

**Acceptance Scenarios**:

1. **Given** Sessions in two Projects, **When** the agent calls `list_sessions` with no arguments, **Then** it receives every non-archived Session, hidden ones with `hidden: true`, and its own row with `self: true`.
2. **Given** an archived Session, **When** `include_archived` is absent or false, **Then** the Session is not listed; **When** it is true, **Then** it is listed with `archived: true`.
3. **Given** `project` set to a Project's name in any letter case, or to its id, **When** the tool runs, **Then** only that Project's Sessions are returned.
4. **Given** `project` that matches no Project id or name, **When** the tool runs, **Then** the result is a tool error with code `unknown_project`.
5. **Given** any call, **Then** no row carries a pull request and the tool starts no PR lookup.

### User Story 2 - The agent reads one Session's status (Priority: P1)

`get_session_status(id)` returns status, branch, PR if any, and last activity for any Session.

**Independent Test**: tape calls it for a Working, an Idle, a Paused, a Stopped and an Archived target.

**Acceptance Scenarios**:

1. **Given** a running Session, **When** the tool runs, **Then** the result is `{id, name, project, status, archived, hidden, branch, pullRequest, lastActivityAt}` with `status` from the five-value vocabulary and the PR taken from that Session's readout cache.
2. **Given** a Session with no live process, **When** the tool runs, **Then** `status` is `stopped` with a `stopReason`, and `pullRequest` comes from one on-demand lookup that keeps the existing backoff.
3. **Given** a Session that needs approval, **Then** `status` is `waiting-for-approval`; a paused Session is `paused`.
4. **Given** a Session whose Worktree is missing or whose agent exited or failed to start, **Then** `status` is `stopped` with `worktree-missing`, `agent-exited` or `start-failed`.
5. **Given** an unknown id, **Then** the result is the tool error `not_found`.

### User Story 3 - The agent messages another Session (Priority: P1)

`send_session_message(id, text)` delivers `text` to the target as a labelled user turn.

**Independent Test**: tape sends to an Idle, a Working, a Paused and a Stopped target; assert outcome, that the target's `prompt` frame carries the envelope, and that a reload shows the label.

**Acceptance Scenarios**:

1. **Given** an Idle target, **When** the agent sends, **Then** the result is `{outcome: "sent"}` and the target receives one user turn whose text is the envelope with the sender's name and id.
2. **Given** a Working or Needs-you target, **Then** the result is `{outcome: "queued"}` and the text is delivered as an OMP `followUp` at the next turn boundary.
3. **Given** a Paused target, **Then** the result is `{outcome: "held"}` and the message waits in the pause hold until Resume.
4. **Given** a Stopped or Archived target, **Then** the result is the tool error `session_not_running` carrying the target's status, and no Session is started.
5. **Given** the target's own id, **Then** `invalid_target`; empty text or over 32 KB, `invalid_input`; unknown id, `not_found`.
6. **Given** text that contains `</session-message>` or another envelope tag, **Then** the tags are escaped so the text cannot close or forge an envelope.
7. **Given** a Session message arrives while the target has an approval card open, **Then** the card stays pending; the message never answers it.
8. **Given** the 11th send from one sender to one target inside 10 minutes, **Then** `rate_limited`; a different target, or the same pair after the window, is unaffected.

### User Story 4 - Stuart can tell who said it (Priority: P1)

In the target's transcript, the message shows as a user turn with a muted "From Session <name>" line above it. The name links back to the sender.

**Independent Test**: unit tests for the parser and the row; live check that the label shows after a reload.

**Acceptance Scenarios**:

1. **Given** a Session message in the transcript, **Then** the turn shows "From Session <name>" above the bubble and the bubble shows only the message body, not the envelope.
2. **Given** the app restarts or the Session reloads, **Then** the label is still there, because it is derived from omp's session file.
3. **Given** the sender still exists, **When** Stuart activates the name, **Then** the front Session switches to the sender and focus is not moved to any other surprising place; it is a real link-like control reachable by keyboard.
4. **Given** the sender was deleted, **Then** the line shows the sender id as plain text, not a link.
5. **Given** a user turn that merely mentions an envelope in the middle of its text, **Then** it is not treated as a Session message.

### User Story 5 - Only Root Sessions get the tools (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a Root Session launch, **Then** the three tools are registered next to the panel tools.
2. **Given** a Child-role launch, **Then** none of the three is registered, and a call by name is `unknown_tool`.

### Edge Cases

- A call from a Session whose process is shutting down is answered `cancelled`, as in spec 124.
- Sessions on the same Project with identical names are told apart by id.
- A target deleted between lookup and send returns `not_found`.
- Messaging from one Session to another does not change which Session is in front.
- Two Session messages queued back to back keep their order.
- A sender name that contains quotes, angle brackets or ampersands is escaped in the `from` attribute and restored on parse.
- Several targets sharing one Repository's Worktree do not share PR lookups beyond the existing per-branch cache.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Root row of the access table MUST register three Host tools, `list_sessions`, `get_session_status` and `send_session_message`, on every Root launch; the Child row MUST stay empty.
- **FR-002**: `list_sessions` MUST accept optional `project` and `include_archived`, return one row per matching Session with `{id, name, project:{id,name}, branch, status, archived, lastActivityAt}`, add `self: true` on the caller's row and `hidden: true` on hidden Sessions, and carry no PR.
- **FR-003**: `project` MUST match a Project id or a Project name case-insensitively; an unmatched value MUST return a tool error.
- **FR-004**: Archived Sessions MUST be listed only when `include_archived` is true.
- **FR-005**: `get_session_status(id)` MUST return `{id, name, project, status, [stopReason], archived, hidden, branch, pullRequest, lastActivityAt}` for any Session id, using the vocabulary `working`, `waiting-for-approval`, `idle`, `paused`, `stopped`, and `stopReason` in `not-started`, `agent-exited`, `start-failed`, `worktree-missing`, `stopped-on-request` for `stopped` only.
- **FR-006**: `pullRequest` MUST come from the readout cache for a running Session and from one on-demand `pull_request_for_branch` call otherwise, as `{number, url}` or `null`. `list_sessions` MUST NOT look up PRs.
- **FR-007**: `send_session_message(id, text)` MUST deliver `text` to the target through the existing chat send path, wrapped in the envelope `<session-message from="<name>" session="<id>">…</session-message>` with the sender's name and id taken from the stream owner, never from arguments.
- **FR-008**: Envelope tags inside the text MUST be escaped before wrapping so a message cannot close, nest or forge an envelope; the sender name MUST be attribute-escaped.
- **FR-009**: None of the three tools MUST raise the approval card in any approval mode, and none MUST take a file or lifecycle action.
- **FR-010**: A busy target (Working or Needs-you) MUST receive the message as an OMP `followUp` and the tool MUST return `{outcome: "queued"}`; an Idle target returns `{outcome: "sent"}`; a Paused target holds it through the pause hold and returns `{outcome: "held"}`.
- **FR-011**: A Stopped or Archived target MUST yield `session_not_running` including the target's status, and the tool MUST NOT start any Session.
- **FR-012**: The tool MUST return `invalid_target` for the caller's own id, `invalid_input` for empty text or text over 32 KB, and `not_found` for an unknown id.
- **FR-013**: Each (sender, target) pair MUST be limited to 10 delivered messages per rolling 10 minutes in memory; the 11th returns `rate_limited`. Refused sends MUST NOT count toward the limit.
- **FR-014**: A Session message MUST NOT answer or resolve any pending approval, ask, or request card in the target.
- **FR-015**: The transcript parser MUST recognise the envelope on load and live, strip it from the bubble text and set `source = {kind: "session", sessionId, name}` on the `TranscriptItem::User` item; text that is not exactly one well-formed envelope MUST stay a plain user turn.
- **FR-016**: The renderer MUST show a muted "From Session <name>" line above the bubble of a turn with a Session `source`, built from shared components in `src/renderer/components/` (ADR 0003), extending an existing shared component with a prop or slot instead of hand-building one.
- **FR-017**: The sender name MUST be a keyboard-operable link that switches to the sender Session by the existing user-initiated switch and MUST NOT move focus anywhere else; when the sender Session no longer exists, the line MUST show the sender id as plain text.
- **FR-018**: Every failure MUST reach omp as `isError: true` with `{error:{code,message}}` and MUST NOT show a toast. Calls and results MUST use the spec 124 router, 8 KiB cap and cancel handling.
- **FR-019**: Session tool logic MUST live in `src-tauri/src/agent_tools/sessions.rs` (split further if it nears 600 lines); `router.rs` and `mod.rs` get only dispatch lines.
- **FR-020**: Docs MUST change with the code: ADR 0008 records the envelope and source decision; `CONTEXT.md` defines **Session message**; `docs/PLAN.md` row 1c.2 shows progress.

### Key Entities

- **Session message**: text one Session sends another through `send_session_message`, delivered as a labelled user turn.
- **Envelope**: the fixed `<session-message from session>` wrapper that makes the origin machine-readable.
- **Message source**: the `source` field on a user transcript item, set from a valid envelope, naming the sender Session.
- **Loop guard**: the in-memory per-pair counter of 10 messages per rolling 10 minutes.
- **Session status**: the five-value vocabulary plus an optional `stopReason` for `stopped`.

## Accessibility (WCAG 2.1 AA)

- The "From Session <name>" line is real text with a visible muted but contrast-passing colour (1.4.3), the link is reachable and operable by keyboard (2.1.1) and has a visible focus ring (2.4.7).
- Activating the link does not move focus to an unexpected place (3.2.2, 2.4.3); the plain-text fallback for a deleted sender is not focusable.
- The bubble's accessible name keeps the sender line so a screen reader hears who sent it before the body (1.3.1).
- A received Session message does not announce itself or take focus.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Live (fake-omp harness via `pnpm verify:tauri`): a tape that calls each of the three tools returns the expected short JSON for every outcome in the stories, and no approval card appears for any of them.
- **SC-002**: Live: a delivered message shows "From Session <name>" in the target before and after a reload, and the name switches to the sender.
- **SC-003**: Live: each error (`unknown_project`, `not_found`, `invalid_target`, `invalid_input`, `session_not_running`, `rate_limited`) produces a tool error and no toast.
- **SC-004**: A tool call for a Session tool from a Child-role launch is `unknown_tool` and never reaches a Session.
- **SC-005**: New logic carries unit tests co-located with it (AGENTS.md Testing rule); each guard (self-send, size limit, rate limit, envelope escaping, strict envelope parsing, access table) has a test that fails when the guard is removed.
- **SC-006**: `pnpm ci:local` passes and no touched file exceeds 600 lines.

## Assumptions

- Spec 124 has merged: the Tool channel, `tools_for`, router, error shape and `verify:tauri` fake-omp harness exist on `main`.
- Session names and ids are the identity an agent works with; no new id scheme.
- A Session message is plain text; attachments and images are not part of this slice.

## Out of scope

Creating, updating or nesting Sessions (#1859); archive, stop, pause, resume and delete tools (#1860); `list_conversations`, `new_conversation`, `switch_conversation` (#1861); any Session list UI (#1862); starting a stopped Session; persisting the loop-guard counter across restarts.

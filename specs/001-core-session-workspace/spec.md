# Feature Specification: Core session workspace

**Feature Branch**: `001-core-session-workspace` (no branch created; work lands on `main`)

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "Core session workspace: the first usable slice of Pinion. A left-hand session list where every session is its own git worktree (create, open, resume after an app restart), and an agent chat pane (streaming turns, stop, tool approvals, agent questions, slash commands). The right pane (git changes, files, side chat) is a later spec."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a session and chat with the agent (Priority: P1)

A developer opens Pinion, points it at a git repository, and starts a new session. Pinion gives the session its own isolated worktree of that repository. The developer types a request, watches the agent's answer stream in, and can stop a turn that is going the wrong way.

**Why this priority**: This is the product. Without a session that holds a live conversation with the agent in its own worktree, nothing else has any value.

**Independent Test**: Add one repository, create one session, send "list the files in this repo", and see the streamed answer. Send a long request, press stop, and confirm the turn ends and a follow-up message is accepted. The result is a usable single-session agent app.

**Acceptance Scenarios**:

1. **Given** Pinion has no sessions, **When** the developer adds a git repository and creates a session, **Then** a new worktree of that repository exists on disk, the session appears in the session list, and the chat pane is ready for a first message.
2. **Given** an open session that is idle, **When** the developer sends a message, **Then** the agent's reply appears progressively as it is produced, along with visible indication of the tools the agent is running, and the session shows as idle again when the turn is finished.
3. **Given** a turn is in progress, **When** the developer presses stop, **Then** the turn ends, the session becomes idle, and a new message can be sent without an "already processing" error.
4. **Given** the agent's reply contains markdown or code, **When** it is displayed, **Then** it renders as formatted text and code blocks and never as executable content.

---

### User Story 2 - Approve tool calls and answer agent questions (Priority: P1)

While working, the agent asks permission before running tools and sometimes asks the developer a question. Pinion shows each request in the chat pane, the developer decides, and the turn continues.

**Why this priority**: Pinion runs the agent so that every tool call needs approval. If requests are not surfaced and answerable, turns stall and the app is unusable, so this is as critical as chatting.

**Independent Test**: Ask the agent to create a file. Confirm an approval request naming the tool and its target appears, approve it, and confirm the file is created. Repeat and deny; confirm the tool does not run and the agent reports the refusal. Ask the agent to ask you a multiple-choice question; confirm you can answer it.

**Acceptance Scenarios**:

1. **Given** the agent wants to run a tool, **When** the request arrives, **Then** the chat pane shows what tool and what target it wants, with clear Approve and Deny actions, and the session is marked as waiting for the developer.
2. **Given** an approval request is showing, **When** the developer approves, **Then** the tool runs and the turn continues; **When** the developer denies, **Then** the tool does not run and the agent is told it was refused.
3. **Given** the agent asks a question with options, **When** the developer picks an option, **Then** that answer is returned to the agent and the turn continues.
4. **Given** the agent asks a question that offers free-text input, **When** the developer types an answer or cancels, **Then** the answer or the cancellation is returned and the turn continues.
5. **Given** a request is waiting in a session the developer is not looking at, **When** they open that session, **Then** the pending request is still there and can be answered.

---

### User Story 3 - Come back after restarting the app (Priority: P2)

The developer quits Pinion, or it crashes, and reopens it later. Their repositories and sessions are still listed. Opening a session restores its full conversation and the developer carries on where they stopped.

**Why this priority**: Worktree sessions are long-lived. A harness that forgets every conversation on restart is a toy, but it is useful before this exists, so it ranks just behind the core loop.

**Independent Test**: Have a two-message conversation in a session, force-quit Pinion, reopen it, open the session, and confirm both messages are shown. Send a follow-up that depends on the earlier conversation and confirm the agent answers using it.

**Acceptance Scenarios**:

1. **Given** sessions existed when Pinion closed, **When** Pinion starts, **Then** every repository and session is listed, and no agent is running for any of them yet.
2. **Given** a session listed from a previous run, **When** the developer opens it, **Then** its full conversation history is shown and a follow-up message continues that same conversation.
3. **Given** a session's stored conversation cannot be found or is empty, **When** the developer opens it, **Then** Pinion says so plainly instead of silently showing an empty new conversation.
4. **Given** Pinion is closed normally or force-closed, **When** the developer looks at running processes, **Then** no agent process from Pinion remains running.

---

### User Story 4 - Work in several sessions at once (Priority: P2)

The developer runs a long task in one session, switches to another to start a second task, and returns to the first without losing anything. The session list shows at a glance which sessions are working, idle, or waiting for them.

**Why this priority**: One-worktree-per-session exists so that parallel work is safe. It is the reason for the list, but the app is usable one session at a time, so it follows the core loop.

**Independent Test**: Start a long-running request in session A, switch to session B and send a different request, then switch back to A. Confirm each conversation is intact, neither received the other's messages, and the list showed both as working while they ran.

**Acceptance Scenarios**:

1. **Given** two sessions, **When** both have turns in progress, **Then** each keeps streaming in the background and the list shows both as working.
2. **Given** a background session needs an approval or an answer, **When** it does, **Then** the list marks that session as waiting for the developer.
3. **Given** the developer switches between sessions, **When** they return to a session, **Then** its scroll position, in-progress text, and pending requests are as they left them.

---

### User Story 5 - Use the agent's commands and recover from failures (Priority: P3)

The developer types a slash command and finds the ones the agent offers. If a session's agent stops unexpectedly, Pinion says so and lets them recover.

**Why this priority**: It rounds off the workspace but is not needed for the first useful build.

**Independent Test**: Type `/` in the message box and confirm the agent's commands are listed and one runs. Kill a session's agent from outside Pinion and confirm the session shows a stopped state with a recover action that restores the conversation.

**Acceptance Scenarios**:

1. **Given** an open session, **When** the developer types `/`, **Then** the commands the agent currently offers are listed and choosing one runs it.
2. **Given** the developer types a slash command the agent does not offer, **When** they send it, **Then** Pinion warns that the command is unknown and does not send it as ordinary chat text.
3. **Given** a session's agent stops unexpectedly, **When** it happens, **Then** the session shows a stopped state with the reason if known, and a recover action reattaches the saved conversation.

---

### Edge Cases

- The chosen folder is not a git repository, or has no commits: Pinion refuses to create a session and says why.
- The worktree cannot be created (name clash, disk full, path too long on Windows): no half-created session is left in the list, and the reason is shown.
- The agent's answer is very long or contains extremely large tool output: the chat stays responsive and scrolls smoothly.
- A session's worktree folder was deleted or moved outside Pinion: the session is shown as broken with the missing path, not silently dropped.
- The developer sends a message while a turn is still running: it is queued or rejected clearly, never lost or interleaved into the running answer.
- An approval or question is pending and the developer closes Pinion: on the next start the request is gone, and the session shows as needing a new turn rather than pretending to still wait.
- Two Pinion windows or instances point at the same repository: the second one warns rather than corrupting session state.
- The agent is not installed or not signed in: Pinion shows an actionable setup message rather than an empty or endlessly loading chat.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to add a local git repository to Pinion and remove it from Pinion without deleting the repository.
- **FR-002**: Users MUST be able to create a session for a repository; each new session MUST get its own git worktree with an automatically generated name.
- **FR-003**: The session list MUST show, per repository, every session with its name and a status of working, idle, waiting for the user, stopped, or broken.
- **FR-004**: Users MUST be able to send a message in a session and see the agent's reply appear progressively, including which tools the agent is running.
- **FR-005**: Users MUST be able to stop a running turn, and MUST be able to send the next message as soon as the stop has taken effect.
- **FR-006**: Every tool call the agent wants to run MUST be shown to the user with the tool and its target, and MUST NOT run until the user approves it.
- **FR-007**: Users MUST be able to approve or deny each tool request, and a denial MUST be reported back to the agent.
- **FR-008**: When the agent asks a question (choice or free text), Pinion MUST show it and return the user's answer or cancellation; no request may be left unanswered without the user being able to see it.
- **FR-009**: Pending approvals and questions MUST stay visible and answerable for as long as the session lives, including while the user is viewing a different session.
- **FR-010**: Agent-produced text, tool output, and file contents MUST be displayed as inert content and never executed or loaded as active content.
- **FR-011**: Pinion MUST remember repositories and sessions across restarts and list them on the next start without starting an agent for each.
- **FR-012**: Opening a previously used session MUST restore its full conversation and MUST allow the conversation to continue.
- **FR-013**: Pinion MUST confirm that a reopened session is really the saved conversation and MUST tell the user if it is missing or empty, rather than presenting a blank conversation as if it were the saved one.
- **FR-014**: Each session's agent MUST run inside that session's own worktree.
- **FR-015**: Several sessions MUST be able to work at the same time without their messages, requests, or output mixing.
- **FR-016**: Closing Pinion, normally or by force, MUST NOT leave agent processes running.
- **FR-017**: When the user types `/`, Pinion MUST list the slash commands the agent currently offers and MUST run the chosen one.
- **FR-018**: Pinion MUST NOT send unknown slash-command text to the agent as ordinary chat; it MUST warn the user.
- **FR-019**: When a session's agent stops unexpectedly, Pinion MUST show the session as stopped and offer a recover action that reattaches the saved conversation.
- **FR-020**: Pinion MUST show an actionable setup message when the agent cannot be started (not installed, not signed in, wrong version).

### Key Entities

- **Repository**: A local git repository registered with Pinion; has a path and owns zero or more sessions.
- **Session**: One conversation with the agent bound to one worktree; has a name, a status, a saved conversation, and the worktree it lives in.
- **Worktree**: An isolated checkout of a repository created for a session; has a folder path and a branch name.
- **Conversation**: The ordered messages, tool activity, and agent answers of a session; stored so it survives restarts.
- **Approval request**: A pending request from the agent to run a tool; shows the tool and target and has an Approve and Deny outcome.
- **Question**: A pending request from the agent for a choice or free-text answer, with an answer or a cancel outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user can add a repository, create a session, and receive a first streamed answer in under 2 minutes, without reading documentation.
- **SC-002**: A newly created session is ready to accept its first message within 30 seconds on the reference machine (Windows 11).
- **SC-003**: After a full app restart, 100% of previously listed sessions reopen with their complete conversation, and a follow-up that depends on earlier content is answered correctly.
- **SC-004**: Every approval request and question the agent raises is visible to the user within 1 second of being raised, and answering it resumes the turn within 2 seconds.
- **SC-005**: With 5 sessions working at once, no message, request, or output appears in the wrong session across a 30-minute run.
- **SC-006**: After Pinion exits, either normally or by being killed, zero agent processes started by it remain running.
- **SC-007**: Pressing stop ends the visible turn within 3 seconds, and the next message sent afterwards is accepted 100% of the time.

## Assumptions

- The user is one developer on Windows 11 with git and the agent (OMP 18.4.4) installed and signed in; other platforms, other agent versions, and multi-user use are out of scope.
- The user's existing agent skills, extensions, and MCP servers apply to every session unchanged.
- Worktrees are created in a folder next to the repository (`<repo>/../pinion-worktrees/<repo>/<generated-name>`), following the one-worktree-per-session convention of GitHub Copilot desktop; the user does not choose the name at creation.
- Removing a session from the list never deletes its worktree or its conversation file unless the user explicitly confirms deleting them.
- Model choice, thinking level, and other agent settings come from the agent's own configuration; a settings screen is out of scope.
- The right pane (git changes, file browser, side chat), plan mode, forking sessions, image attachments, and subagent progress views are out of scope and get their own specs.
- Sessions are only started when the user opens them, not when Pinion starts.
- The prototype phase applies (see the constitution): verification is by running the app and exercising the scenarios above, not by an automated suite.

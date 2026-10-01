# Feature Specification: Core session workspace

**Feature Branch**: `001-core-session-workspace` (no branch created; work lands on `main`)

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "Core session workspace: the first usable slice of Pinion. A left-hand session list where every session is its own git worktree (create, open, resume after an app restart), and an agent chat pane (streaming turns, stop, tool approvals, agent questions, slash commands). The right pane (git changes, files, side chat) is a later spec."

## Clarifications

### Session 2026-10-01

- Q: On a repository's one-click New session button, what does "main" mean? → A: The repository's detected default branch (the same branch the picker preselects), not a branch literally named `main`.
- Q: After the one-click New session button creates a session, does Pinion select and open it? → A: Yes. The new session is selected and its agent starts opening, so the chat pane is ready for a first message. Creating through the branch picker behaves the same way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a session and chat with the agent (Priority: P1)

A developer opens Pinion, points it at a git repository, and creates a session, either in one click from the repository's default branch or by picking another Base branch from a picker. Pinion gives the session its own isolated worktree of that repository. The developer types a request, watches the agent's answer stream in, and can stop a turn that is going the wrong way. Later, they start a fresh conversation in the same session without losing the earlier one, and can reopen it.

**Why this priority**: This is the product. Without a session that holds a live conversation with the agent in its own worktree, nothing else has any value.

**Independent Test**: Add one repository, create one session with the one-click New session button (its Base branch is the repository's default branch), send "list the files in this repo", and see the streamed answer, with each tool call the agent ran shown as a compact row. Send a long request, press stop, and confirm the turn ends and a follow-up message is accepted. Start a new conversation, confirm the earlier one is still reachable as history, and reopen it. Then create a second session through the branch picker and choose a different Base branch.

**Acceptance Scenarios**:

1. **Given** Pinion has no sessions, **When** the developer adds a git repository and creates a session with the one-click New session button, **Then** a new worktree exists on disk on a new branch created from the repository's default branch, the session appears in the session list under an automatically generated name and is selected, and the chat pane is ready for a first message.
2. **Given** an open session that is idle, **When** the developer sends a message, **Then** the agent's reply appears progressively as it is produced, along with visible indication of the tools the agent is running, and the session shows as idle again when the turn is finished.
3. **Given** the agent runs one or more tools during a turn, **When** they appear in the chat pane, **Then** each is one compact row naming the tool, its target, status, and duration; expanding a row reveals its arguments and output, and a file-edit row's expanded view shows a diff of the change.
4. **Given** the agent produces reasoning before its visible answer, **When** the turn is shown, **Then** the reasoning is hidden behind a collapsed "Thinking" row that the developer can expand.
5. **Given** a turn is in progress, **When** the developer presses stop, **Then** the turn ends, the session becomes idle, and a new message can be sent without an "already processing" error.
6. **Given** a turn is in progress, **When** the developer types a message and sends it, **Then** it appears as a removable chip under the running turn instead of being sent immediately; when the turn ends the queued message is sent as the next turn unless the developer removed it first, and a separate "Send now" action on the chip steers the running turn with it instead of waiting.
7. **Given** an open session with a conversation, **When** the developer starts a new conversation, **Then** the same session and worktree are kept, the previous conversation is added to that session's history, and the new one becomes current.
8. **Given** a session's conversation history, **When** the developer opens an earlier conversation, **Then** it becomes the current conversation and the developer can continue it.
9. **Given** the agent's reply contains markdown or code, **When** it is displayed, **Then** it renders as formatted text and code blocks and never as executable content.
10. **Given** a repository in the session list, **When** the developer uses the branch button next to the New session button, **Then** a picker lists the repository's branches with the default branch preselected, and confirming creates a session on a new branch from the chosen Base branch, selected and opened exactly as in scenario 1; cancelling creates nothing. **Given** a one-click creation is already in progress for that repository, **When** the developer clicks New session again, **Then** no second session is created.

---

### User Story 2 - Approve tool calls and answer agent questions (Priority: P1)

While working, the agent may ask permission before running tools, depending on the app's current Approval mode, and it always may ask the developer a question. Pinion shows each request in the chat pane, the developer decides, and the turn continues.

**Why this priority**: When a request that the current Approval mode requires is not surfaced and answerable, or a question goes unanswered, turns stall and the app is unusable, so this is as critical as chatting.

**Independent Test**: With Approval mode set to Ask, ask the agent to create a file. Confirm an approval request naming the tool and its target appears, approve it, and confirm the file is created. Repeat and deny; confirm the tool does not run and the agent reports the refusal. Ask the agent to ask a multiple-choice question; confirm it can be answered.

**Acceptance Scenarios**:

1. **Given** the current Approval mode requires approval for a tool the agent wants to run, **When** the request arrives, **Then** the chat pane shows what tool and what target it wants, with clear Approve and Deny actions, and the session is marked as needing the developer.
2. **Given** an approval request is showing, **When** the developer approves, **Then** the tool runs and the turn continues; **When** the developer denies, **Then** the tool does not run and the agent is told it was refused.
3. **Given** the agent asks a question with options, **When** the developer picks an option, **Then** that answer is returned to the agent and the turn continues.
4. **Given** the agent asks a question that offers free-text input, **When** the developer types an answer or cancels, **Then** the answer or the cancellation is returned and the turn continues.
5. **Given** a request is waiting in a session the developer is not looking at, **When** they open that session, **Then** the pending request is still there and can be answered.

---

### User Story 3 - Control how much the agent can do without asking (Priority: P2)

Approval mode is one app-wide setting: Ask (prompts for file changes and commands), Edit freely (prompts only for commands), or Auto (never prompts); reads are never prompted. The developer sizes it to the task, and changing it never disrupts a turn already underway.

**Why this priority**: Every session's friction depends on this one setting, and a change mid-turn must be safe, so it belongs right after the approval flow it governs.

**Independent Test**: Set Approval mode to Edit freely, ask the agent to edit a file, and confirm it happens with no prompt; ask it to run a shell command and confirm a prompt still appears. Set Approval mode to Auto and confirm neither prompts. While a turn is in progress, switch Approval mode and confirm the running turn finishes untouched before the session reflects the new mode.

**Acceptance Scenarios**:

1. **Given** Approval mode is Ask, **When** the agent wants to change a file or run a command, **Then** each is shown for approval before it runs.
2. **Given** Approval mode is Edit freely, **When** the agent wants to change a file, **Then** it proceeds without a prompt; **When** it wants to run a command, **Then** a prompt still appears.
3. **Given** Approval mode is Auto, **When** the agent wants to run any tool, **Then** it proceeds without a prompt.
4. **Given** a session is mid-turn, **When** the developer changes the app's Approval mode, **Then** the session shows the new mode as pending, the running turn and any pending approval or question finish undisturbed, and only once the session is idle does Pinion restart its agent behind the scenes, reattach the same conversation, and start using the new mode.
5. **Given** every session is idle, **When** the developer changes Approval mode, **Then** it applies to each session's very next tool call with no pending state to wait for.

---

### User Story 4 - Come back after restarting the app (Priority: P2)

The developer quits Pinion, or it crashes, and reopens it later. Their repositories and sessions are still listed. Opening a session restores its conversations and the developer carries on where they stopped.

**Why this priority**: Worktree sessions are long-lived. A harness that forgets every conversation on restart is a toy, but it is useful before this exists, so it ranks just behind the core loop.

**Independent Test**: Have a two-message conversation in a session, force-quit Pinion, reopen it, open the session, and confirm both messages are shown. Send a follow-up that depends on the earlier conversation and confirm the agent answers using it.

**Acceptance Scenarios**:

1. **Given** sessions existed when Pinion closed, **When** Pinion starts, **Then** every repository and non-archived session is listed, and no agent is running for any of them yet.
2. **Given** a session listed from a previous run, **When** the developer opens it, **Then** its conversations are shown, the one that was current resumes, and a follow-up message continues that same conversation.
3. **Given** a session's current conversation cannot be found or is empty, **When** the developer opens it, **Then** Pinion says so plainly instead of silently showing an empty new conversation.
4. **Given** Pinion is closed normally, **When** the developer looks at running processes, **Then** no agent process from Pinion remains running; **Given** Pinion was force-killed, **When** it is next started, **Then** any agent process left over from the killed run is stopped before new sessions start.

---

### User Story 5 - Work in several sessions at once (Priority: P2)

The developer runs a long task in one session, switches to another to start a second task, and returns to the first without losing anything. The session list shows at a glance which sessions are working, idle, need them, or are stopped, and marks any that finished while they were elsewhere.

**Why this priority**: One-worktree-per-session exists so that parallel work is safe. It is the reason for the list, but the app is usable one session at a time, so it follows the core loop.

**Independent Test**: Start a long-running request in session A, switch to session B and send a different request, then switch back to A. Confirm each conversation is intact, neither received the other's messages, and the list showed both as working while they ran. While viewing B, let A finish; confirm A shows an unread marker until opened, and, with Pinion unfocused, confirm a Windows notification appeared for it.

**Acceptance Scenarios**:

1. **Given** two sessions, **When** both have turns in progress, **Then** each keeps streaming in the background and the list shows both as working.
2. **Given** a background session needs an approval or an answer, **When** it does, **Then** the list marks that session as needing the developer.
3. **Given** the developer switches between sessions, **When** they return to a session, **Then** its scroll position, in-progress text, and pending requests are as they left them.
4. **Given** a session finishes while the developer is viewing a different session, **When** they return to the list, **Then** that session shows an unread marker, which clears once they open it.
5. **Given** Pinion is not the focused window, **When** a session starts needing the developer or finishes, **Then** a Windows notification appears; clicking it opens that session. **Given** any other change happens in a session, **Then** no notification fires.

---

### User Story 6 - Archive or delete a session (Priority: P2)

A developer is done with a session for now, or permanently. Archiving gets it out of the main list while keeping the worktree and conversations, and is the default, reversible way to finish. Deleting removes the worktree and conversations for good, and only after a confirmation that names what will be lost.

**Why this priority**: Sessions accumulate as work does; ending them safely is as core to the workspace as creating them.

**Independent Test**: Archive a session and confirm it disappears from the main list but is visible and reopenable from an archived view, with its worktree and conversations intact. Delete a different session that has uncommitted changes and confirm the confirmation names those changes before the session, its worktree, and its conversations disappear.

**Acceptance Scenarios**:

1. **Given** an open session, **When** the developer archives it, **Then** it is hidden from the main session list, its worktree and conversations remain intact, and it can be found and restored from an archived view.
2. **Given** an archived session, **When** the developer restores it, **Then** it reappears in the main list exactly as it was.
3. **Given** a session with uncommitted changes or unpushed commits, **When** the developer starts to delete it, **Then** the confirmation names those specific things before anything is removed.
4. **Given** the developer confirms a delete, **When** it completes, **Then** the session's worktree and conversations are permanently removed and the session no longer appears anywhere.

---

### User Story 7 - Use the agent's commands and recover from failures (Priority: P3)

The developer types a slash command and finds the ones the agent offers. If a session's agent stops unexpectedly, Pinion says so and lets them recover.

**Why this priority**: It rounds off the workspace but is not needed for the first useful build.

**Independent Test**: Type `/` in the message box and confirm the agent's commands are listed and one runs. Kill a session's agent from outside Pinion and confirm the session shows a stopped state with a recover action that restores the conversation.

**Acceptance Scenarios**:

1. **Given** an open session, **When** the developer types `/`, **Then** the commands the agent currently offers are listed and choosing one runs it.
2. **Given** the developer types a slash command the agent does not offer, **When** they send it, **Then** Pinion warns that the command is unknown and does not send it as ordinary chat text.
3. **Given** a session's agent stops unexpectedly, **When** it happens, **Then** the session shows a stopped state with the reason if known, and a recover action reattaches the saved conversation.

---

### Edge Cases

- The chosen folder is not a git repository, has no commits, or the chosen Base branch (including the default branch used by one-click creation) no longer exists: Pinion refuses to create a session and says why.
- The worktree cannot be created (name clash, disk full, path too long on Windows): no half-created session is left in the list, and the reason is shown.
- The agent's answer is very long or contains extremely large tool output: the chat stays responsive and scrolls smoothly.
- A session's worktree folder was deleted or moved outside Pinion: it shows as stopped with the missing path as the reason, offers to recreate the worktree from its branch (only if that branch still exists), archive, or delete, and keeps its conversations readable; it is not silently dropped.
- A queued follow-up chip is removed before the running turn ends: nothing is sent for it.
- Renaming a session while it is working: the display name changes immediately without affecting the running turn, its branch, or its folder.
- An approval or question is pending and the developer closes Pinion: on the next start the request is gone, and the session shows as needing a new turn rather than pretending to still wait.
- The app's Approval mode is changed while every session is idle: it applies to each session's very next tool call, with no pending state or restart to wait for.
- Deleting a session that has neither uncommitted changes nor unpushed commits: confirmation is still required, but without those specific warnings.
- Two Pinion windows or instances point at the same repository: the second one warns rather than corrupting session state.
- The agent is not installed or not signed in: Pinion shows an actionable setup message rather than an empty or endlessly loading chat.
- The machine runs low on free memory while several sessions are live: Pinion warns the user, says how many agents it is running, and lets them stop agents; it does not stop any on its own.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to add a local git repository to Pinion and remove it from Pinion without deleting the repository.
- **FR-002**: Users MUST be able to create a session for a repository in one click from the repository's default branch, or by choosing another Base branch in a picker opened by a separate button, with the repository's default branch preselected there; the session's worktree MUST get a new branch created from that Base branch, and uncommitted edits in the developer's main checkout MUST NOT carry over into it. The new session MUST be selected and opened. Both buttons MUST have accessible names and tooltips, a failure MUST show its reason and leave no half-created session, and a second click while a one-click creation is in progress MUST NOT create a second session.
- **FR-003**: Each new session MUST be given an automatically generated, readable adjective-noun display name; that same name MUST be used to name its worktree's branch and folder.
- **FR-004**: Users MUST be able to rename a session's display name at any time; renaming MUST NOT change its branch or its worktree's folder.
- **FR-005**: The session list MUST show, per repository, every non-archived session with its display name and a status of working, idle, needs you, or stopped.
- **FR-006**: Pinion MUST mark a session as unread when it finishes work while the developer is viewing a different session or a different app window, and MUST clear that marker the next time the developer opens the session.
- **FR-007**: Users MUST be able to send a message in a session and see the agent's reply appear progressively, including which tools the agent is running.
- **FR-008**: Each tool call MUST render as one compact row naming the tool, its target, status, and duration; expanding a row MUST reveal its arguments and output, and a file-edit tool call's expanded row MUST show a diff of the change.
- **FR-009**: The agent's reasoning MUST be hidden behind a collapsed "Thinking" row that the developer can expand; it MUST NOT be shown inline with the visible answer.
- **FR-010**: Users MUST be able to stop a running turn, and MUST be able to send the next message as soon as the stop has taken effect.
- **FR-011**: Sending a message while a turn is running MUST queue it as a removable chip shown under the running turn; the queued message MUST be sent as the next turn once the running turn ends, unless the developer removes it first.
- **FR-012**: A queued follow-up chip MUST offer a "Send now" action that steers the currently running turn with that message instead of waiting for the turn to end.
- **FR-013**: Users MUST be able to start a new conversation in an open session; doing so MUST keep the same session and worktree, add the conversation that was current to that session's history, and make the new one current.
- **FR-014**: Users MUST be able to open any earlier conversation from a session's history; doing so MUST make it the current conversation and allow it to continue.
- **FR-015**: Approval mode MUST be a single app-wide setting with three levels — Ask (prompts for file changes and commands), Edit freely (prompts only for commands), and Auto (never prompts) — applying to every session; reads are never prompted; the default is Ask.
- **FR-016**: A tool call the agent wants to run MUST be shown to the user with the tool and its target, and MUST NOT run until approved, whenever the current Approval mode requires approval for it.
- **FR-017**: Users MUST be able to approve or deny each tool request that is shown; a denial MUST be reported back to the agent.
- **FR-018**: When the agent asks a question (choice or free text), Pinion MUST show it and return the user's answer or cancellation; no request may be left unanswered without the user being able to see it.
- **FR-019**: Pending approvals and questions MUST stay visible and answerable for as long as the session lives, including while the user is viewing a different session.
- **FR-020**: Changing the app's Approval mode while a session is mid-turn MUST show the new mode as pending on that session; the change MUST take effect only once that session is idle (its turn, any background work, and any pending approval or question have all finished), at which point Pinion restarts that session's agent behind the scenes and reattaches the same conversation; an in-flight turn or a pending prompt MUST NOT be interrupted by a mode change.
- **FR-021**: Agent-produced text, tool output, and file contents MUST be displayed as inert content and never executed or loaded as active content.
- **FR-022**: Pinion MUST remember repositories and non-archived sessions across restarts and list them on the next start without starting an agent for each.
- **FR-023**: Opening a previously used session MUST restore its conversations, resume the one that was current, and allow it to continue.
- **FR-024**: Pinion MUST confirm that a reopened session's current conversation is really the saved one and MUST tell the user if it is missing or empty, rather than presenting a blank conversation as if it were the saved one.
- **FR-025**: Each session's agent MUST run inside that session's own worktree.
- **FR-026**: Several sessions MUST be able to work at the same time without their messages, requests, or output mixing.
- **FR-027**: While Pinion is not the focused window, a Windows notification MUST fire only when a session becomes needs you or when it finishes; clicking it MUST open that session; no other session state change MUST trigger a notification.
- **FR-028**: Users MUST be able to archive a session, hiding it from the main list while keeping its worktree and conversations intact; archiving MUST be reversible from an archived view.
- **FR-029**: Users MUST be able to delete a session only after an explicit confirmation that names what will be lost — its uncommitted changes and unpushed commits — after which its worktree and conversations are permanently removed.
- **FR-030**: Pinion's own git use MUST be limited to creating and deleting worktrees, listing branches, and reading enough status to warn before a delete; committing, pushing, and opening pull requests MUST be done by the user asking the agent in chat, not through dedicated Pinion controls.
- **FR-031**: Closing Pinion normally MUST NOT leave agent processes running. After Pinion is force-killed, agent processes left over MUST be stopped no later than the next Pinion start.
- **FR-032**: When the user types `/`, Pinion MUST list the slash commands the agent currently offers and MUST run the chosen one.
- **FR-033**: Pinion MUST NOT send unknown slash-command text to the agent as ordinary chat; it MUST warn the user.
- **FR-034**: When a session's agent stops unexpectedly, Pinion MUST show the session as stopped with the reason if known, and offer a recover action that reattaches the saved conversation.
- **FR-035**: When a session's worktree folder is found missing, Pinion MUST show the session as stopped with the missing path, MUST keep its conversations readable, and MUST offer to recreate the worktree from the session's branch (only if that branch still exists), archive the session, or delete it; it MUST NOT offer a recover action, because the agent cannot run without its worktree.
- **FR-036**: Pinion MUST show an actionable setup message when the agent cannot be started (not installed, not signed in, wrong version).
- **FR-037**: Pinion MUST warn the user when the machine's free memory falls below a low-memory threshold, stating how many agents Pinion is running, and MUST NOT stop any agent on its own.
- **FR-038**: Users MUST be able to stop a session's agent without archiving the session; the session stays listed, and reopening it reattaches its current conversation.

### Key Entities

- **Repository**: A local git repository registered with Pinion; has a path and owns zero or more sessions.
- **Session**: One worktree together with the conversations held in it; has a display name (renamed independently of its branch and folder), a status of working, idle, needs you, or stopped, and an archive state of active or archived. A repository has many sessions; a session has exactly one worktree.
- **Worktree**: The isolated checkout created for a session; has a folder path, a branch name, and the base branch it was created from.
- **Base branch**: The branch a new session's worktree branches from, chosen at creation; one-click creation uses the repository's default branch, and the picker preselects it.
- **Conversation**: One continuous exchange with the agent inside a session; a session has many conversations, one of which is current, and earlier ones stay reachable as history; stored so it survives restarts.
- **Approval mode**: The single app-wide setting controlling how much the agent may do without asking — Ask, Edit freely, or Auto; applies to every session; a change made mid-turn is pending on that session until its turn ends.
- **Approval request**: A pending request from the agent to run a tool, raised only when the current Approval mode requires it; shows the tool and target and has an Approve and Deny outcome.
- **Question**: A pending request from the agent for a choice or free-text answer, with an answer or a cancel outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user can add a repository, create a session, and receive a first streamed answer in under 2 minutes, without reading documentation.
- **SC-002**: A newly created session is ready to accept its first message within 30 seconds on the reference machine (Windows 11).
- **SC-003**: After a full app restart, 100% of previously listed non-archived sessions reopen with their conversations intact, and continuing the current conversation with a follow-up that depends on earlier content is answered correctly.
- **SC-004**: Every approval request and question the agent raises is visible to the user within 1 second of being raised, and answering it resumes the turn within 2 seconds.
- **SC-005**: With 5 sessions working at once on a machine with enough free memory, no message, request, or output appears in the wrong session across a 30-minute run.
- **SC-006**: After a normal exit, zero agent processes started by Pinion remain running. After a forced kill, zero remain within 10 seconds, or any that do are stopped at the next start before a session opens.
- **SC-007**: Pressing stop ends the visible turn within 3 seconds, and the next message sent afterwards is accepted 100% of the time.
- **SC-008**: A turn with 30 tool calls renders as 30 single-line rows; the developer can read every tool's name and status without expanding any row.
- **SC-009**: A mid-turn Approval mode change never interrupts the running turn; it takes effect with zero lost conversation messages once the session next goes idle.
- **SC-010**: The low-memory warning appears within 10 seconds of free memory falling below the threshold, and stopping an agent from it frees that agent's memory without changing the session's saved conversation.

## Assumptions

- The user is one developer on Windows 11 with git and the agent (OMP 18.4.x) installed and signed in; other platforms, other agent versions, and multi-user use are out of scope.
- The user's existing agent skills, extensions, and MCP servers apply to every session unchanged.
- Worktrees are created in a folder next to the repository (`<repo>/../pinion-worktrees/<repo>/<generated-name>`), following the one-worktree-per-session convention of GitHub Copilot desktop; the same generated name is used for the session's branch. The user does not choose either name at creation, only the Base branch and, afterward, the session's display label.
- Ending a session normally means Archive: it hides the session from the main list while keeping its worktree and conversations, and is reversible from an archived view. Delete is a separate, explicit action that only proceeds after a confirmation naming the uncommitted changes and unpushed commits that will be lost.
- Model choice, thinking level, and other agent settings come from the agent's own configuration; a settings screen for those is out of scope, though the single Approval mode setting described here is in scope.
- The right pane (git changes, file browser, side chat), plan mode, forking sessions, image attachments, and subagent progress views are out of scope and get their own specs. Pinion's own git use in this spec is limited to creating and deleting worktrees, listing branches, and reading status to warn before a delete; commit, push, and pull-request controls and the changes pane belong to that later spec, and until then those actions happen only by asking the agent in chat.
- Sessions are only started when the user opens them, not when Pinion starts. A cold start took about 16 seconds to the first answer token on the reference machine (3 runs, 2.2 to 3.9 seconds to ready).
- Each live session costs roughly 1.1 to 1.7 GB on the reference machine, mostly the developer's own tool servers running under the agent, and about 1.9 GB while answering. Pinion does not limit live agents (a decision by the developer); it warns when memory is low and lets the developer stop agents.
- Approval mode sits on top of the agent's own per-tool settings: a tool the developer has configured to always prompt (or deny) in the agent's own configuration still prompts (or is denied) even in Auto.
- A killed Pinion cannot clean up after itself. The transport spike found that the agent and its tool servers exit within seconds when their parent is killed, but a subprocess the agent launched for a tool keeps running. The plan therefore puts every agent in a kill-on-close process group (a Windows Job Object), which was proven to stop the whole tree.
- The prototype phase applies (see the constitution): verification is by running the app and exercising the scenarios above, not by an automated suite.

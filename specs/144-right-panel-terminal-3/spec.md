# Feature Specification: Right-panel terminal

**Feature Branch**: `spec/3-terminal` (spec only; the implementation branch is cut later)

**Created**: 2026-11-28

**Status**: Draft

**Input**: User description: "Issue #3, epic #2227 (Right panels): a built-in terminal in the right pane, with tabs and several shells per Session. PowerShell by default, falling back to the OS command interpreter. Shells run in the background. Closing Refract ends every shell; relaunch brings the tabs back as fresh shells. Scrollback is never written to disk. No output reaches the model automatically; the context menu has \"Add to chat\" and \"Ask agent about this\". Split view and app-wide terminals are refused. Grilled 2026-11-10 (Stuart); Away Mode decisions 2026-11-28."

## Epic context

Epic #2227 groups the right-pane panels. The open v1 children are #3 (this feature), #391 (FDB Agent Builder), #392 (FDB Knowledge Base), #463 (file explorer with preview and Open in VS Code), #470 (edit files in the right pane with AI assist), #478 (Jira side panel), #878 (Markdown editor), and the polish follow-ups #1232, #1248, #1308, #1521, #2106 and #2151. This feature owns the Terminal panel only. It MUST NOT absorb: file editing or preview (#463, #470, #878), the rail and tab-strip polish (#1248, #2151, #2106), the other panels (#391, #392, #478), or the `@terminal` mention (#465).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run commands next to the chat (Priority: P1)

A developer opens the Terminal panel in the right pane of a Session and gets a working shell in that Session's working folder. They type commands such as `pnpm test` or `git status`, see the output as it streams, and resize the pane without garbling the display.

**Why this priority**: This is the whole point of the feature; every other story builds on a working shell.

**Independent Test**: With one Session open, open the Terminal panel, run `Get-Location` and a command that prints for several seconds, drag the pane wider. The shell starts in the Session's folder, output streams, and the display re-wraps to the new width.

**Acceptance Scenarios**:

1. **Given** a Session with a working folder and no Terminal tab, **When** the developer opens the Terminal panel, **Then** one Terminal tab starts a shell in that folder and accepts input within 2 seconds.
2. **Given** a running shell, **When** the developer types a command and presses Enter, **Then** the output appears in the tab as the shell produces it, including colour and cursor movement.
3. **Given** a running shell, **When** the developer resizes the right pane, **Then** the shell's reported columns and rows change to match the visible area.
4. **Given** PowerShell 7 is not installed, **When** a tab opens, **Then** the shell is Windows PowerShell; **Given** neither is available, **Then** the tab uses the OS command interpreter (`%COMSPEC%`).

---

### User Story 2 - Several tabs per Session that keep running (Priority: P1)

A developer opens several Terminal tabs in one Session (a dev server, a test watcher, a scratch shell), switches between them, and switches to other Sessions and back. Nothing stops, and what was on screen is still there.

**Why this priority**: Long-running dev servers are the main reason to keep a terminal beside the chat; losing them on a Session switch would make the panel unusable.

**Independent Test**: Start a server in tab 1, open tab 2, switch to another Session and back, reload the window. The server still runs and tab 1 still shows its earlier output.

**Acceptance Scenarios**:

1. **Given** a Terminal tab, **When** the developer adds a new tab, **Then** a second independent shell starts in the same folder and becomes the active tab.
2. **Given** a tab running a command, **When** the developer switches to another tab, another Panel, or another Session, **Then** the command keeps running and its output keeps being captured.
3. **Given** a tab that has produced output, **When** the developer returns to it after a Session switch or a renderer reload, **Then** the earlier output (up to the scrollback bound) is shown again.
4. **Given** two Sessions each with Terminal tabs, **When** the developer views one Session, **Then** only that Session's tabs are shown.
5. **Given** a tab, **When** the developer renames it, **Then** the new name shows in the tab strip and survives a restart.

---

### User Story 3 - Tabs end cleanly and come back after a restart (Priority: P2)

A developer closes tabs they no longer need, is protected from killing a running job by accident, and after quitting Refract finds their tabs again as fresh shells.

**Why this priority**: Lifecycle correctness (no stray shells, no surprise kills) is a safety and trust requirement, but it follows the working shell.

**Independent Test**: Run a long command, close its tab, answer the confirmation; archive a Session with open tabs; quit Refract and confirm no shell process remains; relaunch and see the tabs.

**Acceptance Scenarios**:

1. **Given** a tab whose shell has a running child process, **When** the developer closes the tab, **Then** Refract asks to confirm and ends the shell only after the developer agrees.
2. **Given** a tab whose shell is idle at its prompt, **When** the developer closes the tab, **Then** it closes without a confirmation.
3. **Given** a Session with Terminal tabs, **When** the Session is archived or deleted, **Then** every one of its shells ends.
4. **Given** open Terminal tabs, **When** the developer quits Refract, **Then** no shell started by Refract is still running afterwards.
5. **Given** Terminal tabs existed at quit, **When** Refract relaunches, **Then** each Session shows its tabs again with the same names and working folders, each running a fresh shell.
6. **Given** any time during use, **Then** no terminal output or input is ever written to disk.

---

### User Story 4 - Bring terminal output to the agent on purpose (Priority: P2)

A developer hits a failing build in the terminal and sends the error to the agent, choosing what to send.

**Why this priority**: It makes the terminal useful for the agent workflow while keeping the developer in control of what the model sees.

**Independent Test**: Select error text in a tab, right-click, choose "Add to chat", and see a quoted block in the composer; run a failing command, right-click, choose "Ask agent about this", and see a turn sent with the output.

**Acceptance Scenarios**:

1. **Given** selected text in a tab, **When** the developer chooses "Add to chat", **Then** the selection is inserted into the Session's composer as a quoted block and nothing is sent.
2. **Given** a tab, **When** the developer chooses "Ask agent about this", **Then** a prompt carrying the chosen output is sent to the Session's agent.
3. **Given** a terminal printing output, **Then** nothing from it reaches the model unless the developer used one of the two actions.
4. **Given** the agent's own `bash` tool runs a command, **Then** that command does not run in, or appear in, any Terminal tab.

---

### User Story 5 - Understandable failures (Priority: P3)

A shell that cannot start, or that exits, tells the developer plainly and offers a way forward.

**Why this priority**: Failure states are rare but must not leave a blank, silent panel.

**Independent Test**: Make the working folder unavailable and open a tab; run `exit` in a tab.

**Acceptance Scenarios**:

1. **Given** a shell that exits on its own, **When** it ends, **Then** the tab shows that the shell ended, its exit code, and a "Restart shell" action.
2. **Given** a working folder that no longer exists, **When** a tab tries to start, **Then** the tab shows a plain error naming the folder and offers "Restart shell".

---

### Edge Cases

- A command prints very fast (for example `yes` or a large log): the renderer stays responsive and memory stays bounded.
- A command prints a very long line or binary garbage: the display does not freeze, and the retained scrollback stays within its bound.
- The Personal Agent Session has no worktree: its Terminal tabs start in the Session's home folder.
- A Session's worktree is removed while a tab is running: the tab shows the shell's own errors, and the Session ending ends the shell.
- Many tabs: each shell is a real process, so the number of tabs per Session has an upper bound.
- The renderer reloads while shells are running: shells and their buffered output survive; the renderer reattaches.
- Paste of multi-line text containing control characters: the paste does not run unseen commands without the terminal's normal paste handling.
- Two Refract windows: Refract is single-instance, so one set of shells exists.

## Requirements *(mandatory)*

### Functional Requirements

**Panel and placement**

- **FR-001**: The Terminal MUST be a **Panel** in the right pane, reached from [NEEDS CLARIFICATION: its own icon-rail button and panel, or a mode inside an existing panel?].
- **FR-002**: The panel MUST follow the existing panel conventions: open and close as a whole, appear in the **Panel order** and the panel launcher, keep position and width across restarts, and be reachable by keyboard.
- **FR-003**: The panel MUST show one tab strip of the active Session's Terminal tabs, with a control to add a tab.

**Shells**

- **FR-004**: Refract MUST start each tab's shell in the Session's working folder (the Personal Agent's home folder when it has no worktree).
- **FR-005**: The shell MUST be chosen in this order: PowerShell 7 (`pwsh.exe`) if installed, then Windows PowerShell, then the OS command interpreter named by `%COMSPEC%`.
- **FR-006**: Shells MUST be hosted by the Rust backend; the renderer MUST only display them and MUST NOT start any process.
- **FR-007**: Input, output, colour, cursor movement, bracketed paste and window resizes MUST work as in a normal terminal, and the shell's size MUST follow the visible area.
- **FR-008**: A shell MUST keep running while its tab is not shown, while another Panel is open, while another Session is shown, and while the right pane is collapsed.
- **FR-009**: A Session MUST NOT exceed a fixed maximum number of Terminal tabs; adding past the maximum MUST say why it cannot.

**Scrollback**

- **FR-010**: Each tab's output MUST be retained in a bounded in-memory buffer in the Rust backend [NEEDS CLARIFICATION: scrollback bound and whether it survives Session switch and renderer reload].
- **FR-011**: Scrollback, input and any other terminal content MUST NOT be written to disk by Refract, including in logs, crash reports and the saved tab list.

**Lifecycle**

- **FR-012**: Closing a tab MUST end its shell and every process it started.
- **FR-013**: Closing a tab [NEEDS CLARIFICATION: confirm when a child process is running?].
- **FR-014**: Archiving or deleting a Session MUST end all of its shells; restoring an archived Session MUST NOT revive them.
- **FR-015**: Quitting Refract, by any route, MUST end every shell and its children.
- **FR-016**: Relaunching MUST restore each Session's tabs (name, working folder, shell kind, order) as fresh shells; it MUST NOT restore scrollback or running processes.
- **FR-017**: When a shell exits, its tab MUST stay open, state that the shell ended with its exit code, and offer "Restart shell".

**Agent access**

- **FR-018**: No terminal output MUST reach the model without a developer action.
- **FR-019**: The tab's context menu MUST offer **Add to chat**, which inserts the selected text into the Session's composer as a quoted block without sending.
- **FR-020**: The tab's context menu MUST offer **Ask agent about this**, which sends a prompt with the chosen output to the Session's agent. [NEEDS CLARIFICATION: what is "the chosen output" when nothing is selected?]
- **FR-021**: Output sent to the agent MUST be size-capped, and the developer MUST see that it was truncated when it is.
- **FR-022**: The agent's own `bash` tool MUST NOT run through the Terminal.

**Security and privacy**

- **FR-023**: The feature MUST fit the Tauri security baseline: no new webview capability, no shell or process plugin permission for the renderer, no CSP relaxation, and renderer-callable surface limited to an explicit allow-list.
- **FR-024**: Terminal requests MUST be refused from any window other than the main window and MUST be validated in Rust (Session exists, tab belongs to the Session, size and rate limits).

**Out of scope for v1**

- **FR-025**: The v1 Terminal MUST NOT offer split view, an app-wide terminal that is not tied to a Session, per-repo shell profiles, or an `@terminal` mention.

### Key Entities *(include if feature involves data)*

- **Terminal tab**: One shell in one Session. Has a Session, a display name, a working folder, a shell kind, an order, and a state (starting, running, ended with an exit code).
- **Scrollback**: The bounded, in-memory record of a tab's recent output. Never persisted.
- **Saved tab record**: The only persisted data: Session id, tab name, working folder, shell kind, order. No content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer sees a usable prompt within 2 seconds of opening the panel on a Session with no tabs.
- **SC-002**: After quitting Refract by any route, zero shell processes started by Refract remain.
- **SC-003**: A tab producing continuous output keeps the app's other interactions responsive, and a tab's memory use stays under its stated scrollback bound.
- **SC-004**: After a Session switch or a window reload, each tab shows its earlier output again.
- **SC-005**: No file written by Refract (data folder, logs, crash dumps) contains terminal output, checked by a scan after a session that printed a known marker string.
- **SC-006**: In a Session where the developer used neither context-menu action, no model request contains terminal output.

## Assumptions

- Windows 11 only for v1 (Constitution); `portable-pty`'s other platforms are not exercised.
- Refract is single-instance, so one set of shells exists at a time.
- The renderer draws the terminal; how it is drawn is a plan decision (ADR 0016 records the stack).
- The tab strip reuses the existing right-pane tab conventions.
- The `@terminal` mention is tracked in #465 and not part of this feature.

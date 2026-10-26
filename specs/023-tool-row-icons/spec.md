# Feature Specification: Tool-row icons with the intent or verb as the label

**Feature Branch**: `stuarthopwood-feat-469-tool-row-icons`
**Created**: 2026-10-26
**Status**: Draft
**Input**: Issue #469: "Show an icon with a verb tooltip instead of raw tool names on tool call rows." Grilled 2026-10-26 (Stuart, grill-with-docs); Specify route chosen over the triage comment's converge route. Builds on spec 022 (issue #1208, PR #1223), whose one shared verb map this feature extends. The MCP server and tool split is deferred to issue #1226.

## Clarifications

### Session 2026-10-26 (Stuart's grill; binding)

- Q: Which Spec Kit route does #469 take? → A: A new spec, `specs/023-tool-row-icons`, on the full Specify route (specify, clarify, plan, tasks, analyze, implement), not a converge on spec 001.
- Q: Where do the tool icon and the status icon sit on a row? → A: The tool icon leads and takes the row's icon slot. The status icon (spinner, check, cross and the other status icon states) moves to the trailing status and duration slot. Status is never shown by colour alone.
- Q: Does a row ever show a raw tool name? → A: No. The visible label stays (the intent or the verb). The raw tool id lives in the tool icon's tooltip, from the shared tooltip component, shown on hover and on keyboard focus. `grep` rows drop the leading `grep` from their summary: the verb, then the pattern ("Searched text" `"pattern"`). This supersedes spec 022's 2026-10-26 decision that `bash` and `grep` rows show no verb label: both now show a verb, and spec 022 carries a note pointing here.
- Q: What does a `bash` row show? → A: The terminal (command prompt) icon, "Running" while running and "Ran" when done, then the command without the `$` prefix.
- Q: Which tools get an icon and verb? → A: The one verb map from spec 022 is extended, each tool with a distinct icon: read FileText Reading/Read; edit Pencil Editing/Edited; write FilePlus Writing/Wrote; bash Terminal Running/Ran; eval Braces Running code/Ran code; grep TextSearch Searching text/Searched text; find and glob FolderSearch Finding files/Found files; ast_grep ScanSearch Searching code/Searched code; ast_edit Replace Rewriting code/Rewrote code; lsp Waypoints Querying code/Queried code; task Users Delegating/Delegated; ask MessageCircleQuestion Asking/Asked; web_search Globe Searching web/Searched web; github Github (or a fallback if the icon set lacks it); debug Bug Debugging/Debugged; recall, retain and reflect Database Recalling/Recalled, Remembering/Remembered, Reflecting/Reflected; generate_image Image Generating image/Generated image; a skill read (`skill://`) keeps Using skill/Used skill with its own icon; thinking is unchanged. An MCP tool (`mcp__*`) shows the Plug icon and its humanised raw name. An unknown tool shows the Wrench icon and its raw name in sentence case. The exact verb wording for the extra tools is the worker's call within this pattern, flagged for review.
- Q: Does #469 split an MCP tool into server and tool? → A: No. Deferred to issue #1226. #469 shows the Plug icon and the humanised raw name.
- Q: Can a user still see the raw tool names on rows? → A: Yes, through a Settings switch "Show tool names on rows", next to the #457 chat toggles, off by default. On: the raw tool id shows muted next to the label ("Searched text grep"). Off: the label only.
- Q: What does a `write` to `xd://<tool>` show? → A: That tool's icon and verb.
- Q: What do the approval card and subagent rows show? → A: The approval card shows the tool icon beside its raw id; its "Allow tool: bash" text is unchanged, consistent with spec 022. Subagent rows keep the agent's name as their label and gain the Delegate (`task`) icon.
- Q: Does `wait` join the map? → A: Yes: the Hourglass icon, Waiting/Waited, and a summary that says what it waits for. Its animation stays with #566 and its colours with #570.
- Q: What is the row's label when the model states its intent? → A: OMP sends a model-written intent on the tool start frame (for example "Reading README.md"), and history keeps it as the call's `i` argument. When a call has an intent, the row reads: tool icon, the intent, the muted target, then the trailing status icon. The verb is the fallback when there is no intent. The intent is untrusted model text: plain text only, never markup. The transcript does not carry the intent today, so this needs the session backend and the shared transcript model to carry it.
- Q: When a failed, stopped or interrupted call has no intent, what does its label say? → A: A plain base form from the one verb map (for example "Search text", "Run", "Edit", "Run code"), so rows never show a raw tool name and never claim work that did not happen; the status prefix in the accessible name and the trailing status icon say what happened. Each map entry gains this third form; an unmapped tool still falls back to its sentence-case name. (Stuart, 2026-10-26; supersedes the clarify step's "sentence-case tool name" answer below and the visible-label part of spec 022's "What does a call that did not complete show?" answer.)

### Session 2026-10-26 (Skippy's own calls during the grill; not grilled, flag for review)

- Q: What does a group of calls to one tool read? → A: Decided (Skippy; flag for review): the shared tool's verb ×N ("Searched text ×3"), with the shared tool's icon; each member row shows its own intent (or its verb when it has none).
- Q: What is a tool row's accessible name? → A: Decided (Skippy; flag for review): spec 022's status-prefix rule, then the label (intent or verb), then the target. The tooltip is supplementary and never the only carrier of any information.
- Q: What does the tool icon's tooltip say? → A: Decided (Skippy; flag for review): the raw tool id, for example `grep`, `mcp__mcp_atlassian_jira_search`, or `write xd://ast_grep`.
- Q: Does the tool-call dialog title change? → A: Decided (Skippy; flag for review): no. It keeps the raw tool id (spec 022's decision stands).

### Session 2026-10-26 (clarify step run by a worker; Stuart was not reachable, so every answer is resolved from the issue and the code and flagged for review)

- Q: How does a row's tooltip open from the keyboard without adding a tab stop to every row? → A: Decided (worker, from code; flag for review): the row is already one focusable disclosure control, and a focusable control cannot nest inside it. The tooltip opens when the pointer hovers the tool icon and while the row's own control has keyboard focus; the icon adds no tab stop and is hidden from assistive technology, because the accessible name already carries the label.
- Q: What does a call that did not complete show when it has no intent? → A: Superseded by Stuart's binding answer of 2026-10-26 (Clarifications, first block): the call shows its map entry's base form ("Search text", "Run"), not the tool's name in sentence case; only an unmapped tool still shows its sentence-case name. Unchanged from the original answer: never a past-tense verb, so the row never claims work that did not happen; the tool icon and the status icon still show; a call with an intent shows the intent in every status.
- Q: How is an MCP tool's raw name humanised? → A: Decided (worker, from issue comments; flag for review): the leading `mcp__` is removed and the rest is put in sentence case with spec 022's rule (underscores and hyphens become spaces, first letter capitalised): `mcp__mcp_atlassian_jira_search` reads "Mcp atlassian jira search". The name is never split into server and tool (#1226).
- Q: What icon and verb does the `github` tool get? → A: Decided (worker, from code; flag for review): the installed icon set (lucide-react 1.49.0) has no GitHub brand icon, so the fallback is the GitPullRequest icon the app already uses for GitHub surfaces, with Querying GitHub/Queried GitHub.
- Q: Which icon does a skill read use? → A: Decided (worker, from code; flag for review): BookOpen, the icon the "Skill invoked" row already uses.
- Q: Where does the raw tool id sit when "Show tool names on rows" is on, and is it announced? → A: Decided (worker; flag for review): immediately after the label and before the target, muted, in the same text style as the target. It is part of the accessible name only while the switch is on, so the name always matches what is shown.
- Q: What colour is the tool icon on a failed call? → A: Decided (worker, from #570 and spec 022; flag for review): the tool icon follows the label's colour, so it takes the error colour with the label on failure; the trailing status icon keeps its own #570 shape and colour. Every other state keeps the icon muted.
- Q: How are `write` calls to `xd://<tool>` grouped and shown when the tool is unknown? → A: Decided (worker; flag for review): such a call is displayed as the target tool everywhere (icon, verb, group label) and never merges into a group with plain `write` calls or with a different target tool; an unknown target tool takes the Wrench icon and its sentence-case name. The tooltip reads `write xd://<tool>`.
- Q: What does a `wait` row's summary say? → A: Decided (worker; flag for review): the call's target, the jobs or agents it waits for, shown where every other row shows its target; no new text is invented.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recognise each tool call at a glance (Priority: P1)

A developer scans a long transcript and recognises reads, edits, commands, searches and delegations by a leading icon and a plain-words label, instead of raw lowercase tool ids such as `grep` and `bash`.

**Why this priority**: Raw tool ids read as debug output, and a column of identical status icons gives the eye nothing to anchor on. The icon slot is the most visible place to say what kind of work a row is.

**Independent Test**: Run a turn that reads, edits, writes, runs a command, searches text and finds files; check every row's leading icon, its label, and the status icon at the end of the row as each call runs and finishes.

**Acceptance Scenarios**:

1. **Given** a `read` call with no intent, **When** it runs, **Then** the row shows the FileText icon first, then "Reading", the muted target and a running status icon at the end; **When** it finishes, **Then** the label reads "Read" and the status icon shows done.
2. **Given** a `bash` call, **When** it renders, **Then** the row shows the Terminal icon, "Running" or "Ran", and the command with no `$` prefix.
3. **Given** a `grep` call, **When** it renders, **Then** the row reads "Searching text" or "Searched text", then the quoted pattern and the path, with no leading `grep`.
4. **Given** a tool in the map (FR-003), **When** it renders, **Then** it shows its own icon and its running or done verb.
5. **Given** an MCP tool `mcp__mcp_atlassian_jira_search`, **When** it renders, **Then** it shows the Plug icon and "Mcp atlassian jira search".
6. **Given** a tool the map does not know, **When** it renders, **Then** it shows the Wrench icon and its name in sentence case.
7. **Given** a failed call, **When** it renders, **Then** the trailing status icon shows the failed shape, so the state does not depend on colour; **and** when the call has no intent, its label is the base form (a failed `grep` reads "Search text", a failed `bash` reads "Run"), never the raw tool id.

### User Story 2 - Read what the agent meant to do (Priority: P1)

A developer reads the model's own one-line intent on each tool row ("Reading README.md", "Checking the build output") in place of a generic verb, as the GitHub app shows it.

**Why this priority**: The intent says why the call was made, which a verb cannot; it is the label Stuart chose from the GitHub app's transcript.

**Independent Test**: Run a turn in which the model states intents; check that live rows and the same rows reopened from history both show the intent, and that a call without an intent falls back to the verb.

**Acceptance Scenarios**:

1. **Given** a call that arrives live with an intent, **When** it renders, **Then** the row shows the tool icon, the intent, the muted target and the trailing status icon.
2. **Given** the same Conversation reopened from history, **When** it renders, **Then** the same rows show the same intents.
3. **Given** a call without an intent, **When** it renders, **Then** the label is the tool's verb (FR-003).
4. **Given** an intent containing markup, a link, control characters or a bidirectional override, **When** it renders, **Then** it shows as plain text on one line with the control and override characters removed, and nothing in it is clickable.
5. **Given** a group of three `grep` calls, **When** it renders, **Then** the group reads "Searched text ×3" with the TextSearch icon, and each member shows its own intent.

### User Story 3 - Find the raw tool name when it matters (Priority: P2)

A developer debugging a session needs the exact tool id: they hover or focus a row to see it in a tooltip, or turn on "Show tool names on rows" to see it on every row.

**Why this priority**: The raw id still matters for debugging and for MCP tools, but it is secondary to the label, so it moves out of the default view without being lost.

**Independent Test**: Hover a row's icon, then tab to a row; then turn the Settings switch on and off and watch the rows update.

**Acceptance Scenarios**:

1. **Given** any tool row, **When** the pointer hovers its icon, **Then** a tooltip shows the raw tool id (`grep`, `mcp__mcp_atlassian_jira_search`, `write xd://ast_grep`).
2. **Given** keyboard focus moves to a tool row, **When** the row has focus, **Then** the same tooltip shows, and no extra tab stop was added for the icon.
3. **Given** "Show tool names on rows" is turned on, **When** the transcript renders, **Then** every tool row shows its raw id muted after the label ("Searched text grep"); **When** it is turned off, **Then** the ids disappear at once, with no reload.
4. **Given** a fresh install, **When** Settings opens, **Then** the switch sits with the chat display toggles and is off.

### User Story 4 - The same icons beyond tool rows (Priority: P3)

A developer sees the same tool icon on the approval card and on subagent rows, so the visual language is the same wherever a tool appears.

**Why this priority**: Consistency across surfaces; less visible than the transcript rows.

**Independent Test**: Trigger a tool approval in Ask mode and start a subagent batch; check both surfaces.

**Acceptance Scenarios**:

1. **Given** a tool approval request for `bash`, **When** the card shows, **Then** the Terminal icon sits beside "Allow tool: bash", whose text is unchanged.
2. **Given** a subagent row, **When** it renders, **Then** it keeps the agent's name as its label and shows the Users (Delegate) icon.
3. **Given** a `wait` call, **When** it renders, **Then** it shows the Hourglass icon, "Waiting" or "Waited", and what it waits for.

### Edge Cases

- A call with an intent that later fails keeps its intent as the label; the status icon and the accessible name's status prefix ("Failed ...") carry the failure.
- A call with no intent that does not complete shows its map entry's base form ("Search text", "Run"); the status prefix in the accessible name ("Failed Search text ...") and the trailing status icon say what happened. An unmapped tool shows its sentence-case name (see Clarifications).
- An intent longer than the row truncates with an ellipsis like the summary does; the full intent is in the accessible name and the expanded row.
- An empty or whitespace-only intent counts as no intent, so the verb shows.
- A `write` to `xd://<tool>` for an unknown tool shows the Wrench icon and that tool's sentence-case name; its tooltip reads `write xd://<tool>`.
- A skill read (`skill://`) stays its own row and grouping boundary (#543) and shows BookOpen with Using skill/Used skill.
- A thought row is unchanged: no tool icon is added.
- At 360 px width the tool icon, the label and the trailing status icon stay visible; the target and the raw id (when shown) truncate first.
- In forced-colours (high contrast) mode the tool icon and the status icon both stay visible and the status keeps its distinct shape.
- An MCP tool whose name after `mcp__` is empty reads "Tool" (spec 022's empty-name rule).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every tool row and tool group row MUST show the tool's icon in the leading icon slot, and the status icon (running, done, failed, interrupted, cancelled, agent exited) in the trailing status and duration slot. Each status MUST keep a distinct shape, so status is never conveyed by colour alone.
- **FR-002**: The tool's icon, running verb and done verb MUST come from the one shared verb map introduced by spec 022, extended with an icon per entry. The tool rows, group rows, tooltip, approval card and subagent rows MUST all read it; there MUST be no second map.
- **FR-003**: The map MUST hold these entries (tool: icon, running form / done form / base form): `read` FileText Reading/Read/Read; `edit` Pencil Editing/Edited/Edit; `write` FilePlus Writing/Wrote/Write; `bash` Terminal Running/Ran/Run; `eval` Braces Running code/Ran code/Run code; `grep` TextSearch Searching text/Searched text/Search text; `find` and `glob` FolderSearch Finding files/Found files/Find files; `ast_grep` ScanSearch Searching code/Searched code/Search code; `ast_edit` Replace Rewriting code/Rewrote code/Rewrite code; `lsp` Waypoints Querying code/Queried code/Query code; `task` Users Delegating/Delegated/Delegate; `ask` MessageCircleQuestion Asking/Asked/Ask; `web_search` Globe Searching web/Searched web/Search web; `github` GitPullRequest Querying GitHub/Queried GitHub/Query GitHub; `debug` Bug Debugging/Debugged/Debug; `recall` Database Recalling/Recalled/Recall; `retain` Database Remembering/Remembered/Remember; `reflect` Database Reflecting/Reflected/Reflect; `generate_image` Image Generating image/Generated image/Generate image; `wait` Hourglass Waiting/Waited/Wait; skill read BookOpen Using skill/Used skill/Use skill. Thinking keeps spec 022's entry with no tool icon and needs no base form. These values replace spec 022's `grep` and `find` entries (Searching/Searched). The running form is used while running, the done form when done, and the base form for every status that did not complete (error, interrupted, cancelled, agent exited).
- **FR-004**: An MCP tool (id starting `mcp__`) MUST show the Plug icon and its humanised raw name: the `mcp__` prefix removed, then spec 022's sentence-case rule. The name MUST NOT be split into server and tool (issue #1226).
- **FR-005**: A tool not in the map and not an MCP tool MUST show the Wrench icon and its raw name in sentence case (spec 022's rule).
- **FR-006**: When "Show tool names on rows" is off, no tool row or group row MUST show a raw tool id in its label or summary. A `bash` row's summary is the command with no `$` prefix; a `grep` row's summary is the quoted pattern and the path, with no leading `grep`.
- **FR-007**: When a call has a non-empty intent, its row's label MUST be the intent; otherwise the label MUST be the map form for its status (FR-003): the running form, the done form, or, for a call that did not complete, the base form. A tool with no map entry uses its sentence-case name in every status (FR-004, FR-005).
- **FR-008**: The intent MUST be read from the live tool start frame (top-level `intent`, then `args.i`, then `args.intent`) and from the call's `arguments.i` (then `arguments.intent`) in a message snapshot or history, and MUST be carried by the shared transcript model so live and reopened rows show the same label. An empty or whitespace-only value counts as absent. Both field shapes are recorded in `docs/spike/FINDINGS.md` item 64 (verified 2026-10-26 on OMP 18.12.6 and on session files written by 18.12.x; constitution Principle IV); an OMP version that sends neither field shows the verb fallback.
- **FR-009**: The intent MUST render as plain text only: never as markup or a link, on one line, with control characters and bidirectional override characters removed, trimmed, truncated with an ellipsis when it does not fit, and capped at 400 characters (the same cap the readout already applies to the intent).
- **FR-010**: A row MUST read, left to right: the tool icon, the label (intent or verb), the raw tool id when the setting is on (muted), the muted target or summary, then the trailing status icon and duration.
- **FR-011**: The tool icon MUST carry a tooltip whose text is the raw tool id (for a `write` to `xd://<tool>`, `write xd://<tool>`). It MUST open on pointer hover over the icon and while the row's own control has keyboard focus, MUST NOT add a tab stop, and MUST NOT be the only carrier of any information.
- **FR-012**: Settings MUST offer a switch "Show tool names on rows" beside the chat display toggles from #457, off by default, applied immediately with no Save step, and persisted across restarts. When on, every tool row and group row shows its raw tool id muted after the label.
- **FR-013**: A `write` call whose target is `xd://<tool>` MUST show that tool's icon and verb (or the Wrench icon and sentence-case name for an unknown tool), and MUST NOT group with plain `write` calls or with calls to a different target tool.
- **FR-014**: A group row of calls to one tool MUST read "<verb> ×N" with the shared tool's icon, using the group's running or settled form (spec 022's group rule); each member row MUST show its own label per FR-007.
- **FR-015**: A tool row's accessible name MUST be spec 022's status prefix (only where the label cannot carry the status), then the label, then the raw tool id while the setting is on, then the target. The tool icon MUST be hidden from assistive technology.
- **FR-016**: The approval card MUST show the tool's icon beside its title; the title text ("Allow tool: <raw id>") MUST NOT change.
- **FR-017**: A subagent row MUST keep the agent's name as its label and show the `task` (Users) icon in its leading slot.
- **FR-018**: A `wait` row's summary MUST be the call's target (what it waits for). Its animation (#566) and its success and failure colours (#570) are out of scope.
- **FR-019**: The tool-call dialog title MUST keep the raw tool id (spec 022's decision).
- **FR-020**: The tool icon MUST meet 3:1 non-text contrast against the row background in every built-in theme, using theme colour tokens. It is muted in every state except failure, where it takes the error colour with the label; the trailing status icon keeps its own #570 shape and colour.
- **FR-021**: The tool icon, its tooltip and the Settings switch MUST be built from shared components in `src/renderer/components/` (the shared tooltip, the shared setting switch row, and one shared tool icon component that reads the map), extended with a prop where a new use case needs one; no feature-folder copy or hand-styled primitive.
- **FR-022**: Thought rows, the status icon shapes and colours, and the duration display MUST NOT change.

### Key Entities

- **Tool display entry**: a tool id with its icon, running form, done form and base form; one entry per tool in the shared verb map.
- **Intent**: a short, model-written, untrusted description of one tool call, taken from the live start frame or the history `i` argument; optional per call.
- **Tool names setting**: the "Show tool names on rows" switch; a boolean, off by default, persisted with the other chat display settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the setting off, a session that uses every mapped tool, an MCP tool and an unknown tool shows zero raw tool ids in its rows' visible text, in every status, except the sentence-case names of unknown and MCP tools.
- **SC-002**: Every tool in FR-003 shows its own icon; only `find`/`glob` and `recall`/`retain`/`reflect` share one by design.
- **SC-003**: A user finds any row's raw tool id in one hover or one keyboard focus, with no added tab stops in the transcript.
- **SC-004**: The tool icon meets 3:1 contrast against its row in all five built-in themes.
- **SC-005**: At 360 px width every tool row keeps its tool icon, label and status icon visible.
- **SC-006**: Toggling "Show tool names on rows" changes every visible row within one second, with no reload.
- **SC-007**: A Conversation reopened from history shows the same labels (intent or verb) as it did live.

## Assumptions

- The five built-in themes are the ones in the theme picker today.
- The icon names in FR-003 exist in the installed icon set (lucide-react 1.49.0, checked 2026-10-26); GitHub has no brand icon there, hence GitPullRequest.
- OMP sends the intent on the tool start frame, as the session backend already reads it for the readout, and history keeps it as the call's `arguments.i`; both are recorded in `docs/spike/FINDINGS.md` item 64 (FR-008).
- The MCP server and tool split (#1226), the `wait` animation (#566) and the success and failure colours (#570) are separate issues.
- The tool row source file is at 598 of its 600-line cap, so the map, the icon component and any new row logic live in their own modules (no-god-files rule, #806).
- No new tests while prototyping (rule of 2026-10-08); behaviour is verified live.

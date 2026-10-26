# Feature Specification: Lighter font weights and sentence-case action verbs

**Feature Branch**: `stuarthopwood-feat-1208-font-weights-verbs`
**Created**: 2026-10-26
**Status**: Draft
**Input**: Issue #1208: "UI polish: Chat and app-wide: lighter font weights (labels at 400, one weight scale) and sentence-case action verbs." Grilled 2026-10-23 (Stuart, grill-with-docs; UX architect consulted, Flow, Visual and Layout specialists unanimous); all questions resolved, none deferred.

## Clarifications

### Session 2026-10-23 (Stuart's grill; binding)

- Q: How heavy are the transcript's action labels? → A: Regular (400). Tool, thought, Stage, agent-message and advisory labels drop from medium (500) to regular. Hierarchy comes from colour (label in the body colour, summary muted), not weight. Only error rows and real headings may be heavier. 450 is rejected: the app font is Segoe UI Variable, and static Segoe UI on Windows 10 has no 450, so it renders inconsistently.
- Q: What do the action labels say? → A: A sentence-case verb from one shared map, present tense while running and past tense when done: Reading/Read, Editing/Edited, Writing/Wrote, Running/Ran, Searching/Searched, Thinking/Thought process. A tool the map does not know (an MCP or extension tool) falls back to its own name in sentence case. Issue #469 (icon plus verb tooltip) reuses the same map. Trailing colons on labels are removed ("Skill invoked:", "Asked user:").
- Q: Is there a separate weight for dark themes? → A: No. One weight scale on every theme: 400 for body text, labels, metadata, muted section labels, badges and ghost buttons; 500 for buttons, selected states and in-chat headings; 600 for page titles only (for example the Settings section headings); 700 for brand text only (the Refract wordmark). The scale is recorded in the design foundations.
- Q: Which places change? → A: The named offenders in the issue (chat header badge, role option, pull request filter tabs, role-cycle overlay, sidebar brand title, markdown headings, muted section labels in advisory, tool and tool-call views, the to-do tree group label, the sidebar ghost button), the shared row label and the transcript row labels, then every other medium or semibold use in the app checked against the scale. Shared components change in preference to individual call sites.
- Q: Does a lighter weight change accessibility results? → A: No. Contrast depends on colour only (weight matters only for the large-bold exception), so 400 does not change pass or fail. Muted text on raised muted surfaces, where contrast is lowest, is measured. Accessible names follow the new verb labels.
- Q: How heavy is the chat header's Session badge and the role option? → A: Decided (from issue #1208 grill 2026-10-23): the chat header's Session badge keeps its pill but drops uppercase and goes to 500; the role option's selected state goes to 500.

### Session 2026-10-26 (clarify step run by a worker; Stuart was not reachable, so every answer is resolved from the issue and the code and flagged for review)

- Q: What do `bash` and `grep` rows show, and what do screen readers hear? → A: Decided (worker, from code; flag for review): they keep no visible label (their command text is the summary, as today); their accessible name starts with the verb ("Ran npm test"). Every tool row's accessible name starts with its verb label; a status word stays as a prefix only when the tense cannot carry it (Failed, Interrupted, Cancelled, Agent exited), so a running row is never announced "Running Running".
  - Superseded by spec 023 (issue #469, Stuart's grill 2026-10-26): `bash` and `grep` rows now show a verb ("Ran", "Searched text"); see `specs/023-tool-row-icons/spec.md`.
- Q: What does a grouped row of calls to one tool read? → A: Decided (worker, from code; flag for review): "<verb> ×N" (for example "Ran ×3"), replacing "<tool> ×N"; the verb follows the group's own running or done state.
- Q: What replaces the colon labels? → A: Decided (worker, from code; flag for review): "Using skill:" becomes "Using skill" while running and "Used skill" when done; "Skill invoked:" becomes "Skill invoked"; "Asked user:" becomes "Asked user".
- Q: Do solo thought rows change? → A: Decided (worker, from code; flag for review): no. A solo thought row keeps "Thinking", "Thought for 3s" or "Thought"; the map supplies "Thinking" and "Thought process" for the run header and the solo "Thinking" label.
- Q: How is an unknown tool name put into sentence case? → A: Decided (worker, from code; flag for review): underscores and hyphens become spaces, repeated spaces collapse, and only the first letter is capitalised (`web_search` reads "Web search"); an empty result reads "Tool".
- Q: Does the scale raise a page title that is lighter than 600 today? → A: Decided (worker, from code; flag for review): no. The scale caps weights, it does not raise them: the Readiness heading stays 500 and the Readiness tagline keeps its brand-header weight.
- Q: Where else does a raw tool id show, and does it change? → A: Decided (worker, from code; flag for review): the live status announcement for a running tool ("Running bash") uses the verb ("Running"); the tool-call dialog title (`bash npm test`) and the approval card ("Allow tool: bash") keep the raw tool id, because they show the literal call being inspected or approved. A subagent row's label is the agent's own name, not a tool id, and is not mapped.
- Q: Which colons does the no-colon rule cover? → A: Decided (worker, from code; flag for review): only a row's visible label (the `CollapsedLine` label slot). Inline prefixes followed by their value on the same line ("Answer: " in the answered-question row, "Uses:" in Stage dependencies) and the screen-reader-only notice severity words ("Info:", "Warning:", "Error:" in `NoticeRow.tsx`) keep their colons, because there the colon separates a name from its value.
- Q: What does a call that did not complete show? → A: Decided (Skippy, quality gate 2026-10-26, accessibility and UI architect Mediums): the past-tense verb only for `done`. A failed, interrupted, stopped or agent-exited call shows its tool name in sentence case ("Edit", "Grep"), with the status word first in the accessible name ("Failed Edit foo.ts"), so it never claims work that did not happen. A multi-call group's verb tracks only running versus settled ("Ran ×2"); its failed and stopped counts carry the rest, with no status prefix. A running tool shown by its own name (unmapped) keeps "Running" first in its accessible name and live announcement, because its label has no tense. Advisory summaries are muted (FR-001); the severity colour stays on the label, icon and stripe. The link button variant is always underlined, since at 400 it is otherwise indistinguishable from body text.
## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the transcript without heavy labels (Priority: P1)

A developer reads a long agent transcript on a dark theme. Tool, thought, Stage, agent-message and advisory labels are the same weight as the reply text around them; the label stands out by its colour and position, not its weight.

**Why this priority**: Light text on dark backgrounds reads bolder, so medium labels make every row look shouted; the transcript is the screen used most.

**Independent Test**: Open a Session with tool calls, a thought run, a Stage and an advisory; compare the label weight against the reply text in each of the five themes.

**Acceptance Scenarios**:

1. **Given** a transcript with tool, thought, Stage, agent-message and advisory rows, **When** it renders, **Then** every row label is regular weight, in the body text colour, and its summary is muted.
2. **Given** a failed tool call, **When** it renders, **Then** its label and icon show in the error colour (unchanged from today) and the row's start position (icon then label) is unchanged.
3. **Given** a markdown reply with headings, **When** it renders, **Then** headings are medium (500), not semibold.
4. **Given** an expanded tool, tool-call dialog or advisory row, **When** it shows its muted section labels ("Prompt", "Result", "Guidance", "Location"), **Then** they are regular weight.

### User Story 2 - Read what the agent did in plain words (Priority: P1)

A developer scans the transcript and reads "Reading", "Edited", "Ran" and "Searched" rather than raw lowercase tool ids such as `read`, `edit` and `bash`.

**Why this priority**: Raw tool ids are inconsistent with the sentence-case thought rows and read as debug output.

**Independent Test**: Run a turn that reads, edits, writes and runs a command; watch each row's label change from present tense to past tense as it finishes.

**Acceptance Scenarios**:

1. **Given** a `read` call in progress, **When** it renders, **Then** the label reads "Reading"; **When** it finishes, **Then** it reads "Read".
2. **Given** `edit`, `write`, `bash` and `grep` or `find` calls, **When** they run and finish, **Then** they read Editing/Edited, Writing/Wrote, Running/Ran and Searching/Searched.
3. **Given** a tool the map does not know (for example an MCP tool `web_search`), **When** it renders, **Then** its label is the tool name in sentence case ("Web search").
4. **Given** a thought run, **When** it is live, **Then** it reads "Thinking"; **When** it settles, **Then** it reads "Thought process".
5. **Given** a skill or answered-question row, **When** it renders, **Then** its label has no trailing colon.
6. **Given** any of these rows, **When** a screen reader focuses it, **Then** its accessible name starts with the same verb label it shows.

### User Story 3 - One consistent weight scale across the app (Priority: P2)

A developer moves between the sidebar, Settings, pull requests, dialogs and the chat, and sees one weight scale: regular for text, labels, metadata and badges; medium for buttons, selected states and in-chat headings; semibold for page titles only; bold for the brand wordmark only.

**Why this priority**: Today some labels are 500 and some 600 for the same role; one scale removes the inconsistency, but the transcript (stories 1 and 2) is the visible win.

**Independent Test**: Walk every screen in the five themes and at 360 px width; every weight matches the scale table in the design foundations.

**Acceptance Scenarios**:

1. **Given** the pull request filter tabs, **When** a tab is selected, **Then** it is medium, the same as an unselected tab, so the row does not reflow.
2. **Given** the role picker, **When** an option is selected, **Then** it is medium (not semibold).
3. **Given** the chat header Session badge, **When** it renders, **Then** it is medium and not uppercase.
4. **Given** badges, field labels, muted section labels and ghost buttons anywhere in the app, **When** they render, **Then** they are regular weight.
5. **Given** a Settings section heading or a page title, **When** it renders, **Then** it is semibold; **Given** the Readiness wordmark, **Then** it is bold; no other text is bold or semibold.

### Edge Cases

- A label that is styled text rather than plain text (advisory severity words) still inherits the shared row label's regular weight.
- A row that drops its visible label (`bash` and `grep`) still announces the verb in its accessible name.
- A grouped row of calls to one tool shows the verb once, with the count.
- An unknown tool name that is empty or only punctuation falls back to "Tool".
- At 360 px width, labels at 400 are slightly narrower; the icon and label still start at the same column, and the summary truncates as before.
- Forced-colours (high contrast) mode keeps every non-colour cue it has today; weight is never the only cue for a state.
- Selecting a pull request tab no longer changes weight (tabs are medium whether selected or not). A role option still moves from regular to medium when selected, as decided; the live check confirms the shift is not visible.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every transcript row label (tool, thought, Stage, agent message, advisory, skill, answered question) MUST render at regular weight (400) in the body text colour, with its summary muted. Only error colouring and real headings may differ.
- **FR-002**: Tool and thought labels MUST come from one shared verb map with a present-tense form while running and a past-tense form when finished: read Reading/Read, edit Editing/Edited, write Writing/Wrote, bash Running/Ran, grep and find Searching/Searched, thinking Thinking/Thought process.
- **FR-003**: A tool missing from the map MUST show its own name in sentence case (underscores and hyphens become spaces; first letter capitalised); an empty result MUST read "Tool".
- **FR-004**: The verb map MUST be one module that the tool rows, the thought run row and issue #469's icon tooltip can all import; no second copy.
- **FR-005**: Transcript row labels MUST NOT end with a colon (inline name-value prefixes are out of scope; see Clarifications). The skill row reads "Using skill" while running and "Used skill" when done; the skill prompt row reads "Skill invoked"; the answered-question row reads "Asked user".
- **FR-006**: A row's accessible name MUST start with its visible verb label (label in name), and MUST NOT repeat the status as a second verb; a status word stays as a prefix only for Failed, Interrupted, Cancelled and Agent exited. Rows with no visible label (`bash`, `grep`) MUST still start their accessible name with the verb.
- **FR-007**: The app MUST use one weight scale on every theme, with no theme-specific weight token: 400 for body text, labels, metadata, muted section labels, badges and ghost buttons; 500 for buttons, selected states and in-chat headings; 600 for page titles only; 700 for the brand wordmark only.
- **FR-008**: The named offenders in issue #1208 MUST change as decided: chat header badge 600 uppercase to 500 sentence case; role option selected 600 to 500; pull request selected tab 600 to 500; role-cycle overlay 600 to 400; sidebar brand title 600 to 500; markdown headings 600 to 500; advisory, tool and tool-call muted section labels 500 to 400; to-do tree group label 500 to 400; sidebar ghost button 500 to 400.
- **FR-009**: Every other medium, semibold or bold use in the renderer MUST match the scale; the assignment is listed in the research inventory.
- **FR-010**: Weight changes MUST be made in shared components (row label, button, badge, tabs, menu labels) where one exists, rather than at each call site.
- **FR-011**: The design foundations MUST record the scale and the verb rule, replacing the current "medium weight" guidance for section labels.
- **FR-012**: Colour contrast results MUST be unchanged or better in every built-in theme, including muted text on raised muted surfaces.
- **FR-013**: A grouped row of calls to one tool MUST read "<verb> ×N", using the group's running or done form.
- **FR-014**: A solo thought row MUST keep its existing labels ("Thinking", "Thought for Ns", "Thought"); a thought run header MUST read "Thinking" while live and "Thought process" when settled, both from the verb map.
- **FR-015**: The live status announcement for a running tool MUST use the verb ("Running", "Reading"), not "Running <tool id>". The tool-call dialog title and the approval card keep the raw tool id.

### Key Entities

- **Verb entry**: a tool id with its running form and its done form (for example `read`: "Reading", "Read").
- **Weight role**: one of body, label, metadata, muted section label, badge, ghost button (400); button, selected state, in-chat heading (500); page title (600); brand (700).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No transcript row label is heavier than the reply text around it in any of the five built-in themes.
- **SC-002**: 100% of known tool rows show a sentence-case verb; no raw lowercase tool id is visible in the transcript.
- **SC-003**: Every medium, semibold or bold use in the renderer maps to a role in the scale; semibold appears only on page titles and bold only on the brand wordmark.
- **SC-004**: Colour contrast checks pass in every built-in theme with no new failure.
- **SC-005**: At 360 px width, every transcript row keeps its icon and label at the row's start, and selecting a pull request tab causes no text reflow; selecting a role option causes no visible reflow of neighbouring options.

## Assumptions

- The five built-in themes are the ones in the theme picker today; the scale applies to all of them and to any added later.
- Markdown bold (`strong`) inside replies is content, not chrome, and keeps the browser's bold.
- Existing `font-normal` uses that become redundant are left alone; removing them is not in scope.
- Uppercase muted section labels outside the named chat header badge (right-pane placeholder panels) get the weight change only; their case is a follow-up.
- Issue #469 is built later and only needs the map to exist.
- No new tests while prototyping (rule of 2026-10-08); behaviour is verified live.

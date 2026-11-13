# Refract

Refract is a desktop app for working with a coding agent, one isolated copy of a project per unit of work. This file is the shared vocabulary for specs, plans, and code.

## Language

**Project**:
A local git checkout the developer has added to Refract, either an existing folder or a clone of a **GitHub repository**. Owns zero or more **Sessions**.
_Avoid_: Repository, repo, workspace (in UI text; code identifiers keep `repository`)

**GitHub repository**:
The remote copy of a **Project** on GitHub: what a **Project** is cloned from, and where its pull requests and issues live. A **Project** has zero or one **GitHub repository**.
_Avoid_: Project (for the remote side), remote (alone)

**Project colour**:
An optional colour the developer chooses for a **Project**, shown on its header in the session list. A **Project** has none until one is chosen.
_Avoid_: Accent, tag colour, label colour

**Session**:
One unit of work: a **Worktree** together with the **Conversations** held in it. It is one entry in the session list and lives until the developer archives or deletes it. A **Project** has many **Sessions**; a **Session** has exactly one **Worktree**. Its display name is independent of its branch and worktree folder name: renaming a Session never touches either, and the new name shows everywhere at once (list, chat header, branch picker, notifications).
_Avoid_: Task, thread, chat (for the whole unit)

**Child Session**:
A **Session** created by another Session's agent (#1304), linked to that parent Session and nested under it in the session list. It has its own **Worktree** and branch and is otherwise a full Session the developer can open, message, stop and archive. Nesting goes to depth 3 (a developer-created Session is depth 1, its child depth 2, a grandchild depth 3), and a parent has at most 4 live children; a Session at depth 3 cannot create a child. Rust enforces both limits (#1859). Not a **Subagent**, which runs inside its parent's Worktree through OMP's `task` tool and is not a Session.
_Avoid_: Sub-session, nested session, spawned session

**Own tree**:
A calling agent's **Session** plus its descendant **Child Sessions** (ADR 0009). An agent's changes to Sessions inside its own tree run without the approval card; changes to siblings, parents and other roots raise it.
_Avoid_: Subtree, family

**Live child**:
A **Child Session** that is not archived. Stopped and hidden children are live and count toward a parent's limit of 4.
_Avoid_: Active child

**Tool channel**:
How Refract gives an agent its own tools (#1193, ADR 0007): each launch registers **Host tools** with OMP over the RPC stream, Refract routes each call to the renderer and back, and a failure returns to the agent as a tool error, never a toast. The tools a launch registers depend on the **Session**'s role and depth.
_Avoid_: MCP server (the reserved fallback, not built), plugin, bridge

**Host tool**:
A tool Refract registers with OMP for one launch, named `refract_<name>` (for example `refract_open_panel`), and serves itself. OMP calls it; Refract answers.
_Avoid_: custom tool, extension tool

**Session message**:
A user turn that one **Session**'s agent sends to another **Session** through `send_session_message`, labelled with the sending **Session**. It is never the developer's instruction and never an approval (ADR 0008).
_Avoid_: Agent message, cross-session prompt

**Panel action**:
A named operation a right-pane panel declares for the agent: name, description, input schema and whether it changes something. A mutating one asks the developer first through the approval card; reading and navigating ones run straight away.
_Avoid_: panel command, panel API

**Session status**:
The one state shown for a **Session** by the shared status icon and its word: Working, Needs you, Paused, Stopped, Unread response or Idle, in that order of precedence.
_Avoid_: state dot, status badge

**Chat row spacing**:
The Settings choice (Appearance) between **Tight** (4px), **Compact** (8px, default) and **Comfy** (16px) for the gap between consecutive bookkeeping rows in the transcript (#1300). Turn and message gaps stay 24px.
_Avoid_: row density (in UI copy)

**Status style**:
The Settings choice (Appearance, "Session status style") between **Icons** (default) and **Dots** for how the shared status icon draws a **Session status**. Every state is colour-coded in its state colour in both styles, including Working (Icons tints the spinner with `--state-working`); Dots keep a shape cue per state so colour is never the only signal. It applies live, applies to the shared status icon only (not the Subagent panel or Transcript icons), and shows a preview of all five states.
_Avoid_: status mode, dot mode
**Paused**:
The **Session status** of a **Session** the developer paused. Refract holds its queued messages, goal continuation and new sends until the developer resumes it; it shows Pausing… until the running turn ends. Pause also cancels the Session's running **Subagents** at once and cancels any the agent starts while paused; Resume revives none of them and posts a notice naming what was cancelled. Pause persists across restarts and never resumes on its own.
_Avoid_: suspended, frozen

**Unread response**:
The **Session status** of an idle **Session** whose latest reply the developer has not seen, because it finished while the **Session** was not shown in a **Chat pane**. It clears when the **Session** is shown, and it is drawn by the shared status icon in place of Idle.
_Avoid_: response ready, unread dot, response indicator, new message

**Archive**:
Move a **Session** out of the main list into the Archived group while keeping its **Worktree** and **Conversations** intact; reversible. Stops the agent. The default way to finish with a **Session**.
_Avoid_: Close, remove (ambiguous with delete)

**Hide** / **Hidden Session** (issue #748):
Remove a **Session** from the session list only (`hiddenAt`, independent of **Archive**). Nothing stops: the agent keeps running, the **Session** stays searchable (tagged Hidden) and in Manage sessions, and it never resurfaces on its own, even when it needs you; the Show hidden toggle carries a badge counting hidden **Sessions** that need attention. Reversible with Unhide or the Hide toast's Undo.
_Avoid_: Mute (Hide does not silence notifications), archive (separate flag)

**Delete**:
Permanently remove a **Session**, its **Worktree**, and its **Conversations**. A manual Delete asks first, naming what will be lost (uncommitted changes, unpushed commits); **Session cleanup** deletes without asking, but only Sessions it archived itself and that pass the same safety checks (issue #476).
_Avoid_: Remove, discard

**Session cleanup**:
The automatic housekeeping in Settings > Sessions: it **Archives** a **Session** whose pull request has merged once it has been inactive for a chosen number of days, and, if a delete period is chosen, later **Deletes** the Sessions it archived. It never touches a Session archived by hand (issue #476).
_Avoid_: Auto-cleanup, garbage collection, reaping

**Group header**:
The collapsible header above one Project's Sessions in the session list, shared by the Archived group.
_Avoid_: repository header, section header

**Activity line**:
The second line of a Session row: what the agent is doing right now while it is working or waiting (#526), otherwise the Session's branch. Derived from the same activity as the composer's current-work banner (one shared derive), for every Session including the open one; the Settings > Appearance **Activity text** choice (Plain or Playful) applies to both. Playful only replaces the generic "Working…" line.
_Avoid_: status line (from PR #877 on, **Status line** is the composer row), sub-line, codename.

**Waiting marker**:
The status icon on a collapsed Group header showing the most urgent state among the Sessions it hides: Needs you, then Terminated unexpectedly, then Unread response.
_Avoid_: badge, dot, hidden-state marker (Hidden is #748's term), alert (#560's term)

**Alert row**:
A quiet, single-line notice directly under the profile item, naming one condition (low memory, an unverified omp version) with one text action and a small dismiss-for-the-run control. Never boxed or pill-shaped like a badge, and never part of a status bar (the app does not have one).
_Avoid_: alert bar, notice banner, status bar

**Worktree**:
The isolated checkout of a **Project** that a **Session** works in. Created by Refract when the **Session** is created.
_Avoid_: Branch, folder, clone

**Base branch**:
The branch a new **Session**'s **Worktree** branches from. One-click creation uses the **Project**'s default branch; the branch button opens a picker with the default branch preselected. Any branch can be a Base branch, including another **Session**'s branch, which the picker lists under that **Session**'s name.
_Avoid_: Parent branch, source branch

**Approval mode**:
The app-wide setting for how much the agent may do without asking: **Ask** (prompts for file changes and commands), **Ask and remember** (as Ask, and remembers the files and folders you approve), **Edit freely** (prompts only for commands), or **Auto** (never prompts). Applies to every **Session**; reads are never prompted.
_Avoid_: Permission level, yolo (internal OMP name for Auto)

**Queued panel**:
The panel above the message box listing the messages waiting to send, one row each with Send now and Remove (#1145). It sits below the pinned Todo panel and shows only while something is queued.
_Avoid_: Queue chips, queued pills

**Status banner**:
A pinned, non-modal strip above the message box reporting routine, non-problem activity, such as running background agents (#865). It is the `status` feedback channel in `docs/design/patterns.md`, distinct from a Banner, which reports a problem and stays until fixed.
_Avoid_: Telemetry dock

**Conversation**:
One continuous exchange with the agent inside a **Session**. A **Session** has many **Conversations**, one of which is current; starting a fresh one keeps the same **Session** and **Worktree** and keeps the earlier ones reachable as history.
_Avoid_: Session (in the agent's own sense), transcript

**Status line**:
The row between the transcript and the message box (spec 004), spanning the chat column's full width: one **Readout** per glanceable fact about a **Chat pane**'s **Session**'s current state -- Changes, Context window usage, Turn time, Current time, Pull request, Subagents, or Todo progress -- live, each hidden entirely or reading "Not available" per its own rule, never conveyed by colour alone. Plain text, no boxes (2026-10-15 grill, issue #564): a read-only Readout is an icon plus text with no border or fill; one that opens something (Pull request, Subagents) is a quiet text button with a hover background and no border. Which kinds show is chosen per-kind in Settings; each pane of a **Split** reads its own Session's data independently. Two health readouts, "RPC slow" and "Agent memory high" (#561, spec 044), are degraded-only: they render nothing, and reserve no space, until the Session's agent is actually degraded, and have no Settings row.
_Avoid_: Readout chip, chip row, Status chip, badge (for this row specifically)

**Alarm**:
A one-shot reminder set from the **Status line**'s Current time readout (issue #1426, spec 072): a time and an optional label. It fires once, as an OS notification plus an in-app toast when the window is focused, then stays listed as Fired until edited or deleted. Alarms are app-wide (in `settings.json`), not per **Session**, and never repeat.
_Avoid_: Timer, reminder, snooze

**Turn total**:
The muted elapsed-time line under a **Session**'s turn in the transcript (spec 001 FR-046). The running turn's total always ticks live; the settled total shows only when Settings > Chat "Show finished turn times" is on (default off, 2026-10-27 grill, issue #1250, FR-119). Distinct from the **Status line**'s Turn time readout, and the current-work banner above the composer shows no elapsed time at all.
_Avoid_: Turn timer (ambiguous: the banner no longer has one)

**Stage**:
The subagents started by one `task()` call, or by `task()` calls issued together within the same owning assistant message, numbered in turn order (issue #563; gate round 2 architect addendum A: keyed on that message's own id, not on transcript adjacency -- reopened history carries no subagent timing to split a later serial call on a different signal). Two or more agents in a Stage are connected by a **Spine** (issue #565). Its name is the first line of its batch brief, after its number ("Stage 1 · Quality gate for #923", issue #941).
_Avoid_: Batch (in UI text), gate, phase (a phase is a **Todo phase**)

**Todo task**:
One item in a **Todo phase** of the agent's own todo list (OMP `todoPhases`), shown in the Todo panel and the Todo **Readout** (issue #1432). In user-facing text "task" means only this; delegated work is a subagent, a **Stage** or a Delegate. The model role id `task` and the `task()` tool name are protocol identifiers and stay.
_Avoid_: Task for a subagent, Stage, step

**Todo phase**:
A named group of **Todo tasks** in the agent's own todo list (OMP `todoPhases`). Pending todo phases are what **Up next** lists; a todo phase is planned work, never a **Stage**.
_Avoid_: Stage, step

**Up next**:
The muted list of the agent's pending **Todo phases** shown after a turn's **Stages** (issue #941). Live state only, so a reopened Conversation does not show it.
_Avoid_: Upcoming stages, queue

**Subagent chain**:
The per-turn summary row listing a turn's **Stages** and their agents with status and duration (issue #563); its own stage-to-stage list is also connected by a **Spine** (issue #565).
_Avoid_: DAG, gate topology, pipeline

**Subagent panel**:
The right region's first occupant (spec 004), opened by activating the Subagents **Readout chip**: a tree of the **Session**'s subagents (issue #563; the **Session** is the root, started agents are the first level, their own child agents the next once the tracker knows the parent), each with a **Status icon** plus the state word, and showing a selected one's live stream (text and tool calls) updating as it runs.
_Avoid_: Subagent sidebar, task panel

**Spine**:
The 1px neutral `border-divider` line down the left of an expanded group row's members, marking that they belong to that header; decorative, state lives on each member's own icon, and it is never coloured or animated (issue #565). The **Stage** group and **Subagent chain** (above) use it as their shared connector.
_Avoid_: rail (taken by Icon rail), guide rail, thread, timeline, connector

**Status icon**:
The one icon shape and colour per state, shared by tool rows, tool groups, **Stage** groups, the **Subagent chain**, and the **Subagent panel**, from one shared table both `toolStatus.tsx` and `subagentStatus.tsx` read (`statusGlyph.ts`, issue #570, gate round 1): done/finished is fully neutral, and only running and failed/error carry colour. A tool row's own label additionally takes the error colour on failure (tool rows and groups only; **Stage**, the **Subagent chain** and the **Subagent panel** colour only the icon, never their label), since a chromatic success colour used outside its own meaning teaches the wrong meaning.
_Avoid_: state dot, badge

**Tool icon**:
The icon that leads a tool row, a **Tool group** row, the approval card and a subagent row, naming the kind of tool (FileText for `read`, Terminal for `bash`, Plug for any MCP tool, Wrench for an unknown tool), from the one shared verb map; the **Status icon** sits at the row's trailing end instead. Its tooltip shows the raw tool id (spec 023, issue #469).
_Avoid_: tool badge, glyph

**Tool label**:
A tool row's visible label: the model's own intent for the call when it gave one ("Reading README.md"), otherwise the tool's verb from the shared verb map ("Reading" while running, "Read" when done). The raw tool id is never the label; it shows only in the **Tool icon**'s tooltip, or muted after the label when Settings > Chat "Show tool names on rows" is on (spec 022, spec 023).
_Avoid_: tool name, tool title

**Error line**:
The first meaningful line of a failed tool call's own output, shown directly under its row whether collapsed or expanded, without needing to expand anything (the LAST line for a `bash` call, after OMP's own trailing `Wall time:` footer is stripped; the FIRST line for every other tool). For a silent `bash` failure (no stdout or stderr), the line is the exit code or timeout OMP itself reported ("Exited with code N"/"Command timed out after N seconds"), never OMP's bare `(no output)` wrapper text; "Failed." is reserved for when no output and no exit/timeout information exist at all (issue #570, gate round 1).
_Avoid_: error preview, output tail

**Tool group**:
A run of consecutive calls to the same tool, shown as one row that expands to its calls down a **Spine**; a run of one is still a Tool group, with no Spine (issue #565).
_Avoid_: thread, batch

**Thought run**:
Consecutive thoughts in one turn with nothing else between them, shown as one row reading "Thought process" with the step count and, once every thought's own timing is known, the total elapsed time. Two or more thoughts show as "Thought process", which expands to its thoughts down a **Spine**; a single thought is still a Thought run, with no **Spine** (issue #557).
_Avoid_: thought group, thinking group, phase, step group

**Chat pane**:
One half of the split chat area (spec 005): a complete chat for one **Session** -- header, transcript, message box, queued messages, pending approvals and questions, and the **Status line** -- matching what a single, unsplit chat pane shows for that **Session**. One or two show at once; the same **Session** is never shown in two panes at the same time.
_Avoid_: Chat panel, pane (alone, when a **Split** is in scope)

**Split**:
The app-wide arrangement of two **Chat panes** side by side (spec 005): which two **Sessions** are shown, the **Divider**'s position, and which pane is **Focused**. Persists across a restart (`Settings.split`); opened via "Open in split" or Ctrl+click on a session row, closed by closing either pane.
_Avoid_: Split view, dual pane

**Divider**:
The draggable boundary between a **Split**'s two **Chat panes** (spec 005): draggable with the pointer, adjustable from the keyboard, stops at a minimum width per pane, carries the focus-move button.
_Avoid_: Splitter, resize handle (for this boundary specifically)

**Focused pane**:
Whichever of a **Split**'s two **Chat panes** currently receives a session-row click, the message box, Stop, the queue, and approvals (spec 005). Exactly one pane is focused at a time, marked by a left-edge accent bar plus a visible "Focused" text badge (never colour alone); clicking, typing, or Ctrl+Shift+\ moves it.
_Avoid_: Active pane, selected pane

**Home**:
The left-nav entry and the main view that shows when no **Chat pane** is open: what needs the developer and their recent work across all **Projects** (Sessions waiting on them, recent **Sessions**, their pull requests and issues, and a Tidy up list of Sessions whose pull request merged or closed). Its nav item shows the count of Sessions that need the developer.
_Avoid_: Home pane, dashboard, start page

**Holiday touches**:
Seasonal, purely decorative artwork (and, when allowed, gentle ambient motion) that Refract shows near a holiday, and the Appearance setting that controls it (Full, Artwork only, Off).
_Avoid_: Easter eggs, seasonal theme, festive mode

**Pull requests view**:
The left-nav entry and the list-plus-detail view it opens (spec 003), scoped to a chosen **Project**'s **GitHub repository** and its pull requests, read and acted on through the developer's already-signed-in GitHub CLI; Refract stores no token of its own.
_Avoid_: PR view, merge requests (GitLab's term)

**Issues view**:
The left-nav entry and the list-plus-detail view it opens, listing GitHub issues from every **Project** that has a **GitHub repository**, on the same list shell as the **Pull requests view**.
_Avoid_: Issues page, issue log, issue tracker

**Usage view**:
The left-nav entry and the dashboard it opens (#1331), showing every OMP model call, tool call, token and **AI credit** recorded on this machine, by **Project**, model, reasoning level and agent type, read from Refract's own local `usage.db` (ADR 0006), never committed to any repository.

**Project label**:
The name the **Usage view** shows for the folder an OMP session ran in: the **Project**'s name when the session's working directory is, or sits inside, a Project's checkout (longest match wins), otherwise the working directory's last path segment. A display label only; it does not create a **Project**.

**usage.db**:
Refract's own SQLite database in its data folder (#1331, ADR 0006), filled incrementally and idempotently from OMP's session files (`~/.omp/agent/sessions`, or the folder `REFRACT_OMP_SESSIONS_DIR` names). It is a rebuildable cache of OMP's record, plus the Usage view's saved filters and Jokes toggle; the session files stay the source of truth.
_Avoid_: Stats page, billing page

**AI credit**:
The Copilot premium-request unit a model call costs: the model's multiplier (for example Opus 15, Sonnet 1), counted against the Copilot plan's monthly entitlement. Calls to other providers are shown in list-price USD instead.
_Avoid_: premium request (GitHub's billing term), token

**Item reference**:
A mention of a pull request or issue by number in chat prose: `#123` means that number in the **GitHub repository** of the chat's **Session**'s **Project**, and `owner/repo#123` means that number in the named repository. Shown as a link with an **Item card**; a pull request opens in the **Pull requests view**, anything else on GitHub (issue #1155).
_Avoid_: Hashtag, issue link, PR link

**Item card**:
The hover card an **Item reference** shows on hover or focus: repository and created date, title and number, state and author, and for a pull request its base and head branches (issue #1155).
_Avoid_: Tooltip, preview, popup

**Filter tab**:
One of the tabs across the top of a **Pull requests view**'s or **Issues view**'s list (pull requests: All, Authored by me, Assigned to me, Involves me, Review requested; issues: Open, Assigned to me, Authored by me, Mentions me), narrowing which items the list shows; exactly one is active at a time, defaulting to the first. The Pull requests first tab is **All** (renamed from Open, Stuart 2026-10-16, #499), because the State control in its Filters section (Open, Closed incl. merged, All; default Open) now narrows whichever tab is active. Pull requests Filter tabs are ghost tabs in one row that scrolls sideways, the active one on a subtle background (#499). Pull requests' Overview/Changes pair uses a locally-styled underline variant of the shared Tabs primitive, pending #394's app-wide tab convention.
_Avoid_: Filter, category, "Created by me" (say Authored by me)

**Review thread**:
A comment thread anchored to a location in a pull request's diff (spec 003), with a resolved or unresolved state; resolving and unresolving are both explicit, reversible actions, never inferred from a reply.
_Avoid_: Comment thread, discussion

**Review action**:
Any of comment, reply, react, resolve, unresolve, submit a review (comment/approve/request changes), close, or merge (spec 003; react and close added 2026-10-23, #1199 and #1196) -- every one runs only as the direct result of an explicit user action, and approving, requesting changes, closing, and merging each require a confirmation naming the pull request and the exact action first; reacting never asks, since it is undone by clicking again.
_Avoid_: PR action, operation

**History line**:
The **Spine** down the left of the Pull requests Overview **Timeline** (#915, grilled 2026-10-29): commits are unboxed single rows on it (commit icon, headline only, short SHA, relative time; consecutive commits group under "N commits"), while comments, reviews and **Review threads** keep a soft `--divider` card hung off it. Decorative (`aria-hidden`).
_Avoid_: rail, timeline line

**Author kind**:
What a Timeline card header says about its author (#915): every card shows the avatar and login; a bot (`__typename` `Bot`) gets a muted "Bot" badge; the signed-in developer's own cards get an accent-tinted header and a "You" badge (never colour alone). The pull request's own author is not special-cased (no "Author" badge, Stuart 2026-10-29).
_Avoid_: role badge, owner badge

**PR image**:
An image in a pull request's Markdown, fetched by the backend (allow-listed GitHub image hosts, type and size checked, returned as a `data:` URL) and shown only in the **Pull requests view**, never in agent chat (#915, ADR 0004). Any other image keeps the alt-text link.
_Avoid_: embedded image, remote image

**Markdown editor**:
The shared composer-styled field for writing GitHub Markdown in the Pull requests view (#1196): a Write/Preview toggle (Preview renders through the shared `Markdown`), a toolbar (Heading, Bold, Italic, Quote, Code, Link, Bulleted, Numbered and Task list) and Ctrl+B, Ctrl+I and Ctrl+K. It has a full size (top-level comment, with "Close pull request" and "Comment") and a compact size (thread reply, no Close). It reuses the composer's tokens and does not edit `MessageInput.tsx`; the composer can adopt it later (Stuart 2026-10-29).
_Avoid_: composer (that is the chat input), rich text editor

**Checks section**:
The Overview section after the **Timeline** and before the comment box (#1198): the overall state in its header, checks grouped by outcome (Action required and Failing expanded; Pending; Successful, Neutral and Skipped collapsed with counts), each row a status icon plus word, the check name and its duration, with an "Open details" row menu that opens the run in the browser. No re-run in v1; it refreshes with the pending-check poll.
_Avoid_: CI panel, build status

**Rendered view**:
The formatted display of a Markdown file or value, with its syntax hidden; for a Markdown file in a file tab it is editable in place. One of the two views behind the Rendered/Source toggle.
_Avoid_: Preview (implies read-only), WYSIWYG, edit mode

**Source view**:
The raw Markdown text of the same file or value, shown and edited as code. The other view behind the Rendered/Source toggle.
_Avoid_: Code view, raw view, code only

**Theme** (spec 007):
One of the built-in dark-toned colour presets (Dark, Dark (high contrast), Obsidian -- #550, theme foundation palette v2) applying app-wide, chosen from the Settings screen's Appearance section and autosaved on choose (no preview, Save or Cancel; spec 068, #1424). Spec 008's planned profile Theme submenu reuses the same `theme-store.ts` `save`/`preview` actions and `THEMES` table, not new theme data of its own.
_Avoid_: light mode, dark mode (ambiguous once more than one dark preset exists), follow-system

**Chat width** (issue #554):
The app-wide Settings, Appearance choice between Full (default, the transcript column fills the pane) and Reading column (caps it at 64rem, centred); applies to the chat transcript only, never the message box or the status line. Autosaved on choose, the same interaction model as **Theme**.
_Avoid_: reading width, line width (ambiguous with a font/measure setting, which does not exist)

**UI font / Code font** (issue #1246, grilled 2026-10-27):
The two default typefaces: **UI font** is bundled Geist and **Code font** is bundled Geist Mono (Segoe UI Variable and Cascadia stacks stay as fallbacks). **Weight scale** is one set of theme tokens, shifted down one step from #1208: normal 300 (body), medium 400, semibold 500, bold 600; 200 is rejected for stroke contrast and there is no weight setting. Every literal 400 left by #1208 (diff headers, row labels) follows the scale to 300. The **composer** textarea uses the Code font (pulling #839's font rule into this issue). **Code ligatures** (Geist Mono `liga`) are on by default; a Settings > Chat switch turns them off app-wide. User font pickers stay with #4.
_Avoid_: font weight setting, font slider (neither exists)

### UI vocabulary

Decided by Stuart in the #474 grill, 2026-10-08. Glossary only -- implementation detail (icon, button, and tooltip rules) lives in `docs/design/`, not here.

**Pill**:
A small, fully-rounded control showing one current state or mode at a glance, usually opening a menu to change it (for example, the Approval mode pill).
_Avoid_: Badge, tag (for a control that opens a menu)

**Chip**:
A small, rounded-rectangle element showing one discrete fact or item, read-only or removable, usually grouped with others in a row (for example, a pasted-text chip in the composer's attachment strip -- this entry defines the shape generically). The **Status line**'s own entries are plain text, not this shape (2026-10-15 grill, issue #564): see **Status line**'s own _Avoid_ note.
_Avoid_: Tag, token (ambiguous with a design token)

**Message image**:
An image sent with a user message, shown inside that message's bubble above its text; it exists once the message is sent. Before sending, the same image is a pending attachment in the composer's attachment strip, not a Message image (2026-10-27 grill, issue #513).
_Avoid_: Attachment (for a sent image), thumbnail (that is only how a Message image is drawn)

**Image viewer**:
The modal that shows one Message image at a larger size, with previous and next when the message has several (2026-10-27 grill, issue #513).
_Avoid_: Lightbox, preview modal (the composer's pending-attachment preview is a separate use of the same shared component)

**Row**:
One horizontal line of a list that repeats the same layout as its siblings -- an icon, a label, and trailing actions (for example, a session row).
_Avoid_: Item, entry (too generic elsewhere in this file)

**Card**:
A boxed, self-contained block of content set apart from the surrounding list or layout, typically surfacing details or asking for a decision (for example, a session details card).
_Avoid_: Panel

**Question card**:
The decision card shown when the agent asks the developer one or more questions (issue #572); has one tab per question when there are several, and one Submit.
_Avoid_: ask tool card, ask dialog (OMP's protocol name)

**Asked-user line**:
The unboxed, collapsible transcript row an answered, cancelled, or unanswered **Question card** becomes (issue #572).
_Avoid_: answered card, answer pill

**Recommended option**:
The option the agent marks as its default (issue #572). Shown as text, never preselected; OMP uses it if the question times out.

**Panel**:
A distinct, secondary tool or view hosted in the right pane, opened and closed as a whole (for example, the **Subagent panel**). The pane itself collapses and expands from the **Icon rail**'s top button or Ctrl+Shift+B; collapsing keeps every open panel, the tab order and the width, and all three survive a restart.
_Avoid_: Sidebar, drawer

**Panel order**:
The user's saved order of the **Panel**s, shared by the **Icon rail** and the launcher (not the tab bar, which keeps open order). Default: Git changes, File explorer, Subagents, Side chat, FDB Knowledge, Agent Builder. Changed by dragging a rail button or Alt+Shift+Up/Down on it, restored by "Reset panel order" in Settings (issue #730).
_Avoid_: Rail order, button order

**Right pane surface**:
The background of the right pane and the **Icon rail**, one surface: the `--sidebar-right` token, a per-theme midpoint between `--background` and `--sidebar` (the left Session list), so the right edge reads as its own region, neither page nor left panel (decided 2026-10-29, issue #674). The pane has no Min / Default / Max buttons; its width is set by dragging, double-click (reset to 320 px), the handle's context menu and the View menu (Narrow 240, Default 320, Wide 520, Close pane), which are the WCAG 2.5.7 non-drag alternative. Dragging below 240 px closes it.
_Avoid_: width preset, sidebar background

**Git decoration**:
The colour a file or folder name and icon in the File explorer take from the `--git-*` tokens (modified, added, untracked, deleted, ignored, renamed, conflicted, staged), separate from the session-state colours. A folder takes the most significant status among its descendants (conflicted, deleted, modified, staged, renamed, added, untracked; ignored does not roll up). The trailing status icon and its screen-reader word stay (issue #768).
_Avoid_: status colour (the session-state colours)

**Pane**:
An unboxed, resizable region of the main content area, one of possibly several side by side, each independently scrollable (for example, a **Chat pane**). Inside a **Split**, say **Chat pane**, not the bare word, per that entry's own _Avoid_ note.
_Avoid_: Panel (a distinct, secondary tool or view, not this region), split view (for the arrangement itself -- see **Split**)

**Tab**:
One of a set of mutually exclusive selectable labels that switches which content shows in the same region, exactly one active at a time (for example, a **Pull requests view**'s **Filter tab**).
_Avoid_: Filter (see **Filter tab**), section

**Readout**:
A compact, glanceable display of one live fact about something elsewhere in the app -- the **Status line**'s own entries (for example, Changes, Pull request, Subagents). Most readouts are plain text; some are also the entry point to an action, in which case they behave like a quiet text button rather than a chip (for example, one that opens an external link or a panel). The Context usage readout opens a menu (spec 052, issue #506) with Shake context, Shake thinking and Shake images, which send OMP's `/shake`, `/shake thinking` and `/shake images`; OMP's own reply in the transcript is the result, and thinking and images confirm first because they are not recoverable.
_Avoid_: Display, indicator, Readout chip (retired 2026-10-15, issue #564 -- see **Status line**)

**Role·Model pill**:
The composer control showing the **Session**'s current role and the model it runs on ("Default · Sonnet 5.5"), or "Pinned" and the model when a model was chosen directly. It opens one switcher for both; the thinking level has its own pill (issue #766).
_Avoid_: Role chip, model badge, model picker (for the combined control)

**Pending change**:
A role, model or thinking-level choice made while a turn runs or the agent is stopped. It shows at once with a "next turn" mark and is applied before the next prompt (or when the agent starts); the last choice wins (issue #766).
_Avoid_: Queued change (a queued message is different), deferred setting

**Prism**:
Refract's way of splitting one task across models (issue #1089): **Solo** (one model), **Draft & check** (a quick model drafts and a checker accepts it or hands it up to a stronger model) or **Second opinion** (models from other families review and the drafter revises once). Set to Off, On or Max in Settings.
_Avoid_: Cascade, critique, orchestration, multi-model, ensemble, HydraFusion

**Agent setting**:
A setting that lives in the agent runtime's own config (OMP's), not Refract's, shown in Refract's Settings as a row tagged "Agent" (issue #691; tag renamed from "OMP" 2026-11-02, issue #1551). Refract reads it live and writes it back to the agent's global config, so the terminal and Refract agree; a **Project** can still override it in its own `.omp/config.yml`, which the row shows.
_Avoid_: OMP setting, "OMP" in any user-visible text (say "the agent", issue #1551), Imported setting, Refract setting (for these), config key (in UI text)

**Advisor**:
omp's optional watchdog subsystem that watches a Session's turns and emits advisories (blocker, concern and nit rows -- see **Advisory accent bar**/**Advisory location**/**Advisory concern run**), a distinct thing from those rows themselves. Runs on `modelRoles.advisor`, possibly a different provider than the primary model, and sees the Session's transcript. Toggled per Session, not persisted, with `/advisor on`, `/advisor off` and `/advisor status` (issue #917). **Amended 2026-10-20 (Stuart, #691 grill):** a Settings row (an **Agent setting**) sets whether the Advisor is on for *new* Sessions. OMP starts it off for RPC hosts, so Refract applies that choice itself at each Session start. The Advisor readout and the per-Session `/advisor` command keep their 2026-10-16 "no Settings toggle" rule. Decided (Stuart, 2026-10-16): no cost readout (`advisor_cost_changed` stays unread); `/advisor status` reports spend on demand instead; a persistent on/off indicator is tracked separately as issue #937. That indicator (issue #937, follow-up to #917/PR #923) is the **Status line**'s own Advisor readout (**Readout**, zero-box convention): shown only while the advisor is on for that Session, hidden entirely while off, with no cost, spend, or token figures of its own; clicking it sends `/advisor off`. Its state comes from `/advisor on|off`'s own reply text (the only fully-trusted signal) plus a best-effort, silent `/advisor status` probe run once on Session attach/resume -- that probe's own reply never appears in the transcript, and its ambiguous wording (`session::advisor`'s own header comment) is never trusted for an "on" reading, only an unambiguous "Advisor is enabled"/"Advisor is disabled" substring is.
_Avoid_: Advisory (the note the Advisor produces, not the subsystem itself), reviewer, chip (the React component and the issue title use that word informally; prose calls it the Advisor readout, per **Status line**/**Readout**/**Chip**'s own _Avoid_ notes)

**Source tag**:
A small muted icon-and-word label at the start of a transcript row naming who the row came from when it is neither the developer nor the main agent, for example "Advisor" on an **Advisory** (issue #1041). Shared by every such row.
_Avoid_: Badge, chip, author label

**Advisory accent bar**:
The 3px left stripe on a BLOCKER row (always, even collapsed, error colour) or an EXPANDED concern row (warning colour) -- drawn as an absolutely-positioned `before:` pseudo-element on `AdvisoryRow`'s own local wrapper `div` (zero layout impact, so the icon stays on the shared 24px grid in every state); never a `CollapsedLine` primitive prop (issue #558, gate round 1).
_Avoid_: severity box, blocker card, alert stripe

**Advisory location**:
A `path:line` (optionally `:column`) the advisory's note or guidance names, extracted by a conservative, allowlisted-extension regex and shown as monospace, selectable text under an expanded blocker or concern -- never a link (opening the file waits on #463). Zero or more per advisory; none shown when none is found (issue #558).
_Avoid_: file reference, source pointer

**Advisory concern run**:
Every run of consecutive concern-severity advisories in one turn with nothing else between them (even a run of one, always wrapped -- issue #558 gate round 1, matching **Tool group**/**Thought run**'s own "always wrap" rule): a run of five or fewer renders unchanged, with no control; a run of six or more shows the newest five plus a "+ Show N more advisor concerns" one-way reveal button, placed above the rows (the hidden ones are the older ones). Blockers and nits are never part of a run.
_Avoid_: concern group, advisory batch

**Spacing grid**:
The 8px grid with a 4px half-step that every padding, margin and gap in `src/renderer` follows: allowed steps 4, 8, 16, 24, 32, 40 and 48 px (plus 0), 4px only for tight icon-to-text gaps and inline chip padding. Control heights are 24px (`xs`/`sm`) and 32px (`default`); icon boxes are 8, 16, 24 or 32 px. Enforced by `pnpm check:spacing`, with exceptions in an allowlist file. Supersedes the 4px grid of #474 (issue #1252, `specs/028-8px-spacing-grid/`).
_Avoid_: 4px grid, spacing scale

**Functional circle**:
A control or mark whose round shape carries meaning, so it stays fully round whatever the corner radius token is: status dots, avatars, the switch, the radio mark, the scrollbar thumb, the composer Send/Stop button and the pane resize grip. Text pills, chips and badges are not functional circles; they take the corner radius token (wave 1 grill, 2026-10-28, #843 and #738).
_Avoid_: pill (for these), round button

**Chrome band**:
The window title bar (logo, Session title, window controls) and the menu bar under it, drawn as one surface with one soft divider below and none between them, so the drag area is visible (wave 1 grill, 2026-10-28, #682).
_Avoid_: header, top bar (when the whole band is meant)

**Settings page**:
One section of the Settings screen, drawn by the shared `SettingsPage` (title, intro, a content column capped near one reading column and left-aligned next to the nav) and split into **Settings groups**. The nav is one flat list of task-based sections: Appearance, Chat, Status line, Models, Advanced, Sessions, Panels (wave 2 grill, 2026-10-29, #714). The brand mark (icon and wordmark) shows in the Settings header (#450).
_Avoid_: tab, panel (a **Panel** is a right-pane surface), Composer and status (the nav says Status line)

**Settings group**:
A headed run of related rows inside a **Settings page** (`SettingsGroup`, `role="group"` labelled by its heading), made of `SettingRow`s (label, plain-English description, control slot, optional leading icon).
_Avoid_: card, fieldset (unless it is a radio group)

**Advanced**:
The Settings section that replaces "OMP" (wave 2 grill, #714): every row is a Refract-written launch-overlay value (the token guard, spec 021) that applies to new Sessions only and resets to Refract's default. Rows sit in groups (Context compaction, Idle compaction, Image compression, Subagents, Advisor, Tool output, Learning), each with a hand-written description. The Advisor model is not here; it is Models > Advisor.
_Avoid_: OMP (as the section name), expert settings

**Role colour**:
A categorical identity colour for a model role (`--role-*` tokens, 3:1 on every preset), given only to the four roles a switcher cycles (default, smol, slow, plan); other roles stay neutral. Always paired with the role name and a role icon, never the only cue, and distinct from severity and status colours (#714 part 4, #717; `foundations-icons.md` amended to allow "role identity").
_Avoid_: role badge colour, status colour

**Text size**:
Three independent text scales, App, Chat and Code, each 80 to 150 percent in steps of 5 (default 100), applied by redeclaring the theme `--text-*` size variables per role container so layout, spacing and icons never scale; the smallest resulting size is clamped at 11 px. Presets Small 90, Default 100, Large 115, Larger 130. Persisted as `Settings.typography` and carried by the theme bootstrap so the first paint has no flash (wave 2 grill, 2026-10-29, #842).
_Avoid_: zoom (window zoom scales everything and stays separate), font size (families are #4)

**Turn error row**:
The row at the end of a turn that ended in a model error: OMP's own error text, a one-line plain-language hint when the error is a known kind (TLS verification, auth, rate limit) and a **Retry** button that resends the unanswered prompt once and goes away when the new turn starts. Built from the shared **PaneBanner**-family styling (wave 3 grill, 2026-10-29, #1284).
_Avoid_: error toast, error bubble

**Retry line**:
The live row shown while OMP retries a failing model call ("Retrying, attempt 3 of 6") with a **Stop** button that aborts the turn. It gives way to the **Turn error row** if the retries run out (#1284).
_Avoid_: retry banner

**Pane banner**:
The unboxed row at the top of a Session pane for a Session-level problem (Worktree missing, Terminated unexpectedly, The agent stopped, start failed): a severity icon in the error colour, a foreground title, a muted monospace detail line, one outlined primary action and text buttons for the rest, with Delete as red text that confirms in a dialog. Drawn by the shared `PaneBanner` (wave 3 grill, 2026-10-29, #746). Red is for the severity icon and destructive actions only.
_Avoid_: alert box, error box

**Parked**:
A subagent state, shown with its own icon and the word "Parked": the agent finished its turn but stays alive and wakes when messaged. Not "Finished", and never counted by the composer Subagents readout (which shows only running, failed and exited; #1085). Its data source is OMP's `subagent_lifecycle` channel, probed live before it is trusted (wave 3 grill, 2026-10-29, #1098).
_Avoid_: Idle, Completed (for a resumable agent)

**Focused pane tint**:
The subtle background tint on the focused chat pane body in a split view (`--pane-focused`), replacing the left accent bar; the header stays untinted and keeps the "Focused" badge, which carries the non-colour cue. Gated on `showSplit`, not `isSplit`. High contrast uses a 2 px edge instead of a tint (#684).
_Avoid_: dimming the unfocused pane

**Navigable message**:
A transcript item that chat navigation can land on: a user message or an `assistant-text` item (each agent text between tool calls is its own message). Tool calls, thinking, subagents, agent-to-agent messages, advisories, requests and notices are not navigable. One per-pane **message index** lists them in order; Previous/Next, the Outline, chat search and the scrollbar map all read it and all move the chat through one `jumpToMessage` (wave 4 grill, 2026-10-29, #750 to #754, ADR 0005).
_Avoid_: turn (a turn holds several messages), row

**Message step**:
Previous message / Next message: two chevron buttons that fade in while the transcript scrolls, step through any navigable message (user or agent), hide Previous at the top and Next at the bottom, and answer Alt+Up and Alt+Down in the transcript and composer. Scroll to end becomes `ArrowDownToLineIcon` so the two down glyphs differ (#751).

**Outline**:
The right-pane panel (`outline`, last in the default rail order after Side chat) listing the shown pane's Session messages, agent replies nested under their user prompt; click jumps the chat (#752).

**Chat search**:
Ctrl+F (only with focus inside a chat pane) or the header ghost search icon opens a floating find bar over the user and agent messages. Counts and highlights come from the rendered text for rendered messages and from source text for messages the window has not rendered (#753).

**Scrollbar map**:
A canvas strip in the scrollbar gutter with one mark per navigable message (user left, agent right) and a viewport window; covers rendered rows only plus an "N earlier turns" stub that triggers Load earlier. Hidden under 1.5 viewports of content. Has a Settings toggle "Show scrollbar map" in the Chat group, default on (#754).

**Label overflow chip** (#1740):
The "+N" chip at the end of an **Issues view** row that stands for the labels beyond the first two. It is focusable, and hovering or focusing it shows the hidden labels in a tooltip.
_Avoid_: label count, more-labels badge

**Shared build cache**:
The single `CARGO_TARGET_DIR` every worktree builds into (`docs/rust-build.md`), so a lane never creates its own `src-tauri/target`.
_Avoid_: target folder, per-worktree target

**Sweep**:
Running `pnpm cache:sweep` (`scripts/cache-sweep.mjs`, #1736): removes **Shared build cache** artefacts unused for N days (default 7, `--days N`; `--dry-run` previews) through the pinned cargo-sweep 0.8.0. It refuses while a cargo build holds the target lock (enforced on Windows only; see `docs/rust-build.md`).
_Avoid_: cargo clean, cache wipe

**Token guard**:
Refract's Settings > OMP launch-overlay values (`src-tauri/src/session/token_guard.rs`, `src/shared/tokenGuard.ts`) that cap what the agent spends. App-wide, applied to new **Sessions** at launch, not set per **Session**.
_Avoid_: spend limit, cost cap

**Soft request budget**:
OMP's `task.softRequestBudget`, edited in the token guard as "Subagent request budget": the model-call count at which a subagent is asked to wrap up. It is stopped at 1.5 times that number; 0 means no limit.
_Avoid_: hard limit, request cap

**Cache warming**:
OMP's `providers.cacheWarming` setting (off, streaming or idle) that keeps the provider prompt cache alive. The token guard pins it to idle (#1672).
_Avoid_: keep-alive, cache ping

**Prompt cache write**:
A model call that writes the provider prompt cache, billed higher than a cache read. It happens when the cache has expired, so the token guard works to avoid them (#1684).
_Avoid_: cache miss, cache fill

## Flagged ambiguities

- The agent (OMP) uses "session" for what Refract calls a **Conversation**. In Refract, **Session** always means the worktree-bound unit of work; say **Conversation** for the agent's notion.
- The current spec (`specs/001-core-session-workspace/spec.md`) defines Session as "one conversation with the agent bound to one worktree". That contradicts the resolution above and must be corrected when the spec is next amended.
- The generic **Readout** term (#474 UI vocabulary) is not mutually exclusive with interactivity: a Readout is sometimes a real button or link (for example, Pull request, Subagents), not only plain text -- see **Status line**'s own distinction between the two. **Readout chip** (the row's older, boxed name) is retired as of the 2026-10-15 grill, issue #564: the row is now plain text, not chip-shaped, so **Status line** and **Readout** are the only current terms.

## Example dialogue

> **Dev:** I started a fresh chat in my "login-fix" **Session**. Did I just make a second **Session**?
> **Expert:** No. "login-fix" is still one **Session** with the same **Worktree**. You now have a second **Conversation** in it, and the first one is still there as history.
> **Dev:** And if I want a separate copy of the repo to try something else?
> **Expert:** That is a new **Session**, and Refract creates a new **Worktree** for it.

**Composer Markdown styling**
Live syntax styling of the chat composer while typing (#1170, spec 050): headings, lists, quotes, bold, italic and code are coloured on a mirror layer behind the transparent textarea, so the text, caret, selection and IME stay the plain textarea's. Width-neutral only (text stroke for bold and headings, colour for the rest), off while a slash command is typed, plain text in forced colours and Dark (high contrast). Not the **Markdown editor** of the Pull requests view.
_Avoid_: WYSIWYG, preview

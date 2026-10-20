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

**Session status**:
The one state shown for a **Session** by the shared status icon and its word: Working, Needs you, Stopped, Unread response or Idle, in that order of precedence.
_Avoid_: state dot, status badge

**Unread response**:
The **Session status** of an idle **Session** whose latest reply the developer has not seen, because it finished while the **Session** was not shown in a **Chat pane**. It clears when the **Session** is shown, and it is drawn by the shared status icon in place of Idle.
_Avoid_: response ready, unread dot, response indicator, new message

**Archive**:
Hide a **Session** from the main list while keeping its **Worktree** and **Conversations** intact; reversible. The default way to finish with a **Session**.
_Avoid_: Close, remove (ambiguous with delete)

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
The second line of a Session row: what the agent is doing right now while it is working or waiting (#526), otherwise the Session's branch.
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
The app-wide setting for how much the agent may do without asking: **Ask** (prompts for file changes and commands), **Edit freely** (prompts only for commands), or **Auto** (never prompts). Applies to every **Session**; reads are never prompted.
_Avoid_: Permission level, yolo (internal OMP name for Auto)

**Conversation**:
One continuous exchange with the agent inside a **Session**. A **Session** has many **Conversations**, one of which is current; starting a fresh one keeps the same **Session** and **Worktree** and keeps the earlier ones reachable as history.
_Avoid_: Session (in the agent's own sense), transcript

**Status line**:
The row between the transcript and the message box (spec 004), spanning the chat column's full width: one **Readout** per glanceable fact about a **Chat pane**'s **Session**'s current state -- Changes, Context window usage, Turn time, Current time, Pull request, Subagents, or Todo progress -- live, each hidden entirely or reading "Not available" per its own rule, never conveyed by colour alone. Plain text, no boxes (2026-10-15 grill, issue #564): a read-only Readout is an icon plus text with no border or fill; one that opens something (Pull request, Subagents) is a quiet text button with a hover background and no border. Which kinds show is chosen per-kind in Settings; each pane of a **Split** reads its own Session's data independently.
_Avoid_: Readout chip, chip row, Status chip, badge (for this row specifically)

**Stage**:
The subagents started by one `task()` call, or by `task()` calls issued together within the same owning assistant message, numbered in turn order (issue #563; gate round 2 architect addendum A: keyed on that message's own id, not on transcript adjacency -- reopened history carries no subagent timing to split a later serial call on a different signal). Two or more agents in a Stage are connected by a **Spine** (issue #565). Its name is the first line of its batch brief, after its number ("Stage 1 · Quality gate for #923", issue #941).
_Avoid_: Batch (in UI text), gate, phase (a phase is a **Todo phase**)

**Todo phase**:
A named group of tasks in the agent's own todo list (OMP `todoPhases`). Pending todo phases are what **Up next** lists; a todo phase is planned work, never a **Stage**.
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
The left-nav entry and the main view that shows when no **Chat pane** is open: what needs the developer and their recent work across all **Projects** (Sessions waiting on them, recent **Sessions**, their pull requests and issues).
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

**Filter tab**:
One of the tabs across the top of a **Pull requests view**'s or **Issues view**'s list (pull requests: All, Authored by me, Assigned to me, Involves me, Review requested; issues: Open, Assigned to me, Authored by me, Mentions me), narrowing which items the list shows; exactly one is active at a time, defaulting to the first. The Pull requests first tab is **All** (renamed from Open, Stuart 2026-10-16, #499), because the State control in its Filters section (Open, Closed incl. merged, All; default Open) now narrows whichever tab is active. Pull requests Filter tabs are ghost tabs in one row that scrolls sideways, the active one on a subtle background (#499). Pull requests' Overview/Changes pair uses a locally-styled underline variant of the shared Tabs primitive, pending #394's app-wide tab convention.
_Avoid_: Filter, category, "Created by me" (say Authored by me)

**Review thread**:
A comment thread anchored to a location in a pull request's diff (spec 003), with a resolved or unresolved state; resolving and unresolving are both explicit, reversible actions, never inferred from a reply.
_Avoid_: Comment thread, discussion

**Review action**:
Any of comment, reply, resolve, unresolve, submit a review (comment/approve/request changes), or merge (spec 003) -- every one runs only as the direct result of an explicit user action, and approving, requesting changes, and merging each require a confirmation naming the pull request and the exact action first.
_Avoid_: PR action, operation

**Rendered view**:
The formatted display of a Markdown file or value, with its syntax hidden; for a Markdown file in a file tab it is editable in place. One of the two views behind the Rendered/Source toggle.
_Avoid_: Preview (implies read-only), WYSIWYG, edit mode

**Source view**:
The raw Markdown text of the same file or value, shown and edited as code. The other view behind the Rendered/Source toggle.
_Avoid_: Code view, raw view, code only

**Theme** (spec 007):
One of the built-in dark-toned colour presets (Dark, Dark (high contrast), Obsidian -- #550, theme foundation palette v2) applying app-wide, chosen from the Settings screen's Appearance section with a live preview; Save persists it, Cancel/Esc/leaving Settings reverts it. Spec 008's planned profile Theme submenu reuses the same `theme-store.ts` `save`/`preview` actions and `THEMES` table, not new theme data of its own.
_Avoid_: light mode, dark mode (ambiguous once more than one dark preset exists), follow-system

**Chat width** (issue #554):
The app-wide Settings, Appearance choice between Full (default, the transcript column fills the pane) and Reading column (caps it at 64rem, centred); applies to the chat transcript only, never the message box or the status line. Save/Cancel live preview, the same interaction model as **Theme**.
_Avoid_: reading width, line width (ambiguous with a font/measure setting, which does not exist)

### UI vocabulary

Decided by Stuart in the #474 grill, 2026-10-08. Glossary only -- implementation detail (icon, button, and tooltip rules) lives in `docs/design/`, not here.

**Pill**:
A small, fully-rounded control showing one current state or mode at a glance, usually opening a menu to change it (for example, the Approval mode pill).
_Avoid_: Badge, tag (for a control that opens a menu)

**Chip**:
A small, rounded-rectangle element showing one discrete fact or item, read-only or removable, usually grouped with others in a row (for example, a pasted-text chip in the composer's attachment strip -- this entry defines the shape generically). The **Status line**'s own entries are plain text, not this shape (2026-10-15 grill, issue #564): see **Status line**'s own _Avoid_ note.
_Avoid_: Tag, token (ambiguous with a design token)

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
A distinct, secondary tool or view hosted in the right pane, opened and closed as a whole (for example, the **Subagent panel**).
_Avoid_: Sidebar, drawer

**Pane**:
An unboxed, resizable region of the main content area, one of possibly several side by side, each independently scrollable (for example, a **Chat pane**). Inside a **Split**, say **Chat pane**, not the bare word, per that entry's own _Avoid_ note.
_Avoid_: Panel (a distinct, secondary tool or view, not this region), split view (for the arrangement itself -- see **Split**)

**Tab**:
One of a set of mutually exclusive selectable labels that switches which content shows in the same region, exactly one active at a time (for example, a **Pull requests view**'s **Filter tab**).
_Avoid_: Filter (see **Filter tab**), section

**Readout**:
A compact, glanceable display of one live fact about something elsewhere in the app -- the **Status line**'s own entries (for example, Changes, Pull request, Subagents). Most readouts are plain text; some are also the entry point to an action, in which case they behave like a quiet text button rather than a chip (for example, one that opens an external link or a panel).
_Avoid_: Display, indicator, Readout chip (retired 2026-10-15, issue #564 -- see **Status line**)

**Role·Model pill**:
The composer control showing the **Session**'s current role and the model it runs on ("Default · Sonnet 5.5"), or "Pinned" and the model when a model was chosen directly. It opens one switcher for both; the thinking level has its own pill (issue #766).
_Avoid_: Role chip, model badge, model picker (for the combined control)

**Pending change**:
A role, model or thinking-level choice made while a turn runs or the agent is stopped. It shows at once with a "next turn" mark and is applied before the next prompt (or when the agent starts); the last choice wins (issue #766).
_Avoid_: Queued change (a queued message is different), deferred setting

**Advisor**:
omp's optional watchdog subsystem that watches a Session's turns and emits advisories (blocker, concern and nit rows -- see **Advisory accent bar**/**Advisory location**/**Advisory concern run**), a distinct thing from those rows themselves. Runs on `modelRoles.advisor`, possibly a different provider than the primary model, and sees the Session's transcript. Toggled per Session, not persisted, with `/advisor on`, `/advisor off` and `/advisor status` (issue #917); no Settings toggle. Decided (Stuart, 2026-10-16): no cost readout (`advisor_cost_changed` stays unread); `/advisor status` reports spend on demand instead; a persistent on/off indicator is tracked separately as issue #937. That indicator (issue #937, follow-up to #917/PR #923) is the **Status line**'s own Advisor readout (**Readout**, zero-box convention): shown only while the advisor is on for that Session, hidden entirely while off, with no cost, spend, or token figures of its own; clicking it sends `/advisor off`. Its state comes from `/advisor on|off`'s own reply text (the only fully-trusted signal) plus a best-effort, silent `/advisor status` probe run once on Session attach/resume -- that probe's own reply never appears in the transcript, and its ambiguous wording (`session::advisor`'s own header comment) is never trusted for an "on" reading, only an unambiguous "Advisor is enabled"/"Advisor is disabled" substring is.
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

## Flagged ambiguities

- The agent (OMP) uses "session" for what Refract calls a **Conversation**. In Refract, **Session** always means the worktree-bound unit of work; say **Conversation** for the agent's notion.
- The current spec (`specs/001-core-session-workspace/spec.md`) defines Session as "one conversation with the agent bound to one worktree". That contradicts the resolution above and must be corrected when the spec is next amended.
- The generic **Readout** term (#474 UI vocabulary) is not mutually exclusive with interactivity: a Readout is sometimes a real button or link (for example, Pull request, Subagents), not only plain text -- see **Status line**'s own distinction between the two. **Readout chip** (the row's older, boxed name) is retired as of the 2026-10-15 grill, issue #564: the row is now plain text, not chip-shaped, so **Status line** and **Readout** are the only current terms.

## Example dialogue

> **Dev:** I started a fresh chat in my "login-fix" **Session**. Did I just make a second **Session**?
> **Expert:** No. "login-fix" is still one **Session** with the same **Worktree**. You now have a second **Conversation** in it, and the first one is still there as history.
> **Dev:** And if I want a separate copy of the repo to try something else?
> **Expert:** That is a new **Session**, and Refract creates a new **Worktree** for it.

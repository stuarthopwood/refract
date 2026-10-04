# Refract

Refract is a desktop app for working with a coding agent, one isolated copy of a project per unit of work. This file is the shared vocabulary for specs, plans, and code.

## Language

**Repository**:
A local git project the developer has added to Refract. Owns zero or more **Sessions**.
_Avoid_: Project, workspace

**Session**:
One unit of work: a **Worktree** together with the **Conversations** held in it. It is one entry in the session list and lives until the developer archives or deletes it. A **Repository** has many **Sessions**; a **Session** has exactly one **Worktree**. Its display name is independent of its branch and worktree folder name: renaming a Session never touches either, and the new name shows everywhere at once (list, chat header, branch picker, notifications).
_Avoid_: Task, thread, chat (for the whole unit)

**Archive**:
Hide a **Session** from the main list while keeping its **Worktree** and **Conversations** intact; reversible. The default way to finish with a **Session**.
_Avoid_: Close, remove (ambiguous with delete)

**Delete**:
Permanently remove a **Session**, its **Worktree**, and its **Conversations**, only after a confirmation that names what will be lost (uncommitted changes, unpushed commits).
_Avoid_: Remove, discard

**Worktree**:
The isolated checkout of a **Repository** that a **Session** works in. Created by Refract when the **Session** is created.
_Avoid_: Branch, folder, clone

**Base branch**:
The branch a new **Session**'s **Worktree** branches from. One-click creation uses the repository's default branch; the branch button opens a picker with the default branch preselected. Any branch can be a Base branch, including another **Session**'s branch, which the picker lists under that **Session**'s name.
_Avoid_: Parent branch, source branch

**Approval mode**:
The app-wide setting for how much the agent may do without asking: **Ask** (prompts for file changes and commands), **Edit freely** (prompts only for commands), or **Auto** (never prompts). Applies to every **Session**; reads are never prompted.
_Avoid_: Permission level, yolo (internal OMP name for Auto)

**Conversation**:
One continuous exchange with the agent inside a **Session**. A **Session** has many **Conversations**, one of which is current; starting a fresh one keeps the same **Session** and **Worktree** and keeps the earlier ones reachable as history.
_Avoid_: Session (in the agent's own sense), transcript

**Readout chip**:
One entry in the row above the message box (spec 004) showing one glanceable fact about a **Chat pane**'s **Session**'s current state -- Changes, Context window usage, Turn time, Current time, Pull request, Subagents, or Todo progress -- live, each hidden entirely or reading "Not available" per its own rule, never conveyed by colour alone. Which kinds show is chosen per-kind in Settings; each pane of a **Split** reads its own Session's data independently.
_Avoid_: Status chip, badge (for this row specifically)

**Subagent panel**:
The right region's first occupant (spec 004), opened by activating the Subagents **Readout chip**: lists the current turn's subagents by name/task with a state icon plus the state word, and shows a selected one's live stream (text and tool calls) updating as it runs.
_Avoid_: Subagent sidebar, task panel

**Chat pane**:
One half of the split chat area (spec 005): a complete chat for one **Session** -- header, transcript, message box, queued messages, pending approvals and questions, and the **Readout chip** row -- matching what a single, unsplit chat pane shows for that **Session**. One or two show at once; the same **Session** is never shown in two panes at the same time.
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

**Pull requests view**:
The left-nav entry and the list-plus-detail view it opens (spec 003), scoped to a chosen **Repository**'s pull requests on GitHub, read and acted on through the developer's already-signed-in GitHub CLI; Refract stores no token of its own.
_Avoid_: PR view, merge requests (GitLab's term)

**Filter tab**:
One of the five tabs a **Pull requests view**'s list offers -- Open, Authored by me, Assigned to me, Involves me, Review requested (spec 003) -- narrowing which pull requests the list shows; exactly one is active at a time, defaulting to Open.
_Avoid_: Filter, category

**Review thread**:
A comment thread anchored to a location in a pull request's diff (spec 003), with a resolved or unresolved state; resolving and unresolving are both explicit, reversible actions, never inferred from a reply.
_Avoid_: Comment thread, discussion

**Review action**:
Any of comment, reply, resolve, unresolve, submit a review (comment/approve/request changes), or merge (spec 003) -- every one runs only as the direct result of an explicit user action, and approving, requesting changes, and merging each require a confirmation naming the pull request and the exact action first.
_Avoid_: PR action, operation

## Flagged ambiguities

- The agent (OMP) uses "session" for what Refract calls a **Conversation**. In Refract, **Session** always means the worktree-bound unit of work; say **Conversation** for the agent's notion.
- The current spec (`specs/001-core-session-workspace/spec.md`) defines Session as "one conversation with the agent bound to one worktree". That contradicts the resolution above and must be corrected when the spec is next amended.

## Example dialogue

> **Dev:** I started a fresh chat in my "login-fix" **Session**. Did I just make a second **Session**?
> **Expert:** No. "login-fix" is still one **Session** with the same **Worktree**. You now have a second **Conversation** in it, and the first one is still there as history.
> **Dev:** And if I want a separate copy of the repo to try something else?
> **Expert:** That is a new **Session**, and Refract creates a new **Worktree** for it.

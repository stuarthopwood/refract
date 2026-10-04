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
One entry in the row above the message box (spec 004) showing one glanceable fact about the visible **Session**'s current state -- Changes, Context window usage, Turn time, Current time, Pull request, Subagents, or Todo progress -- live, each hidden entirely or reading "Not available" per its own rule, never conveyed by colour alone. Which kinds show is chosen per-kind in Settings.
_Avoid_: Status chip, badge (for this row specifically)

**Subagent panel**:
The right region's first occupant (spec 004), opened by activating the Subagents **Readout chip**: lists the current turn's subagents by name/task with a state icon plus the state word, and shows a selected one's live stream (text and tool calls) updating as it runs.
_Avoid_: Subagent sidebar, task panel

## Flagged ambiguities

- The agent (OMP) uses "session" for what Refract calls a **Conversation**. In Refract, **Session** always means the worktree-bound unit of work; say **Conversation** for the agent's notion.
- The current spec (`specs/001-core-session-workspace/spec.md`) defines Session as "one conversation with the agent bound to one worktree". That contradicts the resolution above and must be corrected when the spec is next amended.

## Example dialogue

> **Dev:** I started a fresh chat in my "login-fix" **Session**. Did I just make a second **Session**?
> **Expert:** No. "login-fix" is still one **Session** with the same **Worktree**. You now have a second **Conversation** in it, and the first one is still there as history.
> **Dev:** And if I want a separate copy of the repo to try something else?
> **Expert:** That is a new **Session**, and Refract creates a new **Worktree** for it.

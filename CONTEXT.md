# Pinion

Pinion is a desktop app for working with a coding agent, one isolated copy of a project per unit of work. This file is the shared vocabulary for specs, plans, and code.

## Language

**Repository**:
A local git project the developer has added to Pinion. Owns zero or more **Sessions**.
_Avoid_: Project, workspace

**Session**:
One unit of work: a **Worktree** together with the **Conversations** held in it. It is one entry in the session list and lives until the developer archives or deletes it. A **Repository** has many **Sessions**; a **Session** has exactly one **Worktree**.
_Avoid_: Task, thread, chat (for the whole unit)

**Archive**:
Hide a **Session** from the main list while keeping its **Worktree** and **Conversations** intact; reversible. The default way to finish with a **Session**.
_Avoid_: Close, remove (ambiguous with delete)

**Delete**:
Permanently remove a **Session**, its **Worktree**, and its **Conversations**, only after a confirmation that names what will be lost (uncommitted changes, unpushed commits).
_Avoid_: Remove, discard

**Worktree**:
The isolated checkout of a **Repository** that a **Session** works in. Created by Pinion when the **Session** is created.
_Avoid_: Branch, folder, clone

**Base branch**:
The branch a new **Session**'s **Worktree** branches from. Chosen when the **Session** is created; the repository's default branch is preselected.
_Avoid_: Parent branch, source branch

**Approval mode**:
The app-wide setting for how much the agent may do without asking: **Ask** (prompts for file changes and commands), **Edit freely** (prompts only for commands), or **Auto** (never prompts). Applies to every **Session**; reads are never prompted.
_Avoid_: Permission level, yolo (internal OMP name for Auto)

**Conversation**:
One continuous exchange with the agent inside a **Session**. A **Session** has many **Conversations**, one of which is current; starting a fresh one keeps the same **Session** and **Worktree** and keeps the earlier ones reachable as history.
_Avoid_: Session (in the agent's own sense), transcript

## Flagged ambiguities

- The agent (OMP) uses "session" for what Pinion calls a **Conversation**. In Pinion, **Session** always means the worktree-bound unit of work; say **Conversation** for the agent's notion.
- The current spec (`specs/001-core-session-workspace/spec.md`) defines Session as "one conversation with the agent bound to one worktree". That contradicts the resolution above and must be corrected when the spec is next amended.

## Example dialogue

> **Dev:** I started a fresh chat in my "login-fix" **Session**. Did I just make a second **Session**?
> **Expert:** No. "login-fix" is still one **Session** with the same **Worktree**. You now have a second **Conversation** in it, and the first one is still there as history.
> **Dev:** And if I want a separate copy of the repo to try something else?
> **Expert:** That is a new **Session**, and Pinion creates a new **Worktree** for it.

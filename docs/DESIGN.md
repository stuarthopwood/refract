# Pinion design

Look, feel, and interaction rules shared by every spec. Vocabulary is in [CONTEXT.md](../CONTEXT.md); behaviour is in `specs/`; rules are in the [constitution](../.specify/memory/constitution.md). Ideas and features are tracked as GitHub issues (see [Backlog](#backlog)).

Items marked **(default)** are my proposals that you have not reviewed yet.

## Principles

- Show state at a glance; never make the developer open a Session to learn whether it needs them.
- A dense turn stays readable: many tool calls must not bury the answer.
- Every action has a visible button; shortcuts are a second way, never the only way.
- Destructive actions name what will be lost before they happen.
- The agent does the work; Pinion is the place to watch, steer, and approve it.

## Layout

- Three regions: **session list** (left), **chat** (centre), and a reserved right region for the later changes, files, and side chat pane (hidden until that spec ships).
- A **status bar** along the bottom carries the app-wide Approval mode switch.
- Panes resize by dragging their borders; the session list can be hidden.
- Session list: collapsible group per **Repository**, **Sessions** sorted by most recent activity. Each row shows a state icon, the Session name, its branch, time since last activity, and an unread dot. **Archived** Sessions sit in a collapsed group at the bottom of each Repository.
- Chat header: Session name and branch, a Conversation switcher (history of that Session's Conversations), and a small chip when an Approval mode change is pending ("Auto after this turn").

## Look and feel

- **Theme**: dark by default, with a light option. **(default)** No follow-system setting in the first build.
- **Density**: medium. Neither terminal-tight nor roomy chat-app.
- **Fonts**: two independent, user-customisable settings.
  - **UI font** for the app chrome.
  - **Code font** for code blocks, tool output, diffs, and the message box: monospaced, with Nerd Font glyph support and a ligatures on/off choice, and a size setting.
  - **(default)** Pinion uses fonts installed on the system and does not bundle any; glyphs missing from the chosen font fall back to another installed font.
- **State colour roles** **(default)**: working (accent), idle (muted), needs you (warning), stopped (error). Every state also has a distinct icon, so colour is never the only signal.

## Chat

- Full-width transcript, no bubbles. Your messages are a subtly tinted block with a small "You" label; the agent's text sits plain on the background.
- Each tool call is one compact row: tool, target, status, duration. Expanding shows arguments and output; a file edit shows a diff. Reasoning is a collapsed "Thinking" row.
- Prose keeps a readable maximum line width; code blocks and diffs may span wider.
- Sending while a turn runs queues a removable chip under the turn; "Send now" on the chip steers the running turn.
- Approval requests and agent questions appear inline in the transcript at the point they arise, with Approve / Deny or the answer controls, and mark the Session as needs you.
- Agent text, tool output, and file contents are always shown as inert content.

## Keyboard

| Action | Shortcut |
|---|---|
| Send message | Enter |
| Newline in message | Shift+Enter |
| Clear the message box | Esc |
| Stop the running turn | Ctrl+Shift+X |
| New Session | Ctrl+N |
| New Conversation | Ctrl+Shift+N |
| Jump to the Nth Session | Ctrl+1 to Ctrl+9 |
| Hide or show the session list | Ctrl+B |
| Open Settings | Ctrl+, |
| Cycle Approval mode | Ctrl+Shift+A |
| Command palette | Ctrl+K |

Ctrl+Esc and Ctrl+Shift+Esc were considered for Stop and rejected: Windows reserves them (Start menu and Task Manager), so the app may never receive them.

## First run and empty states

- With nothing configured, the window shows a readiness checklist: git found, OMP found and on the supported version, OMP signed in. Each failing item has a fix hint.
- One primary action, **Add repository**, is disabled until the checklist passes. After that, the same area is the empty state for "no Sessions yet" with a **New session** button.

## Feedback and errors

**(default)**

- Problems belonging to one Session (agent stopped, worktree missing) show as a persistent banner in that Session's chat and a stopped state in the list.
- Transient app-level problems (a branch list failed to load) show as a toast.
- A Windows notification fires only for **needs you** and **finished**, and only when Pinion is not the focused window; clicking it opens that Session.

## Settings in the first build

- Approval mode (also on the status bar).
- Theme, UI font, code font (family, ligatures, size): wanted, but not in spec 001, which uses defaults; tracked as an issue.

## Confirmed in implementation

- **Opening a Session**: clicking a non-visible row only flips `visibleSessionId`; `ChatPane`'s effect on that id change is the single place that asks for a snapshot (`sessions.open`) and applies it (transcript, queue, pending requests, stop banner). Clicking the already-visible row (waking a `not-started` Session) calls `open` directly instead, since there is no visibility change to trigger that effect.
- **Approval mode switch**: changing the status-bar mode persists immediately, but a live Session only restarts into it once it is idle with nothing pending (`pendingMode` on the runtime view); the chat header shows "<mode> after this turn" while a restart is pending. A Session that is not live simply launches in the new mode next time.
- **Reattaching a live process to a Conversation** (`switch_session`, used by both session-open and the mode-change restart) is verified, not assumed: after the RPC call reports `cancelled: false`, Pinion calls `get_state` and checks its `messageCount` is at least the Conversation's last known `lastMessageCount` before trusting the reattach; a failed check rolls back to the previous Conversation where possible.
- **Readiness ("OMP signed in")**: `get_state`'s current model must also appear in `get_available_models`; a resolved `{provider, id}` from `get_state` alone is not diagnostic of sign-in (disabled or uncredentialled providers can still show up there), so the model-presence check is the actual signal. `get_login_providers` is used only to enrich the failure hint with the unauthenticated provider ids.
- **Tool rows**: a `write` result shows "Wrote N lines to `<path>`"; an `edit` result shows a diff built from the tool's own `details.oldText`/`details.newText` (not a general-purpose git diff, which is unreliable per-call once several edits touch the same file in one turn).
- **Session list keyboard and focus model**: each row is one button (open/wake) plus an `⋮` menu trigger (rename, archive/restore, stop agent, delete). F2 on the focused row button starts renaming; Enter/Escape commit or cancel it. Archive/restore/delete can unmount the focused row (sometimes its whole group), so every such action captures a fallback chain before acting -- next row, then previous row, then the Repository's own collapsible trigger, then the Sessions nav root -- so focus never lands on `<body>` (WCAG 2.1 AA).
- **Motion**: a `prefers-reduced-motion: reduce` media query disables animation globally (spinners, transitions), leaving colour, icon, and `sr-only` state text as the non-motion signal.
- **State icons**: each Session state (`working`, `idle`, `needs-you`, `stopped`) pairs a distinct Lucide icon and colour with an `sr-only` text label (`STATUS_LABEL`), so colour is never the only signal, including for screen readers.

## Backlog

Ideas and features live in the GitHub issue log for `stuarthopwood/pinion`. Labels:

- **Type**: `idea` (the inbox), `feature`, `bug`, `spike`, `chore`.
- **Area**: `session-list`, `chat`, `approvals`, `worktree`, `transport`, `notifications`, `settings`, `design`, `right-pane`, `build`.
- **Priority**: `p1`, `p2`, `p3`.
- **Spec link**: `spec:NNN` when an issue has been shaped into `specs/NNN-...`.

Status is only open or closed. A new thought is filed as an `idea`; when it is worth building it is shaped with `/speckit.specify`, gets a `spec:NNN` label, and links to the spec.

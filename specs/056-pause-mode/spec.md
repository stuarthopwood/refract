# Spec 056: Pause mode (issue #477)

Source: issue #477, amendment block (grill-with-docs, 2026-10-29). The amendment supersedes the older body.

## Clarifications

Session 2026-10-29. Answered by Skippy, delegated by Stuart, from the grill block.

- Q: Does OMP have an RPC pause? A: No (can1357/oh-my-pi#17371). Refract runs the safe point itself at the turn boundary: the running turn finishes, then queued and new messages are held.
- Q: A new status enum variant or a separate field? A: Separate `pause` field (`pausing` | `paused`, absent = not paused). Reason: a new `SessionStatus` variant breaks every exhaustive match across Rust and TypeScript. The renderer derives the display status.
- Q: Status precedence? A: Working, Needs you, Paused, Stopped, Unread response, Idle. A working Session with `pausing` shows Paused with the label "Pausing…".
- Q: Messages with images sent while paused? A: Refused with a clear error. Reason: held messages persist as text only.
- Q: Messages already in OMP's queue when Pause is pressed? A: Withdrawn from OMP's queue into Refract's held list (images on those are lost; follow-up). They send again on Resume.
- Q: Goal mode? A: `goal pause` is out of scope: no goal-mode code exists (#479 not built).
- Q: Persistence? A: A `paused` flag and the held texts persist in the Session registry. A paused Session relaunches paused and never auto-resumes.

## Requirements

- FR-001: `chat.pause(sessionId)` marks the Session Pausing if a turn is running, else Paused.
- FR-002: While Pausing or Paused, `SessionAgent::send` holds the message (text only) instead of sending it. Image messages are refused.
- FR-003: At turn settle, a Pausing Session becomes Paused. A persisted Session state survives app and agent restarts.
- FR-004: `chat.resume` clears pause and sends held messages in order (first as a prompt, the rest as follow-ups).
- FR-005: `chat.pauseAll` pauses every live Session. `chat.resumeAll` resumes every paused Session.
- FR-006: `/pause` toggles pause. `/resume` stays OMP's. `/pause` is no longer refused as reserved.
- FR-007: `session:status`, `sessions.list` and `SessionSnapshot.runtime` carry the optional `pause` field.
- FR-008: The paused chat (transcript and composer) is blurred and inert. The overlay shows a pause icon, "Paused", the line "Press Space or select Resume", and a Resume button.
- FR-009: Controls: session row context menu item (Pause or Resume), a Pause/Resume button in the chat header, Pause all / Resume all in the session list footer between ProfileItem and Settings (Resume all while any Session is paused).
- FR-010: Space resumes the focused paused pane. It does nothing in text fields, menus and dialogs. It is listed in the shortcuts dialog and on the palette's Resume action.
- FR-011: The status change is announced politely to screen readers.

## Out of scope

- `goal pause` (#479). OMP RPC pause (upstream). Persisting images on held messages.

Amended by `specs/127-pause-cancels-subagents-1835/spec.md` (#1835): Pause also cancels the Session's running subagents and auto-cancels any started while paused. Everything above is otherwise unchanged.

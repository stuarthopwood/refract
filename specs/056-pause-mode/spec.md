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

Session 2026-11-12 (#1890). Amended retroactively: the code was written first on this branch (commit ff050399) and this amendment records the decisions it implements, per the converge route. Issue #1890 names spec 001, but the pause requirements live here, so the amendment is here.

- Q: Does Resume on a stopped paused Session start the agent? A: Yes. Resume starts the agent, sends held messages in order, then clears the pause (Stuart, 2026-11-11). The separate **Start agent** button on the Paused body is removed; one primary **Resume** keeps focus.
- Q: Resume all when a Session fails to start? A: Each paused, stopped Session starts independently. A failure keeps that Session paused with its held messages, and one notice reports "Resumed N, M failed to start" (Stuart, 2026-11-12).
- Q: After a Refract restart? A: A paused Session with held messages stays paused and stopped until **Resume** is pressed. Refract never auto-starts it at launch (Stuart, 2026-11-12).
- Q: Does Stop idle sweep up paused Sessions? A: No. The Stop idle dialog skips them and shows one muted line, "Skipped N paused Sessions.", only when N is greater than 0 (Stuart, 2026-11-12).
- Q: Archived paused Sessions? A: Resume refuses with `session-archived` and Resume all skips them: Resume must not revive a hidden agent. Accepted by Stuart.

## Requirements

- FR-001: `chat.pause(sessionId)` marks the Session Pausing if a turn is running, else Paused.
- FR-002: While Pausing or Paused, `SessionAgent::send` holds the message (text only) instead of sending it. Image messages are refused.
- FR-003: At turn settle, a Pausing Session becomes Paused. A persisted Session state survives app and agent restarts.
- FR-004: `chat.resume` starts the agent when the Session is stopped, then sends held messages in order (first as a prompt, the rest as follow-ups) and clears the pause. A failed start or send keeps the Session paused with the unsent messages held. An archived Session is refused with `session-archived`.
- FR-005: `chat.pauseAll` pauses every live Session. `chat.resumeAll` resumes every paused, non-archived Session independently, starting stopped ones, and returns `{count, failed}`; one notice reads "Resumed N, M failed to start" when `failed` is above 0.
- FR-006: `/pause` toggles pause. `/resume` stays OMP's. `/pause` is no longer refused as reserved.
- FR-007: `session:status`, `sessions.list` and `SessionSnapshot.runtime` carry the optional `pause` field.
- FR-008: The paused chat (transcript and composer) is blurred and inert. The overlay shows a pause icon, "Paused", the line "Press Space or select Resume", and one primary Resume button (no separate Start agent button, even when the agent is stopped).
- FR-009: Controls: session row context menu item (Pause or Resume), a Pause/Resume button in the chat header, Pause all / Resume all in the session list footer between ProfileItem and Settings (Resume all while any Session is paused).
- FR-010: Space resumes the focused paused pane. It does nothing in text fields, menus and dialogs. It is listed in the shortcuts dialog and on the palette's Resume action.
- FR-011: The status change is announced politely to screen readers.
- FR-012: The Stop idle dialog (Memory Triage) MUST NOT select paused Sessions. When N above 0 are skipped it shows one muted line "Skipped N paused Sessions." (singular for N = 1).

## Acceptance scenario

1. **Given** a paused, stopped Session holding a queued message, **When** the user presses Resume, **Then** the agent starts, the held message is sent, and the pause clears; if the start fails the Session stays paused with the message held.

## Edge cases

- Resume pressed twice (Space twice, Resume all) starts and drains once.
- Resume all with some archived or failing Sessions resumes the rest.

## Out of scope

- `goal pause` (#479). OMP RPC pause (upstream). Persisting images on held messages.

Amended by `specs/127-pause-cancels-subagents-1835/spec.md` (#1835): Pause also cancels the Session's running subagents and auto-cancels any started while paused. Everything above is otherwise unchanged.

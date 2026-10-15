# Quickstart: verifying the session readout

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/](contracts/). Prerequisites and `pnpm` commands are
unchanged from spec 001's quickstart.

## Prerequisites

- Everything in spec 001's quickstart (Windows 11, `omp` 18.4.x or 18.5.x signed in, a scratch repository).
- Spec 001 tasks T098 (Approval mode pill / chip row) and T068 (`sessions.diffStat`) already on
  `main`: this spec's chip row has nothing to attach to otherwise.
- The GitHub CLI (`gh`) signed in, and a scratch branch pushed with an open pull request, for the
  Pull request chip check.
- A model/agent configuration that can run a multi-subagent turn (the `task` tool), for the
  Subagents checks.

## First-task gates (constitution IV)

These OMP facts are unverified and are checked before the work that depends on them:

- Whether and where OMP reports context-window usage (`get_state` field, `get_session_stats`, or
  only `/context`'s `command_output`).
- Whether and where OMP reports task-list ("todo") done/total counts.
- Whether `tool_execution_update` progress (or `set_subagent_subscription`) carries a per-subagent
  live text/tool-call stream, not only a status summary.

## Checks per story

**Story 1: see a session's state at a glance (FR-001 to FR-010, FR-021)**

1. Open a Session with uncommitted edits against its Base branch. Expect: the status line (the
   old chip row, renamed; 2026-10-15, issue #564 -- the Approval mode pill is no longer here, it
   is inside the message box instead, spec 001 FR-065) directly above the message box shows a
   Changes chip matching the Session details card's figure (spec 001 FR-039), abbreviated for a
   very large count.
2. Open a Session whose worktree or Base branch is missing. Expect: the Changes chip reads "Not
   available" rather than a count or being hidden.
3. Start a turn and watch the row while it runs. Expect: a Turn time chip ticks up, a Context
   window usage chip shows used/window/percent abbreviated by the shared `k`/`m`/`b` formatter
   with no literal word "tokens" (for example "44.8k/1m (4%)", issue #437), or "Not available" if
   the agent never reports it, and visibly warns (text or icon, not colour alone) once usage
   nears the window's limit.
4. Let the turn end. Expect: the Turn time chip disappears; Changes and Context window usage keep
   their last reading.
5. Watch the Current time chip (turn it on in Settings first; it defaults off) for at least a
   minute. Expect: it advances to the next minute without any assistive-technology announcement
   on the ordinary tick (check with a screen reader running: no "live region" chatter every
   second).
6. With the scratch branch's pull request open on GitHub, reopen the Session. Expect: a Pull
   request chip shows its number; activating it opens that pull request (system browser, until
   spec 003's own view exists — research.md decision 4). Switch to a branch with no pull request,
   or disconnect from GitHub: the chip disappears with no error toast.
7. Ask the agent a request that starts two or more subagents. Expect: while any are still
   running, the Subagents chip shows the running count only (for example "2 subagents running",
   issue #536 — never a combined running-plus-finished total worded "running"); once the turn
   settles with none still running, it shows a quiet, comma-joined total of whichever of
   `finished`/`exited`/`failed` are non-zero (for example "2 finished", or "1 finished, 1 exited"
   — gate fixes 2 finding 7, never folded into one misleading "N finished" bucket), and keeps
   showing that same total until a later turn starts (and clears the prior turn's subagent list).
7b. Crash the agent process mid-subagent-run and reopen the Session (`taskkill /PID <omp pid> /F`
    while a `task()` call is genuinely running, then reopen the Session from the list — issue
    #489). Expect: the Subagents chip is reachable again (not silently hidden), the panel lists
    the interrupted subagent exactly ONCE (gate fix, 2026-10-07: a prior build double-counted it
    as two rows/"2 finished" because the live summary and the chat-transcript row used
    unrelated id schemes) with state "Agent exited" (a distinct icon, never the spinner or the
    check/cross finished/failed icons), the chat transcript's own collapsed subagent line shows
    the same settled state (not left spinning "running" while the panel disagrees), selecting
    that row in the panel shows an explanatory placeholder instead of erroring, and the chip's
    quiet count includes it with no duration shown if the agent's own start time was never known.
7c. Steer the agent (send a new message) while a subagent is still running, then crash the agent
    process and reopen the Session (durable turn marker, issue #489). Expect: the steered
    subagent's pill survives — it still settles to "Agent exited" on reattach, not silently
    dropped — because scope is now the persisted `Session.currentTurnSubagents` registry marker,
    not transcript position, so the steer's own `user` item can no longer move the turn boundary
    past the still-running subagent's row.
8. Ask the agent to keep a task list for the current work, and read it partway through. Expect: a
   Todo chip reads "Todo N/M"; it disappears once the agent has no task list at all.
9. Resize the window very narrow with several chips enabled. Expect: the row wraps onto a further
   line, or scrolls; it never hides or overlaps the message box.
10. Using only the keyboard, Tab to the Pull request and Subagents chips (when shown): each has a
    visible focus indicator and an accessible name stating what it opens; a non-clickable chip
    (for example Changes) reads as one phrase through a screen reader.

**Story 2: choose which readouts show (FR-011 to FR-016)**

1. Open Settings (the temporary gear affordance this spec adds, until spec 008's profile-item cog
   exists — research.md decision 7). Expect: two sections, "Session readout" (this spec) and
   "Appearance" (spec 007's theme picker) — the Session readout section lists Changes,
   Context window usage, Turn time, Current time, Pull request, Subagents, and Todo progress, each
   with its own on/off control; on a never-changed install, every one is on except Current time.
2. Turn Current time on. Expect: every open Session's status line shows it, last at the row's
   right end, within about 1 s, with no Session reopened and no restart.
3. Restart Refract. Expect: Settings and every Session's row still reflect that choice.
4. Using only the keyboard, reach every control in the Session readout section with a visible
   focus indicator, and toggle at least two of them.

**Story 3: inspect subagents (FR-017 to FR-020)**

1. Start a turn with two subagents, and while it runs, activate the Subagents chip. Expect: a
   right-side panel opens listing each subagent with its name or task and its state (running,
   finished, failed, or exited — the last only after a crash/resume, issue #489); the chat pane
   is otherwise unchanged.
2. Select the running one. Expect: the panel shows its live stream — text and tool calls — updating
   within about 2 s of new output.
3. Let it finish while its stream is open. Expect: the panel updates its state without closing.
4. Close the panel. Expect: it closes, and the chat pane is exactly as it was before the panel
   opened (no size change, no scroll jump).

## Dependency note for this quickstart

The Settings entry point used in Story 2 step 1 is temporary (research.md decision 7); once spec
008's profile-item cog lands, use that instead and retire the temporary control per that spec's
own plan — this quickstart's steps otherwise stay the same.

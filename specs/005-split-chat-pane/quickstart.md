# Quickstart: verifying the split chat pane

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/ipc.md](contracts/ipc.md). This quickstart assumes
spec 001's own quickstart already passes (git, OMP, sign-in; a scratch repository with at least
two Sessions is easiest — create two from the session list before starting these checks).

## Prerequisites

Same as spec 001's quickstart, plus: at least two Sessions already created in the scratch
repository (or two different repositories), so "Open in split" has a second Session to pick.

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: put a second session beside the first (FR-001 to FR-006, FR-010, FR-019, SC-001, SC-002)**

1. With one Session open (single pane, full width), open the second Session's row menu and
   choose **Open in split**. Expect: the chat area divides into two side-by-side panes separated
   by a draggable divider; the pane that was already open keeps its Session, the chosen one
   appears in the other pane, both showing a complete chat (header, transcript, message box).
2. Close the split (either pane's close control) to return to one pane, then repeat step 1 using
   Ctrl+click on the second Session's row instead of the menu item. Expect the same result.
3. Drag the divider with the pointer: both panes resize. Tab to the divider and use the arrow
   keys: the divider moves without the pointer (FR-002, research.md Decision 5).
4. Send a message in each pane's Session. Expect: both stream their replies at the same time,
   neither pane's typing or streaming visibly delayed by the other (SC-002).
5. While one turn is running, trigger an approval or a question in that Session (per spec 001
   Story 2). Expect: the request card appears inline in that pane only, answerable without
   affecting the other pane (FR-019).

**Story 2: work in either pane (FR-005 to FR-010, SC-005)**

1. With two panes open, click inside the left pane. Expect: it is marked focused by more than
   colour (an accent bar plus a text marker), and the right pane loses the marker.
2. Type in the now-focused pane and send a message: confirm only that pane's Session receives it.
3. Press the focus-move keyboard command (Ctrl+Shift+\\, research.md Decision 8) with no pointer
   use. Expect: focus and its marker move to the other pane. Also click the small focus-move
   button on the divider handle: same effect.
4. Click a Session row in the session list that is not shown in either pane. Expect: it replaces
   the focused pane's Session; the other pane is unchanged (FR-008).
5. Click a Session row already shown in the *unfocused* pane. Expect: that pane becomes focused
   instead of the Session appearing a second time (FR-009); the same Session is never in both
   panes at once.
6. Use the message box, Stop, a queued-message chip, and an approval/question control in one
   pane. Expect: each acts only on that pane's Session.

**Story 3: close or change the split (FR-011 to FR-013, SC-004)**

1. With two panes open, close one. Expect: the other becomes the only pane, at full width,
   immediately, with no other step.
2. Reopen a split (Story 1), then choose **Open in split** (or Ctrl+click) on a third Session.
   Expect: it replaces the session shown in the **unfocused** pane; the focused pane is
   unchanged (FR-012).
3. Repeat choosing "Open in split" on the Session already shown in the *focused* pane
   (research.md Decision 7). Expect: no change (a no-op), never a third pane, never a duplicate.

**Story 4: the split survives a restart (FR-014, FR-015, SC-003)**

1. Open a split, drag the divider to a distinctive position, focus the right pane.
2. Quit Refract fully, then relaunch it (`pnpm dev`, or the built app).
3. Expect: the same two Sessions reopen in a split, side by side, at the same divider position,
   with the right pane focused — and, checked via Task Manager (`Get-Process omp`) or the
   session list's state icons, **neither Session's agent is running** until you interact with a
   pane (FR-014). Click into a restored pane and send a message: expect the agent starts only
   now, and the message is accepted normally.
4. Archive one of the two Sessions (from the session list), then restart Refract again. Expect:
   only the remaining Session's pane appears, at full width — the archived one is silently
   dropped from the restored split (FR-015).

## Narrow-window collapse (FR-017, SC-007, research.md Decision 6)

1. With two panes open, shrink the window width until the chat area can no longer fit two
   360 px-minimum panes. Expect: the chat area shows one pane (the focused Session) and a small
   chip in the header names the other (hidden) Session.
2. Click the chip. Expect: it swaps focus-and-display to the other Session, in one action, with
   no need to widen the window first.
3. Widen the window back past the two-pane threshold. Expect: both panes reappear automatically
   at the divider position they had before narrowing.

## Accessibility (FR-022, FR-023, SC-005)

1. With a screen reader running, move focus between panes with the keyboard command. Expect: one
   short announcement naming the newly focused Session, not a re-read of the whole pane.
2. Tab through the divider handle, the focus-move button, and both panes' controls with no mouse.
   Expect: a visible focus indicator at every step, and nothing is unreachable from the keyboard.

## First-task gates

This spec introduces no new OMP, Electron, GitHub CLI, or Windows behaviour to probe
(constitution IV): every process/IPC/security primitive it uses was already verified by spec 001.
The one third-party-library behaviour it newly relies on (keyboard-operable resize handle,
`onLayoutChanged` persistence) is sourced from the installed library's own documentation
(research.md Decision 5) and is checked live in Story 1, check 3 above, rather than by a separate
probe script.

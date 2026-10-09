# Feature Specification: Split chat pane

**Feature Branch**: `005-split-chat-pane` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "I understand the column width, with that in mind, lets add a
feature to split the chat pane so two sessions can be on screen at the same time." The column
width remark refers to spec 001 FR-049 (all chat text fills the full width of its column), raised
here because each pane's text must fill that pane's own width once the chat area is split.

## Clarifications

### Session 2026-10-02

- Q: How many sessions can be on screen at the same time? -> A: Two.
- Q: What orientation should the split take? -> A: Side by side.
- Q: How does a developer put a second session into the split? -> A: An "Open in split" item in
  each session's row menu, and Ctrl+click on a row.
- Q: Does the split persist across a restart? -> A: Restore the split after a restart.
- Q: What happens when the developer clicks a session row in the list while two panes are open?
  -> A: Replace the focused pane: one pane is focused and marked; clicking a row shows that
  session in the focused pane; clicking inside a pane focuses it.

### Session 2026-10-04 (convergence with spec 004)

- Q: Spec 004's Subagents panel is a single, shared right-side panel keyed to one Session. Once
  two panes exist, which pane does it belong to -- the focused one, always, or whichever pane's
  Subagents chip the developer actually clicked? -> A: Whichever pane's chip was clicked. The
  panel stays bound to the session that last explicitly opened or retargeted it; moving focus
  between panes on its own never silently retargets an already-open panel, matching spec 004's
  own existing rule that the panel only ever changes what it shows on an explicit user action
  (Close, a new turn starting, the shown Session vanishing) -- see research.md Decision 10.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Put a second session beside the first (Priority: P1)

A developer working in one session wants to see a second session at the same time. From that
session's row menu, or any other session's row menu, they choose "Open in split" (or Ctrl+click
the row instead); the chat area divides into two panes, side by side, separated by a draggable
divider. Each pane is a complete chat for its own session — header, transcript, message box,
queued messages, pending approvals and questions, and, once spec 004 exists, that session's
readout chip row — and both panes keep streaming live at the same time.

**Why this priority**: Without a second pane there is nothing to focus, close, or restore; every
later story in this spec depends on two sessions actually being on screen together first.

**Independent Test**: With two idle sessions open, choose "Open in split" on the second session's
row menu; confirm two side-by-side panes appear, each showing one session's complete chat. Send a
message in each session and confirm both stream their replies independently. Drag the divider
with the pointer, then move it again using only the keyboard.

**Acceptance Scenarios**:

1. **Given** a single chat pane is shown, **When** the developer chooses "Open in split" from a
   session row's menu, **Then** the chat area divides into two side-by-side panes: the session
   that was already open stays in one pane, and the chosen session appears in the other.
2. **Given** a single chat pane is shown, **When** the developer Ctrl+clicks a session row,
   **Then** the same split happens as in scenario 1.
3. **Given** two panes are open, **When** the developer looks at the chat area, **Then** a
   draggable divider separates the panes, and dragging it with the pointer resizes both.
4. **Given** the divider is focused, **When** the developer uses the keyboard, **Then** the
   divider's position changes without the pointer.
5. **Given** two panes are open, **When** the developer looks at either one, **Then** it shows a
   header, transcript, message box, any queued messages, and any pending approvals or questions
   for its own session, matching what a single chat pane shows for that session.
6. **Given** both sessions in a split have turns running, **When** the developer watches the two
   panes, **Then** both keep streaming their replies live at the same time, neither waiting on
   the other.

---

### User Story 2 - Work in either pane (Priority: P1)

With two panes open, the developer moves between them: one pane is always focused and visibly
marked; clicking or typing inside a pane focuses it; a keyboard command moves focus without
touching the pointer; and whichever pane is focused is the one a session-row click, the message
box, Stop, the queue, and approvals act on.

**Why this priority**: A split that cannot show which pane is "live" for input is unusable; this
story is what makes two panes safely independent instead of one pane with a confusing extra copy
beside it.

**Independent Test**: With two panes open, click inside the left pane and confirm it is marked
focused; type in it and send a message, confirming only that pane's session receives it. Press
the keyboard focus-move command and confirm focus and its marker move to the right pane. Click a
session row from the list and confirm it replaces the now-focused (right) pane's session, leaving
the left pane's session unchanged.

**Acceptance Scenarios**:

1. **Given** two panes are open, **When** the developer looks at the chat area, **Then** exactly
   one pane is marked as focused, using more than color alone.
2. **Given** two panes are open, **When** the developer clicks or types inside the unfocused
   pane, **Then** that pane becomes focused and the other pane loses the marker.
3. **Given** two panes are open, **When** the developer uses a keyboard-only command to move
   focus, **Then** focus moves to the other pane; the exact chord is decided with the rest of the
   keyboard shortcut set (backlog issue #6), and a visible, focusable control also moves focus
   between panes.
4. **Given** two panes are open, **When** the developer clicks a session row in the session list,
   **Then** that session replaces whatever was shown in the focused pane; the unfocused pane is
   unchanged.
5. **Given** two panes are open and the developer chooses a session already shown in the other
   pane (by row click, "Open in split", or Ctrl+click), **When** the action happens, **Then**
   that pane is focused instead of showing the session a second time; the same session never
   appears in both panes.
6. **Given** two panes are open, **When** the developer uses the message box, Stop, the queue, or
   an approval or question control inside a pane, **Then** it acts only on that pane's session,
   never on the other pane's session.

---

### User Story 3 - Close or change the split (Priority: P2)

The developer closes a pane to return to one session at full width, or keeps the split open and
swaps which session fills the unfocused pane.

**Why this priority**: Opening a split (User Story 1) is only half the feature; a developer who
cannot narrow back down to one pane, or who finds every "Open in split" afterwards opening a
third pane instead of replacing one, loses confidence in the whole feature.

**Independent Test**: With two panes open, close one and confirm the remaining session takes the
full chat area. Reopen a split, choose "Open in split" on a third session, and confirm it
replaces the unfocused pane rather than adding a third pane.

**Acceptance Scenarios**:

1. **Given** two panes are open, **When** the developer closes one, **Then** the other becomes
   the only pane, at full width.
2. **Given** two panes are open, **When** the developer chooses "Open in split" or Ctrl+clicks a
   session row, **Then** the session shown in the unfocused pane is replaced; the focused pane
   and its session are unchanged.
3. **Given** a split is open, **When** the developer wants a single pane again, **Then** closing
   either pane returns to one pane, at any time, with no other step required.
4. **Given** one pane is open (no split), **When** the developer closes it, **Then** the chat area
   shows the empty state ("Select a Session or create one.") and the Session stays listed,
   unarchived and running (quality-gate remediation, verifier LOW, PR #634).

---

### User Story 4 - The split survives a restart (Priority: P2)

The developer quits or restarts Refract with a split open. Reopening Refract shows the same two
sessions in the same arrangement: the same divider position and the same focused pane.

**Why this priority**: A split a developer sets up deliberately and loses on every restart is a
worse experience than no split at all; this story is what makes the feature durable rather than a
one-off layout that has to be rebuilt by hand every session.

**Independent Test**: Open a split, drag the divider, focus the right pane, restart Refract, and
confirm both sessions, the divider position, and the right pane's focus are restored. Archive one
of the two sessions, restart again, and confirm the remaining session now fills the chat area
alone.

**Acceptance Scenarios**:

1. **Given** a split was open when Refract closed, **When** Refract starts again, **Then** the
   same two sessions reopen in a split, side by side.
2. **Given** that restored split, **When** the developer looks at it, **Then** the divider is at
   the position it was left at, and the pane that was focused before closing is focused again.
3. **Given** a session that was part of a saved split no longer exists or is archived, **When**
   Refract starts, **Then** that session is dropped from the split and the remaining session's
   pane takes the full chat area.

---

### Edge Cases

- A pane's session is archived, deleted, or its agent stops while the split is open: the pane
  shows the same stopped, archived, or recover state a single chat pane would show; a session
  being deleted closes its pane, leaving the other at full width.
- The window becomes too narrow for two usable panes: the divider stops at a minimum pane width;
  below the width where two minimum-width panes can no longer both fit, the chat area shows one
  pane, and the second session stays one action away, re-splitting automatically once there is
  room again.
- The same session is never shown in both panes at once.
- A session that is cold-starting is shown in its pane with the same starting feedback a single
  chat pane gives.
- A session shown in either pane counts as being viewed, for unread purposes, while Refract is
  the focused window; a session in neither pane is marked unread once it finishes.
- A pending approval or question for the session in the unfocused pane stays visible and
  answerable in that pane without the developer focusing it first.
- A long reply streaming in one pane never delays typing or streaming in the other pane.
- The Subagents panel (spec 004, once it exists) opens at the right of the chat area for the
  focused pane's session, not for the unfocused one.
- A session in the split has a repository that was removed from Refract: its pane behaves as a
  single chat pane would for the same loss, rather than breaking the split.
- The Settings screen (spec 004) or the Pull requests view (spec 003) replaces the chat area: the
  split's own state is kept and the same split returns, unchanged, once the chat area is shown
  again.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each session row's menu MUST offer an "Open in split" item, and Ctrl+click on a
  session row MUST have the same effect; activating either while a single pane is shown MUST
  divide the chat area into two side-by-side panes, keeping the currently shown session in one
  pane and showing the chosen session in the other.
- **FR-002**: The chat area MUST support at most two panes shown side by side at once, separated
  by a divider the developer can drag with the pointer or adjust with the keyboard; the divider
  MUST stop at a minimum width per pane.
- **FR-003**: Each pane MUST show a complete chat for its own session — header, transcript,
  message box, queued messages, pending approvals and questions, and, once spec 004 exists, that
  session's readout chip row — matching what a single, unsplit chat pane shows for that session.
- **FR-004**: Both panes MUST keep streaming their sessions' turns live at the same time;
  activity in one pane MUST NOT delay typing or streaming in the other.
- **FR-005**: Exactly one pane MUST be focused at any time while a split is open, and the focused
  pane MUST be marked visibly by more than color alone.
- **FR-006**: Clicking or typing inside a pane MUST focus that pane.
- **FR-007**: A keyboard-only command MUST move focus between the two panes; its exact chord is
  decided with the rest of the keyboard shortcut set (backlog issue #6). A visible, focusable
  control MUST also move focus between panes.
- **FR-008**: Clicking a session row in the session list MUST show that session in the focused
  pane, replacing whatever it showed; the unfocused pane MUST be unaffected.
- **FR-009**: Choosing a session that is already shown in the other pane — by row click, "Open in
  split", or Ctrl+click — MUST focus that pane instead of showing the session a second time; the
  same session MUST NOT appear in both panes at once.
- **FR-010**: The message box, Stop, the queued-message chips, and the approval and question
  controls inside a pane MUST act only on that pane's session.
- **FR-011**: Each pane MUST be independently closeable; closing one pane MUST leave the other as
  the single pane, at full width. A single, unsplit pane MUST also be independently closeable
  (generalised by issue #621): closing it MUST show the existing zero-session empty state, with
  the Session's agent left untouched (not stopped, archived or deleted) -- never auto-selecting
  a replacement.
- **FR-012**: While two panes are open, "Open in split" and Ctrl+click MUST replace the session
  shown in the unfocused pane rather than opening a third pane.
- **FR-013**: The developer MUST be able to return to a single pane at any time, by closing
  either pane. This also covers the single-pane case (issue #621): closing the one open pane
  returns the chat area to its zero-pane empty state.
- **FR-014**: Refract MUST restore, after a restart, the same two sessions in a split, the
  divider's position, and which pane was focused, provided both sessions still exist and are not
  archived. Restoring a split MUST NOT start any agent: each restored pane MUST show its session
  in the same not-started state a single, unsplit chat shows for a session that has not been
  opened (spec 001 Assumptions: sessions start only when the user opens them), and an agent MUST
  start only when the developer opens that pane's session.
- **FR-015**: If a session that was part of a saved split no longer exists or is archived at
  restart, it MUST be dropped from the split, and the remaining session's pane MUST take the
  full chat area.
- **FR-016**: A pane whose session is archived, deleted, or whose agent stops MUST show the same
  stopped, archived, or recover state a single, unsplit chat pane would show for that session; a
  session being deleted MUST close its pane, leaving the other pane at full width.
- **FR-017**: Below the window width at which two minimum-width panes can no longer both fit, the
  chat area MUST show one pane instead of two, and MUST keep the second session reachable in one
  action, re-splitting automatically once the window is wide enough again.
- **FR-018**: A session shown in either pane MUST count as being viewed, for unread purposes
  (spec 001 FR-006), while Refract is the focused window; a session in neither pane MUST be
  marked unread when it finishes, matching spec 001 FR-006's single-pane behaviour.
- **FR-019**: A pending approval or question (spec 001 FR-018, FR-019) for the session in the
  unfocused pane MUST stay visible and answerable in that pane without the developer focusing it
  first.
- **FR-020**: The Subagents panel (spec 004, once it exists) MUST open at the right of the chat
  area for the focused pane's session.
- **FR-021**: Replacing the chat area with the Settings screen (spec 004) or the Pull requests
  view (spec 003) MUST leave the split's state unchanged, and the same split MUST be shown again
  when the chat area returns.
- **FR-022**: Each pane MUST be a labelled region naming the session it shows, and a change of
  which pane is focused MUST be announced to assistive technology.
- **FR-023**: Divider resizing and focus movement between panes MUST both be fully operable from
  the keyboard, with a visible focus indicator throughout.

### Key Entities

- **Chat pane**: one half of the split chat area; shows one session's complete chat (header,
  transcript, message box, queued messages, pending approvals and questions, and the spec 004
  readout chip row); is either focused or not.
- **Split**: the app-wide arrangement of two chat panes side by side, holding which two sessions
  are shown, the divider's position, and which pane is focused; persists across restarts.
- **Divider**: the boundary between the two panes; draggable with the pointer and adjustable from
  the keyboard; stops at a minimum width per pane.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a single chat pane, a developer can put a second session beside it — from the
  row menu or by Ctrl+click — in one action, with both panes immediately showing their complete
  chats.
- **SC-002**: With two sessions each running a turn, both panes' replies keep streaming with no
  observable delay introduced in either pane by the other, for the full duration of both turns.
- **SC-003**: After a full app restart, a previously open split's two sessions, divider position,
  and focused pane are restored exactly, 100% of the time both sessions still exist and are not
  archived.
- **SC-004**: The same session is never shown in both panes at the same time, across every way of
  opening or changing a pane described in this spec.
- **SC-005**: A developer can move focus between panes, resize the divider, and close either pane
  using only the keyboard, with a visible focus indicator throughout.
- **SC-006**: A session shown in either pane while Refract is the focused window is never marked
  unread; a session in neither pane is marked unread on the same terms spec 001 defines for a
  single pane.
- **SC-007**: Below the minimum two-pane width, the chat area shows one pane and re-splits
  automatically once there is room, with the second session never more than one action away,
  100% of the time.

## Assumptions

- Restoring a split does not start the agents of its two sessions, because each live agent costs
  roughly 1.1 to 1.7 GB and a cold start takes about 16 seconds (spec 001 Assumptions); this is a
  reading to confirm.
- At most two panes are shown at once, per Stuart's own wording ("two sessions"); a third pane is
  out of scope.
- The split is side by side only, per Stuart's answer; a stacked (top and bottom) layout is out
  of scope.
- The split is an app-wide layout, not scoped to one repository; either pane can show a session
  from any repository Refract has open, including two sessions from different repositories at
  once.
- Collapsing to one pane below the minimum two-pane width, keeping the second session one action
  away, and re-splitting once there is room again, is a reasonable reading of what a usable split
  needs on a narrow window; it is not a separately confirmed answer and should be confirmed with
  Stuart.
- Treating "Open in split" and Ctrl+click, while already split, as replacing the unfocused pane
  (rather than, for example, being disabled, or asking which pane to replace) is a reading of
  Stuart's "Replace the focused pane" answer extended to the one case he was not directly asked
  about; it should be confirmed with Stuart.
- This spec depends on spec 001 User Story 5 (working in several sessions at once), FR-006
  (unread), FR-018 and FR-019 (questions and approvals stay visible and answerable while a
  session is not the one being viewed), and FR-049 (chat text fills the width of its column,
  which this spec reads as the width of whichever pane holds it).
- This spec depends on spec 004 for the readout chip row and the Subagents panel; until spec 004
  ships, a pane simply has no chip row and no Subagents panel to show.
- Windows 11 is the only supported platform, consistent with the constitution.

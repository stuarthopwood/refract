# Feature Specification: Composer draft persistence

**Feature Branch**: `010-composer-draft-persistence`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "The in-progress message draft and its pending attachments (spec 009) are
lost whenever MessageInput unmounts -- switching the visible Session away and back, or opening
Settings and returning to chat. Fix this via the speckit process."

## Clarifications

### Session 2026-10-04

- Q: Two causes unmount `MessageInput` today: `ChatPane.tsx`'s `key={sessionId}` remount on a
  Session switch, and `App.tsx` swapping the whole chat `ResizablePanelGroup` out for
  `SettingsScreen`. Does fixing this mean removing either remount, or surviving it? -> A:
  Surviving it. Neither remount is itself a bug (the `key={sessionId}` remount is deliberate, per
  its own comments, and the Settings swap is spec 004's own documented, intentionally-deferred
  design); the draft and its attachments move to state that outlives the component's mount
  lifecycle, so the remount itself becomes invisible to the developer.
- Q: Which pieces of `MessageInput`'s local state must survive, and which may reset on remount? ->
  A: Only the draft text and the two kinds of pending attachment (images, text chips) from spec
  009 survive. Everything else already resets today and stays that way: the ghost-text suggestion
  overlay (`ghost`, `announcedSuggestion`), the slash-command menu's open/dismissed state
  (`slashActiveIndex`, `slashDismissed`), and the in-flight "starting" flag. None of these is
  meaningful to resume after a remount; re-deriving them fresh from the restored text (the
  slash-menu, ghost-text) is exactly what happens on a normal first load already.
- Q: Does the restored text land with any particular cursor/selection state? -> A: No explicit
  restoration -- the textarea is a plain controlled input; setting its `value` on mount without
  also calling `setSelectionRange` leaves the browser's own default caret placement (the end of
  the value), identical to how a freshly typed draft looks today. No new code is needed for this.
- Q: Is the draft persisted to disk (surviving a full app restart), or renderer-memory only? -> A:
  Renderer-memory only, matching spec 009's own Assumptions for its attachments ("gone if Refract
  restarts, the same as the draft text itself already is"). This spec only moves *where in memory*
  the draft lives (from a component's local `useState` to a store that outlives the component), not
  *how long* it lives. Persisting across restarts is a different, larger feature (its own storage
  format, migration, and privacy questions) that nothing here was asked to solve.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Switch sessions without losing a draft (Priority: P1)

A developer is mid-sentence in Session A's message box, including a pasted screenshot and a pasted
block of text collapsed into a chip, and clicks over to Session B in the session list to check on
something. When they click back to Session A, their draft text, the pasted image, and the pasted
text chip are all exactly as they left them -- not an empty box.

**Why this priority**: This is the more frequent of the two unmount triggers (switching sessions is
a routine, many-times-a-day action) and the one most likely to destroy real, hard-to-reconstruct
work (a carefully pasted screenshot is not simply re-typed).

**Independent Test**: Can be fully tested by typing a draft and pasting an image and an oversized
text block into Session A's message box, switching to Session B, switching back to Session A, and
confirming all three are restored exactly.

**Acceptance Scenarios**:

1. **Given** a draft with typed text in Session A, **When** the developer switches to Session B and
   back to Session A, **Then** Session A's message box shows exactly the text it had before the
   switch, with the cursor at the end.
2. **Given** a pending pasted image in Session A's attachment strip, **When** the developer
   switches away and back, **Then** the same image is still pending, still opens the same full-size
   preview on click, and still attaches correctly on send.
3. **Given** a pending pasted text chip in Session A's draft, **When** the developer switches away
   and back, **Then** the same chip is still shown at its same position in the draft, still opens
   the same full original text on click, and still substitutes back into the message on send.
4. **Given** independent drafts with different text and different attachments in two open Sessions
   A and B, **When** the developer switches between them any number of times, **Then** each
   Session's own draft and attachments are shown, with no text or attachment from one ever
   appearing in the other.
5. **Given** a draft with a pending text chip whose label was deleted/edited away before switching
   (so the chip was already pruned, spec 009 FR-014), **When** the developer switches away and
   back, **Then** that chip is not resurrected -- the already-pruned state survives exactly as it
   was, not the state before pruning.

---

### User Story 2 - Round-trip through Settings without losing a draft (Priority: P2)

A developer is mid-draft in the visible Session, including a pending attachment, opens Settings to
toggle a readout chip, and clicks "Back to chat". Their draft and attachment are still there.

**Why this priority**: Less frequent than switching Sessions, but the same loss, and the same fix
(the shared store) covers it for free once User Story 1 is built -- confirming it independently
guards against the store being wired only through `ChatPane`'s remount path and not actually
decoupled from any component's mount lifecycle.

**Independent Test**: Can be fully tested by typing a draft and pasting an attachment, opening
Settings, clicking "Back to chat", and confirming both are restored exactly.

**Acceptance Scenarios**:

1. **Given** a draft with typed text and a pending image in the visible Session, **When** the
   developer opens Settings and returns to chat, **Then** the message box and attachment strip show
   exactly what was there before, with no reload-looking flash of an empty box in between.
2. **Given** the same round-trip, **When** the developer repeats it several times in a row without
   changing the draft, **Then** the draft and its attachments are unaffected by any number of
   repetitions (no accumulation, no duplication, no loss).

---

### Edge Cases

- Sending a message still clears that Session's draft text and every pending attachment, exactly as
  before (spec 009 FR-007) -- this spec changes where that state is held, not the send-success
  clearing behaviour itself.
- A Session that is archived or deleted while it has a pending draft leaves that draft's store
  entry simply unused from then on (never read again, since no Session row can make it the visible
  Session again) -- matching every other per-session store in the app today (`queue-store.ts`,
  `commands-store.ts`, `transcript-store.ts`, `pending-requests-store.ts`), none of which prune a
  deleted Session's entry either. No new leak is introduced here; none of the existing ones are
  fixed by this spec, since that is a pre-existing, repo-wide pattern, not something this feature
  was asked to change.
- Two Sessions switched between rapidly (several times within the debounce window of the
  ghost-text/ slash-menu logic that still resets on remount) never cross-contaminate: each
  read/write is keyed by its own `sessionId`, never by "whichever Session was visible most
  recently".
- A brand-new Session that has never had a draft reads as an empty draft with no pending
  attachments (the store's own default for an unknown key), identical to today's first-mount
  `useState('')`/`useState(EMPTY_ATTACHMENTS)` behaviour.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The in-progress draft text for a Session MUST survive that Session's `MessageInput`
  instance unmounting and remounting, whether caused by switching the visible Session away and back
  (`ChatPane.tsx`'s `key={sessionId}` remount) or by opening Settings and returning to chat
  (`App.tsx`'s view swap) -- restored exactly as it was left, with the cursor landing at its end
  (Clarifications).
- **FR-002**: Every pending image attachment (spec 009) for a Session's draft MUST survive the same
  two unmount triggers as FR-001, remaining clickable (full-size preview) and still attaching
  correctly on send after being restored.
- **FR-003**: Every pending text chip (spec 009) for a Session's draft, including its position in
  the draft text and its full original pasted text, MUST survive the same two unmount triggers as
  FR-001, remaining clickable (full-text preview) and still substituting back into the message on
  send after being restored.
- **FR-004**: The draft text and pending attachments for each open Session MUST be tracked
  independently per Session: restoring one Session's draft MUST NOT show, consume, or mutate any
  other Session's draft or attachments.
- **FR-005**: Sending a message MUST still clear that Session's draft text and every pending
  attachment immediately on send acceptance, exactly as spec 009 FR-007 already specifies -- this
  spec changes only where that state is held between keystrokes/pastes and a send, not when or
  whether it clears.
- **FR-006**: Every other piece of `MessageInput`'s local state that already resets on remount today
  (the ghost-text suggestion and its screen-reader announcement, the slash-command menu's active
  index and dismissed flag, the in-flight "starting" indicator) MUST continue to reset on remount;
  this spec MUST NOT change their lifetime (Clarifications).
- **FR-007**: The draft text and pending attachments MUST NOT be persisted to disk or survive a full
  application restart; they remain renderer-memory-only state, exactly as today (Clarifications).

### Key Entities

- **Draft**: the per-Session in-progress message box state -- its current text and its pending
  attachments (spec 009's `AttachmentsState`: pending images and pending text chips) -- held for as
  long as the Session stays open in this run of Refract, independent of whether `MessageInput`'s own
  component instance for that Session is currently mounted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Switching the visible Session away and back restores that Session's draft text and
  every pending attachment exactly, 100% of the time, for any number of consecutive switches.
- **SC-002**: Opening Settings and returning to chat restores the visible Session's draft text and
  every pending attachment exactly, 100% of the time, for any number of consecutive round-trips.
- **SC-003**: Two Sessions with independent in-progress drafts never show, on either one, any text
  or attachment that belongs to the other, across any sequence of switches between them.
- **SC-004**: Sending a message still clears that Session's draft and attachments immediately, with
  zero measurable regression versus today's behaviour.

## Assumptions

- Scope is exactly the two unmount triggers named in the background: `ChatPane.tsx`'s
  `key={sessionId}` remount and `App.tsx`'s Settings view-swap. No other Refract surface currently
  unmounts `MessageInput`; if one is found during implementation, it is in scope by the same FR-001
  reasoning (the fix is "state that outlives the mount", not "patch each trigger site"), since the
  chosen design (lifting state into a store) fixes every unmount trigger uniformly rather than
  patching each site individually.
- This spec's `docs/DESIGN.md` note is written by the implementation task that builds the feature,
  not by this spec-writing pass, matching how every other spec's own doc-update task works.
- Depends on spec 001's message composer (`MessageInput.tsx`) and spec 009's attachment types and
  helpers (`attachments.ts`, `AttachmentStrip.tsx`) exactly as they exist on `main` today; this spec
  relocates two pieces of their existing state, it does not change their shape, their validation
  rules, or any of their other behaviour.
- Windows 11 is the only supported platform, consistent with the constitution.
- No automated tests; Refract is a prototype verified by hand per quickstart.md, consistent with
  every other spec.
- No telemetry is added by this spec.
- No new OMP wire-level fact is needed: nothing here crosses the IPC/RPC boundary differently than
  it already does (spec 009's `chat.send` call is unchanged; only *which in-memory value* is read to
  build its arguments changes). No first-task probe gate is scheduled, the same reasoning spec 009
  itself used for its own "no probe needed" conclusion.

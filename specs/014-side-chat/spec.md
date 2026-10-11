# Feature Specification: Side chat (`/btw`)

**Feature branch**: `014-side-chat`
**Created**: 2026-10-11
**Status**: Draft
**Input**: issue://1 ("Right panel: per-Session side chat (`/btw`)"), issue://516 ("build the side
chat on OMP's native `btw` RPC instead of the bundled extension (amends #1 and constitution II)"),
`docs/PLAN.md` row C2, `docs/spike/FINDINGS.md` item 14, `.specify/memory/constitution.md`
Principles I, II, IV.

## Clarifications

### Already decided (cited, not re-asked)

1. **Native `btw` RPC, not the bundled `runEphemeralTurn` extension** (Stuart, 2026-10-07, quoted
   at the top of both issue://1 and issue://516): OMP 18.6.3 added `btw`/`btw_cancel`/
   `get_btw_history`/`btw_delta`/`btw_record` as RPC-native side questions. The extension route
   (`docs/spike/btw-ext.ts`, constitution II's old wording) is dropped entirely, never shipped.
2. **Minimum supported OMP version raised to 18.6.3** (Stuart, 2026-10-07; re-confirmed 2026-10-09
   via `docs/PLAN.md` row B5: "an 18.8.0-only verification is sufficient to set the new
   supported-version minimum"). The constitution edit and version bump are implementation work for
   this feature (both issues' own words), not a fresh decision.
3. **Highest right-panel priority, first real tenant of the C1 shell** (Stuart, 2026-10-06, quoted
   in issue://1: "I use it a lot. High priority over other side panels."). Side chat is a NEW
   fourth tenant registered in `panel-registry.ts` alongside `subagents`/`fdb-knowledge`/
   `agent-builder` (spec 013) -- it does not replace any of them.
4. **Context**: `btw` "runs one ephemeral model turn over the current session context" (rpc.md, as
   quoted in issue://516) -- the whole Session's live context, automatically. Refract assembles no
   context itself.
5. **Tools**: `btw` runs with no tool use (OMP's own contract, issue://516). No approval dialog
   path exists for a side-chat turn.
6. **Persistence**: `get_btw_history` is OMP's own sidecar, confirmed live to survive a process
   restart (FINDINGS item 14: `btwHistoryHasOurRecord: true` after closing and reopening the
   process onto the same session file). Refract reads it, stores nothing of its own for
   durability. Per-Session (not per-Conversation): `get_btw_history` is scoped to the session file,
   same scope `btw`/`btw_cancel` use.
7. **Concurrency**: one `btw` request at a time per Session; OMP itself cancels a running one on
   Session switch, `new_session`, `fork`, `open_session`, or shutdown (issue://516, from rpc.md).
   Refract reflects that state; it does not implement its own single-flight guard beyond disabling
   the composer while one is in flight.
8. **Streaming is unverified live**: `btw_delta` frames are documented (rpc.md) but FINDINGS item
   14 observed zero of them across all probe runs (a trivial arithmetic question, 20s watch
   window) -- only the request's initial `running` record and its later persistence were directly
   observed. The shipped UI MUST remain correct if `btw_delta` never arrives and the answer appears
   only in a single terminal `btw_record`.
9. **`/btw` literal text in the composer**: never forwarded as a prompt (constitution II,
   unchanged in spirit). Instead of being silently refused (today's behaviour,
   `NATIVE_RESERVED_COMMANDS.btw`), Refract intercepts it locally, opens and focuses the Side chat
   panel, and issues a `btw` RPC request with the text that followed `/btw ` (issue://1, issue://516).

### Needs Stuart's decision (not yet resolved; decision comment posted on issue://1/issue://516
before implementation per process; conservative choice taken below, continuing rather than
blocking)

10. **A keyboard shortcut to open/focus the panel** (issue://1 suggested "for example Ctrl+/", not
    a firm requirement). Conservative choice: not built in this spec's first slices; a follow-up
    once the existing shortcut table (`docs/design/index.md`) is checked for conflicts.
11. **"Use as context" per-answer action** (issue://1, ties to issue://465's unbuilt `@` mentions).
    Conservative choice: carved to `future/open-questions.md` -- it depends on unbuilt
    infrastructure, same reasoning spec 013 used to carve its own four open issue://538 items.
12. **Model and token cost shown per answer** (issue://516's own open question). Conservative
    choice: not shown in the first slices; `get_state`'s `model` field is already read elsewhere
    in the app (readout chips) for the main turn, so this is a smaller follow-up once the shell
    ships, not a blocker.

### Carved out, not blocking this spec (per the constitution's Incremental Enhancement rule)

- The keyboard shortcut (item 10 above).
- "Use as context" (item 11 above).
- Model/cost display per answer (item 12 above).
- Packaging/installer work: moot. The native RPC approach ships no extension file, so issue://1's
  original "packaging the extension" risk section no longer applies to this spec at all.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask a side question without touching the main conversation (Priority: P1)

A developer mid-task wants to ask the agent something aside -- "what does this function do" --
without adding it to the main transcript, losing their place, or waiting for the main turn to
finish.

**Why this priority**: the feature's whole reason to exist (issue://1: "I use it a lot").

**Independent Test**: open the Side chat panel (rail icon or `/btw`), type a question, send it,
and confirm the main transcript, message count, and readout chips are completely unchanged
afterward, both while the main agent is idle and while it is mid-stream.

**Acceptance Scenarios**:

1. **Given** a Session with no side chat open, **When** the developer clicks the Side chat rail
   icon, **Then** the panel opens (title row or tab, per the existing shell rules) showing an
   empty thread and a composer.
2. **Given** the Side chat panel is open and empty, **When** the developer types a question and
   sends it, **Then** a "Thinking" state shows, the question appears right-aligned in the thread,
   and the answer (once the `btw_record` reaches `status: "complete"`) renders as markdown through
   the shared `Markdown`/`CodeBlock` components.
3. **Given** the main agent is mid-stream on a normal turn, **When** the developer sends a side
   question, **Then** it still completes (FINDINGS C18's documented idle-and-mid-stream support,
   now via the native RPC) and the main turn's own stream is unaffected.
4. **Given** a side question has completed, **When** the developer checks `get_messages`/the main
   transcript, **Then** neither the question nor the answer appears there, and the message count is
   unchanged.

### User Story 2 - Ask a follow-up in the same topic (Priority: P1)

Having asked one side question, the developer wants to ask a related follow-up without restating
the context.

**Why this priority**: issue://1's own ask ("a Side chat tab... one thread per Session") and
issue://516's `recordId` follow-up mechanism are the feature's core interaction model, not an
add-on.

**Independent Test**: send a first side question, then a second one from the same panel; confirm
the second request carries the first's `recordId` and the answer reads as if it had the first
exchange's context (OMP's own replay, not asserted by inspecting Refract's own state).

**Acceptance Scenarios**:

1. **Given** a completed side-chat answer is showing, **When** the developer sends another message
   in the same panel, **Then** Refract issues `{type: "btw", question, recordId: <first answer's
   record id>}`, not a bare new topic.
2. **Given** the developer wants a fresh, unrelated topic, **When** they use Clear thread (or
   equivalent), **Then** the next question is sent with no `recordId` (Refract's own displayed
   history clears; OMP's underlying `get_btw_history` sidecar is untouched -- no delete RPC exists
   in the docs read for this spec).

### User Story 3 - See the same thread again after reopening or restarting (Priority: P1)

A developer closes the panel, switches Sessions and back, or restarts Refract entirely, and
expects their side-chat history for that Session to still be there.

**Why this priority**: `get_btw_history`'s own confirmed restart-survival (FINDINGS item 14) is the
one piece of this feature already proven live; building the UI to actually use it is the direct
payoff.

**Independent Test**: ask a side question, close the panel (or quit and relaunch Refract against
the same worktree), reopen the Side chat panel on the same Session, confirm the prior question and
answer are shown without resending anything.

**Acceptance Scenarios**:

1. **Given** a Session with existing side-chat history, **When** the developer opens the Side chat
   panel for that Session, **Then** Refract calls `get_btw_history` and renders every returned
   record in order, before any new question is sent.
2. **Given** the developer switches to a different Session's pane and back, **When** they return
   to the original Session's Side chat tab, **Then** the same thread is still showing (no refetch
   needed if already loaded this app run; a defensive refetch on first open per Session is
   acceptable).

### User Story 4 - Use `/btw` from the main composer (Priority: P2)

A developer already typing in the main composer wants to ask a side question without first
clicking over to the panel.

**Why this priority**: named explicitly in both issues, but the panel itself (Stories 1-3) is
usable without it -- this is the fast path, not the only path.

**Independent Test**: type `/btw <question>` in the main composer and send; confirm it never
appears in the main transcript and instead opens/focuses the Side chat panel with that question
sent.

**Acceptance Scenarios**:

1. **Given** the main composer has focus, **When** the developer types `/btw explain this error`
   and sends, **Then** the literal text is never forwarded as a prompt (no `prompt` RPC request is
   issued for it), the Side chat panel opens and gains focus, and a `btw` RPC request is issued
   with `question: "explain this error"`.
2. **Given** `/btw` with no question text, **When** the developer sends it, **Then** the panel
   opens and focuses its composer with no request sent (an empty question is one of `btw`'s own
   documented failure cases, issue://516 -- Refract does not even attempt it).

### User Story 5 - Cancel or recover from an error (Priority: P2)

A side question is taking too long, or the model/host has no capacity, and the developer wants to
stop it or understand why it failed.

**Why this priority**: necessary for the feature to feel safe to use daily, but the happy path
(Stories 1-3) is the priority-P1 core.

**Independent Test**: send a side question, cancel it mid-flight with `btw_cancel`, confirm the
panel returns to an idle composer with no stuck "Thinking" state; separately, force a failure
(blank question, unknown `recordId`, or trigger a Session switch mid-question) and confirm the
error renders as text with an icon (never colour alone) and a Retry action where retrying makes
sense.

**Acceptance Scenarios**:

1. **Given** a side question is running, **When** the developer presses the panel's Cancel button
   (or Esc, matching the Accessibility section's ask), **Then** Refract issues `btw_cancel` and the
   `btw_record`'s lifecycle moves to `cancelled`.
2. **Given** a side question is running, **When** the developer switches Sessions, **Then** OMP's
   own cancellation (issue://516: Session switch cancels a running `btw` first) is reflected in the
   panel for the Session being left, without Refract issuing its own `btw_cancel` redundantly.
3. **Given** a `btw_record` reaches `status: "error"`, **When** the panel re-renders, **Then** the
   error text shows with an icon (not colour alone) and, where OMP's own contract allows a retry
   (not an empty-question error), a Retry action resends the same question.

### Edge Cases

- **A Session with no side-chat history.** `get_btw_history` returns an empty list; the panel shows
  an empty-thread state with the composer focused, not a loading spinner that never resolves.
- **The host does not support `btw`** (an OMP process older than 18.6.3, reachable only if a
  running process somehow predates the version check -- the readiness gate should already prevent
  this at launch, per Principle IV). Documented as a defensive case, not actively tested without a
  pre-18.6.3 binary on this machine.
- **`btw_delta` never arrives** (the confirmed-live behaviour for at least one real question type,
  FINDINGS item 14): the panel must still reach a correct final state from the terminal
  `btw_record` alone -- Scenario coverage for User Story 1 explicitly tests this path, not the
  streaming path, since streaming has never been observed live.
- **A long side-chat history** (many prior records for one Session): `get_btw_history`'s own
  pagination/limit behaviour is undocumented in the excerpts available for this spec; render what
  it returns, revisit if a real long history is seen to misbehave.
- **The Side chat panel is closed while a question is in flight.** The request is not cancelled by
  closing the panel (FR-003's collapse-vs-close precedent from spec 013: collapsing/closing a
  pane's view never cancels its owner's underlying work) -- it continues, and the panel shows the
  completed state next time it is opened, consistent with User Story 3's restore-on-reopen.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST register a new `side-chat` panel in `panel-registry.ts`, hosted by
  spec 013's shell (rail icon, launcher entry, tab/title-row participation) alongside `subagents`,
  `fdb-knowledge`, and `agent-builder`, replacing none of them.
- **FR-002**: The system MUST send a side question as `{type: "btw", question, recordId?}` over the
  session's existing `rpc-ui` connection, never as a `prompt` request, and never forward literal
  `/btw ...` composer text as a prompt.
- **FR-003**: The system MUST include the prior answer's own record id as `recordId` when the
  developer's next message in the same panel session is a follow-up (User Story 2), and MUST omit
  it for a genuinely new topic (after Clear thread, or the panel's first question for that
  Session).
- **FR-004**: The system MUST call `get_btw_history` when the Side chat panel is opened for a
  Session that has not yet loaded its history this app run, and render every returned record
  before accepting a new question.
- **FR-005**: The system MUST render an in-flight side question with a "Thinking" state and MUST
  NOT block the main composer or any other Session's own turn while it is running.
- **FR-006**: The system MUST provide a Cancel action that issues `btw_cancel` for the running
  request, and MUST clear any "Thinking" state for a Session whose running `btw` OMP itself
  cancelled (a Session switch, `new_session`, `fork`, `open_session`, or shutdown), without
  Refract re-issuing its own cancel in that case.
- **FR-007**: The system MUST intercept `/btw` typed in the main composer locally (moving it out of
  `NATIVE_RESERVED_COMMANDS` into Refract's own locally-handled slash commands), open and focus the
  Side chat panel for the Session the composer belongs to, and issue a `btw` request with the text
  following `/btw ` when non-empty.
- **FR-008**: The system MUST render a `btw_record` in `status: "error"` as visible text with an
  icon (never colour alone), and MUST offer Retry only for a failure the documented contract
  allows resending (not an already-empty question).
- **FR-009**: The system MUST render the answer as sanitised markdown through the existing shared
  `Markdown`/`CodeBlock` components (constitution V: agent output is untrusted, never raw HTML).
- **FR-010**: The system MUST NOT add any field, event, or state to the main transcript, message
  count, readout chips, or turn timer because of a side-chat question (reattach verification and
  every main-turn-derived UI element must be unaffected, per both issues' own ask).
- **FR-011**: The system MUST provide a Copy action for a completed answer (issue://1, same pattern
  as the existing main-transcript Copy, issue://466).
- **FR-012**: The system MUST announce a completed answer once, through a polite live region, not
  per streamed token (Accessibility section, issue://1).
- **FR-013**: Focus MUST move into the Side chat panel's composer when it opens via the rail, the
  launcher, or `/btw`, and MUST return to the triggering control when the panel closes (shared
  focus-management pattern already used by spec 013's own panels).
- **FR-014**: `.specify/memory/constitution.md` Principle I MUST drop `/btw` from the "supplies
  natively" list (no longer absent over RPC); Principle II MUST replace the
  `runEphemeralTurn`/`btw-ext.ts` rule with the native `btw`/`btw_cancel`/`get_btw_history`/
  `btw_delta`/`btw_record` contract; Principle IV MUST raise the minimum supported OMP version to
  18.6.3, citing FINDINGS item 14 and the already-recorded B5 caveat (18.6.3 itself untested on
  this machine, only 18.8.0 directly verified).

### Key Entities

- **Side-chat record**: OMP's own `btw_record` shape (per rpc.md, as summarised in issue://516): an
  `id`, a `status` (`running`/`complete`/`cancelled`/`error`/`interrupted`), the question, and the
  answer once settled. Refract does not redefine this shape; it types what the frame actually
  carries (`data-model.md`).
- **Side-chat thread (per Session)**: the ordered list of records for one Session, as returned by
  `get_btw_history` plus any new ones sent this app run. Not a Refract-owned store of record
  content -- only of what is currently loaded/displayed and which record id the next follow-up
  should carry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sending a side question and receiving its answer never changes `get_messages`'
  returned message count for that Session (User Story 1, directly testable the same way FINDINGS
  item 14 already confirmed it for the RPC call itself).
- **SC-002**: A Session's side-chat history, once asked, is still showing after a full Refract
  restart against the same worktree, with zero new requests sent to reconstruct it (User Story 3).
- **SC-003**: `/btw <question>` typed in the main composer results in zero `prompt` RPC requests
  containing the literal `/btw` text (User Story 4).
- **SC-004**: 100% of error records (`status: "error"`) render with both an icon and text; zero
  rely on colour alone (FR-008, constitution/accessibility baseline).
- **SC-005**: A side question sent while the main agent is mid-stream completes without altering
  the main turn's own `message_update`/`message_end` sequence (User Story 1 Scenario 3).

## Assumptions

- Windows 11, Electron/React stack, no new runtime dependency (consistent with spec 013's own
  Technical Context default).
- The exact `btw_record`/`btw_delta` wire shapes are taken from issue://516's own summary of
  `omp://rpc.md` and FINDINGS item 14's live confirmation; `omp://rpc.md` itself is an OMP-bundled
  doc, not a file in this repository, and was not re-read verbatim while drafting this spec --
  `research.md` flags every field whose exact shape is inferred from the issue's prose rather than
  a raw captured frame.
- The keyboard shortcut, "Use as context", and model/cost display (Clarifications items 10-12) are
  out of this spec's build scope; `future/open-questions.md` tracks them.
- This spec assumes spec 013's shell (panel registry, rail, tab bar, launcher) as already built and
  unchanged by this feature, consistent with issue://1's own framing ("the first real tenant of the
  panel shell").

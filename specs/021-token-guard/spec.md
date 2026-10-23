# Feature Specification: Token guard

**Feature Branch**: `feat/1212-token-guard`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Token guard (issue #1212, P0): launch overlay, periodic shake, snapcompact, long-conversation Hand off, Refract-owned rules. Supersedes #1184. All five decisions grilled by Stuart on 2026-10-23, none deferred."

## Clarifications

### Session 2026-10-23

All answers come from the issue's grilled block (Stuart, 2026-10-23) and the code; none were left open.

- Q: Does the overlay replace the #1184 global reset, or run beside it? -> A: It replaces it. Refract stops reading and writing the global OMP config for guarding; the #1184 code is removed (plan.md lists every file). The `omp config set` helper and dotted-key validator in `omp/config.rs` stay (reused by #691).
- Q: Where do the overlay values live and what edits them? -> A: In a Refract-owned store beside the other Refract data, seeded with the grilled defaults. A deliberate change in Settings > OMP updates the stored value; the next launch writes it into the overlay. A running Session keeps the values it launched with (OMP reads config once).
- Q: Does Settings > OMP exist yet? -> A: No (#691 is still open; the "Guarded" rows of #1184 item 5 never shipped). This feature adds the OMP section with only the "Set by Refract" rows; #691 later adds its own rows to it.
- Q: What does a "Set by Refract" row offer? -> A: The key, a plain-language label, the current value, a control suited to the type (switch, number, text, and a per-model number list for `compaction.modelThresholds`), the text "Set by Refract", and Reset to default.
- Q: Can RPC `compact` select the shake method? -> A: No (probed on omp 18.12.6; research.md). RPC `compact` takes only optional focus instructions and manual compaction knows only soft, remote and snapcompact. The `/shake` command does run in RPC mode with no model call, so Refract sends that after a turn settles. The per-Session overlay fallback is not needed.
- Q: What counts as "after every turn ends"? -> A: The existing settle point (`session_settled`, or `prompt_result` with `sessionSettled`). Never during a turn.
- Q: What if the shake fails or finds nothing? -> A: Nothing is shown; it is logged. At most one attempt per settle, so a Conversation still above 60k after a shake is not re-shaken until its next settle.
- Q: Does the `/shake` output reach the transcript? -> A: No; the frame is swallowed like the silent advisor probe.
- Q: Which calls does the counter count? -> A: One per completed assistant `message_end` on the main Conversation stream. It resets on a new Conversation and is re-derived from loaded history when a Conversation is opened or resumed.
- Q: What does Hand off do? -> A: Asks the agent in the current Conversation for a handoff summary, waits for it, starts a new Conversation in the same Session (`conversations.startNew`), and sends the summary as its first message. It is offered only while the Session is idle. On failure nothing is started and the old Conversation is untouched.
- Q: Is anything hard-blocked? -> A: No. The readout at 300 and the banner at 500 only offer Hand off.
- Q: Do the readout and banner coexist? -> A: Yes. At 500 both show; the banner can be dismissed for that Conversation and returns after another 100 calls.
- Q: How is the rules text passed? -> A: As a file path: Refract writes the shipped rules into its data folder on launch and passes that path with `--append-system-prompt` (which accepts text or a file). This avoids quoting 1.5k characters on a Windows command line.
- Q: Does the overlay touch the terminal OMP or a Project's own `.omp/config.yml`? -> A: Neither. The overlay is passed only to OMP processes Refract launches; Refract never edits a Project's config and no longer reports overrides.
- Q: What if the overlay or rules file cannot be written? -> A: The Session launches without the failed argument and the developer sees one toast saying the token guard is off for that launch and why.
- Q: Which launch paths need the arguments? -> A: Every place that builds the `omp` argument list for a Refract Session (the Session process builder). Side-chat and other helper processes that reuse that builder inherit them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Token-cost settings cannot drift for Refract Sessions (Priority: P1)

Every OMP process Refract starts gets Refract's own token-cost settings, which win over the developer's global OMP config for that process only. Changing the global config, or running the terminal OMP, neither undoes them nor is affected by them.

**Why this priority**: October 2026 cost about $15.4k at list price, 95% of it cache reads and writes from long contexts; settings that drifted within a day undo the savings.

**Independent Test**: Launch a Session, read the `omp` command line and confirm it carries the overlay and the rules file. Change a guarded key in the global config, launch another Session, and confirm the overlay value still applies and the global file is unchanged by Refract.

**Acceptance Scenarios**:

1. **Given** any Session launch, **When** `omp` starts, **Then** its command line includes Refract's overlay file and Refract's rules file.
2. **Given** the global OMP config sets `advisor.reviewMode` to `turn`, **When** a Session launches, **Then** that Session behaves as `agent-end` and the global file is not modified by Refract.
3. **Given** the developer runs OMP in a terminal, **When** it starts, **Then** it uses only the global config (no overlay).
4. **Given** the developer edits or deletes their `AGENTS.md`, **When** a Session launches, **Then** the rules file is still passed.
5. **Given** Refract starts after the #1184 guard shipped, **When** it starts, **Then** it no longer resets keys in the global OMP config and shows no "OMP settings guard" toast.

---

### User Story 2 - The developer sees and edits what Refract sets (Priority: P2)

Settings > OMP lists every overlay setting as "Set by Refract" with its current value, lets the developer change a value deliberately, and lets them return it to Refract's default.

**Why this priority**: The values must be visible and deliberately changeable, or the guard is a black box.

**Independent Test**: Open Settings > OMP, change `task.maxConcurrency`, launch a Session, and confirm the overlay has the new value; reset it to default and confirm 6.

**Acceptance Scenarios**:

1. **Given** Settings > OMP, **When** it opens, **Then** each overlay key is a row with its value and the text "Set by Refract".
2. **Given** the developer changes a value, **When** the next Session launches, **Then** the overlay carries the new value; a running Session is unchanged.
3. **Given** a changed value, **When** the developer activates "Reset to default", **Then** the grilled default is restored.
4. **Given** keyboard-only use, **When** the developer moves through the rows, **Then** every control is reachable and labelled.

---

### User Story 3 - Long contexts are shaken after each turn (Priority: P1)

After every turn ends, if the Conversation's context is above 60k tokens, Refract drops recoverable heavy content (old tool results and large blocks) with no model call. It never acts mid-turn.

**Why this priority**: Long contexts drive the cache-read cost; shaking between turns keeps them small without a summarising model call.

**Independent Test**: Drive a long recorded tape past 60k context, let the turn end, and confirm context drops and the transcript is unchanged; confirm nothing fires during the turn.

**Acceptance Scenarios**:

1. **Given** a turn ends with context above 60k, **When** the Session settles, **Then** one shake runs and the context readout updates.
2. **Given** context is at or below 60k, **When** a turn ends, **Then** nothing runs.
3. **Given** a turn is running or a queued follow-up is about to run, **When** context passes 60k, **Then** nothing runs until the Session settles.
4. **Given** a shake finds nothing to drop or fails, **When** it finishes, **Then** no toast appears, the failure is logged, and the Session stays usable.
5. **Given** a prompt is sent while a shake is running, **When** the prompt is sent, **Then** it waits for the shake rather than racing it.

---

### User Story 4 - Long conversations offer Hand off (Priority: P2)

At 300 model calls in one Conversation, the Status line shows "Long conversation" with a Hand off button. At 500, a banner in the pane repeats the offer. Hand off summarises the Conversation and continues in a fresh one in the same Session.

**Why this priority**: Very long Conversations pay cache cost on every call; a guided restart keeps the work without the history.

**Independent Test**: Replay a tape past 300 calls; confirm the readout and button, activate Hand off, and confirm a new Conversation opens whose first message is the summary. Replay past 500 and confirm the banner.

**Acceptance Scenarios**:

1. **Given** a Conversation reaches 300 model calls, **When** it is idle or running, **Then** the Status line shows the text "Long conversation" with the call count and a Hand off button.
2. **Given** the readout is shown, **When** the developer activates Hand off, **Then** the agent produces a handoff summary, a new Conversation starts in the same Session, and the summary is sent as its first message.
3. **Given** a Conversation reaches 500 calls, **When** the pane renders, **Then** a banner repeats the offer and can be dismissed.
4. **Given** the summary request fails, **When** Hand off was activated, **Then** the old Conversation is untouched and the developer sees why.
5. **Given** a screen reader, **When** the threshold is first crossed, **Then** it is announced once, not on every later call.
6. **Given** the developer ignores the offer, **When** they keep sending, **Then** sending is never blocked.

---

### User Story 5 - Snapcompact and Refract-owned rules cut cost further (Priority: P2)

The overlay keeps tool-result imaging on, makes snapcompact the first compaction method (then shake, handoff, soft), and keeps the system prompt out of images so prompt caching survives. A rules file shipped with Refract carries the guidance settings cannot express.

**Why this priority**: These are the remaining cost levers named in the grilled decisions.

**Independent Test**: Read the overlay file and confirm the snapcompact keys and compaction order; read the rules file and confirm it is passed on every launch.

**Acceptance Scenarios**:

1. **Given** the overlay, **When** read, **Then** `snapcompact.toolResults` is true, `snapcompact.systemPrompt` is `none`, and `compaction.methodOrder` is snapcompact, shake, handoff, soft.
2. **Given** the shipped rules file, **When** read, **Then** it is about 1.5k characters and covers the director model, one task per worker, narrow reads, and the cheapest fitting agent.

### Edge Cases

- The overlay or rules file cannot be written: the Session still launches without them, with one toast naming the reason.
- Two Sessions launch at once: each launch sees a complete overlay (atomic write, never a half-written file).
- The overlay's version is older than the app's: regenerated on the next launch, keeping any value the developer deliberately changed.
- A Conversation opened from history already has over 300 calls: the readout shows immediately.
- The model reports no context size: the shake is skipped for that settle and nothing is shown.
- A Session is stopped between settle and shake: the shake is dropped.
- Hand off while a turn is running: the button is disabled until the Session is idle, with the reason in text.
- The developer has several Sessions: each Conversation has its own counter and its own announcement.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Refract MUST write its own configuration overlay into its data folder and pass it to every OMP process it launches, for every launch path.
- **FR-002**: Overlay values MUST win over the developer's global OMP config for Refract Sessions only, and MUST NOT affect OMP started outside Refract.
- **FR-003**: The overlay MUST be written atomically, carry a version, and be regenerated when the version or any stored value changes.
- **FR-004**: The overlay MUST contain exactly the grilled values: `compaction.modelThresholds` (Opus 5.5 200000; Sonnet 5.5, Sonnet 5, Haiku 5.5 120000; Gemini 4 Argon, GPT-5.6 Terra 150000), `compaction.thresholdTokens` 200000, `compaction.idleEnabled` true, `compaction.idleThresholdTokens` 80000, `compaction.idleTimeoutSeconds` 240, `task.softRequestBudget` 80, `task.maxConcurrency` 6, `autolearn.autoContinue` false, `advisor.reviewMode` agent-end, `modelRoles.advisor` github-copilot/gemini-4-argon:auto, `grep.contextBefore` 0, `grep.contextAfter` 1, `read.defaultLimit` 200, `tools.artifactSpillThreshold` 30, `tools.xdev` true.
- **FR-005**: The overlay MUST also set `snapcompact.toolResults` true, `compaction.methodOrder` to snapcompact, shake, handoff, soft, and `snapcompact.systemPrompt` to `none`.
- **FR-006**: Overlay values MUST be stored in Refract's own data, seeded with the FR-004 and FR-005 defaults, and be editable from Settings > OMP.
- **FR-007**: Settings > OMP MUST show every overlay key as a row labelled "Set by Refract" with its value, a control to change it, and a Reset to default.
- **FR-008**: A changed value MUST apply to the next launched Session; a running Session MUST be unchanged.
- **FR-009**: Refract MUST stop resetting keys in the global OMP config and MUST remove the #1184 guard, its notice, dialog and event.
- **FR-010**: Refract MUST ship a rules file (about 1.5k characters) covering the director model, one task per worker, narrow reads, and the cheapest fitting agent, and pass it to OMP on every launch.
- **FR-011**: Refract MUST NOT shake during a turn; after a turn settles with context above 60k tokens it MUST run one shake with no model call.
- **FR-012**: A shake that fails, or has nothing to drop, MUST NOT interrupt the Session or show an error; a prompt sent while a shake runs MUST wait for it.
- **FR-013**: Refract MUST count completed model calls per Conversation from the OMP message stream, reset on a new Conversation, and recover the count when a Conversation is opened or resumed.
- **FR-014**: At 300 calls the Status line MUST show a text readout "Long conversation" with the count and a real Hand off button; at 500 a pane banner MUST repeat the offer. Neither MUST block sending.
- **FR-015**: Hand off MUST request a handoff summary from the agent, start a new Conversation in the same Session, and send the summary as its first message; on failure it MUST leave the old Conversation untouched and say why.
- **FR-016**: The readout and banner MUST convey state in text, not colour alone; Hand off MUST be keyboard operable; each threshold crossing MUST be announced once per Conversation.
- **FR-017**: If the overlay or rules file cannot be written, the launch MUST proceed without them and the developer MUST be told once.
- **FR-018**: All UI MUST be built from shared components in the renderer's component library.
- **FR-019**: The output of the shake MUST NOT appear in the transcript.
- **FR-020**: Hand off MUST be offered only while the Session is idle; while busy the button is disabled with the reason in text.
- **FR-021**: The pane banner MUST be dismissible for the current Conversation and reappear after 100 further calls.
- **FR-022**: The OMP section MUST be added to Settings without removing or reordering the existing sections, so #691 can add rows to it later.

### Key Entities

- **Overlay**: The Refract-written settings file for OMP: version, generated values, location in Refract's data folder.
- **Token guard values**: The stored, deliberately editable defaults behind the overlay and Settings rows; each has a key, a default, and an optional developer override.
- **Rules file**: The Refract-owned guidance text passed on every launch.
- **Conversation call count**: Completed model calls in one Conversation; drives the readout and banner and resets on a new Conversation.
- **Shake**: A between-turn removal of recoverable heavy content from context, with no model call.
- **Handoff summary**: The agent's summary of a Conversation, used as the first message of the next one.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of Refract-launched OMP processes carry the overlay and the rules file; 0 launches depend on the developer's global config for a guarded value.
- **SC-002**: After the global OMP config is changed, the next Session still behaves with the overlay values, and the global file is byte-identical to before.
- **SC-003**: A Conversation above 60k context at turn end is back below that after the shake in the replayed long-tape check, and no shake runs while a turn is in progress.
- **SC-004**: A developer reaches Hand off from the Status line at 300 calls with one keyboard action and ends in a new Conversation holding the summary.
- **SC-005**: The threshold announcement is spoken once per Conversation per threshold, not once per call.
- **SC-006**: Every overlay row in Settings > OMP is reachable and operable by keyboard alone and states "Set by Refract" in text.

## Assumptions

- #691 (the wider Settings > OMP) is not shipped; this feature adds the OMP section with only the "Set by Refract" rows.
- Refract launches OMP in `rpc-ui` mode (the issue says `rpc`); the arguments are added for that mode.
- Overlay values are persisted in a small separate Refract store, not the main settings file, to stay within the file-size cap; the issue's "Refract settings" is read as "Refract-owned stored values".
- The shake is triggered with OMP's `/shake` command because RPC `compact` cannot select a method (research.md).
- Tests: no new renderer or shared tests (prototyping rule); minimal Rust unit tests for the new module are allowed; verified live.
- Whether `snapcompact.systemPrompt` should later become `agents-md` is decided from a separate one-week comparison, out of scope here.

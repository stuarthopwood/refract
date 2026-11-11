# Feature Specification: Token guard

**Feature Branch**: `feat/1212-token-guard`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Token guard (issue #1212, P0): launch overlay, periodic shake, snapcompact, long-conversation Hand off, Refract-owned rules. Supersedes #1184. All five decisions grilled by Stuart on 2026-10-23, none deferred."

## Clarifications

### Session 2026-10-23

All answers come from the issue's grilled block (Stuart, 2026-10-23) and the code; none were left open.

- Q: Does the overlay replace the #1184 global reset, or run beside it? -> A: It replaces it. Refract stops reading and writing the global OMP config for guarding; the #1184 code is removed (plan.md lists every file). The `omp config set` helper and dotted-key validator in `omp/config.rs` stay (reused by #691).
- Q: Where do the overlay values live and what edits them? -> A: In a Refract-owned store beside the other Refract data, seeded with the grilled defaults. A deliberate change in Settings > OMP updates the stored value; the next launch writes it into the overlay. A running Session keeps the values it launched with (OMP reads config once), except live keys (FR-036).
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

### Session 2026-11-03 (Settings > Advanced batch: #1553, #1579, #1555, #1580)

All answers come from the four issues' grilled blocks (Stuart, 2026-11-02) and the cross-issue grill (Stuart, 2026-11-03); none were left open. Where they differ from the 2026-10-23 entries above, these win.

- #1553 Q: How is the global compaction threshold shown and stored? -> A: As a whole percent 1-99 of the context window in the agent's native `compaction.thresholdPercent`, default 70. Refract writes `compaction.thresholdTokens: -1` because a positive token value wins over the percentage.
- #1553 Q: Per-model thresholds? -> A: Stored in `compaction.modelThresholds` as `"N%"` strings so the agent resolves each against the model's own window. When the chat catalogue knows the model's `contextWindow` the row also shows "≈ N of W tokens"; an unknown window still works.
- #1553 Q: Built-in per-model defaults? -> A: None. The six shipped token entries are removed; every model uses the global percent unless the developer adds a row. "Add model" seeds the new row with the global percent.
- #1553 Q: Idle compaction threshold? -> A: Shown as a percent 1-99 of the Default role model's window with "≈ N tokens" beneath; still stored in tokens (`compaction.idleThresholdTokens`, round(% x window)) because the agent has no idle percent key. If the Default role's window is unknown the row falls back to a token field.
- #1553 Q: Input and migration? -> A: Whole percentages 1-99 (the agent clamps to 99); Reset restores the default. Stored token overrides for the global and per-model thresholds reset to the new defaults; Settings shows a one-line note on the first load after the upgrade. An idle-threshold token override stays (still tokens). Supersedes "still tokens underneath" for the global and per-model thresholds; stored `version` bumps to 2 and the migration runs where the store loads.
- #1579 Q: Number inputs? -> A: One shared `NumberField` primitive in `src/renderer/components/ui/` (ADR 0003): `type="number"` with `min`, `step`, `max` where one exists; native spinner arrows stay visible; ArrowUp/ArrowDown step. Every number-only input in Settings > Advanced uses it (`NumberUnitField`, all nine `count` rows, the per-model threshold inputs). Commit-on-Enter and commit-on-blur stay; `parseCount` validation and `aria-invalid` stay; `e`, `+`, `-` are blocked in `onKeyDown`; wheel scrolling must not change a focused value. `step` follows the unit: 1 for lines, requests, subagents, seconds and KB; 1000 for tokens. `ScaleControl.tsx` is out of scope.
- #1555 Q: Descriptions and labels? -> A: Every Settings > Advanced row description is rewritten in plain words using the issue's approved table; "Cross-device tools" becomes "Load rare tools on demand"; "Auto-continue after learning" becomes "Extra turn to record lessons"; the Advisor review mode option "Every turn" becomes "Every step" (stored value `turn` unchanged). Each compaction method (Shake, Handoff, Soft, Remote, Snapcompact) gets a one-line muted hint under its name, tied to its checkbox with `aria-describedby`. The two compaction threshold rows are not touched (#1553 owns them). No "OMP" in user-visible text (#1551). Accessible names stay the labels.
- #1580 Q: Impact warnings? -> A: A row shows a warning line only when its value is set in the costlier direction from its token guard default; at defaults the page shows no warnings. Optional `impact?: { costlierWhen: (value, default) => boolean; text: string }` on `TokenGuardKeyInfo` in `src/shared/tokenGuard.ts`, rendered by the shared `AdvancedRow` with the warning severity token and a `TriangleAlert` icon, under the description, linked by `aria-describedby`, 4.5:1 in every theme. `task.maxConcurrency` is excluded. Rows whose costlier direction is not established (`compaction.methodOrder`, `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds`, `snapcompact.systemPrompt`, `read.summarize.enabled`, `prewalk.enabled`, `plan.defaultOnStartup`) are checked against the OMP settings docs; any with a clear direction gets a line, others none, each recorded in the PR. Stuart approves the exact wording on the PR screenshot.
- Cross-issue 1: #1580 after #1553: the global Compaction threshold warns when above 70%; a per-model row warns when its percent is above the current global percent.
- Cross-issue 2: #1579 after #1553: percent fields step 1; the idle threshold's token fallback (Default role window unknown) steps 1000.
- Cross-issue 3: one PR with four commits, in the order #1553, #1579, #1555, #1580.
- Cross-issue 4: converge on this spec (021).

### Session 2026-11-04 (#1581 Optimise token usage)

All answers come from #1581's grilled block (Stuart, 2026-11-02, "Grilled ... all resolved, none deferred"); none were left open.

- #1581 Q: What does the button do? -> A: "**Optimise token usage** sets every token guard row back to its default. The defaults are the single known-good set, and there is no separate preset."
- #1581 Q: Are the defaults reviewed first? -> A: "**Spike first, in this issue:** review each default against the Usage database and the OMP settings docs, then **apply the findings to the defaults themselves** (`values.rs` and `tokenGuard.ts`) before the button ships. The PR reports, for each changed default, the old and new value and the evidence (Stuart decided: 'do the spike and apply to defaults')." Any default that moves needs a one-time migration like #1545's: users still on the old default move with it, a value the user set stays.
- #1581 Q: Confirmation? -> A: "A confirm dialog lists each row that will change (from and to) before anything is written." The dialog lists each row whose value differs from its default (label, current value, default); the list is a real list; focus returns to the button when it closes.
- #1581 Q: Placement and weight? -> A: In the Advanced page header, a shared `Button` with `variant="default"` (the page's one primary action).
- #1581 Q: Nothing to change? -> A: "When every row already equals its default, the button is disabled with the tooltip 'Already optimised'."
- #1581 Q: Write path? -> A: "It uses the same write path as each row's **Reset**, so new Sessions pick up the change in the same way." Implemented as one `tokenGuard.resetAll` channel that applies `values::reset` semantics to every key in a single store write.

### Session 2026-11-05 (#1646 NumberField chevrons)

All answers come from #1646's grilled block (Stuart, 2026-11-04, "all resolved, none deferred").

- #1646 Q: What replaces the native spinner? -> A: Two small stacked `ChevronUpIcon`/`ChevronDownIcon` buttons inside the field's right edge, with an 8px gap between the value and the buttons (right padding reserves the space). The native spinner is hidden (`::-webkit-inner-spin-button` and `::-webkit-outer-spin-button`: `appearance: none`, `margin: 0`). This supersedes #1579's "native spinner arrows stay visible".
- #1646 Q: Colour and states? -> A: `text-muted-foreground`, no fill, at rest; hover and press `text-foreground`; each button is disabled when the field is disabled, or at `max` (up) or `min` (down). At least 3:1 non-text contrast against the field background in every theme.
- #1646 Q: Click behaviour? -> A: `stepUp()`/`stepDown()` on the input, then a native `input` event so `onChange` fires exactly as typing does, honouring `min`, `max` and `step`.
- #1646 Q: Accessibility? -> A: The buttons are `tabIndex={-1}` and `aria-hidden`; ArrowUp/ArrowDown already step the focused input, so keyboard and screen reader users lose nothing and the tab order does not grow.
- #1646 Q: Scope? -> A: Inside `NumberField.tsx` only; callers keep their props; built on the shared `Button`.

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
2. **Given** the developer changes a value, **When** the next Session launches, **Then** the overlay carries the new value; a running Session is unchanged unless the key is live (FR-036).
3. **Given** a changed value, **When** the developer activates "Reset to default", **Then** the grilled default is restored.
4. **Given** keyboard-only use, **When** the developer moves through the rows, **Then** every control is reachable and labelled.

**Settings > Advanced batch scenarios** (amend Story 2; one per issue):

7. (#1553) **Given** Settings > Advanced, **When** it opens, **Then** the global compaction threshold shows 70 % with its description, per-model rows show a percent (plus "≈ N of W tokens" when the window is known), the idle row shows a percent with "≈ N tokens", and the overlay carries `compaction.thresholdPercent: 70` and `compaction.thresholdTokens: -1`.
8. (#1579) **Given** a number-only row, **When** the developer presses ArrowUp or uses the spinner, **Then** the value steps by the unit's step; letters, `e`, `+`, `-` cannot be typed and wheel scrolling over the focused field leaves the value unchanged.
9. (#1555) **Given** Settings > Advanced, **When** read, **Then** every row shows the approved plain description, the labels read "Load rare tools on demand" and "Extra turn to record lessons", the Advisor option reads "Every step", and each compaction method has a hint.
10. (#1580) **Given** a row set costlier than its default, **When** the page renders, **Then** a warning line with an icon appears under its description; **Given** all defaults, **Then** none appears.
11. (#1581) **Given** at least one row differs from its default, **When** the developer activates "Optimise token usage", **Then** a dialog lists each such row (label, current value, default) and nothing is written; **When** they confirm, **Then** every row equals its default and the dialog closes with focus on the button; **When** they cancel, **Then** nothing changes; **Given** all rows at default, **Then** the button is disabled with the tooltip "Already optimised".

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

- The Default role's (or a model's) context window is unknown: the idle row falls back to a token field (step 1000); a per-model row shows only the percent and no "≈" hint.
- Optimise token usage while a row's write is in flight, or the write fails: the dialog stays open showing the error; no partial state is shown as done.
- A running Session picks up Optimise token usage for live keys; every other key applies to the next Session launch (FR-036).
- A user-set value equal to a moved default's old value is indistinguishable from an untouched one and moves with it (accepted, as in #1545's migration).
- A version 1 store holds token overrides for `compaction.thresholdTokens` or `compaction.modelThresholds`: they reset to defaults on load and a one-line note is shown once; `compaction.idleThresholdTokens` is kept.
- A per-model row at or below the global percent shows no warning; the global row at 70 or below shows none.
- A focused number field scrolled with the wheel keeps its value.
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
- **FR-008** (superseded by FR-036, #1765): A changed value MUST apply to the next launched Session; a running Session MUST be unchanged.
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
- **FR-023** (#1553): The global compaction threshold MUST be a whole percent 1-99 stored as `compaction.thresholdPercent` (default 70), with `compaction.thresholdTokens` written as -1 in the overlay. Supersedes the token values for it in FR-004.
- **FR-024** (#1553): `compaction.modelThresholds` MUST hold `"N%"` strings (1-99) with no built-in entries (supersedes the per-model token entries in FR-004); each row shows "≈ N of W tokens" when the window is known; "Add model" seeds the global percent.
- **FR-025** (#1553): The idle compaction threshold MUST be edited as a percent of the Default role model's window and stored as tokens, falling back to a token field when that window is unknown.
- **FR-026** (#1553): Loading a version 1 store MUST reset stored global and per-model token thresholds to the new defaults, bump `version` to 2, and show a one-line note once.
- **FR-027** (#1579, #1646): A shared `NumberField` primitive MUST back every number-only input in Settings > Advanced: ArrowUp/ArrowDown stepping, per-unit `step`, `min`/`max`, blocked `e`/`+`/`-`, wheel-safe focus, unchanged commit and validation behaviour. The native spinner MUST be hidden and replaced by muted stacked chevron step buttons (FR-033).
- **FR-028** (#1555): Settings > Advanced row descriptions, the two renamed labels, the "Every step" option and per-method compaction hints MUST use the approved plain wording, with hints linked by `aria-describedby`.
- **FR-029** (#1580): `TokenGuardKeyInfo` MUST carry an optional `impact` and `AdvancedRow` MUST render a warning line only when the value is costlier than its default; the global compaction threshold warns above 70% and a per-model row warns above the current global percent.
- **FR-030** (#1581): Settings > Advanced MUST offer an "Optimise token usage" primary button in the page header that, after a confirm dialog listing each row whose value differs from its default (label, current value, default), resets every token guard row (including `modelRoles.advisor`) to its default through one `tokenGuard.resetAll` channel using the same semantics as the per-row Reset; nothing is written before confirmation; it is disabled with the tooltip "Already optimised" when every row already equals its default.
- **FR-031** (#1581): Before the button ships, each token guard default MUST be reviewed against the Usage database and the OMP settings docs; findings MUST be applied to `default_for` (`values.rs`) and `TOKEN_GUARD_ROWS` (`tokenGuard.ts`) in the same PR, each changed default with a one-time migration that moves users still on the old default and keeps a value the user set; the PR reports old value, new value and evidence per changed default.
- **FR-032** (#1581): The confirm dialog MUST use the shared `ConfirmAlertDialog` with a real list, a busy state and an error live region on failure, and focus MUST return to the button when it closes; a failed write leaves the dialog open with the reason in text.
- **FR-033** (#1646): `NumberField` MUST hide the native spinner and draw two stacked `ChevronUpIcon`/`ChevronDownIcon` `Button`s inside the field's right edge, 8px clear of the value, `text-muted-foreground` at rest and `text-foreground` on hover and press, no fill, 3:1 against the field background in every theme. They MUST be `tabIndex={-1}` and `aria-hidden`, be disabled when the field is disabled or read-only, or at `max` (up) or `min` (down), and call `stepUp()`/`stepDown()` then dispatch a native `input` event so `onChange` fires as typing does. Callers keep their props.
- **FR-034** (#1767): Settings > Advanced MUST write token guard values to OMP's global config (`~/.omp/agent/config.yml`) and read them back from it; Refract is the source of truth. This supersedes FR-001..FR-003 and FR-006 (overlay and `token-guard.json` store) for token guard keys; a change applies to the next launched Session except for live keys (FR-036).
- **FR-035** (#1767): On first launch Refract MUST back up the global config to `config.yml.refract-backup-YYYY-MM-DD` (`-2`, `-3` on collision, never pruned), migrate `token-guard.json` into it, and show a one-line Settings notice naming the backup path. A failed migration MUST retry every launch; until it succeeds `token-guard.json` stays in effect and Settings shows a one-line error. A debug build with a scratch `REFRACT_DATA_DIR` and no `PI_CODING_AGENT_DIR` MUST skip the migration and refuse token guard writes (migration status `skipped`), so a verification launch never backs up or rewrites the real global config.
- **FR-036** (#1767, #1765): A row whose key is not proven to reload into a running Session MUST say "Applies to new Sessions". Proven live by probe on omp 18.17.0 (research.md sections 9 and 10): `compaction.thresholdPercent`, `compaction.modelThresholds`, `compaction.methodOrder`, plus `tools.xdev` from the #1767 probe; every other token guard key carries the label (`live` flag in `TOKEN_GUARD_KEYS`) until a probe proves it. Saving a value writes the global config (`omp config set`), which a running Session re-reads between turns for live keys; Refract has no restart button.
- **FR-037** (#1767): Settings MUST list the effective compaction trigger for the Default model and the models of open Sessions (window, threshold, per-model entry, resulting tokens), from `tokenGuard.get` `effectiveTriggers`.
- **FR-038** (#1767): When the open Project's `.omp/config.yml` sets a token guard key, that row MUST say so (read-only; Refract never edits repo files), from `projectOverrides`.
- **FR-039** (#1767): `compaction.modelThresholds` entries MUST accept `120000` (tokens; 1-99 reads as a percent), `"f200000"` (fixed tokens) and `"80%"`.

### Key Entities

- **Overlay**: The Refract-written settings file for OMP: version, generated values, location in Refract's data folder.
- **Token guard values**: The stored, deliberately editable defaults behind the overlay and Settings rows; each has a key, a default, and an optional developer override.
- **Rules file**: The Refract-owned guidance text passed on every launch.
- **Conversation call count**: Completed model calls in one Conversation; drives the readout and banner and resets on a new Conversation.
- **Shake**: A between-turn removal of recoverable heavy content from context, with no model call.
- **Handoff summary**: The agent's summary of a Conversation, used as the first message of the next one.
- **Impact rule**: Optional `{ costlierWhen, text }` on a token guard key; drives the warning line under the row description.
- **Percent threshold**: A whole percent 1-99 of a model's context window; the stored form of the global (`compaction.thresholdPercent`) and per-model (`"N%"`) thresholds.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of Refract-launched OMP processes carry the overlay and the rules file; 0 launches depend on the developer's global config for a guarded value.
- **SC-002**: After the global OMP config is changed, the next Session still behaves with the overlay values, and the global file is byte-identical to before.
- **SC-003**: A Conversation above 60k context at turn end is back below that after the shake in the replayed long-tape check, and no shake runs while a turn is in progress.
- **SC-004**: A developer reaches Hand off from the Status line at 300 calls with one keyboard action and ends in a new Conversation holding the summary.
- **SC-005**: The threshold announcement is spoken once per Conversation per threshold, not once per call.
- **SC-006**: Every overlay row in Settings > OMP is reachable and operable by keyboard alone and states "Set by Refract" in text.
- **SC-007**: With all values at default, Settings > Advanced shows no impact warnings; raising a costlier value shows its warning, and the compaction rows show percentages with the "≈ N tokens" hint where the window is known.
- **SC-008**: With any row changed, Optimise token usage lists exactly the changed rows (from and to) and writes nothing until confirmed; after confirming, every row equals its default, no warning shows, and the next Session's overlay carries the defaults; with all rows at default the button is disabled with "Already optimised".
- **SC-009**: In Settings > Advanced every number field shows muted chevrons (no native grey spinner) with an 8px gap after the value in the dark and light themes; clicking a chevron steps the value by `step` within `min`/`max` and commits like typing; the chevrons are not in the tab order.

## Assumptions

- #691 (the wider Settings > OMP) is not shipped; this feature adds the OMP section with only the "Set by Refract" rows.
- Refract launches OMP in `rpc-ui` mode (the issue says `rpc`); the arguments are added for that mode.
- Overlay values are persisted in a small separate Refract store, not the main settings file, to stay within the file-size cap; the issue's "Refract settings" is read as "Refract-owned stored values".
- The shake is triggered with OMP's `/shake` command because RPC `compact` cannot select a method (research.md).
- Tests: no new renderer or shared tests (prototyping rule); minimal Rust unit tests for the new module are allowed; verified live.
- Whether `snapcompact.systemPrompt` should later become `agents-md` is decided from a separate one-week comparison, out of scope here.

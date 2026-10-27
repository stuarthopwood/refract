# Feature Specification: Session readout

**Feature Branch**: `004-session-readout` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "Show changes count, context window usage, time, etc. OMP has a
wealth of options. Configurable from a settings page." Reference screenshot
(`Screenshot 2026-10-02 083349.png`): pill chips "Changes +193" and "Artifacts 3" above a message
field whose bottom bar shows the mode, model, and agent.

## Clarifications

### Session 2026-10-02

- Q: Should this spec include the settings page the readouts are configured from, or assume one
  already exists? -> A: Include a minimal Settings page in this spec: a Settings screen opened
  from the left nav with one section, "Session readout"; backlog issue #4 ("Settings screen:
  theme, UI font, code font") adds further sections later.
- Q: Where does the readout sit relative to the message box? -> A: Chip row above the message box.
- Q: Beyond a changes count, which of OMP's other readouts belong in this row? -> A: Sub Agents
  (opens a right side panel pane, shows list of agents - click to open and view stream). PR Number
  (click opens PR view). Current Time as well.

### Session 2026-10-06

- Q: #492 reported the subagent panel's stream content does not wrap (long paths and paragraphs
  clip at the right edge) and its padding is inconsistent (header `px-3`, list and stream `p-2`)
  — fix only this panel, or fix the shared cause so the future Agents panel (#490) inherits it?
  -> A: Fix the shared cause: the `ScrollArea` wrapper's Radix viewport child (an internal
  `display: table` div that sizes to its widest row instead of the viewport's own width) gets the
  override once, and `CollapsedLine`'s tool-row summary gets an opt-in wrap so the chat's own rows
  stay one-line while the narrower subagent panel wraps. Both the subagent list and the stream
  move their padding from `p-2` to `px-3`/`py-2`, matching the header (commit `d6a3e63`).

### Session 2026-10-07

- Q: Issue #536 found the Subagents chip's wording wrong — `12 finished, 1 running` read as "13
  subagents running" (the count was `running + finished`, the word always "running" while any
  was). What should it show instead? -> A: The running count alone while any subagent is still
  running (for example "1 subagent running"); once none are, a quiet "N finished" total instead
  (folding in any subagent issue #489 seeds as `exited` — see Edge Cases). Matches issue #507's
  row-count definition. **SUPERSEDED, gate fixes 2 finding 7 (2026-10-07)**: a single folded-in
  "N finished" total was itself found misleading once seeded `exited`/`failed` subagents could
  coexist with genuinely `finished` ones -- the shipped wording is a comma-joined list of
  whichever of `finished`/`exited`/`failed` are non-zero (FR-007, `ReadoutChips.tsx`).
- Q: Issue #489 found a crashed-and-resumed Session's still-remembered-running subagent has no
  Subagents pill at all (`runtime.subagents` is rebuilt empty on every attach/resume and only a
  live `task` tool call ever repopulates it). What should attach/resume do? -> A: Seed
  `runtime.subagents` from the reattached transcript's own still-`running` `subagent` rows,
  correlated against any already-live `runtime.subagents` entry by `toolCallId`+`specIndex` (not
  by either side's own `id` string, which use unrelated schemes) so the SAME subagent instance
  never produces two candidates. **Superseded 2026-10-07 (gate fixes)**: the original design
  additionally called OMP's `get_subagents` once per candidate to tell genuinely-still-running
  from provably-gone; live verification found `launch()` always spawns a brand-new `OmpProcess`
  (never reuses one), so that call's own registry is unconditionally empty at this point --
  asking can never discriminate differently from assuming "gone" for this call site. Every
  surviving `running` candidate is therefore now resolved straight to the terminal `exited` state
  unconditionally, with no RPC round trip (see Edge Cases, FR-007, FR-017, and
  `contracts/omp-usage.md` section (d)). Scoped to the current/last turn only (the last `user`
  transcript item onward): an older turn's `subagent` row OMP's own history keeps rebuilding as
  `running` must never resurface as a phantom "finished" once a newer turn has started none of
  its own. **SUPERSEDED, durable turn marker (2026-10-07)**: "the last `user` transcript item
  onward" is no longer the scoping rule; scope is now the persisted `Session.currentTurnSubagents`
  registry marker (see Edge Cases "Durable turn marker" entry, FR-007, data-model.md). The exact
  scenario Stuart saw (what crashed, whether a process was left running) is
  still unconfirmed — PLAN.md open question 9 — so this remains designed from the `get_subagents`
  contract (confirmed live, `docs/spike/get-subagents-probe.mjs`, 2026-10-07) rather than a
  specific repro.

### Session 2026-10-15

- Q: Issue #563 (Decided, Skippy, delegated by Stuart 2026-10-15; ui-architect-v3 roundtable, full
  minutes on the issue): the Subagent panel is a flat list today. Child issue #490 (cross-Session
  Agents panel) and #712 (parent/child lifecycle data) are both not yet built. What does #563
  alone change? -> A: The panel becomes a `role="tree"` (FR-024): the Session's own subagents, in
  start order, each with its own child agents below once the tracker knows the parent -- none
  today, since no parent id exists in the current data, so the tree is honestly one level deep
  until #712 lands; no placeholder grandchild row is drawn. A vertical `ResizablePanelGroup`
  splits the tree above the selected agent's live stream (the `FileExplorerPanel.tsx` precedent).
  Full keyboard tree semantics (roving tab stop, arrow keys, Home/End, type-ahead) are built now
  even though every row is a leaf today, so #712 lands onto a working contract instead of a
  retrofit.
- Q: Is a cancelled/aborted subagent distinct from a failed one? -> A: Yes (FR-026): both pipelines
  (the Subagents chip/panel's own summary, and the chat transcript's own subagent row, spec 001
  FR-067/FR-068) split `cancelled`/`aborted` out of `failed` into its own status, counted on its
  own in every roll-up, never folded into "failed".
- Q: Where does focus go when the panel closes, now that something other than the Subagents chip
  (the chat's new Subagent chain row, spec 001 FR-068) can open it? -> A: FR-027: focus returns to
  whichever control opened the panel if it still exists in the DOM, else to the Subagents chip.
  Today's hard-coded chip-only target is superseded.
- Q: Issue #564 (composer restyle, child of #549) moves the Approval mode pill out of this row
  and into the message box (spec 001 FR-065) -- what does the row become, and does FR-001's
  "the row holds the pill alone" fallback still apply? -> A: Renamed the status line (FR-023);
  full chat width, figures tabular, Current time last at the right end when enabled; when nothing
  is meaningful or enabled the status line now renders nothing at all, since the pill that used
  to guarantee at least one item is gone.
- Q: `/grill-with-docs` follow-up (issue #564): should the status line's readouts keep the
  existing boxed/chip look (`ReadoutChip.tsx`'s `badgeVariants` pill), now that the Approval
  pill is gone? -> A: No (decision 1): plain text, no box, per the zero-box rule and the mock -- a
  read-only readout is an icon plus text with no border or fill; one that opens something (Pull
  request, Subagents) is a quiet text button with a hover background and no border. CONTEXT.md's
  **Readout chip** term is retired (moved to _Avoid_); the row is the **Status line**, each entry
  a **Readout** (decision 2).
- Q: Issue #437: the Context usage chip shows its figures in full with thousands separators and
  the word "tokens" (for example "44,842/1,000,000 tokens (4%)"), and the old `compact()` helper
  (`Intl.NumberFormat` with `notation: 'compact'`, used only by the Changes chip) is upper-case
  and rounds without a fixed decimal count, so it cannot be reused as is. What replaces both, and
  how far does the change reach? -> A: `/grill-with-docs` session, 2026-10-15. **Scope** (decision
  1): one shared `k`/`m`/`b` formatter for the Changes Readout, the Context usage Readout, AND the
  Session details card's diff line (`formatDiffStat`, spec 001 FR-039) -- so the hover card and
  the status line never show the same figure two ways; it replaces `ReadoutChips.tsx`'s own
  `compact()` entirely. **Threshold** (decision 2): one rule for every figure -- plain below
  1,000, abbreviated from 1,000 up (1,234 reads "1.2k"); at most one decimal, trailing zero
  dropped, round half up (decided earlier the same day, 2026-10-05: lower-case suffixes, no word
  "tokens", example "44.8k/1m (4%)"). **Locale** (decision 3): English suffixes `k`/`m`/`b`
  regardless of the system locale. **Wording and accessibility** (decision 4): the Context usage
  Readout's visible text drops the word "tokens"; the full phrase, including the high-usage
  warning state, reaches assistive technology through a real `sr-only` span next to `aria-hidden`
  visual text (the pattern the Current time chip already uses), replacing the existing high-state
  `accessibleName` on this chip's own role-less `<span>`, which several real screen readers (NVDA
  in browse mode, often Narrator and JAWS) ignore there. Built inside PR #877 (#564's composer
  status line), spec 004 is the right feature directory for this change, not spec 001.
- Q: Gate round 5 (`agent://Arch877`, fifth-gate UI/UX review of PR #877): the Subagents chip's
  running-vs-finished emphasis (`running === 0 ? 'text-muted-foreground' : undefined`) was a
  no-op, since `ReadoutChip.tsx`'s own base class already carries `text-muted-foreground` --
  neither state ever looked different from the other. Fix? -> A: `running > 0 ? 'text-foreground'
  : undefined` (FR-007 amended): the RUNNING state goes brighter instead of attempting to make
  the already-quiet finished state quieter still.
- Q: Gate round 5: the Context usage Readout's high-usage warning tested `contextUsage.percent
  >= 90` (the raw value) while the visible text showed `Math.round(contextUsage.percent)` -- a
  raw 89.5 to 89.99 displayed "90%" with no warning at all. Fix? -> A: Test the rounded,
  DISPLAYED percent instead (FR-003 amended): the warning must always agree with what the
  developer actually reads.

### Session 2026-10-16 (status line type)

- Q: Issue #928 (v0.3.0 feedback item 5): "Increase font size of composer status bar items" --
  the status line's 12px text and 12px icons read too small. What size, and does it apply to
  every readout kind? → A: 13px text, 14px icons, Stuart's own choice over a 14px text step
  (which would read "as loud as the chat"); applies to every readout kind in the row (Changes,
  Context usage, Turn time, Todo progress, Subagents, Pull request, Current time), including the
  interactive ones (FR-023 amended). No existing Tailwind step is 13px, so this adds one named
  step, `--text-readout` (`globals.css`, `docs/design/foundations-typography-spacing.md` "Status
  line type"), rather than a bare arbitrary `text-[13px]` value.

### Session 2026-10-19 (todo pin, issues #700/#701)

- Q: Stuart's steer while away ("I can't quite daily drive without seeing the plan and changes
  that have been made", "easier to have access to all that info in one app"): #700 asks for
  hover/focus summary cards on the Todo and Agents readouts plus a pin mode the Todo readout
  toggles; #701 asks for the pinned todo panel itself. How does the readout's click behaviour
  split, and what ships in this slice? → A: Decided (Skippy, delegated by Stuart 2026-10-19, away
  mode, `ui-architect-v3` ruling; full record on issue #700's own latest comment). One pill, one
  click-target: the Todo readout becomes `<button aria-pressed aria-controls=panel>` with a
  FIXED accessible name, "Pin todo list (Todo d/t)" (unchanged by pin state), toggling a new
  pinned todo panel above the message box. The pinned look is a pin glyph plus a rendered border,
  never the hover/open-card background every other interactive readout already uses. Work ships
  in three slices: **(a)** (this slice) the Rust-retained todo tree (`content`/`status`/
  `blocker`, wire field `todoTree`), live mid-turn updates from the `todo` tool's own
  `tool_execution_end`, a shared pure derive (`todoDerive.ts`, ready for #687/#526), the pinned
  panel itself, and the readout's own pin-toggle click -- no hover/focus card yet. **(b)**
  (separate story, closes #700) the Todo and Agents hover/focus cards plus the Rust
  `taskSummary` field. **(c)** (separate story, after #1048, closes #701) the
  `pinTodoByDefault` Settings, Appearance toggle.
- Q: What do `done`/`total` count, now that a task can be `blocked` or `abandoned` as well as
  `pending`/`in_progress`/`completed`? → A: `done` counts `completed` tasks; `total` excludes
  `abandoned` tasks entirely (neither open nor done); a `blocked` task counts as open (toward
  `total`, never `done`). One shared pure derive (`src/renderer/features/chat/readout/todoDerive.ts`) computes this so the
  readout, the panel, and the future card (slice b) never disagree.
- Q: Is the live mid-turn todo shape (`tool_execution_end`'s own `result.details.phases` for the
  `todo` tool) verified on the supported OMP version before the panel relies on it, per the
  constitution's "Evidence before design"? → A: Yes -- probed live against the real signed-in
  profile on `omp 18.12.2` (`docs/spike/todo-tree-pin-probe-700.mjs`, FINDINGS item 62, next to
  `docs/spike/FINDINGS.md`): the shape is `{op, phases: [{name, tasks: [{content, status,
  blocker?}]}], storage}`, byte-for-byte the same shape `get_state().todoPhases` already reports
  at settle (extending FINDINGS item 35(d)); `blocker` is present only on a `blocked` task; the
  five live status literals are `pending`, `in_progress`, `completed`, `blocked`, `abandoned`.
  Each call-end frame already carries the FULL current tree (not a delta), so the live handler
  simply replaces its retained tree on every `todo` `tool_execution_end`, with turn settle
  (`get_state`) staying the authoritative resync, matching every other readout field's own
  "live updates, settle reconciles" rule (FR-008).

### Session 2026-10-21 (hover/focus cards, taskSummary, issue #700 slice (b))

- Q: Slice (a) (2026-10-19) built the Todo readout's pin-toggle click and the pinned panel; the
  #700/#701 decision record's own slice (b) is "the Todo and Agents hover/focus cards plus the
  Rust `taskSummary` field, closes #700" (full text on issue #700's own latest comment, dated
  2026-10-19). Does anything in that record change for this slice, and what exactly ships? → A:
  Nothing changes; this slice builds exactly its own described scope. A non-modal Popover, built
  on `PopoverAnchor` with a controlled `open` state (never `PopoverTrigger`, `Tooltip`, or
  `HoverCard`, per the decision record), opens on hover after about 400ms or genuine keyboard
  focus-visible, closes on Escape or on losing both hover and focus, stays open while the pointer
  travels from the pill into the card ("hoverable"), opens upward (`side="top"`), and is hidden
  whenever its own readout is (no task list / no subagents this turn). The Todo card never opens
  while the todo list is pinned (decision item 1). One shared `useReadoutCard` controller drives
  both cards so neither drifts onto a different timing. The Todo card renders the identical
  phase/task rows the pinned panel already uses (extracted to `TodoTree.tsx`, never a second row
  renderer). The Agents card shows each running agent's own one-line `taskSummary` (Rust, first
  sentence of `task`, about 100 characters -- a SEPARATE field from the existing `nameOrTask`,
  which prefers a given `name`) and elapsed time, a quiet settled-counts line
  (`finished`/`exited`/`failed`/`cancelled`, reusing the chip's own counting rule via
  `subagentDerive.ts`), and a link that opens the Subagents panel the same way the pill's own
  click already does. Both cards' own content is inert text: nothing inside either is ever
  focused or announced, so keyboard focus never leaves the pill while a card is open.
- Q: Scope addition from Stuart (2026-10-21, grilled): completed todo items go green. Does the
  "done is neutral/grey" treatment the Todo card and pinned panel both inherited from the status
  line's own quiet-finished convention still hold? → A: No -- a completed task is now a named
  exception, the same one issue #941 already made for a finished Stage/subagent: both the check
  icon and the task text read `text-severity-success` (`TodoTree.tsx`'s shared
  `TASK_STATUS_GLYPH.completed`, used identically by the pinned panel and the Todo card, since
  both render through that one shared module). The icon SHAPE (a filled check-circle) stays the
  non-colour cue; "Done" stays screen-reader-only (decision item 5, unchanged); abandoned keeps
  its strike-through; in-progress and blocked are unchanged. Recorded as a named exception in
  `docs/design/foundations-icons.md` alongside #941's own Stage exception. `severity-success` on
  `--popover` (the Todo card's own surface) is added to the contrast gate's `READOUT_CARD_PAIRS`
  at the 4.5:1 body-text floor; `--background` (the pinned panel's own surface) was already
  gated there by #941.

### Session 2026-10-22 (context usage gradient, issue #1082; grilled by Stuart 2026-10-20)

- Q: What is coloured? -> A: The figures text "N/M (P%)" only; the gauge icon stays muted (FR-033).
- Q: Which colours? -> A: A smooth OKLCH blend between four new per-theme tokens
  (`--context-usage-0/-30/-70/-100`: grey, green, amber, red), not the session-state colours;
  every blended colour meets 4.5:1 on the composer background in each theme, the stops tuned
  per theme where needed and checked at every 10% step by `check:theme-contrast`.
- Q: The high state? -> A: Keep the 90%+ warning icon and the word "high"; the word takes the
  same gradient colour, not a fixed red (supersedes #895).
- Q: A progress bar? -> A: Yes, 2px under the figures, the same colour on a faint track,
  decorative, on by default, with "Show context usage bar" in Settings > Chat (FR-034).

### Session 2026-10-23 (current-work banner, issue #687; grilled by Stuart)

- Q: Where does the activity come from? -> A: The main agent's latest tool-call `intent` plus
  OMP's retry/compaction frames, retained in Rust and sent on the existing `readout:update`
  (FR-037); one pure `deriveActivity()` picks the line (FR-036).
- Q: Pinned Todo panel? -> A: The Todo line is dropped; intent and waiting lines stay (FR-036).
- Q: Chrome? -> A: One muted line, no spinner, no stop control, elapsed time like OMP (FR-035,
  FR-039); a Setting turns it off (FR-040).
- Q: Untrusted text? -> A: Plain text, controls stripped, 160 characters (FR-038).

### Session 2026-10-27 (banner styling, issue #1242; grilled by Stuart)

- Q: Where does the shimmer come from? -> A: One shared utility and one Settings > Appearance
  switch, shared with #1210; #1210 had not landed, so #1242 adds both (FR-042).
- Q: Colour and size? -> A: Label `--accent-text`, elapsed time muted; both `text-sm` (FR-039,
  FR-042).
- Q: Position? -> A: Keep `h-6`, add about 4px bottom margin (FR-039).
- Q: When does it move? -> A: Only while working; static when needs-you, reduced motion, hidden
  window, or switch off (FR-042).

### User Story 4 - Know what the agent is doing right now (Priority: P2, issue #687)

A user glancing at a working Session sees one muted line above the composer saying what it is
doing, with how long the turn has run.

**Acceptance**: while working, the line shows the current Todo task, intent or plain verb; it
changes to "Waiting for your answer" when the Session needs you, and disappears when idle or
when the Setting is off; with the Todo panel pinned, the Todo line is not repeated.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See a session's state at a glance (Priority: P1)

A developer looks at an open Session and, without opening any other view, reads a row of chips
above the message box: how much has changed, how full the agent's context window is, how long
the current turn has been running, the current time, the pull request open for this Session's
branch, and how many subagents the current turn has used. Each chip is there only while it means
something; the row never shows an empty placeholder.

**Why this priority**: This is the entire feature. Without the chip row there is nothing to
configure and nothing to click through to the subagent panel.

**Independent Test**: Open a Session with uncommitted edits, a running turn, and an open pull
request for its branch; confirm the chip row shows Changes, Context window usage, Turn time, the
clock, the Pull request number, and a Subagents count, each reflecting the Session's real state,
and that the row updates as the turn progresses.

**Acceptance Scenarios**:

1. **Given** an open Session with committed edits, uncommitted edits, or new untracked files
   against its Base branch, **When** the developer looks at the chip row, **Then** a Changes chip
   shows the number of files changed and the lines added and removed, matching the figure the
   Session details card shows.
2. **Given** a Session whose worktree matches its Base branch exactly, **When** the developer
   looks at the chip row, **Then** no Changes chip is shown.
3. **Given** a Session whose agent reports how much of its context window is used, **When** the
   developer looks at the chip row, **Then** a Context window usage chip shows the tokens used,
   the window size, and the percentage used.
4. **Given** a Session whose agent does not report context window usage, **When** the developer
   looks at the chip row, **Then** the Context window usage chip is hidden, or shows "Not
   available" if a reading was expected and never arrived.
5. **Given** a Session's context window usage is approaching full, **When** the developer looks at
   the chip, **Then** it visibly warns using text or an icon, never color alone.
6. **Given** a turn is running in a Session, **When** the developer looks at the chip row, **Then**
   a Turn time chip shows the turn's elapsed time, updating as it runs; **Given** no turn is
   running, **Then** the chip is not shown.
7. **Given** any open Session, **When** the developer looks at the chip row, **Then** a Current
   time chip shows the local time to the minute, updating each minute.
8. **Given** a Session's branch has an open pull request on GitHub, **When** the developer
   activates the Pull request chip, **Then** that pull request opens in the Pull requests view
   (spec 003); **Given** the branch has no open pull request, or the repository has no GitHub
   remote, **Then** the chip is not shown.
9. **Given** a turn has started one or more subagents, **When** the developer looks at the chip
   row, **Then** a Subagents chip shows the count of subagents that are running or finished for
   the current turn; **Given** no subagents have run this turn, **Then** the chip is not shown.
10. **Given** the agent is working, **When** any readout's underlying value changes, **Then** its
    chip updates without the developer refreshing or reopening the Session, and the developer can
    keep typing in the message box throughout.
11. **Given** the agent keeps a task list for the current work, **When** the developer looks at the
    chip row, **Then** a Todo chip shows how many of its tasks are done out of the total (for
    example "Todo 2/5"); **Given** the agent has no task list, **Then** the chip is not shown.
12. **Given** the agent keeps a task list, **When** the developer clicks the Todo readout (or
    activates it with Enter/Space), **Then** a pinned todo panel appears above the message box
    showing every phase and task with its status and, live, as the agent's own `todo` tool calls
    change them mid-turn; **When** the developer clicks it again, or the panel's own Unpin
    button, **Then** the panel disappears and the in-transcript Up next list (spec 001 FR-079)
    reappears. **Given** the panel is pinned and every task becomes done, **Then** it collapses
    to "All N done"; **Given** the agent's task list is cleared entirely while pinned, **Then**
    the panel disappears but stays pinned for the next task list (issue #700/#701).
13. **Given** the agent keeps a task list or has started subagents this turn, **When** the
    developer hovers or keyboard-focuses the Todo or Agents readout, **Then** a card opens
    (after a short hover delay, or immediately on keyboard focus) showing, for Todo, the full
    phase/task tree, and for Agents, each running agent's one-line task summary and elapsed time
    plus a quiet finished/failed total and a link to the Subagents panel; **When** the developer
    moves the pointer away, blurs the readout, or presses Escape, **Then** the card closes and
    keyboard focus stays on the readout; **Given** the todo list is pinned, **Then** the Todo
    card never opens (issue #700 slice (b)).

---

### User Story 2 - Choose which readouts show (Priority: P2)

A developer opens Settings from the left nav, finds a single "Session readout" section, and turns
individual readouts on or off. The choice applies to every open Session immediately, and survives
restarting Refract.

**Why this priority**: The chip row is only useful once it shows what a given developer cares
about; User Story 1 delivers value with its defaults, but this story is what makes the row
configurable, as Stuart asked.

**Independent Test**: Open Settings, hide the Current time chip and show it again, confirm every
open Session's chip row reflects the change immediately, restart Refract, and confirm the choice
held.

**Acceptance Scenarios**:

1. **Given** the left nav, **When** the developer selects "Settings", **Then** a Settings screen
   opens with a "Session readout" section listing every readout from User Story 1, each with its
   own show-or-hide control.
2. **Given** the Settings screen has never been changed, **When** the developer opens it, **Then**
   Changes, Context window usage, Turn time, Pull request, and Subagents show as on, and Current
   time shows as off.
3. **Given** the developer turns a readout off, **When** they look at any open Session, **Then**
   that readout's chip disappears from its row immediately, without reopening the Session or
   restarting Refract.
4. **Given** a readout choice was changed, **When** the developer restarts Refract, **Then** the
   Settings screen and every Session's chip row reflect the same choice.
5. **Given** the Settings screen, **When** the developer operates it using only the keyboard,
   **Then** they can reach every control, see a visible focus indicator throughout, and change
   every readout's show-or-hide state.

---

### User Story 3 - Inspect subagents (Priority: P3)

A developer activates the Subagents chip to see what the agent has delegated to in the current
turn: which subagents are running, finished, or failed, and, for one they pick, what it is saying
and which tools it is running, without leaving the Session or disturbing the chat.

**Why this priority**: The count alone (User Story 1) already tells the developer something is
happening; seeing the detail is valuable but depends on the chip existing first, and a developer
who never looks at subagent detail still benefits from Stories 1 and 2.

**Independent Test**: With a turn that has started two subagents, one finished and one still
running, activate the Subagents chip, confirm both appear with their states, select the running
one and confirm its live stream shows, then close the panel and confirm the chat is unchanged.

**Acceptance Scenarios**:

1. **Given** a turn with one or more subagents, **When** the developer activates the Subagents
   chip, **Then** a right side panel opens listing each subagent with its name or task and its
   state: running, finished, or failed.
2. **Given** the subagent list is open, **When** the developer selects one, **Then** the panel
   shows that subagent's live stream: what it is saying and which tools it is running.
3. **Given** a selected subagent's stream is open, **When** that subagent finishes, **Then** the
   panel updates to show its finished state without closing on its own.
4. **Given** the subagent panel is open, **When** the developer closes it, **Then** it closes and
   the chat pane is exactly as it was before the panel opened.
5. **Given** a subagent's stream includes a long file path, a long paragraph, or a long unbroken
   string as a tool call's argument or in text, **When** the developer views the panel at its
   narrowest supported width, **Then** the content wraps within the panel instead of clipping,
   and the panel does not grow wider than its own column.

---

### Edge Cases

- No readout is currently meaningful for a Session, or none are enabled in Settings: the status
  line renders nothing at all -- no empty bar -- since the Approval mode pill that previously
  guaranteed at least one item has moved into the message box (spec 001 FR-065, 2026-10-15, issue
  #564; supersedes this bullet's earlier "the row still shows the Approval mode pill alone").
- The agent is not running: Changes and Pull request keep their last read values, because both
  come from git and GitHub rather than from the agent; Context window usage shows its last known
  reading; Turn time and Subagents are hidden, because both only mean something for a turn in
  progress.
- The agent does not report context window usage at all: the chip is hidden, or shows "Not
  available" if a reading was expected and never arrived.
- The Session's Base branch no longer exists, or its worktree is missing: the Changes chip shows
  "Not available" instead of a count or hiding, matching the Session details card (spec 001
  FR-039).
- A change count (or the Context usage chip's token figures) is very large: it is shown
  abbreviated by the shared `k`/`m`/`b` formatter (FR-002, FR-003) rather than as an unbounded
  exact number -- 1,234 reads "1.2k". Rounding to one decimal can carry into the next suffix: for
  example 999,950 rounds to 999.95k, which rounds again to 1000.0k at one decimal, so the
  formatter carries up and shows "1m", never "1000k".
- Many chips are shown at once in a narrow window: the row wraps onto a further line, or scrolls,
  and never hides or overlaps the message box.
- A pull request lookup fails, or GitHub access is unavailable: the chip is simply not shown; no
  error toast appears.
- The subagent panel's stream contains a tool call target or paragraph longer than the panel is
  wide: it wraps across lines (or, for a tool row's summary, breaks within the available width)
  instead of being clipped with an ellipsis or pushing the panel wider; a code block or diff still
  scrolls horizontally inside its own box.
- Many rows are shown in the subagent panel at once: the panel's own vertical scroll still works,
  and every row keeps the same horizontal padding as the header, with no row touching the panel's
  left or right edge.
- The subagent panel is open on a subagent that then ends: the panel stays open and reflects the
  new state instead of closing itself.
- A Session attaches or resumes (a fresh start, or after the agent process exited, crashed or
  otherwise) while its reattached transcript still shows a subagent as `running` from before this
  process existed: it is unconditionally seeded as `exited` (issue #489) — distinct from
  `failed`, since nothing about its own work is known to have gone wrong, only its process is
  gone. **Gate fixes, 2026-10-07**: no `get_subagents` RPC call is made to decide this (a freshly
  launched process can never share a registry with a previous one, confirmed live); a `running`
  `runtime.subagents` entry and a `running` transcript `subagent` row for the SAME instance are
  first collapsed to one candidate (correlated by `toolCallId`+`specIndex`); only candidates from
  the current/last turn (after the last `user` transcript item) are ever seeded, **SUPERSEDED,
  durable turn marker below** (scope is now the persisted `Session.currentTurnSubagents` set, not
  transcript position), so an older
  turn's row never resurfaces as a phantom "finished" once a newer turn started none; the
  matching chat-transcript row is settled to `exited` too, not left spinning "running"; a
  seeded-only candidate (no live stream this run) gets an explanatory placeholder stream instead
  of erroring when selected; and no fabricated ~0s duration is shown when the original start time
  was never known (a row built from history has no wall clock). This makes the Subagents
  chip/panel reachable again instead of silently empty.
  **Gate fixes 2, 2026-10-07**: round 1's own claims above needed four corrections. (1)
  Collapsing by `toolCallId`+`specIndex` on the way in was not enough by itself: a SECOND
  reconcile on the SAME instance with no new turn in between (Recover twice, or Recover then a
  mode-change restart) could still re-seed a duplicate, because only a `running` summary ever
  occupied the correlation map -- an already-settled summary's key is now recorded regardless of
  status, so a transcript row the data-layer defect keeps rebuilding as `running` is never
  re-seeded, and the merge back into `runtime.subagents` replaces by that SAME key, never by the
  two sides' differently-schemed `id`. (2) **SUPERSEDED, gate fixes 3 below** -- "the last `user`
  boundary: a `steer` or a consumed `followUp` prompt becomes its own `user` item within the SAME
  turn (no fresh `agent_start`), so it could land after a still-running subagent's own row and
  scope it out of "the current turn" entirely, leaving its chat row spinning forever; the
  boundary is now anchored on the transcript's own last `subagent` row, walking back to ITS
  preceding `user` item. (3) A subagent that finished or failed before the crash is now seeded
  too, with its real recorded status, not only the ones left `running` -- FR-007/FR-017 call for
  "the current turn's subagents", not a subset. (4) `fromHistory` itself now settles a `running`
  subagent row from an OLDER turn to `exited` once a later `user` item exists, so the main chat
  transcript stops showing it as perpetually running even for a turn `reconcileSubagentsOnAttach`'s
  own scope rule will never touch again. **SUPERSEDED, durable turn marker below**: "once a later
  `user` item exists" is no longer the rule `settleStaleSubagentRows` (`transcript.ts`) uses; it
  now settles any `running` row whose `toolCallId:specIndex` key is absent from the persisted
  `Session.currentTurnSubagents` set. Narrowed: an orphaned previous-life `omp.exe` genuinely
  CAN outlive a real Refract app crash for a window on Windows -- the `exited` resolution above
  relies on `src/main/process/jobObject.ts`'s Job Object (primary) and `pidRecords.ts`'s
  `reapStale()` fallback (run from `main/index.ts` at startup, before any Session attaches)
  actually killing that orphan first, not merely on the assumption that a fresh process can never
  share a registry.
  **Gate fixes 3, 2026-10-07**: two more corrections. (1) Point (2) above is reverted: the turn
  boundary is back to the plain "last `user` transcript item" rule, never "the last `subagent`
  row, walking back to its preceding `user` item" -- that rule's own fix for the steer case
  created a worse bug, confirmed live: with no `subagent` row of its own in a later plain turn,
  walking back from an EARLIER turn's last `subagent` row could land on that earlier turn's own
  preceding `user` item, re-seeding its already-finished subagents as "this turn's" subagents on
  every subsequent restart/Recover/`openConversation` (`runtime.subagents` is empty on a fresh
  instance and `agent_start` already clears it, so nothing else bounds the scope).
  **SUPERSEDED, durable turn marker below** -- this round accepted a documented limitation here:
  if the user steered or sent a consumed `followUp` WHILE a subagent was still running, that
  steer's own `user` item moved the boundary past the subagent's row, and a later restart/Recover
  did not restore its pill. (2) A second Recover (or Recover then a mode-change
  restart) with no new turn in between could still leave the chat-transcript row spinning
  `running` forever even once its `SubagentSummary` had already settled: an already-settled
  correlation key was skipped outright in the transcript scan, so it never reached
  `transcriptSettling`, and `candidates.size === 0` returned before any settling ran. Fixed: an
  already-settled key's still-`running` transcript row is now settled straight to that recorded
  status instead of skipped, and the early return also checks for pending transcript settling.
  Also, a resolved `exited` row no longer reports a `durationMs` at all (it was counting the
  entire app-downtime window the crash and restart spanned, not the subagent's own runtime).
- **Durable turn marker, 2026-10-07 (PLAN.md row A2c, supersedes gate fixes 3's turn-boundary
  rule above)**: "the current turn's subagents" (FR-007) is no longer defined by transcript
  position at all. `Session.currentTurnSubagents` (registry.json, data-model.md) persists the
  `toolCallId:specIndex` keys of the current turn's subagents, written by `handleTaskStart` the
  instant a `task` call starts and cleared only at the next `agent_start` -- the SAME boundary
  `runtime.subagents` already uses, never by a steer (`chat.sendNow`) or a consumed `followUp`
  (a steer never fires `agent_start`; a consumed `followUp` can only be promoted once the prior
  turn, including its subagents, already fully settled, so clearing at `agent_start` is always
  correct for it too). `reconcileSubagentsOnAttach` and `transcript.ts`'s
  `settleStaleSubagentRows` both scope by this SAME persisted set instead of the transcript's
  last `kind: 'user'` item, so a steer mid-subagent no longer loses the pill (the bug this spec
  accepted above) WITHOUT reintroducing gate fixes 2's worse bug (an earlier turn's
  already-finished subagents resurfacing as "current"), because scope is now keyed by exact
  subagent identity, never by walking the transcript. Absent (old registries, or a turn that
  started no subagents) means empty scope -- no migration needed.
- The clock and the turn timer tick frequently: neither is announced to assistive technology on
  every tick.
- No readout's status is ever conveyed by color alone: the context window usage warning always
  carries text or an icon alongside any color.
- Every clickable chip (Pull request, Subagents) is a keyboard-operable control with an accessible
  name stating what it opens.
- Every non-clickable chip is still readable by assistive technology as one phrase (for example
  "Context window 42 percent used").
- The pinned todo panel is toggled open while the agent's task list is cleared (a new
  Conversation, or the agent dropping its plan): the panel unmounts (there is nothing to show),
  but the pin choice itself survives into the next task list the agent starts (issue #700/#701).
- A task is marked `blocked` mid-turn: the panel's own row for it shows a second "Blocked:
  <reason>" line in addition to its status icon and word; an `abandoned` task shows a
  strike-through and is excluded from both `done` and `total` (decision record item 4).
- The pinned panel is open at a 360px pane width: task text wraps in full rather than clipping,
  and opening or closing the panel does not shift the transcript's own scroll position.
- The Todo readout is pinned: hovering or focusing it never opens the hover/focus card (decision
  item 1); only the Agents readout's own card can still open at the same time.
- A running subagent's own `task` text has no sentence-ending punctuation at all: its Agents card
  summary is the whole `task` text (truncated to about 100 characters), never an empty string.
- Nothing inside either hover/focus card is ever focused or read by assistive technology as part
  of a linear or keyboard traversal: both cards are purely visual, inert text (issue #700 slice
  (b)).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An open Session MUST show a chip row directly above the message box. It always
  contains the Approval mode pill (spec 001 FR-056) as its first item, followed by only the
  readouts that are both enabled in Settings and currently meaningful for that Session; when no
  readout is meaningful the row holds the pill alone. (Superseded by FR-023, 2026-10-15, issue
  #564: the pill moves out of this row into the message box itself, spec 001 FR-065, and the row
  is renamed the status line.)
- **FR-002**: The Changes chip MUST show the number of files changed and the total lines added
  and removed for the Session's worktree against its Base branch, counting committed edits,
  uncommitted edits, and new untracked files — the same figure the Session details card shows
  (spec 001 FR-039); each figure MUST be abbreviated past 1,000 by the one shared formatter
  FR-003 also uses (2026-10-15 grill, issue #437), so the two never show the same count two
  different ways; when the Base branch no longer exists or the worktree is missing, the chip
  MUST show "Not available".
- **FR-003**: The Context window usage chip MUST show the tokens used, the context window size,
  and the percentage used, for the Session's running agent; it MUST be hidden, or show "Not
  available", when the agent does not report this; as usage nears the window's limit, the chip
  MUST visibly warn using text or an icon, never color alone. The high-usage warning threshold
  (gate round 5, Flow LOW fix) is evaluated against the ROUNDED percentage actually shown, not
  the raw value underneath it -- a raw 89.5 to 89.99 rounds to the displayed "90%", and the
  warning MUST agree with what the developer reads, not a value one percentage point below it.
  The used-tokens and window-size
  figures MUST be formatted by one shared lower-case `k`/`m`/`b` formatter (2026-10-15 grill,
  issue #437, decided 2026-10-05/2026-10-15): plain below 1,000; at most one decimal above it,
  with a trailing zero dropped (`1m`, never `1.0m`), rounded half up, carrying to the next larger
  suffix when rounding would otherwise reach 1,000 of the current one (for example 999,950 reads
  `1m`, never `1000k`); English suffixes regardless of system locale. This is the SAME formatter
  FR-002's Changes chip and the Session details card's diff line use, so no figure is ever shown
  two different ways across the app. The visible text drops the literal word "tokens" (for
  example "44.8k/1m (4%)"); the full wording, including the high-usage warning state, MUST still
  reach assistive technology, through a real `sr-only` phrase next to `aria-hidden` visual text
  (the same pattern the Current time chip already uses) rather than an `aria-label` on this
  chip's own role-less `<span>`, which several real screen readers ignore there.
- **FR-004**: The Turn time chip MUST show the elapsed time of the Session's currently running
  turn, updating as the turn runs, and MUST be hidden whenever no turn is running.
- **FR-005**: The Current time chip MUST show the local time to the minute, updating at least
  once a minute, without the update being announced to assistive technology on every tick.
- **FR-006**: The Pull request chip MUST show the number of the open pull request for the
  Session's branch; it MUST be hidden when there is no such pull request or no GitHub remote, and
  when a lookup fails or GitHub access is unavailable it MUST be hidden without an error message.
  Activating it MUST open that pull request in the Pull requests view (spec 003).
- **FR-007**: The Subagents chip MUST show the running count of the current turn's subagents
  while any are running; **SUPERSEDED, gate fixes 2 finding 7 (2026-10-07)**: once none are
  running, it is no longer a single "N finished" total of `finished`-or-`exited` ones -- it MUST
  show a quiet, comma-joined total of whichever of `finished`/`exited`/`failed`/`cancelled`
  (issue #563: `cancelled` added, split out of `failed`) are non-zero (for example "1 finished, 1
  exited", or "1 failed" when a turn's only subagents failed), worded distinctly per status
  rather than folded into one misleading "finished" bucket (issue #536); it MUST be hidden when
  the turn has started none. The RUNNING state MUST visibly stand out from the quiet
  finished-only total (gate round 5, Layout/Visual Medium fix: the chip's own base style is
  already the quiet muted colour every readout uses at rest, so a running-vs-finished
  distinction needs the RUNNING state to go brighter, not the finished state to go quieter
  still, which a literal reading of "quiet" above could otherwise be misread as). (Amended
  2026-10-21, issue #700 slice (b): the chip's own hover/focus card, FR-032, shows a one-line
  summary and elapsed time per running agent, built from this same count data.)
- **FR-008**: Every chip MUST update live as the underlying value changes, MUST retain its last
  known value when a live reading is momentarily unavailable but the readout is otherwise
  meaningful (FR-002, FR-003), and MUST NOT block typing into or sending from the message box.
- **FR-009**: At any window width Refract supports, the chip row MUST wrap onto a further line or
  scroll rather than hiding or overlapping the message box.
- **FR-010**: Every clickable chip MUST be a keyboard-operable control with an accessible name
  stating what it opens; every non-clickable chip MUST be readable by assistive technology as one
  phrase describing its current value; no chip's status MUST be conveyed by color alone.
- **FR-011**: The app MUST provide a way to open a Settings screen from the left nav: the cog on the profile item at the bottom of the left nav (spec 008).
- **FR-012**: The Settings screen MUST include one section, "Session readout", listing Changes,
  Context window usage, Turn time, Current time, Pull request, Subagents, and Todo progress, each
  with its own control to show or hide it.
- **FR-013**: The Session readout section's defaults MUST be: Changes, Context window usage, Turn
  time, Pull request, Subagents, and Todo progress shown; Current time hidden.
- **FR-014**: A readout's show-or-hide choice MUST apply across the whole app, MUST persist
  across Refract restarts, and MUST apply to every open Session's chip row immediately, without
  reopening the Session or restarting Refract.
- **FR-015**: The Settings screen MUST be structured so that further sections (for example theme,
  UI font, and code font from backlog issue #4) can be added later without redesigning the
  screen.
- **FR-016**: The Settings screen MUST be fully operable by keyboard, with a visible focus
  indicator at every control.
- **FR-017**: Activating the Subagents chip MUST open the Subagent panel: a `role="tree"` of the
  Session's subagents (FR-024), each with its name or task and its state (running, finished,
  failed, cancelled, or exited — issues #489, #563). **Amended by spec 013**: the panel opens
  through the shared right pane shell (one permanent icon rail, one collapsible pane hosting
  every right-hand panel) rather than a standalone right-hand region; this spec's own FR-018 to
  FR-020 (the panel's content and behaviour) are unchanged.
- **FR-018**: Selecting a subagent in that panel MUST show its live stream — what it is saying and
  which tools it is running — inside the panel.
- **FR-019**: The subagent panel MUST be closeable, and closing it MUST leave the chat pane
  unchanged; closing it MUST return keyboard focus to whichever control opened it, if that
  control still exists, else to the Subagents chip (FR-027, issue #563; supersedes the earlier
  always-the-chip target now that spec 001's Subagent chain row, FR-068, can open the panel too).
- **FR-020**: A subagent finishing while its stream is open in the panel MUST update that
  subagent's shown state without closing the panel.
- **FR-021**: The Todo progress chip MUST show how many of the agent's current tasks are done out
  of the total (for example "Todo 2/5"), MUST be hidden when the agent has no task list, and MUST
  be readable by assistive technology as one phrase (for example "Todo: 2 of 5 tasks done"). It
  replaces the chat's own task-list rows, which are hidden (spec 001 FR-052), so the agent's plan
  progress stays visible. (Amended 2026-10-19, issue #700/#701 slice (a): this readout's own
  click behaviour is superseded by FR-028; its done/total figure is computed by the shared
  `deriveTodoTotals` (FR-029), never duplicated here. Further amended 2026-10-21, issue #700
  slice (b): this readout also gains a hover/focus card, FR-031, showing the full phase/task
  tree.)
- **FR-022**: The subagent panel's content (stream text, paragraphs, tool call summaries) MUST
  wrap within the panel's own width at every panel width Refract supports, MUST NOT clip text or
  grow the panel wider to fit it, and MUST use the same horizontal padding on the subagent list and
  stream as the panel's header; a code block or diff MAY still scroll horizontally inside its own
  box.
- **FR-023**: The status line (renamed from the chip row, 2026-10-15, issue #564) MUST span the
  full width of the chat column, directly between the transcript and the message box, and MUST
  NOT include the Approval mode pill, which lives in the message box instead (spec 001 FR-065).
  It MUST show only the readouts enabled in Settings and currently meaningful for the Session
  (Changes, Todo progress, Context window usage, Turn time, Subagents, Pull request, Current
  time), wrapping onto a further line rather than clipping (FR-009, unchanged) with its figures
  shown as tabular numbers. When enabled, the Current time readout MUST be the line's last item,
  at its right end. When no readout is both enabled and meaningful, the status line MUST render
  nothing at all -- no empty bar -- since the Approval mode pill that previously guaranteed at
  least one item no longer lives here. Every readout MUST be plain text, not a boxed chip
  (2026-10-15 grill, issue #564, decision 1): a read-only readout (Changes, Todo progress,
  Context window usage, Turn time, Current time) MUST show as an icon plus text with no border or
  fill; a readout that opens something (Pull request, Subagents) MUST show as a quiet text
  control with a hover background and no border, never a bordered or filled pill. (Amended
  2026-10-16, issue #928, v0.3.0 feedback item 5: every readout's text is 13px, not the original
  12px -- `--text-readout`, the one new named type-scale step this adds, `docs/design/
  foundations-typography-spacing.md` "Status line type" -- and its icon is 14px, not 12px; Stuart
  chose 13px/14px over a 14px TEXT step, which would read "as loud as the chat".)
- **FR-024** (renumbered from FR-023 during the #877/#563 merge, 2026-10-15 -- both stories
  independently claimed FR-023; #877 merged first, so #563's own subagent-panel FRs move to the
  next free numbers): The Subagent panel MUST show the Session's subagents as a `role="tree"`
  (issue #563): the Session is the implicit root; the agents it started are the first level, in
  start order; each of those agents' own child agents render below it once the tracker can tell
  which agent started which (not derivable from today's data, so the tree MUST render exactly one
  level deep, honestly, with no placeholder grandchild row, until a later story supplies that
  data). The tree and the selected agent's live stream (FR-018) MUST sit in a vertical,
  user-resizable split, the tree above the stream, with a keyboard-operable resize handle.
- **FR-025** (renumbered from FR-024, see FR-024's own note): The subagent tree MUST be fully
  keyboard-operable: a single roving tab stop, Up and Down moving between visible rows, Left and
  Right collapsing/expanding or moving to a parent/child row, Home and End moving to the
  first/last row, and single-character type-ahead jumping to the next row whose name starts with
  the typed character. The selected row MUST be marked by a visible indicator distinct from
  hover, never colour alone, and MUST carry `aria-level`, `aria-setsize`, and `aria-posinset`
  reflecting the row's true position even where indentation is visually capped.
- **FR-026** (renumbered from FR-025, see FR-024's own note): A subagent whose run was cancelled
  or aborted MUST show a status distinct from one that failed (issue #563): neither the
  Subagents chip's roll-up (FR-007) nor the subagent tree MUST ever count or label a
  cancelled/aborted subagent as "failed".
- **FR-027** (renumbered from FR-026, see FR-024's own note): Closing the Subagent panel MUST
  return keyboard focus to whichever control activated it, if that control still exists in the
  document, and MUST fall back to the Subagents chip only when it does not (issue #563; see
  FR-019).
- **FR-028** (new, 2026-10-19, issue #700/#701 slice (a)): The Todo progress readout MUST be a
  keyboard-operable toggle control (`aria-pressed`, `aria-controls` naming the pinned panel
  below) with a FIXED accessible name stating the current figure (for example "Pin todo list
  (Todo 2/5)") that does not change between pinned and unpinned states. Activating it MUST
  toggle a per-Session pinned todo panel (FR-029); the pinned state MUST be shown as a pin icon
  plus a rendered border, never the same hover/open background every other interactive readout
  uses.
- **FR-029** (new, 2026-10-19, issue #700/#701 slice (a)): While a Session's todo list is pinned,
  Refract MUST show a pinned todo panel directly above the message box: a header (the current
  done/total figure and, when one task is in progress, its text, truncated) with a Collapse
  control (`aria-expanded`) and an Unpin control, both keyboard-operable with fixed accessible
  names; and, while not collapsed, the full task tree capped to a scrolling list, grouped by
  phase (a phase header shown only when the agent reports more than one phase, each naming its
  own done/total), with a finished phase folded to one line and the phase containing the current
  task always expanded. Each task MUST show a status icon and, for `in_progress`, `blocked`, and
  `abandoned`, a visible status word (`pending` and `completed` carry the same word for assistive
  technology only); a `blocked` task MUST additionally show its own blocker text on a second
  line; an `abandoned` task MUST show with a strike-through and MUST NOT count toward either
  `done` or `total` (FR-028's shared derive). The list MUST keep the current `in_progress` task
  in view when it changes, UNLESS the developer has scrolled the list themselves, in which case
  it MUST stop auto-following. Task text MUST wrap in full at every panel width Refract supports,
  down to 360px, with no clipping. The panel MUST disappear entirely once the agent has no task
  list at all, without clearing the pinned choice itself, and MUST collapse to a plain "All N
  done" line once every one of its open tasks is complete. Opening or closing the panel MUST NOT
  change the transcript's own scroll position.
- **FR-030** (new, 2026-10-19, issue #700/#701 slice (a); amends spec 001 FR-079): While a
  Session's todo list is pinned (FR-028/FR-029), the in-transcript Up next list (spec 001 FR-079)
  MUST be hidden for that Session, so the agent's plan is never shown in two places at once;
  unpinning MUST show it again under FR-079's own existing rule.
- **FR-031** (new, 2026-10-21, issue #700 slice (b); amended same day, gate round 1 findings 2
  and 4): Both the Todo and Agents readouts MUST show a non-modal card, anchored with a Popover
  `Anchor` under a controlled `open` state (never a `Trigger`, `Tooltip`, or `HoverCard`), that
  opens on hover after about 400ms or on genuine keyboard focus-visible, closes on Escape or once
  neither the readout nor the card itself is hovered or focused, stays open while the pointer
  moves between the readout and the card, and opens above the readout. The card MUST be hidden
  whenever its own readout is hidden (FR-021, FR-007); the Todo card MUST NOT open at all while
  the todo list is pinned (FR-028), and the Agents card MUST NOT open at all while no subagent is
  currently running, even if some finished, failed, or were cancelled this turn (FR-007's own
  quiet settled counts still read on the pill itself regardless). The Todo card's content is
  entirely non-focusable, non-announced inert text; the Agents card's own link to the Subagent
  panel (FR-032) is its one pointer-only exception -- a keyboard user's own equivalent route is
  the readout itself, already keyboard-operable (FR-017). Activating or keyboard-operating
  either readout is unaffected by the card's own open state.
- **FR-032** (new, 2026-10-21, issue #700 slice (b); amended same day, gate round 1 finding 6):
  The Agents card MUST show a "<n> running" header, then one row per currently running
  subagent (capped at six, with a quiet "and N more" line past that), each leading with a status
  glyph and the subagent's own given name (never falling back to its task text the way the
  readout's own identity label does), its one-line task summary (the first sentence of its own
  `task` text, about 100 characters, truncated to one line, never wrapping) in muted text, and
  its running elapsed time in tabular figures; MUST show a quiet line of the turn's
  finished/exited/failed/cancelled counts when any are non-zero (the same counting rule FR-007
  uses); and MUST include a pointer-only link that opens the Subagent panel (FR-017), equivalent
  to activating the Agents readout itself (FR-031).
- **FR-033** (new, 2026-10-22, issue #1082; supersedes #895): The Context usage readout's
  figures text "N/M (P%)" and, at 90% and over, its word "high" MUST take one colour from a
  smooth OKLCH blend between four per-theme context-usage tokens: 0% (muted grey), 30% (green),
  70% (amber), 100% (red), interpolated for every percent between and clamped at 100. The gauge
  icon stays muted; the 90%+ warning icon and the word "high" stay (colour is never the only
  signal); "Not available" stays muted; the `sr-only` phrase is unchanged. Every blended colour
  MUST meet 4.5:1 against the composer background in every built-in theme, checked by
  `check:theme-contrast` at every 10% step. In forced-colors mode the colour is dropped and the
  icon and word carry the state.
- **FR-034** (new, 2026-10-22, issue #1082): A 2px progress bar MUST sit under the Context usage
  figures, the readout's own width, filled to P% (clamped 0-100) in the FR-033 colour on a faint
  track; decorative (`aria-hidden`), hidden with "Not available"; its width change respects
  `prefers-reduced-motion`. It is on by default and turned off by a "Show context usage bar"
  switch in Settings > Chat, beside the other readout settings (`showContextUsageBar`, persisted
  in the Rust settings store).
- **FR-035** (new, 2026-10-23, issue #687): While a Session is working or needs you, one line
  MUST sit above the composer (below the pinned Todo panel) naming what the main agent is doing
  now, prefixed with the elapsed turn time ("1m 12s · Reading ChatPane.tsx"). It is hidden when
  the Session is idle. One banner per chat pane.
- **FR-036** (new, 2026-10-23, issue #687): One pure `deriveActivity()` in `src/shared/activity.ts`
  MUST pick the line by priority: needs you (approval or question pending), "Retrying · attempt
  n of m", "Compacting context…", "Waiting for N subagents", the current Todo task "n of m", the
  latest tool-call `intent`, a plain verb for the latest tool call when it carried no intent
  (never the raw tool name), then "Working…". While the Todo panel is pinned, the Todo line is
  dropped; intent and waiting lines stay.
- **FR-037** (new, 2026-10-23, issue #687): The Rust readout MUST retain the main agent's latest
  tool-call `intent` (set when the call starts), the latest call's name and target path, the
  auto-retry attempt (`auto_retry_start/_end`) and whether an auto-compaction runs
  (`auto_compaction_start/_end`), and expose them as `latestIntent`, `latestTool`, `retry` and
  `compacting` on the existing coalesced `readout:update` (no new event). All clear at the turn
  boundary. The elapsed time reuses `turnTime.startedAt`. Known limit: intent is captured at
  `tool_execution_start` only, because OMP's `tool_execution_update` carries no intent.
- **FR-038** (new, 2026-10-23, issue #687): Agent text is untrusted. The banner MUST render it as
  plain text only, strip control characters, and cap it at 160 characters.
- **FR-039** (new, 2026-10-23, issue #687; amended 2026-10-27, issue #1242 -- see FR-042): The
  banner MUST be one ~24px line of ~14px text, no box, no spinner, no stop control,
  `aria-live="off"`, truncated with the full text in the shared Tooltip. It updates at most about
  twice a second, holds each text at least 600 ms, and fades over 100-150 ms unless
  `prefers-reduced-motion`. It sits about 4px higher above the composer (a 4px bottom margin).
- **FR-042** (new, 2026-10-27, issue #1242): The banner's activity label MUST use `--accent-text`
  (a themed fallback token in any theme where it misses 4.5:1 at 14px against the background);
  the elapsed time stays `text-muted-foreground`. While the Session is working, the label MUST
  carry the one shared shimmer utility (`.text-shimmer`, `globals.css`; about 1.6 s per pass, a
  gradient band clipped to the text, `transform`-driven, band colour the accent text colour). The
  shimmer is a decorative `aria-hidden` layer: the label text, `aria-live="off"` and the tooltip
  are unchanged. It MUST be static when the Session needs you, under `prefers-reduced-motion`,
  while the window is hidden, and when the Settings > Appearance switch "Animated status text"
  (`animatedStatusText`, default on, persisted in the Rust settings store) is off. The same
  utility and switch are reused by issue #1210's transcript-row shimmer (the first to land adds
  them).
- **FR-040** (new, 2026-10-23, issue #687): A "Show current work above the composer" switch
  (readout kind `current-work`, default on) MUST sit beside the other readout toggles in
  Settings and hide the banner when off.
- **FR-041** (new, 2026-10-26, issue #526; amends FR-036): The needs-you line MUST name the first
  pending request: "Needs your input: <the question's start>" for a question or ask dialog,
  "Waiting for approval: <tool> <target>" for an approval, and "Waiting for your answer" only
  when no pending request is known. The text is sanitised like every other agent string
  (FR-038). When spec 001 FR-111's "Activity text" setting is Playful, the generic "Working…"
  line MUST instead show a phrase from a fixed list of about 12, chosen per Session and rotated
  every 10 seconds while that fallback holds; every other line stays factual. The banner and
  spec 001's Session-row Activity line (FR-108) MUST share this one derive and one hold hook.

### Key Entities

- **Readout**: one entry in the status line, for one readout kind (Changes, Context window
  usage, Turn time, Current time, Pull request, Subagents, Todo progress), shown only while that
  readout is enabled and meaningful for the Session, plain text with no border or fill, and a
  quiet text button (hover background, still no border) only for Pull request and Subagents,
  which are the only two that open something (2026-10-15 grill, issue #564, supersedes this
  entry's earlier "chip" framing).
- **Session readout settings**: the app-wide record of which readouts are shown or hidden, with
  the defaults in FR-013, persisted across restarts and applied to every open Session.
- **Subagent panel**: the panel opened from the Subagents chip, showing the Session's subagents
  as a tree (FR-024) with a vertical split onto the live stream of whichever one is selected;
  hosted inside the shared right pane shell (spec 013), not a standalone side region.
- **Subagent entry**: one row in the subagent tree: a name or task, a state (running, finished,
  failed, cancelled, or exited — a process confirmed gone with nothing known about its own work,
  issues #489, #563), its own child agents when the tracker knows the parent (FR-024), and, when
  selected, its stream of output and tool calls.
- **Pinned todo panel** (new, issue #700/#701 slice (a)): the Session-scoped view of the agent's
  full todo tree (phase name, each task's content/status/blocker), toggled by the Todo readout
  (FR-028) and shown directly above the message box while pinned (FR-029); its own collapsed/
  expanded choice persists per Session separately from the pin itself, and neither is persisted
  across an app restart (#701 slice (c)'s `pinTodoByDefault` setting, not built here, is the only
  planned persistence).
- **Todo card** (new, issue #700 slice (b)): the Todo readout's own hover/focus card -- the SAME
  phase/task tree the pinned todo panel renders, read-only, shown only while the readout is not
  pinned.
- **Agents card** (new, issue #700 slice (b)): the Agents (Subagents) readout's own hover/focus
  card -- each running subagent's one-line task summary and elapsed time, the turn's quiet
  settled counts, and a link to the Subagent panel.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can read a Session's Changes count, context window usage, and turn time
  from the chip row within 2 seconds of looking at it, without opening any other view.
- **SC-002**: Turning a readout off or on in Settings changes every open Session's chip row within
  1 second, with no restart of Refract or any Session.
- **SC-003**: Every readout's show-or-hide choice survives a full app restart 100% of the time.
- **SC-004**: The chip row and the Settings screen's Session readout section are fully operable
  using only the keyboard, with a visible focus indicator throughout.
- **SC-005**: No readout is ever conveyed by color alone; the context window usage warning always
  carries text or an icon, checked across its full range from first appearance to full.
- **SC-006**: Activating the Subagents chip shows the current subagent list within 1 second, and a
  selected subagent's stream reflects new output within 2 seconds of it occurring.
- **SC-007**: A pull request lookup failure or unavailable GitHub access never produces an error
  toast; the Pull request chip is simply absent in that case, 100% of the time.
- **SC-008**: At every window width Refract supports, the chip row wraps or scrolls rather than
  hiding or overlapping the message box, 100% of the time.

## Assumptions

- The "Artifacts" chip shown in the reference screenshot has no known source in OMP's reported
  state. It is out of scope until a verified source is found; this is an open question, not a
  [NEEDS CLARIFICATION] item, because the chip is simply dropped from this spec rather than
  blocking it.
- Other OMP statistics that Stuart did not choose for this spec — generation speed, cost and
  token totals, and fast-mode or compaction state — are candidates for a later
  addition to the Session readout section; FR-015's extensible structure is written so they can
  be added without redesigning the screen.
- The Todo progress readout is included because spec 001 FR-052 hides the agent's task-list calls
  from the chat (Stuart chose "Hide them" when the option said progress would show only as a
  chip). Its source, the agent's reported task phases in the session state, is unverified on the
  supported OMP versions (18.4.x/18.5.x) and must be probed and recorded in `docs/spike/FINDINGS.md`
  before the plan relies on it (constitution IV).
- Both a turn timer and a clock are included because Stuart first said "time" and then separately
  said "Current Time as well" when asked to name the readouts. This reading (elapsed turn time
  plus the wall clock, rather than either alone) is a reasonable interpretation of what he said,
  not a separately confirmed answer, and should be confirmed with Stuart.
- Per the constitution's "Evidence before design" principle, this spec's Context window usage and
  Subagents readouts depend on OMP behaviour that is not yet verified on the supported OMP
  versions (18.4.x/18.5.x) and must be recorded in `docs/spike/FINDINGS.md` before the plan relies on it.
  FINDINGS row C6 records that subagent frames pass over a subscription, with progress arriving as
  `tool_call_update` progress on the `task` tool rather than a dedicated event type; that row was
  proven for a different use and is unverified for driving this spec's subagent list and stream.
- This spec depends on spec 003 (Pull request management) for where the Pull request chip's
  activation leads, and on spec 001 FR-039 (the Session details card's Changes figure) and FR-041
  (the message box's existing model and reasoning-effort readout, which this spec does not
  change or duplicate).
- This spec makes no change to OMP's own status-line settings; the chip row is Refract's own
  surface, built from state Refract already reads or newly reads from the agent.
- Session readout settings are app-wide, not per-Session, matching how Approval mode works in
  spec 001.
- Windows 11 is the only supported platform, consistent with the constitution.
- The subagent panel is the first feature to use Refract's right side pane. The right pane's
  other planned content — git changes, a file browser, and a side chat (backlog issue #1) — is
  out of scope here and remains its own, later spec.
- Issue #489's attach/resume seeding (FR-007, FR-017, Edge Cases) was originally designed from
  OMP's `get_subagents` contract, confirmed live (`docs/spike/get-subagents-probe.mjs`,
  2026-10-07, omp 18.8.0): a freshly attached process's own `get_subagents` is scoped to that
  process only and never replays a previous process's registry, even onto the same Conversation
  file. **Gate fixes, 2026-10-07**: `reconcileSubagentsOnAttach` no longer calls `get_subagents`
  at all -- `launch()` always spawns a brand-new process, so that same confirmed-live result means
  its registry is unconditionally empty at this point; every surviving `running` candidate is
  resolved straight to `exited` with no RPC round trip. The exact scenario Stuart saw when he
  filed #489 (what crashed, Refract or `omp`, and whether a process was left running) is unconfirmed
  and logged as PLAN.md's open question 9, not assumed here.
- Issue #700's own hover/focus summary cards on the Todo and Agents readouts, and the Rust
  `taskSummary` field they need, shipped as **slice (b)** (2026-10-21, FR-031/FR-032, Closes
  #700). Issue #701's `pinTodoByDefault` Settings, Appearance toggle remains **deferred to a
  separate story (slice (c), after #1048, closes #701)**: until it ships, every Session starts
  unpinned, with no way to change that default.

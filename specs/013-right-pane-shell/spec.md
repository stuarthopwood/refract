# Feature Specification: Right pane shell

**Feature Branch**: `013-right-pane-shell` (work lands via issue-named branches off `main`, matching
every other story in `docs/PLAN.md`; this directory is the Spec Kit record, not a literal git
branch)

**Created**: 2026-10-08

**Status**: Draft

**Input**: `docs/PLAN.md` phase C, row C1 (p1, demo-critical): issue://538 (behaviour rules for
every right-hand panel), issue://393 (icon rail and the FDB Knowledge/Agent Builder placeholder
panes), issue://394 (tabs so panes can be switched and closed). Stuart decided the rules in #538
on 2026-10-07, the day before the #474 design grill; the grill's `docs/design/components.md`
("Tabs and the right pane") and `docs/design/patterns.md` ("Placeholders and 'coming soon'")
restate and settle them (PR #580, branch `docs/design-system-474`, not yet merged to `main` as of
this writing — cited by content, not by path on `main`).

## Clarifications

### Already decided (cited, not re-asked)

- **Q (issue://538, Stuart 2026-10-07): does the icon rail stay, and do tabs show counts?** ->
  **A: yes to both.** A permanent icon rail stays visible at the window's right edge even while
  the pane is collapsed; an open panel's own tab also shows that panel's live count (issue
  summary line 1; `components.md` "Tabs and the right pane").
- **Q (issue://394, amended by issue://538): what does closing the last open panel do?** ->
  **A: it closes only that panel.** The pane stays open and shows the launcher list of available
  panels; it no longer means the pane itself closes. This supersedes issue://394's original
  "closing the last tab closes the panel" line.
- **Q (issue://393 Open Questions, "Spec 004 overlap"): which spec owns the shell —
  a new one, or an amendment to specs 004 and 005?** -> **A, decided by this spec**: a new spec
  (this one). The shell is app-wide infrastructure (icon rail, one pane, tabs, launcher) shared by
  every future right-hand panel (Agents/#490, side chat/#1, Git changes/#464, Terminal/#3, file
  explorer/#463, Jira/#478), not a Subagents-only concern; spec 004 is amended narrowly (its
  FR-017 "opens a right side panel" now reads "opens through the shared right pane shell, spec
  013") rather than redesigned, and spec 005 is untouched (its `reservesWindowControls` contract
  changes caller, not shape — see FR-021).
- **Q (issue://393 Open Questions / `docs/PLAN.md` Decisions-still-needed item 6, re-asked by
  Stuart in the same session): strict empty states only, a labelled sample-data switch, or static
  concept views for the FDB placeholders?** -> **A: the labelled sample-data switch.** Settled
  verbatim in `docs/design/patterns.md` ("Placeholders and 'coming soon'"): a Settings switch
  **"Show sample data,"** off by default; when on, every sample element carries a visible
  **"Sample data"** label; sample data is never mixed with real data; the switch and its sample
  content are removed outright once the real integrations (#391, #392) land; with the switch off,
  the panes show the honest empty state (icon, one line, next action) and nothing else.
- **Q (implicit in issue://393/#538): is the hosted Subagents panel the future global Agents
  panel (#490), or does it keep today's per-Session behaviour?** -> **A: it keeps today's
  per-Session behaviour, unchanged.** The global, cross-Session Agents panel is `docs/PLAN.md` row
  C2c (issue://490), which explicitly needs this spec (C1) as a prerequisite and is not part of
  it. This spec only moves the *presentation* of the existing per-Session Subagents panel (spec
  004 FR-017 to FR-020) into the shared shell as its first hosted panel; none of its session
  binding, streaming, or reconciliation logic changes.

### Carved out, not blocking this spec (per the constitution's Incremental Enhancement rule)

Four items `issue://538` itself and `docs/design/accessibility.md` list as still open are deferred
to a future increment rather than resolved here; see
[future/open-questions.md](future/open-questions.md) for each one's current state and why it does
not block User Stories 1-6 below: rail-icon counts while the pane is collapsed, persistence of
open panels/order/width across a restart, a keyboard shortcut to toggle the pane open/closed, and
whether rail icons also need a global cross-Session Agents count once #490 exists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open and switch between right-hand panels through one shell (Priority: P1)

A developer glances at the narrow icon rail fixed to the window's right edge, clicks a panel's
icon, and the collapsible pane opens showing that panel. Clicking a second panel's icon opens it
alongside the first; because two panels are now open, a tab bar appears so the developer can
switch between them without losing either one's place, and each tab carries its own close button.

**Why this priority**: this is the shell itself — without it, #393's placeholder panes and #394's
tabs have nowhere to live, and the existing Subagents panel has no shared home to move into.

**Independent Test**: with the pane collapsed, click the Subagents rail icon, then the FDB
Knowledge rail icon; confirm a two-tab bar appears (Subagents, FDB Knowledge), each tab shows its
own icon, name, and live count where it has one; click each tab and confirm its panel's content
shows; close the FDB Knowledge tab and confirm the header reverts to a single title row (no tab
strip) showing Subagents.

**Acceptance Scenarios**:

1. **Given** the pane is collapsed, **When** the developer clicks a rail icon for a panel that is
   not open, **Then** the pane opens at its last working width (or the 320px default on first
   launch) and shows that panel, active.
2. **Given** exactly one panel is open, **When** the developer clicks a different panel's rail
   icon, **Then** both panels are open, shown as a tab bar (ARIA tabs pattern), the newly opened
   one active and focused; the active tab is marked by more than colour.
3. **Given** two or more panels are open, **When** the developer closes every tab but one, **Then**
   the header reverts to that panel's own title row and Close button — no tab strip for a single
   open panel.
4. **Given** two or more open panels' tab bar has focus, **When** the developer presses the arrow
   keys, **Then** focus moves between tabs; **When** they press Delete on a focused tab, **Then**
   that panel closes, matching its own close-button behaviour.
5. **Given** a panel is open and its own rail icon is activated again, **When** the developer
   clicks or presses it, **Then** that panel closes exactly as its tab/title-row Close button
   would.
6. **Given** the pane is open (one panel's title row, or a tab bar), **When** the developer looks
   at the top-right corner, **Then** the panel header's own trailing spacer reserves the width the
   window's minimise/maximise/close buttons occupy, and the chat header immediately to its left no
   longer reserves that same space (issue://394; today only `ChatHeader` reserves it
   unconditionally, which is the bug issue://394 reports).

---

### User Story 2 - See every available panel when none is open (Priority: P1)

With the pane open but no panel currently open — reached by closing the last open panel — a
developer sees a centred list of every available panel instead of a blank pane, so the pane is
never an empty box with nothing to do.

**Why this priority**: this is the behaviour issue://538 rule 5 and the launcher-not-close rule
from issue://394's amendment both depend on; without it, closing the last panel would either close
the whole pane (the old, superseded rule) or leave a genuinely empty box.

**Independent Test**: with two panels open, close both (last one via its title-row Close button);
confirm the pane stays open and shows a vertically-and-horizontally centred list of the three
available panels (Subagents, FDB Knowledge, Agent Builder), each row a button with its icon, name,
and live count where it has one; click or press Enter on a row and confirm that panel opens.

**Acceptance Scenarios**:

1. **Given** the pane is open with one panel showing, **When** the developer closes that panel's
   last tab or title-row Close button, **Then** the pane stays open and shows the launcher list —
   it never collapses.
2. **Given** the launcher list is showing, **When** the developer activates a row with the
   pointer, Enter, or Space, **Then** that panel opens and becomes active.
3. **Given** the launcher list is showing, **When** the developer looks at a row for a panel with
   a meaningful live count, **Then** that count shows with its own icon and colour, never colour
   alone (issue://538 rule 6; FR-012/FR-013 below); **Given** a panel has no count or its count is
   not currently meaningful, **Then** that row shows no number at all, not a zero.

---

### User Story 3 - Keep the Subagents panel working exactly as it does today (Priority: P1)

A developer activating the Subagents readout chip above the message box — the existing entry
point, unchanged — sees the same Subagents panel they do on `main` today: the current turn's
subagents, a selected one's live stream, and its own collapse behaviour, now simply presented
inside the shared shell as its first hosted panel instead of a standalone side region.

**Why this priority**: the Subagents panel is a shipped, gate-passed feature (spec 004 FR-017 to
FR-020); this story is the regression guard that lets the shell exist without breaking it, and is
equally demo-critical to the new shell itself.

**Independent Test**: with a turn that has started two subagents, one finished and one still
running, activate the Subagents chip; confirm the shared pane opens on the Subagents panel exactly
as before (list, state icons, live stream on selection); close it from the shell's header and
confirm the chat pane's size and scroll position are completely unchanged, matching spec 004's own
User Story 3 Acceptance Scenario 4 verbatim.

**Acceptance Scenarios**:

1. **Given** a turn has started one or more subagents, **When** the developer activates the
   Subagents chip, **Then** the shared pane opens (if collapsed) on the Subagents panel, bound to
   the chip's own Session, exactly as `openPanel(sessionId)` does today.
2. **Given** the Subagents panel is the shell's only open panel, **When** the developer closes it
   (chip-opened chat still running), **Then** closing behaves exactly as today: the chat pane's
   size and scroll position are unchanged; **When** the developer instead drags the pane's own
   resize handle fully shut, **Then** the pane collapses (FR-003) but the panel stays open and
   bound to its Session, its live stream paused, and dragging the handle back open restores it
   live -- collapsing is a separate action from closing (data-model.md's collapsed-pane
   invariant), not spec 004's old single-flag behaviour.
3. **Given** the Subagents panel is open and selected on a subagent's live stream, **When** that
   subagent finishes, **Then** the panel updates in place without closing itself (spec 004 FR-020,
   unchanged).
4. **Given** the Subagents panel is open for Session A, **When** a new turn starts in Session A
   with no subagents, **Then** the panel's own per-turn reset (`resetForNewTurn`) still closes it
   exactly as it does on `main` today (spec 004 remediation note, `readout-store.ts`).
5. **Given** the developer opens the Subagents panel via its own rail icon instead of the chip,
   **Then** it binds to the currently focused chat pane's Session (the same fallback FR-008
   already uses for an ambiguous click), matching the existing drag-to-open fallback rule in
   `App.tsx`'s `onResize` handler.

---

### User Story 4 - See an honest, designed placeholder for FDB Knowledge and Agent Builder (Priority: P2)

A developer opens the FDB Knowledge or Agent Builder panel from the rail (or the launcher) and, by
default, sees a designed, on-brand empty state — an icon, one line saying the feature is not built
yet, and the single next action available (for example, waiting on the integration) — never a
"Coming soon" label stapled onto a disabled control.

**Why this priority**: both panels are called out as demo-critical ("what is really going to sell
this prototype to my bosses"), but they must not read as broken or scaffolded; this story is the
default state every developer sees before anyone turns sample data on.

**Independent Test**: with the Settings switch "Show sample data" off (its default), open FDB
Knowledge from the rail; confirm an icon, one line, and a next action show and nothing else —
no disabled search box, no fabricated items. Repeat for Agent Builder.

**Acceptance Scenarios**:

1. **Given** "Show sample data" is off, **When** the developer opens the FDB Knowledge panel,
   **Then** it shows exactly an icon, one line stating the feature is not yet available, and the
   single next action — nothing else, and no network call is ever made from this pane.
2. **Given** "Show sample data" is off, **When** the developer opens the Agent Builder panel,
   **Then** the same three-part empty state shows, naming Agent Builder.
3. **Given** either placeholder is open, **When** the developer looks at its content, **Then**
   nothing reads "Coming soon" and no control is shown disabled-with-a-reason — both patterns are
   the ones `docs/design/patterns.md` forbids outside the sample-data exception below.

---

### User Story 5 - Show labelled sample data in the placeholders on demand (Priority: P2)

A developer who wants to show the FDB panels' intent to a decision-maker turns on a Settings
switch, "Show sample data," and the FDB Knowledge and Agent Builder panels now show believable,
clearly labelled example content instead of the bare empty state — never mixed with anything real,
because nothing real exists behind either panel yet.

**Why this priority**: directly serves the stated demo goal, but only matters once the honest
default (User Story 4) exists and is never silently skipped.

**Independent Test**: open Settings, turn on "Show sample data"; open FDB Knowledge and confirm
its sample search/ask/agent-tools content shows, each element carrying a visible "Sample data"
label; open Agent Builder and confirm its sample cloud-agent content shows the same label; turn
the switch back off and confirm both panels return to the plain empty state from User Story 4;
restart Refract and confirm the switch's choice held.

**Acceptance Scenarios**:

1. **Given** "Show sample data" is off, **When** the developer turns it on, **Then** every open or
   subsequently opened FDB Knowledge/Agent Builder panel shows its sample content instead of the
   empty state, with no restart needed.
2. **Given** "Show sample data" is on, **When** the developer looks at any sample element in
   either panel, **Then** it carries a visible "Sample data" label; no element in either panel is
   ever shown without that label while the switch is on.
3. **Given** "Show sample data" is on, **When** the developer turns it off, **Then** both panels
   immediately return to the honest empty state (User Story 4) for every Session, with no
   restart needed.
4. **Given** the switch was changed, **When** the developer restarts Refract, **Then** the
   Settings screen and both panels reflect the same choice (same persistence pattern as
   `watermarkEnabled`, spec 012).
5. **Given** "Show sample data" is on, **When** the real FDB Knowledge or Agent Builder
   integration (#391/#392) ships, **Then** the switch and all sample content are removed outright
   — not merely hidden — as part of that later work (out of scope for this spec; recorded so the
   switch is never mistaken for a permanent feature).

---

### User Story 6 - Resize the pane without a pointer drag (Priority: P3)

A developer who cannot perform a pointer-drag gesture still needs to change the pane's width.
Alongside the existing drag handle, the pane offers a single-pointer, keyboard-reachable
alternative.

**Why this priority**: required for WCAG 2.2 AA (2.5.7, Dragging movements) per
`docs/design/accessibility.md`, but the shell is fully usable at its default width without it, so
it is the lowest-priority story of the six.

**Independent Test**: with the pane open, reach its width control by keyboard alone (Tab, then
Enter/Space/arrow keys, with no pointer drag at any point); confirm the pane's width changes to
each offered preset and that the drag handle still works unchanged alongside it.

**Acceptance Scenarios**:

1. **Given** the pane is open, **When** the developer reaches its header by keyboard, **Then** a
   width-preset control (not a drag) is reachable that sets the pane to at least its default
   (320px), minimum (240px), and maximum (520px) widths.
2. **Given** the developer sets a width preset, **When** they later drag the existing resize
   handle, **Then** both controls operate on the same underlying width with no desync (the same
   guard `App.tsx`'s existing `onResize` handler already provides for collapse/open desync).

---

### Edge Cases

- **Narrow window (380px minimum, per the live-verification requirement).** The rail stays a fixed
  narrow strip; the pane, when open, still respects its 240px minimum — at a 380px window this
  leaves well under 240px for chat, so the pane's own `ResizablePanel` floor interacts with the
  chat pane's existing 360px `minSize` the same way it does on `main` today (the chat pane already
  wins the squeeze; this spec changes no minimums).
- **Wide window (1280px).** The shell's layout (rail, pane, tabs or launcher) must not grow
  unbounded; the pane keeps its existing 520px maximum.
- **Reduced motion.** Any transition the shell adds (pane expand/collapse, tab switch) respects
  `prefers-reduced-motion: reduce` the same way every other animated affordance in Refract already
  does (`docs/design/foundations-motion.md`).
- **Closing a tab that is not the active one.** Only that panel closes; the active tab, and its
  shown content, do not change.
- **A panel's count changes while its tab is not active.** The tab still shows the live count
  (issue://538: "tabs also show the live counts" — a panel need not be active for its count to be
  current).
- **The focused chat pane's Session changes while the Subagents panel is open, bound to the
  previous Session.** Unchanged from today: the panel stays bound to the Session that opened it
  until closed and reopened (User Story 3's unchanged-behaviour guarantee); it does not silently
  retarget.
- **The window is resized so narrow the rail itself would clip.** Out of scope: the rail's own
  minimum width is a fixed token-based value, not touched by this spec; existing window minimum
  size constraints (`src/main`) are unchanged.
- **A developer toggles "Show sample data" while a placeholder panel's tab is the active one.**
  The open tab re-renders in place (User Story 5, Acceptance Scenario 1) — it does not close or
  lose its place in the tab order.

## Requirements *(mandatory)*

### Functional Requirements

**Shell: rail, pane, ownership**

- **FR-001**: The window MUST show one permanent icon rail at its right edge, with exactly one
  button per available panel (Subagents, FDB Knowledge, Agent Builder, in that order), visible
  whether the pane is open or collapsed.
- **FR-002**: Exactly one component (the right-pane store, data-model.md) MUST own the pane's
  open/collapsed state, its width, which panels are open, their order, and which one is active.
  No individual panel (including the migrated Subagents panel) MUST manage its own open flag.
- **FR-003**: The pane MUST be collapsible to nothing and restorable to the same open panels, tab
  order, and width it had before collapsing, within a single session (persistence across a
  restart is carved out — see future/open-questions.md).
- **FR-004**: The pane MUST default to collapsed on first launch (issue://393), matching today's
  Subagents panel default.
- **FR-005**: Activating an available panel's rail button MUST open the pane if collapsed and open
  (or focus, if already open) that panel.
- **FR-006**: Activating the rail button of a panel that is currently open and active MUST close
  that panel, identical to using its own tab or title-row Close button.

**Tabs and the launcher**

- **FR-007**: With exactly one panel open, the pane header MUST show that panel's title and a
  Close button — no tab strip (issue://538 rule, supersedes any earlier always-tabs design).
- **FR-008**: With two or more panels open, the pane header MUST show a tab bar following the ARIA
  tabs pattern: arrow keys move between tabs, Delete closes the focused tab, the active tab is
  marked by more than colour alone, and each tab has its own close button.
- **FR-009**: Closing a panel MUST close only that panel. Closing the last open panel MUST leave
  the pane open and show the launcher list (User Story 2) — it MUST NOT collapse the pane
  (supersedes issue://394's original "closing the last tab closes the panel").
- **FR-010**: With the pane open and no panel open, the shell MUST show a list of every available
  panel, centred both vertically and horizontally in the pane, each row a button with that panel's
  icon, name, and (FR-012) its live count where it has one; activating a row (pointer, Enter, or
  Space) MUST open that panel.
- **FR-011**: The pane header (tab bar or single title row) MUST reserve the window-controls
  corner — the same `calc(100vw - env(titlebar-area-width, 100vw))` trailing spacer `ChatHeader`
  uses today — whenever the pane is open; the right-most `ChatPane`'s own `reservesWindowControls`
  prop MUST be `false` whenever the pane is open, so the corner is reserved exactly once at a
  time, never by both headers and never by neither (fixes issue://394's reported bug).

**Counts**

- **FR-012**: A panel's live count, where it has one, MUST show on its rail-adjacent tab and on its
  launcher row, with an icon and a colour that is never the only signal (text or `sr-only` content
  pairs every colour, matching `docs/design/accessibility.md` 1.4.1). A panel with no meaningful
  count (none configured, or a configured count currently at a value the panel defines as "not
  meaningful") MUST show no number at all, never a bare zero.
- **FR-013**: The Subagents panel's count MUST be the number of subagents running for the Session
  it is bound to, shown with an agents icon in the existing running-state colour
  (`text-state-working`) — distinct from spec 004's own chip wording (which also reports
  finished/exited/failed); this is the simpler "number running" count issue://538 itself defines.
  The FDB Knowledge and Agent Builder panels have no live count in this spec (neither issue defines
  one for them).
- **FR-014**: The count model (data-model.md `PanelCount`) MUST support a future git-changes shape
  (green `+additions`, red `−deletions`, issue://538) even though no panel in this spec populates
  it, so a later panel (`docs/PLAN.md` row C5, issue://464) can plug into the same tab/launcher
  rendering without a second count representation being invented.

**Subagents panel migration (spec 004 FR-017 to FR-020, unchanged behaviour)**

- **FR-015**: The Subagents panel's existing behaviour (list, state icons, live stream on
  selection, close leaves the chat pane's size and scroll unchanged, a subagent finishing while
  selected updates in place, the per-turn reset closing it) MUST be preserved exactly; this spec
  changes only where its open/closed state and header controls live (the shared shell), never its
  session binding, data, or reconciliation logic (`subagent-store.ts`'s own actions are reused,
  not rewritten).
- **FR-016**: The Subagents readout chip (spec 004, `ReadoutChips.tsx`) MUST continue to open the
  Subagents panel exactly as today, now by calling through the shared shell (open the pane, open
  and activate the `subagents` panel, bound to the chip's own Session) instead of toggling a
  Subagents-only boolean.
- **FR-017**: Dragging the pane's resize handle directly to zero or open MUST keep the shell's own
  state synchronised with the panel's real rendered size, the same guard `App.tsx`'s existing
  `onResize` handler already provides, generalised from the Subagents-only case to the shared
  shell (desync between a dragged-shut pane and an `open: true` store, or the reverse, must not
  recur for any hosted panel).

**FDB placeholder panes (issue://393)**

- **FR-018**: With `Settings.showSampleData` off (the default), the FDB Knowledge panel and the
  Agent Builder panel MUST each show exactly the empty-state shape (one icon, one line, one next
  action) and make no network call and store no state.
- **FR-019**: Neither placeholder MUST ever show a disabled control with a "Coming soon" label or
  reason attached; an unbuilt feature is hidden entirely, except for the sample-data exception
  below (`docs/design/patterns.md`).
- **FR-020**: Settings MUST offer a switch, "Show sample data," off by default, that is the only
  way either placeholder's sample content ever shows.
- **FR-021**: With the switch on, every sample element in either panel MUST carry a visible
  "Sample data" label, and sample content MUST never be shown alongside real content (there is no
  real content behind either panel yet, so in this spec "never mixed" means the switch's two
  states are mutually exclusive per panel, not a runtime merge rule).
- **FR-022**: Turning the switch on or off MUST take effect immediately in any open placeholder
  panel, without reopening it or restarting Refract, and MUST survive a restart (same persistence
  pattern as `Settings.watermarkEnabled`).

**Accessibility**

- **FR-023**: Every rail button MUST have a name (not icon-alone) reachable as an accessible name,
  and MUST expose `aria-pressed` reflecting whether its panel is currently open.
- **FR-024**: Closing the shell's only open panel, or the pane itself, MUST return focus to the
  rail button that opened it — mirroring the existing Subagents panel's own `restoreFocus` rule
  (`subagent-store.ts`) generalised to every hosted panel.
- **FR-025**: The pane MUST offer a non-drag, single-pointer, keyboard-reachable alternative to
  resizing it by dragging the handle (WCAG 2.5.7; User Story 6), since issue://538 itself does not
  yet specify one and `docs/design/accessibility.md` records this as open until a spec supplies
  it.
- **FR-026**: Every icon-only control the shell adds (rail buttons, tab close buttons, the
  launcher's row buttons where icon-only) MUST carry the full icon-only bundle from
  `docs/design/components.md`/`foundations-icons.md`: a `Tooltip` matching its `aria-label`, a
  `Kbd` shortcut inside the tooltip when one exists, Esc-dismissible and hoverable per WCAG 1.4.13,
  a keyboard focus-visible reveal, and a 24px minimum target.

### Key Entities

- **Right pane state** (data-model.md `RightPaneState`): the pane's `open`/collapsed boolean and
  its current width in pixels — the one place this state lives, per FR-002.
- **Hosted panel registry entry** (data-model.md `HostedPanelDescriptor`): a static, build-time
  list of the available panels (id, display name, icon, whether it carries a count, and which
  component renders it) — not the panels' own runtime open/closed state, which lives in Open
  panels state below.
- **Open panels state** (data-model.md `OpenPanelsState`): the ordered list of currently open panel
  ids and which one is active — drives whether the header shows a title row, a tab bar, or (empty)
  the launcher.
- **Panel count** (data-model.md `PanelCount`): either a single running-style count (icon, colour,
  number) or a future additions/deletions pair (FR-014); `null` means "no meaningful count," never
  rendered as zero.
- **Settings.showSampleData**: the one new persisted boolean (FR-020 to FR-022), following
  `Settings.watermarkEnabled`'s exact shape and setter pattern (spec 012).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can open any of the three available panels from the rail in one click
  (or one Enter/Space press after Tab) from a collapsed pane.
- **SC-002**: Opening a second panel while one is already open always produces a tab bar within the
  same render; opening a third never produces a second row or a different pattern — the tab bar
  scales to however many panels this spec and its successors register.
- **SC-003**: Closing the last open panel never collapses the pane and never leaves it visually
  blank; the launcher list shows every time, in every one of the acceptance scenarios above.
- **SC-004**: Every acceptance scenario for the Subagents panel (User Story 3) passes with the
  exact same visible behaviour as `main` today — this is a specified regression bar, not a vague
  "no regressions" note.
- **SC-005**: With "Show sample data" off, zero network calls originate from either FDB panel, in
  every Session, every time either is opened.
- **SC-006**: With "Show sample data" on, 100% of sample elements in both panels carry the visible
  "Sample data" label; zero elements show unlabelled sample content.
- **SC-007**: The shell renders correctly (rail visible, pane usable, no horizontal scrollbar, no
  overlap with the window-controls corner) at both a 380px and a 1280px window width.
- **SC-008**: Zero drag-only interactions remain unreachable by keyboard: the pane's resize handle
  has a working non-drag alternative (User Story 6) in addition to, not instead of, the drag
  gesture.

## Assumptions

- The hosted Subagents panel stays per-Session, exactly as spec 004 built it; the future global,
  cross-Session Agents panel (issue://490, `docs/PLAN.md` row C2c) is out of scope and explicitly
  depends on this spec landing first.
- Persistence of which panels are open, their order, and the pane's width across an app restart is
  not built in this spec (carved out, future/open-questions.md); every launch starts with the
  pane collapsed, matching today's Subagents-only default.
- A keyboard shortcut to toggle the pane open/closed is not built in this spec (carved out,
  future/open-questions.md); the rail buttons and Tab-reachable controls above already make every
  panel keyboard-reachable without one.
- Whether rail icons carry their panel's live count while the pane itself is collapsed is not
  decided (carved out, future/open-questions.md); this spec shows counts only on tabs and the
  launcher, both only visible while the pane is open.
- `docs/design/components.md`, `patterns.md`, `foundations-icons.md`, and `accessibility.md` are
  cited from PR #580 (branch `docs/design-system-474`) by content, since that PR is not yet merged
  to `main`; this spec's implementation MUST re-read those files from wherever they land (`main`
  once merged, or the design branch if this spec's own implementation branch stacks on it) rather
  than trust a stale quote if either page changes again before implementation starts.
- The exact lucide-react icon chosen for each rail button (Subagents, FDB Knowledge, Agent
  Builder) is an implementation-level choice, not a Stuart decision; plan.md records a reasoned
  starting choice, open to review.

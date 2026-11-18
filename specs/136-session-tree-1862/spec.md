# Feature Specification: Session list tree for nested Sessions

**Feature Branch**: `feat/session-tree`
**Created**: 2026-11-18
**Status**: Clarified
**Input**: GitHub issue #1862 (P0 Agent Sessions slice 6 of 6, child of #1304, `design`); builds on spec 131 (create and nest, #1859, ADR 0009) and spec 134 (archive and the cascade, #1860). Route: specify (grill done with Stuart on 2026-11-18), then the `ui-architect-v3` review, whose findings are folded in (see UX review).

## Clarifications

### Session 2026-11-18

- Q: Is any new data needed? -> A: Decided (Stuart, 2026-11-18): the data already exists. `parentSessionId` is on every Session summary and Rust already has `include_children` on archive (`src-tauri/src/agent_tools/sessions_end_tools.rs`). The slice is UI plus only the plumbing the list needs (FR-014, FR-015).
- Q: Expanded or collapsed by default, and is it remembered? -> A: Decided (Stuart, 2026-11-18): parents are expanded by default and each parent's collapsed state persists across restarts.
- Q: What does a collapsed parent show? -> A: Decided (Stuart, 2026-11-18): its child count, plus a text roll-up when a child needs attention (for example "1 child waiting for approval").
- Q: What happens when the developer archives a parent that has children? -> A: Decided (Stuart, 2026-11-18): a confirm dialog asks "Archive 'X' and its N child Sessions?" with **Archive all** (primary), **Archive parent only** and **Cancel**. Running children are named in the dialog. A child left unarchived moves to the top level and keeps a "from <parent> (archived)" line.
- Q: Which accessibility pattern, and which components? -> A: Decided (Stuart, 2026-11-18): the WCAG 2.1 AA tree pattern from the issue; `ui-architect-v3` takes part in the design; the UI is built from shared components in `src/renderer/components/`; verify live with screenshots at default and narrow widths. Amended (Main, 2026-11-18): the prototyping "no new tests" phase is over (AGENTS.md Testing, epic #1918), so the change also carries co-located unit tests that use the shared test utilities (FR-018).
- Q: How is each parent's collapsed state stored (choice A)? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): extend the existing `SessionListCollapse` value with `collapsedParentIds: string[]` rather than adding a second setting. It reuses the one write path (`setSessionListCollapse`), the debounce, the quit flush and the Rust sanitiser; a list of collapsed ids keeps "expanded by default" for every new parent.
- Q: How does the renderer archive with children (choice B)? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): `sessions.archive` takes an optional second argument `includeChildren`, and the Rust handler runs the same cascade the `archive_session` tool runs. The renderer never loops single archive calls, so one call gives one set, one list-changed event and one failure report.
- Q: What does N count in the dialog? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): the live descendants at every depth, because that is the set **Archive all** archives (archived descendants are skipped, as in spec 134). The parent row's child count is direct live children only.
- Q: Does a collapsed parent hide a child that needs attention? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): it shows the roll-up text and the existing attention marker on the parent; the group's own marker already shows a waiting Session when the Project group is closed. The row never expands itself.
- Q: Does a new child expand its parent? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): no. A new child under a collapsed parent raises the child count and is announced (FR-012); nothing moves under the developer's pointer.
- Q: What do Collapse all groups and Expand all groups do to parents? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): nothing. They keep governing Project groups and Archived only (#735), so a parent's state is always the developer's own choice.
- Q: How do search and the Show hidden filter meet the tree? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): the tree is built from the Sessions the filter lets through. While a query is active every parent starts expanded and a toggle writes only an ephemeral override that is dropped when the query clears, as for Project groups (#559); the saved state is untouched. A match whose parent is filtered out shows at the top level with its "from <parent>" line.
- Q: Does nesting cross Projects? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): nesting applies inside one Project group. A child whose parent is in another Project, or is not in the shown set, is a top-level row with its "from <parent>" line.
- Q: Does the Archived group nest? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): no. It stays the flat cross-Project list (#527); an archived child shows its existing second line (the Project name). The link is kept in the data (spec 134), and restore puts the child back under a live parent.
- Q: Is the dialog's initial focus on the primary action? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): initial focus goes to **Cancel**, the least destructive choice, as the Delete dialog does. The UX review kept it (the shared alert dialog already focuses Cancel).
- Q: Do Home's Tidy up and other bulk archives ask? -> A: Decided (Skippy, delegated by Stuart 2026-11-18): the dialog guards the single-Session archive paths (the list row menus, the Manage sessions table row and the chat header, FR-010). Tidy up (`features/home/TidyUpSection.tsx:85`) archives a developer-picked set in one pass and keeps its own review step, so it archives each picked Session on its own (`includeChildren` false) and a live child it leaves behind becomes a top-level row with its "from <parent> (archived)" line.

## Problem

An agent can create Child Sessions (spec 131) and archive subtrees (spec 134), but the Session list still draws every Session as a flat row. The developer cannot see which Sessions an agent spawned, which parent a child belongs to, or that a child is waiting for them inside a pile of rows. Archiving a parent today leaves its children behind with no word about them. This slice draws the tree and asks the one question that matters when a parent is archived.

## User Scenarios & Testing

### User Story 1 - See nested Sessions (Priority: P1)

A developer opens the list and sees each Child Session indented under its parent, with the parent's child count and a "from <parent>" line on each child, all as text.

**Why this priority**: It is the slice's reason to exist.

**Independent Test**: With the fake omp, a Project holds a parent with two live children and a grandchild; the list shows three indent levels, the parent reads "2 children", and each child's third line reads "from <parent name>".

**Acceptance Scenarios**:

1. **Given** a parent with two live children, **When** the list renders, **Then** both rows sit under the parent, indented, in the existing recent-first order, and the parent shows "2 children".
2. **Given** a child at depth 2 with its own child, **When** the list renders, **Then** the grandchild is indented one more level and shows "from <its parent>".
3. **Given** a parent with exactly one live child, **When** the list renders, **Then** the count reads "1 child".
4. **Given** a Session with no children, **When** the list renders, **Then** its row is unchanged from today.

### User Story 2 - Collapse and expand a parent (Priority: P1)

A developer collapses a parent to hide its children and expands it again, by mouse or keyboard. The choice survives a restart.

**Independent Test**: Collapse a parent, restart the app, confirm it is still collapsed; expand another and confirm nothing else changes.

**Acceptance Scenarios**:

1. **Given** a new parent, **When** it first appears, **Then** it is expanded.
2. **Given** an expanded parent, **When** the developer activates its toggle, **Then** its descendants leave the list and the toggle reports "collapsed".
3. **Given** a collapsed parent, **When** the app restarts, **Then** it is still collapsed.
4. **Given** a collapsed parent that is deleted or loses its last child, **When** the list reloads, **Then** its id is dropped from the saved state.

### User Story 3 - Know a collapsed parent needs me (Priority: P1)

A collapsed parent keeps the developer informed. Its second line states what needs them first and the child count after it, such as "1 needs you, 2 children".

**Independent Test**: Collapse a parent whose child raises an approval; the parent's line reads "1 needs you, 2 children" and a screen reader reads the same.

**Acceptance Scenarios**:

1. **Given** a collapsed parent with a descendant whose status is `needs-you`, **When** the list renders, **Then** the roll-up counts those descendants in text, and the parent's status icon is not replaced.
2. **Given** an expanded parent, **When** a child needs the developer, **Then** the roll-up is not shown (the child row says so itself).
3. **Given** a collapsed parent with no attention state, **When** the list renders, **Then** only the child count shows.

### User Story 4 - Archive a parent and decide about its children (Priority: P1)

Archiving a parent with live children opens a dialog that asks about them. Without live children it archives at once, as today.

**Independent Test**: Archive a parent with one running child; the dialog names the running child; **Archive all** archives both; **Archive parent only** archives the parent and leaves the child at the top level with "from <parent> (archived)".

**Acceptance Scenarios**:

1. **Given** a parent with N live descendants, **When** the developer picks Archive, **Then** the dialog asks "Archive 'X' and its N child Sessions?" (singular "its 1 child Session") and offers **Archive all**, **Archive parent only** and **Cancel**.
2. **Given** running descendants, **When** the dialog opens, **Then** it lists their names under "Running now:" and says **Archive all** stops their agents and **Archive parent only** leaves them running.
3. **Given** **Archive all**, **When** it completes, **Then** the parent and every live descendant are archived in one call and their agents are stopped.
4. **Given** **Archive parent only**, **When** it completes, **Then** only the parent is archived and each live child moves to the top level of its Project group with "from <parent> (archived)".
5. **Given** **Cancel** or Escape, **When** the dialog closes, **Then** nothing changes and focus returns to the control that opened it.
6. **Given** a parent whose descendants are all archived, **When** the developer picks Archive, **Then** no dialog opens.

### User Story 5 - A child never loses its context (Priority: P2)

A child whose parent is archived, hidden, in another Project or filtered out stays visible at the top level and still says where it came from.

**Acceptance Scenarios**:

1. **Given** a live child of an archived parent, **When** the list renders, **Then** it is a top-level row with "from <parent> (archived)".
2. **Given** a live child of a hidden parent while Show hidden is off, **When** the list renders, **Then** it is a top-level row with "from <parent> (hidden)".
3. **Given** a filter that matches a child but not its parent, **When** the list renders, **Then** the child shows at the top level with "from <parent>".

### User Story 6 - Keyboard and screen reader (Priority: P1)

A keyboard or screen-reader user can move through the tree, expand and collapse, and hear each row's place in it.

**Acceptance Scenarios**:

1. **Given** focus on a parent's row, **When** the user presses Right Arrow on a collapsed parent, **Then** it expands and focus stays; on an expanded parent Right Arrow moves focus to its first child.
2. **Given** focus on a child, **When** the user presses Left Arrow, **Then** focus moves to its parent; on an expanded parent Left Arrow collapses it.
3. **Given** a screen reader on a row, **When** it announces, **Then** it reports the level, position in set, the expanded or collapsed state of a parent, the child count and the "from" line as text.
4. **Given** focus on a row in a group that renders a tree, **When** the user presses Down or Up Arrow, **Then** focus moves to the next or previous visible row's open button; Home and End move to the first and last visible row.

### User Story 7 - An agent-created Session is announced, not forced (Priority: P2)

When an agent creates a Child Session the developer hears about it once and keeps their place.

**Acceptance Scenarios**:

1. **Given** a Session appears whose `parentSessionId` is set, **When** the list updates after startup, **Then** one polite announcement says "<child> created under <parent>" (with "(collapsed)" when its parent is collapsed) and focus does not move.
2. **Given** the first load or a refresh that adds no new id, **When** the list renders, **Then** nothing is announced.

### Edge Cases

- **Cycle or missing parent**: a child whose parent id is unknown, itself, or part of a cycle renders as a top-level row; the tree builder never loops.
- **Depth beyond 3**: the data cannot produce it (Rust limit), but the indent is clamped at four levels so a bad file never overflows the row.
- **Deleting a parent**: Rust re-roots live children (ADR 0009), so they leave the tree on the next list refresh and carry no "from" line; archived children keep their link.
- **Restore of a child**: it returns under its parent when the parent is live and in the same Project; otherwise it appears at the top level with its "from" line. The 4-live-children gate is Rust's and unchanged.
- **A selected row inside a collapsed parent**: the selected Session stays selected; the parent shows the selected state (the group's `containsOpenSession` rule applied to the parent) so the open Session is not lost.
- **Rename of a parent**: the "from" lines read the current name on the next render.
- **Narrow widths**: indent, count and "from" line truncate with an ellipsis and never hide the row's actions; the full text stays in the accessible name and the details card.
- **Dialog while the list changes**: a descendant added or archived while the dialog is open is applied by the Rust cascade at call time; the result names what was archived.
- **Partial failure**: a cascade that stops midway reports which Sessions were archived and which failed through the existing error notice.

## Requirements

### Functional Requirements

- **FR-001**: Inside a Project group, a Session whose `parentSessionId` names another listed live Session of the same Project renders under it, indented by level, in the existing recent-first order among its siblings. A Session with no listed parent renders at the top level.
- **FR-002**: A parent row shows its direct live child count as text ("1 child", "2 children") in a segment at the start of its second line, before the branch name or activity line it shows today. The segment does not shrink or wrap and the existing slot after it truncates. The count is text, never colour, indent or icon alone.
- **FR-003**: A row whose Session has a `parentSessionId` shows "from <parent name>" as text on a third line of its own, below its branch line; a row with no parent link keeps today's two lines. "from " and any "(archived)" or "(hidden)" suffix never shrink and the parent's name carries the ellipsis. When the parent is archived or hidden the line reads "from <parent name> (archived)" or "from <parent name> (hidden)". The count and the "from" line are in the row's accessible description (`SessionDetailsCard`'s sr-only description) and the details card, not in its accessible name (FR-008).
- **FR-004**: Each parent has a disclosure toggle: a shared `IconButton` (`size="icon-xs"`, 24 by 24 CSS pixels) placed absolutely in the row's existing 24 pixel left gutter at the row's indent, so the status icon does not move. It is always visible (not the hover-only header action class), shows a chevron rotated by `aria-expanded`, has a visible focus ring, is first in DOM order (Tab order: toggle, open, resume, agents, menu), and is named "Collapse <name>" or "Expand <name>". `aria-expanded` is on the tree item; `aria-controls` is set only while the group is rendered. Parents are expanded by default.
- **FR-005**: A collapsed parent's descendants are not rendered (so they leave the tab order and the accessibility tree). A collapsed parent with a `needs-you` descendant (`isNeedsYouSession`, `sessionDisplay.tsx:28`) shows the roll-up first, then the count: "1 needs you, 2 children", "2 need you, 3 children". While the roll-up shows, the branch or activity text is left off line 2 (it stays in the details card). The parent row takes the open-Session state when a descendant is the selected Session.
- **FR-006**: The collapsed set of parent ids persists in `Settings.sessionListCollapse.collapsedParentIds`, is written through `setSessionListCollapse` with the existing debounce and quit flush, is restored before the list first paints (the `restored` rule), and is pruned of ids that no longer have a live child after each successful list load.
- **FR-007**: While a query is active every parent is expanded and a toggle changes only the ephemeral search override; the saved set is untouched (#559). Collapse all groups and Expand all groups do not touch parents.
- **FR-008**: The rows use the tree pattern: the group's list is `role="tree"` when it holds at least one parent, and each row's `<li>` is a `role="treeitem"` carrying `aria-level` (the true level, not the clamped indent), `aria-setsize`, `aria-posinset`, `aria-labelledby` pointing at its open button (so its name is the Session name, not its children's text) and, for parents, `aria-expanded`. A parent's children sit in a `<ul role="group">` that is a sibling of the row element inside the `<li>`; the row's hover, group and active-indicator styling sits on that inner row element, so a parent's hover and selected bar do not run down over its children. A collapsed parent adds its roll-up to the open button's accessible name ("<name>, 1 needs you"); level and position are not put in the name. A group with no parents keeps today's list markup. The existing Session row controls (open button, resume, agents and menu buttons) keep their behaviour inside the tree item.
- **FR-009**: In a Project group that renders `role="tree"`: Down and Up Arrow move focus to the next and previous visible item's open button; Home and End move to the first and last visible item; Right Arrow expands a collapsed parent (focus stays) or moves to the first child of an expanded one; Left Arrow collapses an expanded parent, or moves to the parent from a child (including a collapsed nested parent). Left and Right with no applicable target do nothing and are not prevented. The keys act only when the event target is the row's open button or its toggle and no Ctrl, Alt, Meta or Shift is held (Radix menus portal but React events bubble, so a row-level handler would take submenu arrows). The handler sits beside `handleOpenButtonKeyDown`, not in the table layout. Tab order is unchanged (there is no roving tabindex today; `SessionList.tsx:153` rules out arrow roving for the toolbar), so the arrows are additive. Enter and Space on the toggle expand and collapse. A group with no parent keeps today's behaviour (2.1.1, 2.1.2).
- **FR-010**: Archiving a Session that has live descendants opens a confirm dialog built from the shared `ConfirmAlertDialog`, extended with an optional `secondaryLabel` and `onSecondary` (a third action between Cancel and the primary) and no second dialog component. Title: "Archive '<name>' and its N child Sessions?" (singular for 1). Body: "Archive all stops these Sessions' agents. Archive parent only leaves them running. Archived Sessions can be restored." Under "Running now:" it lists the running descendants (a scrolling list, long names break, a branch appended when two names are identical). When N exceeds the parent's direct count it adds "Includes {N minus direct} nested Session(s)." and marks hidden descendants "(hidden)" in the running list; N and the running list come from the unfiltered store list. Actions in DOM order: **Cancel** (ghost, initial focus), **Archive parent only** (outline), **Archive all** (default fill, primary), `size="md"`. While the call runs the dialog stays open with `busy` and `busyLabel="Archiving..."` and both actions inert; on failure it shows the error line and stays open (as `DeleteDialog` does). Escape and Cancel return focus to the opener, including a context-menu opener via `contextMenuOpenerRef`. A Session with no live descendants archives at once, as today. The trigger path covers the row's menus, the Manage sessions table and any other caller of the shared archive action.
- **FR-011**: **Archive all** calls `sessions.archive(id, true)`; **Archive parent only** calls `sessions.archive(id)`. After **Archive parent only** each live child is a top-level row with "from <parent> (archived)" (FR-003). On success the list announcer says politely "Archived <name> and N child Sessions" (all) or "Archived <name>; N child Sessions are now at the top level" (parent only), and focus moves as it does for a single archive today (to the list container when the row was stranded).
- **FR-012**: When a Session with `parentSessionId` appears in a list update after startup, one polite announcement says "<child name> created under <parent name>", adding "collapsed" when the parent is collapsed; it uses the existing list announcer, does not move focus and does not expand the parent. The first load and refreshes that add no new id announce nothing.
- **FR-013**: Information and relationships are never carried by colour or indentation alone (1.3.1, 1.4.1): level, count, state, roll-up and "from" are text or programmatic. Indent is 12 CSS pixels per level, drawn as `--tree-indent: calc((min(level, 4) - 1) * 12px)`, so the visual maximum is 36 pixels and about 116 pixels of the name remain at 320 CSS pixels; the clamp applies to the CSS value only. Text and icons meet 4.5:1 and 3:1 contrast in every theme (1.4.3, 1.4.11), the layout holds at 320 CSS pixels wide and 200 percent zoom without clipped controls (1.4.4, 1.4.10), and only the chevron rotation animates, with `motion-reduce:transition-none` (2.3.3).
- **FR-014**: The settings value gains `collapsedParentIds` end to end: `SessionListCollapse` and `DEFAULT_SESSION_LIST_COLLAPSE` (`src/shared/model.ts`), the store (`session-list-store.ts`), and the Rust `SessionListCollapse`, file parser, setter argument parser and setter (`src-tauri/src/store/settings.rs`, `settings_parse.rs`, `settings_setters.rs`, `src-tauri/src/ipc/settings.rs`) with the same id and byte caps as `collapsedRepositoryIds`. A settings file without the field reads as an empty list; a malformed field reads as an empty list and leaves the other fields as they were. The setter argument requires the field (the renderer is the sole writer).
- **FR-015**: `sessions.archive` accepts an optional second argument `includeChildren` (boolean, default false; any other type is `invalid_argument`). With `true` it archives the Session and every live descendant, deepest first, through one Rust function (`archive_subtree_core`) that the `archive_session` tool's apply step also calls, so the set, the order and the partial-failure report are the same; the set itself comes from one shared pure function. The renderer store's `archive(id, includeChildren?)`, the `window.refract.sessions.archive` type and the tauri bridge pass it through. No new IPC channel.
- **FR-016**: The tree builder, the roll-up and the "from" lookup are pure functions over `SessionSummary[]`, shared by the Project group and the dialog; the tree rows reuse the shared components in `src/renderer/components/` (`IconButton` for the toggle, `ConfirmAlertDialog` for the dialog, extended in place by FR-010) and render the count, roll-up and "from" lines as text in the row's existing second-line parts; no second disclosure, dialog or badge component is added.
- **FR-017**: Code comments follow rule #1322 (a comment says why, never what), and no touched file exceeds 600 lines; `ipc/settings.rs` (571) and `store/settings.rs` (554) are near the cap, so the settings change adds only the lines plan.md budgets and moves code out if it would cross it.
- **FR-018**: New and changed logic carries unit tests co-located with the system under test, using the shared test utilities (AGENTS.md Testing, epic #1918): the tree builder, roll-up, "from" lookup and tree keyboard model as pure functions; the `collapsedParentIds` store actions, restore and prune; the settings parse and round trip in Rust; the `includeChildren` argument at the IPC handler and through the store; the archive-dialog decision (when it opens, what N counts, which call each button makes) and the announcement rule. Each guard's test fails when the guard is removed. plan.md names the test file beside each changed module.

### Key Entities

- **Child Session**, **Own tree**, **Live child**: as in CONTEXT.md and ADR 0009.
- **Parent Session**: the Session a Child Session is linked to; new glossary term.
- **Session tree**: the nested rows a Project group draws from `parentSessionId` links; new glossary term.
- **Roll-up**: the text on a collapsed parent that counts hidden descendants needing the developer.

## UX review

`ui-architect-v3` reviewed this spec and plan against `src/renderer/features/sessions/` on 2026-11-18. It ran as a single read-only pass (its three-specialist fan-out was not available), so each finding below was checked against the code before it was folded in. Twelve findings, all accepted; none contradicts a grill decision.

- High: the list has no arrow-key roving today (`useSessionRowActions.ts:128-133`, `SessionList.tsx:153`), so the spec's earlier "existing roving behaviour" did not exist. Decided (Skippy, delegated by Stuart 2026-11-18): add Up, Down, Home and End inside tree groups only; Tab order stays (FR-009).
- High: a `treeitem` `<li>` that wraps its children breaks the row's `group-has-[aria-expanded]` hover rule, the indicator bar and the item's accessible name. Decided (Skippy, delegated by Stuart 2026-11-18): the `<li>` is named by `aria-labelledby` and the row styling moves to an inner row element (FR-008).
- High: `ConfirmAlertDialog` has one confirm and one Cancel. Decided (Skippy, delegated by Stuart 2026-11-18): extend it with `secondaryLabel` and `onSecondary`; order Cancel, Archive parent only, Archive all; initial focus stays on Cancel (FR-010).
- High: "archiving stops them" is false for **Archive parent only**. Decided (Skippy, delegated by Stuart 2026-11-18): the body states each button's effect; the list label is "Running now:" (FR-010).
- Medium: N counts all depths but the row counts direct children, and hidden or filtered descendants are archived too. Decided (Skippy, delegated by Stuart 2026-11-18): the body adds "Includes ... nested Session(s)" and marks hidden names (FR-010).
- Medium: no indent value was given. Decided (Skippy, delegated by Stuart 2026-11-18): 12 pixels a level, visual cap 36 pixels, true `aria-level` (FR-013).
- Medium: the toggle's placement was open. Decided (Skippy, delegated by Stuart 2026-11-18): an always-visible 24 by 24 icon button in the existing left gutter, first in DOM order (FR-004).
- Medium: four phrasings of the count and roll-up would truncate badly (about 143 pixels of text against about 116). Decided (Skippy, delegated by Stuart 2026-11-18): one grammar, attention first: "1 needs you, 2 children" (FR-002, FR-005).
- Medium: the "from" line is a third line, not the second, and its state suffix must not truncate. Decided (Skippy, delegated by Stuart 2026-11-18): third line; the suffix and "from " never shrink; the count and "from" go in the accessible description (FR-003).
- Medium: a row-level key handler would steal Radix submenu arrows and break the table layout. Decided (Skippy, delegated by Stuart 2026-11-18): act only from the open button or toggle, with no modifier, beside `handleOpenButtonKeyDown` (FR-009).
- Low: the open button's `aria-label` replaces its visible text, so count and "from" are not read unless added on purpose. Decided (Skippy, delegated by Stuart 2026-11-18): roll-up in the name only while collapsed, count and "from" in the description, level and position left to the tree roles (FR-008, FR-003).
- Low: the archive result was silent and the dialog had no busy state. Decided (Skippy, delegated by Stuart 2026-11-18): a busy state, a failure line and a polite result announcement (FR-010, FR-011).

## Success Criteria

- **SC-001**: With the fake omp, a parent with two children and a grandchild renders three levels; the parent reads "2 children"; each child reads "from <parent>".
- **SC-002**: Collapsing a parent and restarting leaves it collapsed; another parent is unaffected.
- **SC-003**: A collapsed parent with a waiting child shows a text roll-up and a screen reader reads it.
- **SC-004**: Archiving a parent with one running child opens the dialog naming it; **Archive all** archives both in one call; **Archive parent only** leaves the child at the top level with "from <parent> (archived)".
- **SC-005**: Right and Left Arrow expand, collapse and move between parent and child; a screen reader reports level, position, expanded state, count and "from" line.
- **SC-006**: An agent-created child is announced once and focus does not move.
- **SC-007**: Screenshots of the nested list at the default and a narrow width (320 CSS pixels) show no clipped text or controls; the checks pass in light and dark themes.
- **SC-008**: `pnpm ci:local` passes and no touched file exceeds 600 lines.
- **SC-009**: The unit tests named in plan.md pass, and the live fake-omp check (SC-001 to SC-007) runs from a clean committed tree with screenshots kept as evidence.

## Assumptions

- Specs 131 and 134 have merged: `parentSessionId` is on every summary, the cascade exists, and delete re-roots live children (ADR 0009).
- The Session list keeps one `SessionRow` for both list and table layouts; only the list layout nests.
- `needs-you` is the one status that rolls up; other attention states keep the group marker rule.
- AGENTS.md Testing (HARD RULE, epic #1918): new and changed logic carries unit tests co-located with the system under test, using the shared test utilities; the live fake-omp screenshot run is added on top, not instead.

## Out of Scope

- Any agent tool or Rust change beyond the two pieces of plumbing in FR-014 and FR-015.
- Depth and child-count limits (enforced in Rust by spec 131).
- Drag and drop to re-parent a Session; a Session-list view of subagents.
- Unarchiving a subtree, and nesting inside the Archived group.
- Restyling the parent preamble in the child's first turn (#2062).

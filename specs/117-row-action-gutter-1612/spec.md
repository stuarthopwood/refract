# Feature Specification: Transcript row action gutter inside the hover surface

**Feature Branch**: `feat/1612-lane`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1612 (grilled 2026-11-03, amended 2026-11-03 by the #1614/#1615 decision). Route: specify.

## Problem
In a chat transcript the expand chevrons sit in two columns. `CollapsedLine` lays an expandable row out as `[trigger][action]` in a `gap-1` flex row, so a row with an action (tool rows: the `…` menu; the subagent chain: the "Show subagents panel" button) has a trigger 28px narrower than a row without one. The chevrons and timings of tool rows end 28px left of thought, note and "Asked user" rows. The action also sits outside the trigger, so the hover fill stops short of it.

## Clarifications

### Session 2026-11-04 (from grill)

Answers come from the issue body's "Grilled 2026-11-03" and "Amended 2026-11-03" blocks and the #1614/#1615 amendment; no questions were put to Stuart.

- Q: Where does the gutter live? -> A: INSIDE every expandable row's hover surface, i.e. inside the `CollapsibleTrigger`, on the right, after the chevron. This overrides the earlier "gutter outside the row" decision (from amendment).
- Q: Where do the actions go? -> A: `ToolRowKebab` (`…`) and `ChainShowPanelButton` are laid over the gutter, positioned inside the `Collapsible` row wrapper, because a button cannot nest inside the trigger button (from amendment).
- Q: Rows without an action? -> A: The gutter is reserved anyway and stays empty, so every chevron lines up (from grill).
- Q: How wide is the gutter? -> A: The width of an `icon-xs` button (24px) plus the trigger's existing `gap-2` (from grill, "the width of an `icon-xs` button plus the gap").
- Q: When does the `…` show? -> A: On hover or focus only, never moving the chevron or the timing (from amendment and grill).
- Q: What does the fill cover? -> A: The hover fill (and any failed-row tint) covers the full row width, gutter included, including while the pointer is over the action (from amendment).
- Q: Non-expandable branch (`children === undefined`)? -> A: Keeps its width; it has no chevron and no gutter (from grill).
- Q: Scope? -> A: Every `CollapsedLine` kind: tool, thought, note, notice, advisory, agent message, subagent, subagent chain, request, skill, and the same rows in subagent chat (from grill and amendment).
- Q: Accessibility? -> A: The gutter is presentational (`aria-hidden`), not focusable; the tab order is unchanged (trigger, then action) (from grill).
- Q: Callers? -> A: The fix lives in `CollapsedLine`; callers only drop their own offset classes (`translate-y-0.5`, `mr-1`) that compensated for the old sibling layout (derived).
- Q: Open questions? -> A: None.

## User Scenarios & Testing

### User Story 1 - Every chevron in one column (Priority: P1)
A reader scans a transcript that mixes tool, thought, note and asked-user rows and sees every expand chevron and timing in one vertical line.

**Acceptance Scenarios**:
1. **Given** a transcript with a tool row, a failed tool row, a thought, a note and an asked-user row, **When** it renders, **Then** the chevron x-centres of all expandable rows are equal within 1px.
2. **Given** a tool row without a `…` (still running) beside one with it, **Then** their chevrons still align.

### User Story 2 - Hover fills the full row (Priority: P1)
A reader hovers a tool row and the fill covers the whole row, including the area under the `…`.

**Acceptance Scenarios**:
1. **Given** any expandable row, **Then** the trigger's width equals the row wrapper's width (the gutter is inside the hover surface).
2. **Given** the pointer over the `…` or the subagents-panel button, **Then** the row fill stays shown.

### User Story 3 - The `…` appears without layout shift (Priority: P2)
**Acceptance Scenarios**:
1. **Given** a settled tool row at rest, **Then** the `…` is invisible; **when** hovered or focused, **Then** it is visible and the chevron's x does not change.
2. **Given** the keyboard, **When** Tab moves from the trigger, **Then** the next stop is the `…` (unchanged order), and the gutter span is never a tab stop.

### Edge Cases
- A wrapped (multi-line) summary: the action stays aligned with the first line.
- The subagent chain card (`p-1`, `ring-1`, `rounded-lg`): the gutter and action sit inside the trigger's own right padding, the card ring is unaffected.
- Narrow panels (Subagents panel stream): the 32px reserved on the right shrinks the summary; the summary already truncates or wraps.
- A running tool row, a multi-call group, a skill row: no `…`; the gutter is empty.
- Light and dark themes: the action's ghost-hover fill must stay distinguishable on the hovered row fill (`--ghost-hover-bg` precedent from #1632).

## Requirements

### Functional Requirements
- **FR-001**: Every expandable `CollapsedLine` reserves a fixed `w-6` gutter inside the `CollapsibleTrigger`, after the chevron, whether or not it has an action.
- **FR-002**: The `action` is positioned over the gutter, as a sibling of the trigger inside the row header wrapper, vertically aligned to the row's first line.
- **FR-003**: The hover fill is keyed on the header wrapper, so it also shows while the pointer is over the action; the trigger keeps its own focus ring.
- **FR-004**: The gutter is `aria-hidden` and not focusable; DOM order stays trigger then action.
- **FR-005**: The `…` stays hidden at rest and shows on row hover, focus within, or open menu, with no layout shift.
- **FR-006**: The non-expandable branch is unchanged.
- **FR-007**: Callers drop the offsets that compensated for the old layout; no caller changes props.
- **FR-008**: Docs and CHANGELOG describe the gutter; `docs/PLAN.md` row for #1612 is "in review".

### Success Criteria
- **SC-001**: Live: chevron x-centres of all expandable rows in a mixed transcript are equal within 1px.
- **SC-002**: Live: trigger width equals row width for every expandable row; the failed row's fill reaches the right edge.
- **SC-003**: Live: the `…` is invisible at rest, visible on hover, and the chevron x is unchanged.
- **SC-004**: `pnpm typecheck`, targeted chat vitest files and the `check:*` scripts pass; no new tests (prototyping rule).

# Feature Specification: Right pane toggle, persistence and rail counts

**Feature Branch**: `024-right-pane-toggle-persistence`
**Status**: Draft
**Input**: Issue #538 (Right pane behaviour rules). Spec 013 (`specs/013-right-pane-shell/`) built the shell; this slice finishes what #538 still asks for. Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-26)" comment on #538.

## Clarifications

### Session 2026-10-26 (grill, delegated)

- Q: New spec or amend 013? -> A: New spec 024; it amends 013 FR-003 (visible collapse control) and FR-012 (zero count).
- Q: Counts on rail icons while collapsed? -> A: Yes, a corner badge; over 9 shows `9+`.
- Q: Zero count? -> A: Nothing is shown at zero on the launcher row, tab and rail.
- Q: What persists? -> A: Open or collapsed, width, open panel ids in tab order, the active tab.
- Q: Shortcut? -> A: Ctrl+Shift+B (Ctrl+B stays reserved for #453).
- Q: Visible collapse control? -> A: A chevron toggle at the top of the icon rail.
- Q: View menu item? -> A: Not built (no menu-to-renderer channel).
- Out of scope: #730 (rail drag to rearrange), #674 (width presets removal).

## User Scenarios and Testing

### User Story 1 - Collapse and expand with a visible control and a shortcut (P1)

A developer collapses or expands the right pane with a button on the icon rail or Ctrl+Shift+B, without dragging.

**Acceptance Scenarios**:

1. **Given** the pane is open, **When** the user presses the rail toggle, **Then** the pane collapses, open panels and their bindings survive, and the button reports `aria-expanded="false"`.
2. **Given** the pane is collapsed, **When** the user presses Ctrl+Shift+B in the chat view with no dialog open, **Then** the pane expands to its remembered width.
3. **Given** focus is inside the pane, **When** it collapses, **Then** focus moves to the active panel's rail button.
4. **Given** the pane expands, **Then** focus moves to the active panel's content, or the launcher when no panel is open.

### User Story 2 - Pane state survives a restart (P1)

**Acceptance Scenarios**:

1. **Given** the user left the pane open at 400 px with two tabs and the second active, **When** Refract restarts, **Then** the same pane, width, tabs, order and active tab return.
2. **Given** a first launch (nothing saved), **Then** the pane is collapsed at 320 px with no tabs.
3. **Given** the saved state names a panel the registry no longer knows, **Then** it is dropped, the active tab repaired, and an open pane with no panels left shows the launcher.

### User Story 3 - Counts are visible and honest (P2)

**Acceptance Scenarios**:

1. **Given** the pane is collapsed and a Session has 3 running subagents, **Then** the Subagents rail icon shows a `3` badge and its accessible name says "Subagents, 3 running".
2. **Given** the git tree is clean, **Then** no count shows on the launcher row, tab or rail icon.
3. **Given** 4 changed files, **Then** the launcher and tab show `+A -D` with added in the diff-added colour and removed in the diff-removed colour; the rail badge shows `4`.

## Requirements

- **FR-001**: The icon rail MUST carry a toggle button (chevron) with `aria-expanded`, an accessible name and a tooltip naming the shortcut. It stays in the same place open or collapsed.
- **FR-002**: Ctrl+Shift+B MUST toggle the pane in the chat view, matched on `event.key`, ignored while a modal or overlay is open.
- **FR-003**: Collapse and expand MUST follow the focus rules in User Story 1.
- **FR-004**: The shortcut MUST be listed in the Keyboard shortcuts dialog and the Keyboard table of `docs/design/index.md`.
- **FR-005**: Settings MUST persist `rightPane = { open, widthPx, openPanelIds, activePanelId }`, written debounced by the renderer, restored on launch without re-persisting.
- **FR-006**: A malformed or out-of-range saved value MUST fall back to the default (lazy correction); width is clamped; ids are de-duplicated and capped.
- **FR-007**: Restore MUST drop unknown panel ids, repair the active tab, and show the launcher for an open pane with no panels.
- **FR-008**: Git changes MUST report no count when there are no changed files (tested on file count).
- **FR-009**: A count of zero MUST render nothing anywhere.
- **FR-010**: Rail icons MUST show a count badge for Subagents (running, working colour) and Git changes (changed files, neutral); over 9 shows `9+`; the accessible name carries the count; a `forced-colors` outline keeps it visible.
- **FR-011**: The git count MUST render through `DiffStatCounts` (diff tokens, true minus sign) on the launcher and tab.

## Success Criteria

- **SC-001**: Collapsing and expanding takes one click or one chord, no dragging.
- **SC-002**: After a restart the pane, width, tabs and active tab match what was left, verified live.
- **SC-003**: No view shows a zero count.

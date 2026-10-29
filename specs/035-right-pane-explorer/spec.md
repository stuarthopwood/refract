# Feature Specification: Right pane and Explorer (wave 2)

**Feature Branch**: `wave2-right-pane-explorer`
**Status**: Draft
**Input**: One PR for the wave 2 "Right pane and Explorer" bundle in `docs/PLAN.md`: #674, #800, #1126, #756, #768. Decisions: the 2026-10-29 grill (a comment on each issue; glossary terms Right pane surface and Git decoration in `CONTEXT.md`). Numbered 035 because 030 to 032 are taken and the two sibling wave 2 lanes (Settings, Session list) may take 033 and 034.

## Clarifications

### Session 2026-10-29 (wave 2 grill, Stuart)

- #800: the 8px grid (spec 028) wins over the issue's 48/36/20. Rail 48 px wide, buttons 40 px, icons 24 px (`size-6`). One `RAIL_WIDTH_PX = 48` in `src/shared/layout.ts` feeds the rail and `WindowControlsSpacerRow`.
- #674: the rail and the pane share a new `--sidebar-right` token, per theme the midpoint between `--background` and `--sidebar` (not `bg-sidebar`). Max width stays 520 px. Min, Default and Max buttons go; WCAG 2.5.7 alternatives are the handle's context menu, the View menu and handle keyboard keys.
- #756: the inline row buttons are not Tab stops (`tabIndex={-1}`); the keyboard route is the kebab and Shift+F10. The preview header becomes one ghost row with Source and Wrap at the right end (2026-10-21 amendment).
- #768: scope includes the renamed, conflicted and staged marks now (the shared type and Rust already carry them). Dedicated `--git-*` tokens, name and icon coloured, folder rollup in the renderer.
- #1126: as written in the issue (active glyph `text-accent-text`, no border, new contrast pair).
- #1119 (softer clean names) is not in this bundle; clean names are unchanged.

### Session 2026-10-29 (pickup, assumptions recorded without a question)

- Q: Rollup precedence? -> A: conflicted, deleted, modified, staged, renamed, added, untracked; ignored never rolls up.
- Q: Does a folder rollup show a dot? -> A: Yes (gate fix, WCAG 1.4.1): a small trailing dot (`aria-hidden`) beside the tint on the name and icon, plus an `sr-only` "contains changes"; shown whether the folder is collapsed or expanded.
- Q: Container breakpoints for inline buttons? -> A: below 300 px none, 300 to 380 px Open in VS Code and Copy path, above 380 px all three; checked by eye at 240, 320 and 520 px.
- Q: Does the pane need the 40 px row between window controls and tabs? -> A: No; with two or more panels the tab row sits directly under the window-controls row.
- Clarify pass: no further ambiguity that changes the implementation.

## User Scenarios and Testing

### User Story 1 - Free pane resize (P1) (#674)

1. **Given** the right pane, **Then** no Min, Default or Max button exists anywhere (launcher, single-panel header, tab bar).
2. **Given** the handle, **When** the user drags between 240 and 520 px, **Then** the pane follows; dragging below 240 px closes it; dragging from closed opens it.
3. **Given** any width, **When** the user double-clicks the handle, **Then** the pane is 320 px.
4. **Given** the handle focused, **Then** arrows resize, Home and End jump to the limits, and the name announces the width.
5. **Given** no drag ability, **When** the user right-clicks the handle (or Shift+F10) or opens View > Right pane width, **Then** Narrow (240), Default (320), Wide (520) and Close pane are offered, current width marked.
6. **Given** two or more panels, **Then** the tab row sits directly under the window-controls row.
7. **Given** any theme, **Then** the pane and rail use `--sidebar-right` and `check:theme-contrast` passes.

### User Story 2 - Bigger rail (P2) (#800)

1. **Given** the rail, **Then** it is 48 px wide, buttons 40 px, icons 24 px, and the window-controls corner is correct at default and narrow widths.

### User Story 3 - Accent active rail icon (P2) (#1126)

1. **Given** a pressed rail button, **Then** its glyph is `accent-text` on the muted fill with no border, 3:1 in every theme.

### User Story 4 - Row actions (P2) (#756)

1. **Given** a file or folder row hovered, focused or selected, **Then** ghost icon buttons for Open in VS Code, Reveal and Copy path show between the name and the kebab and act on that row without selecting it.
2. **Given** a pane under 300 px, **Then** no inline buttons show; 300 to 380 px shows two; above shows three. "Cannot access" rows show none.
3. **Given** a previewed file, **Then** one ghost header row holds the three actions plus Source (Markdown) or Wrap (text) at the right end; no divider.

### User Story 5 - Git colours (P2) (#768)

1. **Given** changed files, **Then** name and icon take the matching `--git-*` colour; clean files are unchanged.
2. **Given** a collapsed folder with changes inside, **Then** it takes the most significant descendant status; an ignored folder is dimmed and does not roll up.

## Requirements

- **FR-001**: `WidthPresetControl` and its three call sites are removed; spec 013 FR-025 and `docs/DESIGN.md` name the replacements.
- **FR-002**: The right resize handle's `defaultSize` is `RIGHT_PANE_DEFAULT_WIDTH_PX`.
- **FR-003**: `--sidebar-right` is defined for every theme as the midpoint of `--background` and `--sidebar`.
- **FR-004**: `RAIL_WIDTH_PX` is the only definition of the rail width.
- **FR-005**: `--git-*` tokens (modified, added, untracked, deleted, ignored, renamed, conflicted, staged) exist for every theme and clear 4.5:1 on sidebar, hover and selected rows; pairs are in `theme-contrast-pairs.mjs`.
- **FR-006**: Colour is never the only git signal: trailing icon and `sr-only` word stay; folder rollups add the trailing dot and "contains changes".
- **FR-007**: `FileExplorerPanel.tsx` does not grow past its baseline; new code lives in extracted files. `App.tsx` does not grow past its baseline.
- **FR-008**: Shared components are extended, not copied (AGENTS.md reusable UI rule); any shared-component change is additive.
- **FR-009**: No new tests (prototyping phase); existing tests keep passing.

## Success Criteria

- Typecheck, `check:ui-text`, `check:theme-contrast`, `check:drag-regions`, `check:file-size` and `pnpm ci:local` pass.
- Live check on Dark, Dark high contrast and one accent theme with screenshots of the changed surfaces.

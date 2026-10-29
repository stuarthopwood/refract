# Tasks: Right pane and Explorer (wave 2)

## Pane shell (Worker A)
- [ ] T001 Probe why the right handle feels undraggable on a scratch instance (CDP mouse events); record cause on #674.
- [ ] T002 Remove `WidthPresetControl` and `resize` props; fix `defaultSize` (FR-001, FR-002).
- [ ] T003 Tab row directly under window-controls row; pane/rail `--sidebar-right` (FR-003).
- [ ] T004 `PaneWidthMenu` for handle context menu, View menu and handle keyboard (Home/End/arrows, accessible name with width).
- [ ] T005 `RAIL_WIDTH_PX` 48; rail buttons 40, icons 24; spacer uses the constant (FR-004).
- [ ] T006 Active rail glyph `text-accent-text`, no border; contrast pairs.
- [ ] T007 Docs: DESIGN.md, spec 013 FR-025, components.md, foundations-icons.md, tokens doc.

## Explorer (Worker B)
- [ ] T010 `--git-*` tokens per theme + contrast pairs (FR-005).
- [ ] T011 `git-decoration.ts`: status to token map, folder rollup; extend `STATUS_MARKS` for renamed/conflicted/staged.
- [ ] T012 Colour name and icon in `TreeNodeRow`; `sr-only` rollup text (FR-006).
- [ ] T013 `TreeRowActions` inline ghost buttons with container-query breakpoints, copy confirmation, no Tab stop.
- [ ] T014 `FilePreviewPane` one ghost header row with Source/Wrap.
- [ ] T015 Keep `FileExplorerPanel.tsx` at or below its baseline (FR-007).

## Finish
- [ ] T020 Reviewer gate; fix; build slot; ci:local; live check; PR; PLAN.md row.

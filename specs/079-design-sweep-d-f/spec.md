# spec 079: Design sweep slices D, E, F (#579)

Slices D (#1466), E (#1467) and F (#1468) of the #579 design sweep. Slices A to C shipped as spec 077 (PR #1475). Rules: `docs/design/`, #474. Slice plan: https://github.com/stuarthopwood/refract/issues/579#issuecomment-6535153658

## Slice D: menus and Profile theme swatches (#1466)
- FR-001 Every menu item carries a leading 16 px icon or a documented exception. Audit result: only `ProfileMenu` "Install GitHub CLI" lacks one; it gets `DownloadIcon`.
- FR-002 Profile theme radio items keep the shared `ThemeSwatchChip`. The radio ring is the leading mark; the chip is a trailing decorative preview. Documented as the one exception.
- Out: ContextShakeMenu, DeleteDialog, ReviewDialog, transcript menus (spec 076).

## Slice E: spacing and the 40 px panel header (#1467)
- FR-003 New shared `components/PanelHeader.tsx`: 40 px row, no bottom divider, title left, `no-drag-region` actions right, optional window-controls spacer. Used by `ChatHeader`, `PanelTabBar` row 1 and `ScreenHeader`; `SettingsScreen` uses `PanelHeader` directly: its header is Back + `SettingsBrand` + "/" + h1, which `ScreenHeader`'s single-title shape cannot hold; the h1 uses `font-semibold` like `ScreenHeader`, and on navigation focus lands on the section h2, not the h1 (amended after round 1, Skippy delegated by Stuart 2026-10-31).
- FR-004 `PANEL_HEADER_HEIGHT_CLASS` (one constant) for the 40 px rows that are not title rows.
- FR-005 `check:spacing` also catches `p-px`/`m-px` and half-steps in positional utilities; surviving positional offsets are allowlisted with a reason.

## Slice F: lint scripts and the Spec Kit design checklist (#1468)
- FR-006 `check:icon-only-controls`: an icon-only `Button` (`size="icon*"`) must be an `IconButton`; existing hand-built pairs are baselined per file (shrink only).
- FR-007 `check:hit-targets`: interactive elements under 24 px and hand-styled `<button>` outside `Button`/`IconButton` fail; baselined per file.
- FR-008 Both run in CI (`ci.yml`, so `ci:local`).
- FR-009 Eight-item design checklist in the Spec Kit plan template (gate) and checklist template; items 1-6 gate, items 7-8 are advisory.

## Out of scope
No new tests (prototyping phase). Burning down the baselines is future work.

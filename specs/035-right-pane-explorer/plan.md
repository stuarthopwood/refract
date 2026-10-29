# Implementation Plan: Right pane and Explorer (wave 2)

Spec: `spec.md`. Constitution check: Principle V (Tauri security) unaffected (renderer-only plus one View menu entry); no new IPC.

## Pane shell (#674, #800, #1126) - Worker A

Files: `src/renderer/App.tsx` (net shrink only), `features/right-pane/{RightPaneShell,PanelTabBar,IconRail,PanelLauncher,WindowControlsSpacerRow}.tsx`, delete `WidthPresetControl.tsx`, `src/shared/layout.ts`, `src/renderer/globals.css` (`--sidebar-right` per theme block), `AppMenuBar` (View > Right pane width), a new `features/right-pane/PaneWidthMenu.tsx` (shared items used by the handle context menu and View menu), `scripts/theme-contrast-pairs.mjs` (rail pair, `--sidebar-right` foreground pairs), docs (`docs/DESIGN.md`, `docs/design/components.md`, `foundations-icons.md`, `foundations-tokens-theming.md`, spec 013 FR-025).

Probe first: reproduce the "can't be dragged" report on a scratch instance and record the cause on #674.

## Explorer (#756, #768) - Worker B

Files: `features/right-pane/file-explorer/FileExplorerPanel.tsx` (shrink only), `FilePreviewPane.tsx`, new extracted files beside them (`TreeRowActions.tsx`, `git-decoration.ts` for status-to-token map and rollup), `globals.css` (`--git-*` per theme block), `scripts/theme-contrast-pairs.mjs` (git pairs), `docs/design/foundations-tokens-theming.md`.

## Ordering

A and B touch disjoint source files; `globals.css` and the pairs script are edited in different regions. The director commits after each worker.

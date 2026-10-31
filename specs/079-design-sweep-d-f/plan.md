# Plan: spec 079

Renderer, scripts, templates and docs only; no IPC, Rust or state changes.

1. D: `DownloadIcon` on Install GitHub CLI; docs close the swatch exception.
2. E: add `PanelHeader` and `PANEL_HEADER_HEIGHT_CLASS`, adopt in `ChatHeader`, `ScreenHeader`, `PanelTabBar`, `WindowControlsSpacerRow`, `AppMenuBar`, `TitlebarBand`; `SettingsScreen` uses `ScreenHeader`; extend `check:spacing`.
3. F: `check:icon-only-controls` and `check:hit-targets` with baselines, wired into `package.json` and `ci.yml`; design checklist in `.specify/templates`.
4. Docs: `docs/design/components.md`, `foundations-tokens-theming.md`, `foundations-typography-spacing.md`, `docs/PLAN.md`.
5. Verify: `pnpm ci:local`, `scripts/verify-tauri-079.mjs`, six-reviewer gate.

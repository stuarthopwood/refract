# Plan: spec 086

Route: specify, clarify, plan, tasks, analyze, implement (authored by hand; no slash-command prompts exist).

1. Contrast tooling: `scripts/theme-tokens.mjs`, `derived-tokens.mjs`, `check-theme-contrast.mjs`, `theme-contrast-pairs.mjs`.
2. In-app warnings: `src/renderer/lib/themeContrast.ts`.
3. Theme hooks: `useThemeEntries.ts`, `ThemePicker.tsx`, `ProfileMenu.tsx`, `useThemeFileActions.ts`.
4. `RowKebabMenu.tsx`, `ChecksSection.tsx`, `docs/design/components.md`.
5. Colour resolution and Mermaid: `resolveCssColour.ts`, `theme-store.ts`, `MermaidBlock.tsx`, `mermaidTheme.ts`, `globals.css`, `theme-tokens.json`.
6. Rust: `src-tauri/src/ipc/themes.rs` `themes_remove`.
7. Docs, `package.json` scripts, `scripts/verify-tauri-086.mjs`.

No new tokens or IPC. Built-in values unchanged apart from the token rename.

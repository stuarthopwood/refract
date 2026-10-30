# Plan: spec 078

## Design

- **Allowlist.** `src/shared/theme-tokens.json` (`{ "version": 1, "tokens": [...] }`), included by Rust with `include_str!` and imported by the renderer.
- **Rust.** `src-tauri/src/store/theme_files.rs` (validator, folder I/O) and `src-tauri/src/ipc/themes.rs` (channels). `Settings.customTheme: Option<String>` with a setter in the existing setter pattern; `lib.rs` adds the active file's `{ id, name, base, tokens }` to the bootstrap payload and honours `--reset-theme`.
- **Bridge.** `src/shared/ipc-themes.ts` types, `THEMES_*` channel constants, `src/tauri-bridge/index.ts` wrappers, `scripts/check-parity.mjs` entries.
- **Renderer.** `theme-store.ts` carries `customTheme`; `applyThemeClass` adds the `base` class and sets or removes the inline properties. A `themeContrast.ts` resolves colours through a probe element and a canvas and checks the pairs in `themeContrastPairs.ts`. UI: `CustomThemeList` rows inside `ThemePicker`, `ThemeActionsRow`, a shared `RowKebabMenu`, a `warning` `Badge` variant, Profile menu entries, `reset-theme` in `actionRegistry.ts`.
- **Docs.** `foundations-tokens-theming.md` (theme files built, tokens), spec 007 note, `docs/PLAN.md`.

## Analysis (consistency check)

- Spec 007's "Presets only" is amended by a note in its assumptions, not rewritten.
- The existing `theme` setting and `ThemeId` enum are untouched, so `theme.set`, Mermaid and Shiki keep working on the base theme; a custom theme's tokens do not yet reach Mermaid or the bundled Shiki theme (#1474).
- 077's translucent tokens are plain tokens in `:root`; they derive from the roles a file overrides, so they follow it. They stay out of the allowlist.
- Constitution V: values reach the DOM only through `setProperty` after Rust validation, and the renderer re-checks the grammar.
- File-size and comment-density: new modules are small and separate.

# Implementation Plan: Six new themes

**Spec**: [spec.md](spec.md) | **Issue**: #1590 | **Route**: specify (spec 116; 114 and 115 are on other branches)

## Summary
Six new theme blocks plus registration, with the contrast tooling extended so light themes are measured correctly. No new IPC; the only backend change is the persisted theme-id enum.

## Grounding in the existing theme system (read from origin/main)
- **Registry**: `src/shared/themes.ts` holds a `THEMES` record (insertion order = picker order) with `id`, `name`, `swatch`, `syntaxTheme`. Consumers: `useThemeEntries.ts` (picker + custom-theme `base` lookup), `shikiHighlighter.ts` (loads the set of distinct `syntaxTheme`s), `theme-store.ts` (active theme -> syntax theme).
- **Persistence**: `src-tauri/src/store/theme_id.rs` (`ThemeId` enum, used by `store/settings.rs` and `ipc/theme.rs`) must gain six variants or saved settings fail to parse.
- **Tokens**: `src/renderer/styles/globals.css` has one `.theme-<id>` block per theme, each with `color-scheme: dark` today (no light theme exists). `scripts/theme-tokens.mjs` parses these blocks into `themes`, which feeds every contrast script. [INFERENCE until T002: it reads only `globals.css`; if so a new stylesheet needs the parser pointed at it.]
- **Contrast**: `pnpm check:theme-contrast` (`scripts/check-theme-contrast.mjs`) runs the `PAIRS` list in `scripts/theme-contrast-pairs.mjs`; entries use `onlyThemes` / `informationalThemes` with explicit id lists (`dark`, `obsidian`, `nordic-frost`, `cyber-amber`, `dark-high-contrast`). Sibling checks that hard-code theme ids: `markdown-token-contrast.mjs` (`NON_HC`), `composer-selection-contrast.mjs`, `theme-swatch-drift.mjs` (Cyber Amber vs Dark), `derived-tokens.mjs`, Mermaid contrast scripts, and about 20 `scripts/verify-*.mjs` CDP drivers with their own theme lists (left alone unless they iterate all themes).
- **Display audit (#553)**: `scripts/check-display-profiles.mjs` + `display-profiles.mjs` apply TN washout / VA black crush / sunlight glare luminance curves to `STEP` pairs (card, popover, sidebar must be >= N L* **above** canvas) and `RATIO` pairs. The step direction is dark-theme logic: on light themes surfaces are not lighter than the canvas, so the pair must compare absolute L* difference, or sign by `color-scheme`.

## Design decisions
1. **Palettes** (final values chosen and measured in implementation; figures here are targets):
   - Light: neutral grey-white canvas, ink near-black, indigo-family accent as Dark.
   - Light (warm paper): cream canvas, warm brown-black ink, muted terracotta/ochre accent.
   - Light (high contrast): pure-white canvas, black ink >= 7:1, solid 3:1+ edges, no alpha text.
   - Lagoon (teal, Solarized-style): deep blue-green canvas, teal accent.
   - Amethyst (purple, Dracula-style): charcoal-violet canvas, purple accent.
   - Hearth (warm, Gruvbox-style): brown-grey canvas, orange/yellow accent; distinct from Cyber Amber by lower chroma and a brown rather than neutral-black canvas.
2. **Stylesheet location**: six blocks add roughly 1,500 lines to a stylesheet that already holds five. To honour the 600-line cap and never raise `scripts/file-size-baseline.json`, new blocks go in new files under `src/renderer/styles/` (themes-light.css, themes-dark-accents.css) imported from the entry stylesheet; `theme-tokens.mjs` is extended to read them. If the cap check does not apply to CSS, keep one file per family anyway for reviewability. Confirmed in T002.
3. **Alpha text (#1074)**: existing themes use white at 0.9/0.78/0.6 alpha. Light themes use the ink colour at the same alphas; Light HC uses solid ink. New dark themes copy the rule.
4. **Derived tokens (#1474)**: Shiki gets a light variant (`github-light-default`; Light HC uses `github-light-high-contrast` if available in the installed shiki, else `github-light-default` with the comment colour measured >= 4.5:1). Mermaid variables come from tokens via `src/shared/mermaidTheme.ts`; verify the light derivation, and fix `darkMode` flags if hard-coded.
5. **Hard-coded dark assumptions**: sweep `git grep` for `dark:` variants, `oklch(` / hex / `rgba` literals in `src/renderer` and for `bg-black` / `text-white` classes; replace with tokens; list on the PR.
6. **Contrast lists**: each new id is added to the matching `onlyThemes` / `informationalThemes` lists by family: light themes need their own entries where a pair is dark-specific (for example ring vs surface, severity text on card); HC-only pairs gain `light-high-contrast`.
7. **Display audit**: make STEP pairs direction-aware by theme `color-scheme`, then confirm no newly failing offenders per new theme. Existing five themes' output must not change.
8. **Window chrome**: `color-scheme: light` in the block covers webview native controls. Tauri window chrome follow-through is confirmed live in the check; if a Rust-side `set_theme` call is needed, add it in `ipc/theme.rs`.
9. **Swatch**: each entry's two colours (background, primary) are copied from the measured tokens; `theme-swatch-drift.mjs` extended so swatches equal tokens for the new ids.

## Files to touch
- `src/shared/themes.ts`
- `src-tauri/src/store/theme_id.rs` (plus any `match` on `ThemeId` in `store/settings.rs`, `ipc/theme.rs`)
- `src/renderer/styles/globals.css` (imports; `:root` fallbacks only if needed) and new `src/renderer/styles/themes-light.css`, `themes-dark-accents.css`
- `src/renderer/features/chat/shikiHighlighter.ts`, `src/shared/mermaidTheme.ts`, `src/renderer/state/theme-store.ts` (only if light needs a branch)
- Components with hard-coded dark assumptions (found by sweep)
- `scripts/theme-tokens.mjs`, `theme-contrast-pairs.mjs`, `check-theme-contrast.mjs`, `markdown-token-contrast.mjs`, `composer-selection-contrast.mjs`, `theme-swatch-drift.mjs`, `check-display-profiles.mjs`, `derived-tokens.mjs` (as needed)
- One committed CDP driver `scripts/verify-1590-themes.mjs` reusing the #1381 per-theme helper
- Existing tests that enumerate theme ids or count themes (updated, none added)
- Docs: `docs/design/foundations-tokens-theming.md`, `accessibility.md`, `product-look-and-feel.md`, `CHANGELOG.md`, `docs/PLAN.md` row

## Constitution / rules check
No new tests (prototyping); comments why-only; 600-line cap with no baseline increase; reusable components only (no one-off UI); no IPC contract changes beyond the enum.

## Verification
`pnpm check:theme-contrast`, `node scripts/check-display-profiles.mjs --strict`, `theme-swatch-drift`, Mermaid/markdown/composer contrast scripts, `node scripts/ci-local.mjs` (build slot), live CDP screenshots per theme (Chat, Pull requests, Settings, Usage) posted on the PR.

# Plan: spec 084

## Design

- **Tokens.** Declared in a block in `globals.css` (Dark-family defaults in the spec 081 `:is(...)` block, overrides in three theme blocks); allowlist and `@theme inline` need only the allowlist (no utilities, read by JS).
- **Builder.** `src/shared/mermaidTheme.ts` exports `buildMermaidThemeVariables(read)` and `getMermaidThemeCSS(vars)`; `read(token)` returns a colour string. Shared roles map as in the clarifications. The renderer reader (`src/renderer/lib/resolveCssColour.ts`) reads the computed custom property and normalises through a 1x1 canvas; `themeTokens.ts` reuses it for the starter file.
- **Renderer.** `MermaidBlock` computes variables at render time and keys its effect on `useThemeKey()` (theme id, custom id, token JSON). `CodeBlock` picks the Shiki theme with a new `syntaxThemeFor(themeId, customTokens)`.
- **Scripts.** `check-mermaid-contrast.mjs` reads `mermaid-*` tokens from the parsed CSS (defaults merged under each theme block); `markdown-token-contrast.mjs` reads the accent tokens instead of `mermaidAccent.ts`.
- **Docs.** `foundations-tokens-theming.md` token table; `docs/PLAN.md` row.

## Analysis (consistency check)

- Tokens are hex literals equal to the removed TS values, so built-ins render identically; verified by comparing the built variables to the removed tables (once, in the live check) and a screenshot per theme.
- Constitution V holds: values still reach the DOM only through `setProperty`; the Mermaid config receives sanitised `#rrggbb` only, never user CSS text.
- `check:indent` allow-list entry for `mermaidTheme.ts` goes away with the rewrite.
- File size: `mermaidThemeData.ts` (300 lines) and `mermaidAccent.ts` are deleted; CSS is outside the cap.

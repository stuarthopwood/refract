# spec 086: Theme and contrast follow-ups (#1485, #1491)

Follow-ups for the closed #458 epic (specs 078, 081, 083, 084). Lane V owns the `aria-disabled` pointer-events and press-nudge items (#1486, spec 085); they are out of scope. Built-in themes stay visually equivalent.

## User stories

1. As a theme author, the contrast gate checks the hover, outline, tooltip, attention-pill and Mermaid pairs, so a bad theme is caught at build time.
2. As a developer, the in-app contrast warnings are a provable subset of the build gate.
3. As a user, the theme list in Settings and in the profile menu behave identically, and theme file actions never fail silently.
4. As a pointer user, a check row's actions menu opens from the row only.
5. As a theme author, Mermaid and code colours resolve correctly, and a theme change does not re-initialise Mermaid needlessly.

## Functional requirements

- FR-1: `theme-tokens.mjs` resolves plain `:root` tokens; `derived-tokens.mjs` resolves oklch/oklab `color-mix` with optional percentages and premultiplied alpha; pairs accept `on:` to composite a translucent background over a surface.
- FR-2: New gate pairs: secondary, destructive and outline hover; outline-bg; tooltip border; attention pill; Mermaid text, node text, cscale label. Cyber Amber destructive hover (4.26:1) is informational.
- FR-3: `themeContrast.ts` pairs are a subset of the gate; the canvas context is cached; new in-app pairs for hover fills, Mermaid text, node text and scrollbar thumb.
- FR-4: `useThemeEntries` is the one theme-list hook; `useThemeFileActions` catches every action.
- FR-5: `RowKebabMenu` right-click is row-scoped, entries may be links or disabled; `CheckRow` uses it; documented in `docs/design/components.md`.
- FR-6: `themes_remove` logs and ignores a `clear_if_active` failure after the file is removed.
- FR-7: `resolveCssColour` resolves transparent tokens over an opaque surface; `useThemeKey` memoises; Mermaid `initialize` runs only on theme key change; `mermaid-cscale-12` becomes `mermaid-cscale-11`.
- FR-8: Doc fixes; `verify:tauri-081/084/086` scripts; 081 null guard.

## Out of scope

Colour-changing items (selected-meta token, distinct hover/selected backgrounds, unified diagram surfaces, `var(--role)` Mermaid defaults), the `check:mermaid-contrast` loader (#1106), canvas-normaliser dedupe, Lane V's items.

## Success criteria

`pnpm ci:local` passes; no new tests; literal-colour baseline does not grow; `scripts/verify-tauri-086.mjs` passes in Dark and Obsidian.

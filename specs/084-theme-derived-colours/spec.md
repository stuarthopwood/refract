# spec 084: Theme-derived Mermaid and Shiki colours (#1474; #458 slice 6)

Builds on specs 078 and 081 (custom theme files, per-element tokens). Slice 5 is #1473.

## User stories

1. As a theme author, a theme file recolours Mermaid diagrams (surfaces, text, lines, accent, palettes) live, without a rebuild.
2. As a theme author, a theme file recolours code blocks, including on a Dark (high contrast) base.
3. As a theme author, scrollbar colours follow the theme file (already true; proven live).

## Functional requirements

- FR-1: New allowlisted colour tokens: `mermaid-bg`, `mermaid-node-fill`, `mermaid-node-fg`, `mermaid-border`, `mermaid-line`, `mermaid-secondary`, `mermaid-tertiary`, `mermaid-text`, `mermaid-note-bg`, `mermaid-note-fg`, `mermaid-task-text`, `mermaid-ink`, `mermaid-crit`, `mermaid-cscale-12`, `mermaid-cscale-label-12`, `mermaid-accent`, `mermaid-accent-fill`, `mermaid-palette-1` to `-12`, `mermaid-fill-1` to `-8`. Values equal today's hex literals per theme, so built-ins are pixel-equivalent.
- FR-2: Defaults (Dark family) sit in the spec 081 `:is(:root, .theme-*)` block; Obsidian, Dark (high contrast) and Nordic Frost override their surface-tied roles in their own blocks.
- FR-3: `MermaidBlock` resolves the tokens from `documentElement` at render time (any grammar colour normalised to `#rrggbb`) and re-renders when the active theme or the custom theme's token map changes. The per-theme literal tables (`mermaidThemeData.ts`, `mermaidAccent.ts`) are removed.
- FR-4: `syntax-*` and `code-block-fg` join the allowlist; Dark (high contrast) declares them. A custom theme that overrides any of them makes every base use the `css-variables` Shiki theme; otherwise Dark (high contrast) keeps its bundled theme.
- FR-5: `check:mermaid-contrast` builds the variables from the parsed `globals.css` tokens through the same shared builder; `check:theme-contrast` checks the `mermaid-accent` pairing against `accent-text` and the new foreground pairs.
- FR-6: The `#ffffff` literal in `MermaidBlock.tsx` is removed (and the lane T baseline entry shrinks if that lane has merged).

## Out of scope

- `titleBarOverlay` in `themes.ts`: no Tauri consumer.
- A Mermaid-wide colour editor; light themes (unchanged from spec 078).

## Success criteria

- `pnpm ci:local` passes; no new tests; no file grows past its baseline.
- Live check: a Mermaid diagram, a code block and a scrollbar in two built-in themes and in one custom per-element theme, which recolours all three live.

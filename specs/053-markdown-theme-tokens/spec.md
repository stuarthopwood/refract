# Feature Specification: Markdown theme tokens (#456)

**Feature Branch**: `markdown-theme-tokens`  **Status**: Implemented (Lane A, 2026-10-29)
**Input**: Issue #456, including its "Grilled 2026-10-19" block (binding).

## User scenarios

### US1 - Accent-led Markdown in every theme (P1)
As a user, the chat's Markdown picks up my theme's accent so Cyber Amber reads orange, Nordic Frost cyan and Obsidian/Default Dark indigo.
- Given a theme, then h1-h3 headings, list bullets and numbers, the blockquote bar, the code block's language label, inline `code` text and table header text use that theme's accent family. Links already do (#610) and stay underlined.
- h4-h6 and quote text keep the prose and muted colours. Table header fill stays the neutral muted tint.

### US2 - Accent-led syntax colours (P1)
Highlighted code uses an accent-led palette (keywords and functions in the accent hue; strings, constants, parameters in harmonising hues; comments grey). Dark (high contrast) keeps `github-dark-high-contrast`.

### US3 - Mermaid on the same accent source (P2)
Node borders, arrowheads and cluster borders use the theme accent; node fills a faint accent tint; labels in prose colour.

## Requirements

- **FR-001** Named tokens in `globals.css`, one set per theme: `--md-heading`, `--md-marker`, `--md-quote-bar`, `--md-code-label`, `--md-code-fg`, `--md-code-bg`, `--md-table-header-fg`, `--code-block-bg` (defaults to `--card`), and `--syntax-keyword/function/string/constant/parameter/punctuation/comment`, `--code-block-fg`.
- **FR-002** Shiki uses its `css-variables` theme (verified supported on the pinned shiki 4.4.3); `--shiki-*` variables map onto the `--syntax-*` tokens. `themes.ts` `syntaxTheme` is `css-variables` for four presets and `github-dark-high-contrast` for Dark (high contrast).
- **FR-003** Every new text pair is >= 4.5:1 (>= 7:1 in Dark (high contrast) for Markdown elements) and every non-text pair >= 3:1, all added to `scripts/check-theme-contrast.mjs`.
- **FR-004** Colour is never the only cue: links keep their underline, headings their weight, bullets their shape.
- **FR-005** Mermaid palette (`src/shared/mermaidTheme.ts`) derives its accent colours from the same per-theme accent.
- **FR-006** No new tests (prototyping phase). Existing tests keep passing.

## Out of scope
`<mark>`, `::selection`, find highlight (follow-up). Tailwind palette colours in ChangesTab/Readiness (see decision record on the issue).

## Clarifications (/speckit.clarify, all Decided by Skippy, delegated by Stuart 2026-10-29)
1. Prefix: `--md-*` for Markdown, `--syntax-*` and `--code-block-*` for code.
2. Code block background: its own token `--code-block-bg`, default `--card`.
3. Shiki css-variables theme exposes only keyword/constant/string/comment/function/parameter/punctuation/link, so the issue's longer token list (`number`, `type`, `variable`, `inserted`, `deleted`) collapses onto `constant` and `parameter`; diffs keep their own `--diff-*` tokens.
4. `--accent-text` fails 4.5:1 on `--muted` (#610), so inline code and table header text use a lighter tint of the same hue, `--md-code-fg`, instead of `--accent-text` itself.

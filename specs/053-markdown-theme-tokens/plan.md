# Plan: Markdown theme tokens (#456)

Constraints: `Markdown.tsx` stays <= its 997-line baseline; `src/shared/ipc.ts` untouched; `globals.css` is not size-capped; no new tests.

1. `src/shared/themes.ts`: `syntaxTheme` -> `'css-variables'` (4 presets); HC keeps its Shiki theme.
2. `src/renderer/features/chat/shikiHighlighter.ts` (new): the shared highlighter plus `createCssVariablesTheme`, moved out of `Markdown.tsx`; `CodeBlock` skips the background colour replacement for `css-variables`.
3. `globals.css`: per-theme token set inserted after each `--accent-text`; `@theme inline` colour mappings; `:root` mapping of `--shiki-*` onto `--syntax-*`.
4. `Markdown.tsx`, `markdownExtras.tsx`, `markdownLists.tsx`: swap borrowed tokens for `md-*` utility classes.
5. `scripts/`: contrast pairs for every new token (new module `markdown-token-contrast.mjs`), skip `css-variables` in the real-Shiki loop.
6. `src/shared/mermaidTheme.ts`: accent colours from the same per-theme accent.
7. Docs: `docs/PLAN.md` row, `CONTEXT.md` terms, decision record on the issue.

Verification: `pnpm check:theme-contrast`, `pnpm ci:local`, live run in Default Dark, Cyber Amber, Dark (high contrast).

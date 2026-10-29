# Tasks: Markdown theme tokens (#456)

- [x] T001 Probe shiki 4.4.3 `createCssVariablesTheme` (supported; output uses `var(--shiki-*)`)
- [x] T002 themes.ts syntaxTheme values
- [x] T003 shikiHighlighter.ts + CodeBlock wiring
- [x] T004 globals.css tokens, @theme mappings, --shiki-* map
- [x] T005 md-* classes in Markdown.tsx, markdownExtras.tsx, markdownLists.tsx
- [x] T006 contrast pairs (markdown-token-contrast.mjs) and checker wiring
- [x] T007 mermaidTheme.ts accent source
- [x] T008 docs/PLAN.md row, CONTEXT.md terms
- [x] T009 ci:local, live check, gate, PR

## Analysis (/speckit.analyze)
FR-001..FR-006 each map to a task above (FR-003 -> T006, FR-005 -> T007). No constitution conflict: Principle V untouched (no new IPC, no new capabilities). Risk: `Markdown.tsx` baseline growth (mitigated by extracting the highlighter).

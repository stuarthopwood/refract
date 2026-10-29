# Tasks: Markdown theme tokens (#456)

- [x] T001 Probe shiki 4.4.3 `createCssVariablesTheme` (supported; output uses `var(--shiki-*)`)
- [ ] T002 themes.ts syntaxTheme values
- [ ] T003 shikiHighlighter.ts + CodeBlock wiring
- [ ] T004 globals.css tokens, @theme mappings, --shiki-* map
- [ ] T005 md-* classes in Markdown.tsx, markdownExtras.tsx, markdownLists.tsx
- [ ] T006 contrast pairs (markdown-token-contrast.mjs) and checker wiring
- [ ] T007 mermaidTheme.ts accent source
- [ ] T008 docs/PLAN.md row, CONTEXT.md terms
- [ ] T009 ci:local, live check, gate, PR

## Analysis (/speckit.analyze)
FR-001..FR-006 each map to a task above (FR-003 -> T006, FR-005 -> T007). No constitution conflict: Principle V untouched (no new IPC, no new capabilities). Risk: `Markdown.tsx` baseline growth (mitigated by extracting the highlighter).

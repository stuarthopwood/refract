# Analysis: spec 087

Cross-artefact consistency check (spec, clarifications, plan, tasks) run 2026-10-31 before implementation.

| Check | Result |
|---|---|
| Every FR maps to a task | FR-001..FR-018 map to T2..T10 |
| Every skipped item has a reason | yes, four rows in `spec.md` |
| Every clarification is reflected in a FR | Q1 FR-009; Q2 FR-013; Q3 FR-012; Q4 FR-005; Q5 FR-002; Q6 FR-004; Q7 FR-016; Q8 FR-010; Q9, Q10 skipped |
| Risk: delayed blur hides loading state from sighted users on slow loads | delay is ~150 ms only; `aria-busy` and `inert` stay immediate |
| Risk: removing `theme.preview` breaks a caller | grep of renderer, scripts, capabilities and tests before removal (T9) |
| Risk: re-detect on reload shows a roster the user dismissed | the dismissal is keyed by roster path in the store and is checked before render |
| Constitution conflicts | none |
| Theme token, `globals.css` theme block, `themeContrast.ts`, `theme-contrast-pairs.mjs` touched | none (Lane W owns them) |
| New tests added | none |

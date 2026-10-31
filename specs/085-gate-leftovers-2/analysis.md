# Analysis: spec 085

Cross-artefact consistency check (spec, clarifications, plan, tasks) run 2026-10-31 before implementation.

| Check | Result |
|---|---|
| Every FR maps to a task | FR-001..FR-010 map to T2..T11 |
| Every skipped item has a reason | yes, three rows in `spec.md` |
| Every clarification is reflected in a FR | Q1 FR-002; Q2, Q3 FR-003; Q4 FR-004; Q5 FR-005; Q7 FR-009 |
| Risk: removing `pointer-events-none` lets a click through a busy button | each site's handler returns early when busy (verified by reading each); the radio in MergeDialog is kept; the Radix kebab trigger gets an `onPointerDown` guard |
| Risk: shared outline overridden by base Button | `cn()` tailwind-merge resolves the conflict in favour of the later class |
| Constitution conflicts | none |
| Theme, Mermaid, Shiki, scrollbar files touched | none (Lane U owns them) |
| New tests added | none |

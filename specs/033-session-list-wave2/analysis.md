# Analysis: spec 033

- Every FR maps to a task: FR-001 T001, FR-002 T004, FR-003 T005, FR-004 T003, FR-005 T002, FR-006 T006, FR-007 and FR-008 T007.
- #731 has nothing to build (shipped); it closes with the PR.
- File overlap: Worker 1 and Worker 2 both touch `src/shared/model.ts` (different types) and Rust IPC registration; each commits only its own paths and rebases hunks by hand.
- Risk: `settings.rs` is near the 600-line cap; put the new field in a sibling module if needed.
- No contradictions between spec and plan.
- Converge 2026-10-30: FR-006 was only partly built (Manage sessions kept `ManageSessionRow`'s own markup and handlers, about 645 lines). New FR-009 maps to T008-T011; T012 covers the docs. Risk: `useSessionRowActions.ts` is at 576 lines, so T008 splits the resume block out first.

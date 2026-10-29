# Analysis: Hide Sessions (spec vs plan vs tasks)

- Every FR maps to a task: FR-001 T1, FR-002 T2/T3, FR-003 T5, FR-004 T6, FR-005 T5/T7/T9, FR-006 T4/T8/T10, FR-007 T11.
- Risk: `ManageSessionRow.tsx` (662, baseline 662) and `ChatPane.tsx` (1264) cannot grow; new behaviour goes through shared helpers and new files.
- Risk: `useSessionRowActions.ts` has about 13 spare lines; the Hide flow lives in a new hook.
- Risk: Rust is uncompilable until the build slot; expect one compile-fix round.
- No constitution conflicts, no unresolved clarifications. Proceed to implement.

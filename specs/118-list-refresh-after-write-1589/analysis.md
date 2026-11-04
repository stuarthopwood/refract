# Analysis: spec 117 (#1589)

Consistency pass over spec.md, plan.md, tasks.md.

- Every FR maps to a task: FR-001 T003, FR-002 T004, FR-003 T007, FR-004/FR-005 T006, FR-006 T007 (debounce only), FR-007 T006/T007.
- Finding 1: the list pane summary is a polite live region; a count change may be announced. Accepted: it is a count, not the list (matches the grill rule).
- Finding 2: `rebuild_from_history` also resolves repos; emission is placed in `record_writes` only, so replay never emits.
- Finding 3: a write to an unregistered repository has no `repositoryId`; the renderer refreshes regardless.
- Finding 4: Rust compile cannot be checked here; the run worker builds. Only `cargo fmt --check` runs in this lane.
- No open questions.

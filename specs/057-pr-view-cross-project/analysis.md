# Analysis 057

Every FR maps to a task: FR-001/002 to tasks 2, 4, 5; FR-003/004/007 to task 2; FR-005 to task 3; FR-006 to task 2; FR-008 to task 5 (detail untouched).

Risks: `ipc.ts` has +1 line of headroom, so types live in the new module. `pull_requests/mod.rs` is at the cap, so the handler goes in a child module. The sidebar active count depends on the single-Project `list`, which stays. No new tests (prototyping phase); verification is the live check.

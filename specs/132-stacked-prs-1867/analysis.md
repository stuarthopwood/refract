# Analysis: spec 132 (read-only, 2026-11-12)

## Coverage of issue #1867 acceptance criteria

| Acceptance criterion | Spec | Plan | Tasks |
|---|---|---|---|
| Toggle, default on, persisted | FR-001, SC-001 | D1 | T001, T009 |
| Notes carry `gh stack` instructions iff on | FR-002, FR-003, SC-002 | D5 | T004 |
| Merge: stacked via `gh stack merge`, unstacked via today's path | FR-004 to FR-007, SC-003 | D2 | T005 to T007 |
| View shows stack position and links | FR-008 to FR-010, SC-004 | D4 | T006, T008 |
| Missing extension: prompt and Install clears it | FR-011, FR-012, FR-014, SC-005 | D3, D4 | T002, T009 |
| Exit 9: message and plain-PR fallback for that repository | FR-013, SC-006 | D2, D3 | T002, T005, T007 |
| Grilled decisions 1 to 3 | Clarifications | D2, D3 | #1966 filed for the installer |

All six criteria and all three grilled decisions are traced.

## Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A1 | High | FR-004's text pointed at the plan for merging the right stack, while research found a bare number is tried as a stack number first. | Fixed: spec edge case and plan D2 now carry an explicit guard and refusal; T007 tests it. |
| A2 | Medium | FR-003 was garbled ("read from docs only in summary"). | Fixed: states the fixed block and its content. |
| A3 | Medium | No requirement for safe argument handling of the pull request number (Constitution V). | Fixed: FR-015. |
| A4 | Medium | T003 needs a real stacked pull request that does not exist on the repo. | Open: the task has a stated fallback (CLI refusal only) so it cannot block; Stuart can name a scratch repo. |
| A5 | Low | `gh stack view --json` runs per head branch (N processes). | Plan risk records the cap and cache. |
| A6 | Low | #1859 edits `args.rs` too. | Plan records the merge-order handling. |

No Critical findings; the High finding is fixed. No constitution conflicts: no new OMP wire surface, no shell, and no process left running.

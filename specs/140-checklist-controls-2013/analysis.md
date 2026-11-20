# Analysis: spec 140 (#2013)

Lean pass, run by reading spec.md, plan.md and tasks.md together. No code was read in this pass; code anchors rely on the earlier reads and T001 re-verifies them.

## Coverage

| Requirement | Task |
|---|---|
| FR-001 | T002, T003 |
| FR-002 | T007 |
| FR-003 | T008, T009 |
| FR-004, FR-005, FR-006, FR-007 | T006 (T004, T005) |
| FR-008 | T008 |
| FR-009 | T011 |
| FR-010 | T010 |
| FR-011 | T011, T019 |
| FR-012 | T013-T018 |
| FR-013 | every task (tests named), T021 |
| SC-001..SC-005 | T003, T008, T019, T022, T021 |

## Findings

- **F1 (resolved)**: the first spec draft had `accept_complete` hash text before `rev` existed. Resolved by the builder form (Clarifications; T005).
- **F2 (resolved)**: `value` and `complete` need `baseRev`; the design signature omitted it. Added (Clarifications; T006, T009).
- **F3 (resolved)**: `not_agent_completable` was not an `ErrorCode`. Added (T004).
- **F4 (resolved)**: plan referenced T010, T011, T012, T022 by number; tasks.md keeps those numbers (T019 sits after T011 on purpose).
- **F5 (open, low)**: file lengths of `frame.rs` (385) and `chat.rs` (339) were read earlier; T001 re-measures and splits before editing if a file would pass 600.
- **F6 (open, low)**: #2012 filenames are unknown until it merges; T013-T018 say "named in T001". If #2012 is not merged when this lane starts, the renderer phase waits.
- **F7 (open, medium)**: whether the `message_start` frame text equals the sent text exactly (needed for the hash match in T010) was not verified in this pass; T010's `edited_text_does_not_start_it` and a test using a real frame fixture cover it, and a mismatch would be a finding to report.

No `[NEEDS CLARIFICATION]` remains. No constitution conflicts found.

## Deviations list (filled by T001)

(empty until T001 runs)

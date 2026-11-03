# Analysis: Delete Session in the background

Cross-check of `spec.md`, `plan.md`, `tasks.md` against the issue #1591 grill block and `docs/PLAN.md` line 1033.

## Coverage

| Requirement | Plan | Tasks |
|---|---|---|
| FR-001 checks before close | `sessions_delete` keeps checks before return | T006 |
| FR-002 background removal | `delete_in_flight::start` | T005, T006 |
| FR-003 Deleting… row | SessionRow(Table) | T019, T020 |
| FR-004 no re-open/archive/rename/delete | backend refusal + action builder | T007, T008, T021, T022 |
| FR-005 success removal + announcement | init-stores | T016 |
| FR-006 failure toast + announcement | `deleteFailureToast` | T015, T016 |
| FR-007 Retry / Details | toast + `DeleteDetailsHost` + `initialError` | T015, T017, T018 |
| FR-008 parallel | per-Session guard in `start` | T005 |
| FR-009 reload restore | `sessions.deleting` + store refresh | T007, T013 |
| FR-010 quit prompt | `quit_guard` | T010-T012 |
| FR-011 error payload | `delete-failed` payload | T009 |
| FR-012 shared components | ui/sonner, shared row | T015, T019 |
| FR-013 keyboard toast | sonner action/cancel buttons | T015 |

## Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A1 | MEDIUM | Three existing tests assert completion on return from `sessions_delete`. | T014 adapts them with no new cases. |
| A2 | LOW | The grill does not fix the quit prompt mechanism, toast persistence, or repeated-failure behaviour. | Defaults stated in spec Clarifications; flagged for Stuart. |
| A3 | LOW | `sessions.rename` handler location not recorded. | T008 names the grep to find it. |

No CRITICAL or HIGH findings. Constitution check: no violations. No requirement lacks a task; no task lacks a requirement.

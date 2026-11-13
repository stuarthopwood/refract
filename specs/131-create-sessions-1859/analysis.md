# Analysis: spec 131 (#1859)

Read-only pass over spec.md, plan.md, tasks.md, contracts/tools.md, 2026-11-12, plus the code lines the plan cites at origin/main 7149e691.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| A1 | High | Slices 1 and 2 were described as able to run in parallel, but T003 and T004 both edit `ipc/sessions_lifecycle.rs`; the dependency line also contradicted the slice order. | Fixed: dependencies are now one chain T001 to T009 with T010 free; the file collision is stated. |
| A2 | High | The spec edge case "caller deleted while its child is being created -> `cancelled`, no orphan link" had no task or test. | Fixed: added to the T006 tests. |
| A3 | High | FR-001 widens access to every depth while spec 129 decision 5 and SC-004 keep the Child row empty; a reader could see a conflict. | Resolved by clarify decision 14: created Sessions launch as `Role::Root` with their real depth, the `Role::Child` row and its `unknown_tool` test are unchanged, and T008 tests both. No spec 129 change needed. |
| A4 | Medium | Decision 17 reads "parent's approval mode" in the issue but uses the caller's mode. | Recorded as a delegated decision with its reason (the card shows in the caller's chat; they are the same Session in the common case). Not a conflict with the grill, which says "governed by the parent's approval mode" and defines no other source. |
| A5 | Medium | The plan cites `update_session_name`, `choose_role` and `create_session_record` as seams; the extraction and exact names are unverified in code beyond the lines read. | Open, cosmetic: implement reads them first (Risks lists it); names in tasks are the contract, not the line numbers. |
| A6 | Medium | `router.rs` is 549 lines; five tools of dispatch must stay under 600. | Open, tracked: T008 allows splitting `Plan` into `plan.rs` in the same task (Risks). |
| A7 | Low | The rules-size test bound (1000..=2000) must rise with the 900-character block. | Covered by T010. |
| A8 | Low | No renderer change, so no accessibility tasks; the flat child row is existing behaviour until #1862. | Accepted; stated in the spec. |

Counts: Critical 0, High 3 (all fixed), Medium 3 (1 recorded, 2 open and non-blocking), Low 2.

Coverage: all 18 FRs and 6 SCs map to a task (checked by script: no FR or SC id missing from tasks.md).

Open Critical or High: none.

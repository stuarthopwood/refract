# Analysis: spec 129 (#1858)

Run after tasks, 2026-11-12. Read-only pass over spec.md, plan.md, tasks.md, contracts/tools.md.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| A1 | High | SC-004 (Child call is `unknown_tool`) and the shutting-down `cancelled` edge case had no task. | Fixed: added to T006 tests. |
| A2 | High | SC-002 (label survives reload) and SC-003 (no toast on every error) were not in the live task. | Fixed: T009 now names both. |
| A3 | Medium | `Status: Draft` and spec decisions 10-14 were unnumbered in the plan's references. | Open, cosmetic. |
| A4 | Medium | Spec 124 documents the error body as `{error: code, message}`; the grill says `{error:{code,message}}`. The router is the source of truth; implement checks `ToolError` serialisation and follows it. Conflict recorded in the report. | Open; checked at T006. |
| A5 | Low | Envelope escape wording in contracts/tools.md is terse; T001 tests are the executable definition. | Open. |

Counts: Critical 0, High 2 (fixed), Medium 2, Low 1. Coverage: all 20 FRs and 6 SCs map to a task.

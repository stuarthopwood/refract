# Analysis: #1831 (spec 126)

Read-only cross-check of spec, plan and tasks.

## Coverage
| Requirement | Tasks |
|---|---|
| FR-001 | T001 |
| FR-002 | T005 |
| FR-003 | T002, T005 |
| FR-004 | T002, T004 |
| FR-005 | T003, T004 |
| FR-006 | T007 |
| FR-007 | T006 |
| FR-008 | T008 |
| FR-009 | T005 |
| SC-001 | T008, T011 |
| SC-002 | T004, T011 |
| SC-003 | T001 |
| SC-004 | T004, T011 |

Every FR and SC maps to at least one task. No task lacks a requirement except T009 to T011 (plan decision, docs, verification).

## Findings
- **A1 (medium, deferred)**: Three deferred clarifications (cancel, required fields, extra field types) are unresolved. The spec states an interim behaviour for each (Submit only, no validation, fallback), so the plan is buildable; T012 tracks them. Stuart must decide before any of them is added.
- **A2 (medium, risk)**: The `(N selected) ` prefix and the `input` versus `editor` split are source-read, not observed. `matchFrame` is lenient on both and T011 verifies on a real 18.18.3 run.
- **A3 (low)**: Spec User Story 2, scenario 2 says Submit is "not offered" for an empty Other. That edges into the deferred required-field decision. Treat it as pending clarification 2, not an implemented rule. Wording fixed by marking it so in tasks (T012).
- **A4 (low)**: Plan names `AskFormHistory.tsx` or a read-only mode of `AskFormCard`; T006 resolves it at implement time (prefer the read-only mode, to avoid a second card).
- **A5 (info)**: Terminology is consistent: "Ask card", "field", "frame", "Other", "Done selecting". No contradictions between spec, plan and tasks.
- **A6 (info)**: Constitution: no violation. Rust untouched, no new dependency, shared components used.

No `[NEEDS CLARIFICATION]` markers remain. No critical findings; safe to implement T001 to T011.

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
- **A1 (resolved)**: The three clarifications (cancel, required fields, extra field types) were answered by Stuart on 2026-11-11 and are in `spec.md`. Radio groups can never be blank, so Submit stays blocked until each is answered (no mid-form fallback); Esc cancels only while focus is inside the card and not in a text input or textarea, and the Cancel button works from anywhere; the parser caps at 100 fields and 200 options per field with per-field-card fallback.
- **A2 (medium, risk)**: The `(N selected) ` prefix and the `input` versus `editor` split are source-read, not observed. `matchFrame` is lenient on both and T011 verifies on a real 18.18.3 run.
- **A3 (resolved)**: An empty Other counts as unanswered; it blocks Submit for a radio group or a `required` field and is sent as no selection for an optional checkbox group (spec US2.2, FR-011).
- **A4 (low)**: Plan names `AskFormHistory.tsx` or a read-only mode of `AskFormCard`; T006 resolves it at implement time (prefer the read-only mode, to avoid a second card).
- **A5 (info)**: Terminology is consistent: "Ask card", "field", "frame", "Other", "Done selecting". No contradictions between spec, plan and tasks.
- **A6 (info)**: Constitution: no violation. Rust untouched, no new dependency, shared components used.

No `[NEEDS CLARIFICATION]` markers remain. No critical findings; safe to implement T001 to T011.

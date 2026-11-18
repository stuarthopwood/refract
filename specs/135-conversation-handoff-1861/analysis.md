# Analysis: spec 135 (#1861)

Read-only cross-check of `spec.md`, `plan.md` and `tasks.md` against the issue, the 2026-11-17 and 2026-11-18 grill comments and the code at `origin/main` 6f3a93c9.

## Coverage

| Requirement | Plan section | Tasks |
|---|---|---|
| FR-001 three tools | Target plan, Tool results | T007-T010 |
| FR-002 rules | Target plan | T007 |
| FR-003 helper | `start_conversation_with` | T001 |
| FR-004 deferral | Deferral state | T003-T006 |
| FR-005 errors | Target plan | T007 |
| FR-006 event | Event and renderer | T011 |
| FR-007 card text | Target plan step 6 | T007 |

Every scenario in the spec maps to a numbered live check in `plan.md`.

## Findings

- **Open 1 (conflict between grill notes).** The 2026-11-17 comment says AGENTS.md now asks for co-located unit tests, and the issue body and the 2026-11-18 comment say no new tests. The assignment follows 2026-11-18 (live check only). Main should confirm before Phase 2.
- **Open 2 (superseded text).** The 2026-11-17 rule "another Session that is Working is refused with `invalid_state`" is replaced by deferral (2026-11-18). The spec records the replacement; the issue body should be updated.
- **Open 3 (unverified code).** The plan cites `handle_turn_settled` (`frame.rs:188`) and the stop paths, but the settle handler body was not read in full. Implementation must confirm the hook point is after the status becomes idle and that `turn_abort_requested` is still readable there.
- **Open 4 (agent sees the notice).** Whether a transcript notice reaches omp as context on the next turn is unverified. Scenario 8 checks it; if not, the fallback is to prefix the next user prompt with the notice.
- **Open 5 (stopped target).** The `conversations.startNew` handler body was not read; A5 depends on it (a stopped Session may no-op `startNew`, `conversations.rs:12-22`).
- **Open 6 (spec number).** Number 135 was the next free on `origin/main`; parallel Wave 5 lanes may have picked the same number. The folder suffix `-1861` keeps the paths distinct; Main should renumber on merge if needed.
- **Low (role gating).** Which roles and depths get the tools is assumed to match the other Session tools (A7); `agent_tools/mod.rs` registration should be checked at implementation.
- No duplicated or contradictory requirements found inside the three documents. No requirement lacks a task.

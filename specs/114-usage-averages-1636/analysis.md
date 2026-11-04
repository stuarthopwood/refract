# Analysis: spec, plan, tasks (#1636)

Result: PASS after resolving 4 findings. No CRITICAL left.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | HIGH | `queries.rs` is 597 lines; adding fields and queries breaches the 600-line cap. | Plan and T1 move `Summary`, `summary()`, `tool_totals()` to `queries_summary.rs`; FR-008 added. |
| 2 | MEDIUM | Issue says `$0.042` but `formatUsd` rounds values of $0.01 and over to cents. | Added `formatUsdPerCall` (T7), decision recorded in Clarifications. |
| 3 | MEDIUM | "Session" unit undefined for `sessions` (conversation file vs Session directory). | Chose distinct `session_file`, as Top sessions does; flagged as overrule-able. |
| 4 | LOW | Chart and average could disagree on day boundary. | T2 shares the bucket expression and exact-rows rule. |

Coverage: every FR (001 to 008) maps to a task; both user stories and the panel story map to T3/T8/T9/T10. No task lacks a requirement. Verification rule (Rust test extension, live check) covered by T4 and T10. No constitution conflict (prototyping: no new tests).

Open items (none blocking): Session unit and per-call precision are defaults chosen by the lane, both listed in the spec.

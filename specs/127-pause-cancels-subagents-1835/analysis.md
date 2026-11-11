# Analysis: spec 127 (#1835), 2026-11-11

Read-only cross-check of `spec.md`, `plan.md`, `tasks.md` against the code on `origin/main` 3cdc19cd and the 2026-11-10 probe log. No constitution violations found.

## Coverage

| Requirement | Tasks | Plan location |
|---|---|---|
| FR-001, FR-002, FR-003 | T002, T004, T005 | `pause.rs:124-164`, `pause_subagents.rs` |
| FR-004 | T002, T004, T005 | `frame.rs` match arm |
| FR-005 | T003, T006 | `pause.rs:15-22`, `:194-204` |
| FR-006 | T006 | `pause.rs:167-192` |
| FR-007, SC-004 | T002, T008 | none new |
| FR-008 | T006 | `append_notice`, `mod.rs:384` |
| FR-009 | T009 | existing `subagents_progress.rs:195-275` |

All requirements map to at least one task. No task lacks a requirement except T010, T011 (docs, verification). T001 is dropped (DC-1).

## Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A1 | Medium | The grill says "remove the Pausing state". The Pausing the grill meant (wait for subagents, 2-minute grace) was never on `main`. What is on `main` is the turn-boundary Pausing derived in `pause.rs:25-36` and shown in `ChatHeader.tsx`, `PausedBody.tsx`, `sessionDisplay.tsx`. Removing it is a renderer and spec 056 change the grill did not clearly cover. | Resolved 2026-11-11 (DC-2): keep turn-boundary Pausing; no renderer change. |
| A2 | Medium | Sequential `cancel_subagent` calls inside `pause()` could delay `emit_status` by N x RPC timeout if OMP stalls. | T004 sends them concurrently; FR-002 bounds the wait. |
| A3 | Medium | The 13:57 decision (revive on Resume via a continue message) conflicts with the RPC docs: `steer_subagent` answers `Subagent not running` for a cancelled subagent. The probe revived through the parent's `write agent://<id>` tool. | Resolved 2026-11-11 (DC-1): Resume does not revive; T001 and T007 dropped. |
| A4 | Low | Resume must clear `held` before reviving, or FR-004 cancels the revived subagent's own `started` frame (it carries no `parentToolCallId`). | Resume clears `held` first (`drain_held`, `pause.rs:202`). No revive is built (DC-1), so this is a guard only. |
| A5 | Low | Auto-cancel inside `handle_frame` could stall the frame pump if awaited. | T004 verifies; spawn with `arc()` if needed. |
| A6 | Low | The 13:57 decision's agent-to-agent message gating (hold or block) cannot be implemented from Refract: those messages travel inside OMP, and no #1672 watchdog code is on `main`. | DC-4: out of scope, interim not built. |
| A7 | Low | No unit-test double for `get_subagents`/`cancel_subagent` exists in `scripts/verify-tauri-fake-omp.mjs`. | Tests use a stub process; live check uses real OMP (plan Risks). |
| A8 | Info | FR-004 depends on `set_subagent_subscription`; older OMP answers `success:false` (`subagents_progress.rs:176-190`) and auto-cancel then degrades silently. | Stated in the spec's Edge Cases. |

No CRITICAL findings. A1 and A3 were decided 2026-11-11; no decisions are pending before implement.

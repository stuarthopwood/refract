# Analysis: Agents archive, stop, pause, resume and delete Sessions (#1860)

Cross-artifact consistency pass over spec.md, plan.md, data-model.md, contracts/tools.md, quickstart.md and tasks.md, against the code at `e82fb419`. Every finding below was fixed in the docs in the commit that adds this file.

## Findings

| ID | Severity | Finding | Fix |
|---|---|---|---|
| A1 | High | `delete_core` ran the refusal checks and the claim together, but the tool must run the refusals before the card and claim only after approval. | T002 now extracts `delete_precheck` (no claim) and `delete_core` (re-checks, claims, starts); T014 uses both. |
| A2 | Medium | `stop_core` was declared without a `Result`, while plan.md and the handler return errors (`not_found`). | T003 returns `Result<(), IpcError>`. |
| A3 | Medium | The contract's `cancelled` case "own-tree status changed while the card was open" had no task or test for tools that show no card (unarchive, pause, resume). | T011 and T013 tests added, mirroring `commit_update`. |
| A4 | Medium | T016 required a test through `delete_core`, which needs a real worktree. | Test moves to the `remove_session` seam, only when no existing test covers it. |
| A5 | Low | FR-014 was worded as a negation ("No new tests are skipped"). | Reworded as a positive requirement. |
| A6 | Low | plan.md project structure listed a stray "research-free" label. | Replaced by the real file list. |

## Coverage

- Every FR maps to at least one task (see the Coverage section in tasks.md); every SC maps to T021 or T024.
- Every edge case in spec.md has a task test: self/ancestor/Personal Agent (T006), state mismatches (T009 to T014), deleting member in a cascade (T010), caller deleted (T009, T014), set changed under the card (T010), cancelled and shut-down calls (T009 spawn-and-await).
- Every decision in the Clarifications section appears in contracts/tools.md and quickstart.md.

## Constitution and rule checks

- ADR 0009: delete re-roots live children in `Registry::remove_session` (`store/registry.rs:471`, loop at `:488`), called from `delete_in_flight.rs:147-153`; archive never touches children; unarchive reuses the `child-limit` gate (`sessions_lifecycle.rs:282`). No second path.
- AGENTS.md: why-only comments, Testing rule per guard, 600-line cap handled by Phase 1 extractions (`sessions_lifecycle.rs` 582, `router.rs` 556, `registry.rs` 557, `sessions_agent.rs` 516; none is in the baseline file).
- No renderer change, so no reusable-component or UI rule applies.

## Open questions

None.

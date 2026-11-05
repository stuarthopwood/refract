# Analysis 060

Read-only consistency pass over `spec.md`, `plan.md`, `data-model.md`, `contracts/ipc.md`, `research.md`, `quickstart.md`, `tasks.md` (2026-10-30).

Coverage: FR-001 S2-05, S2-06; FR-002 S1-01, S1-03, S1-10; FR-003, FR-004, FR-005 S1-07, S1-09, S1-17; FR-006 S1-10, S1-15; FR-007 S1-16; FR-008, FR-009 S1-11, S1-15; FR-010 S1-12, S1-13; FR-011 S1-03, S1-15, S2-15; FR-012 S2-08 to S2-14; FR-013 S2-01, S2-03, S2-04, S2-11; FR-014 S2-12; FR-015 S1-07, S1-15 (no prose column in `data-model.md`); FR-016 S1-14 plus every new file under 600 lines (S1-11 and S2-12 name their split); FR-017 S1-02, S1-19; FR-018 S2-01 to S2-04. SC-001 to SC-003 are measured in S1-19 and S2-18 on the generated fixture; SC-004 in S2-18.

Constitution: I pass (reading session files is ADR 0006; `omp usage --json` is a one-shot read-only CLI, not a session). II and III untouched. IV pass: field names verified on real files and on the real `omp usage --json` output. V pass: no new capability or CSP entry, SQL parameterised, sort keys allowlisted, no renderer-supplied paths, `omp` spawned by argv.

Rules: `ipc.ts` and `App.tsx` do not grow (contract in `ipc-usage.ts`, prefs in `usage.db`, one net-zero branch). No new renderer tests; Rust tests limited to S1-17. Reusable components: four new shared components, each with a named consumer.

Findings:
- Fixed during this pass: `topSessions` could not honour model, reasoning or agent filters from `session_rollup`; `data-model.md` now groups `messages` in that case.
- Risk, accepted: `usage.premiumRequests` is stored but unused; if Copilot billing reverts to request multipliers the credits rule (spec Clarifications) is revisited.
- Risk, accepted: a Project added after ingest relabels only on the next scan (five-minute rescan or `usage.start`); ingest starts at app launch (#1655), so the view does not need to start it.
- Open (not blocking): Command palette "Open Usage" cannot be registered until #5 exists; S2-16 ships the descriptor only.
- Open (verify at implement): `plan_snapshot()` assumes `quota_snapshots.premium_interactions` also exposes `entitlement` and `quota_remaining` in the same units as `omp usage --json` (both observed consistent: 2,000,000 limit); S1-19's fake `gh` must use the real field names, and S1-13 confirms the units against one real read-only call.
- Open (verify at implement): SC-002 and SC-003 timings are targets until measured on the fixture.

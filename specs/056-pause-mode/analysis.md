# Analysis: Pause mode (spec 056)

Cross-check of spec.md, plan.md and tasks.md (2026-10-29, Skippy, delegated by Stuart).

- Coverage: FR-001..004 map to T001-T003; FR-005/006 to T005; FR-007 to T004 and T006; FR-008 to T007-T008; FR-009 to T009; FR-010/011 to T010. No requirement lacks a task.
- Consistency: the separate `pause` field (clarify) is what plan and tasks use. FR-003 says the Pausing-to-Paused change happens at turn settle; the implementation derives `pausing` or `paused` from the Session status at wire time, so the same observable behaviour needs no transition code.
- Constraint check: `src/shared/ipc.ts`, `model.ts`, `App.tsx`, `ChatPane.tsx` and `agent/mod.rs` are at their file-size caps, so new types and components live in new modules (`ipc-pause.ts`, `pause.rs`, `chat_pause.rs`, `PausedOverlay`). Principle V: no new capability or shell access; all new channels go through the existing `refract_request` dispatcher.
- Risks: held messages lose images (refused while paused, withdrawn queue items lose images; follow-up). Resume with held messages and no running agent returns `agent-not-running` and stays paused.
- Verdict: no blocking gaps; proceed to implement.

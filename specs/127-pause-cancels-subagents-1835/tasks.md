# Tasks: Pause cancels the Session's subagents (#1835)

**Spec**: `specs/127-pause-cancels-subagents-1835/spec.md` | **Plan**: `plan.md`

- [ ] T001 DROPPED 2026-11-11 (DC-1: Resume does not revive, so no revive-proof gate).
- [x] T002 Red tests first in `pause_subagents.test.rs` for FR-001, 003, 004, 007 (stub process records RPC; `get_subagents` with two ids; `cancelled:false`; no subagents sends only `get_subagents`; lifecycle `started` while paused and not paused)
- [x] T003 Add `cancelled: Vec<String>` to `pause::State` (`pause.rs:15-22`) (FR-005)
- [x] T004 New `pause_subagents.rs`: `cancel_running_subagents` (send the `cancel_subagent` requests concurrently so N subagents cost one RPC timeout, not N), `on_subagent_started`; register `mod` in `agent/mod.rs`; confirm no frame-pump deadlock, spawn if needed (FR-001..004)
- [x] T005 Call `cancel_running_subagents` from `pause()` (`pause.rs:123-164`) before `emit_status`, and `on_subagent_started` from `frame.rs` `subagent_lifecycle` handling (FR-001, FR-004)
- [x] T006 Notices: one per Pause that cancelled something, one per auto-cancel; Resume posts one notice naming the cancelled subagents and clears `cancelled` (FR-005, FR-006, FR-008)
- [ ] T007 DROPPED 2026-11-11 (DC-1: Resume does not revive; no reviving code).
- [x] T008 Unit tests green; assert spec 056 behaviour unchanged (held order, `pauseAll`) (FR-007, SC-004)
- [x] T009 Live check with real OMP and evidence file (SC-001, SC-002); verify the Subagents panel shows Cancelled (FR-009)
- [x] T010 Docs: `CONTEXT.md:51` glossary line, pointer in `specs/056-pause-mode/spec.md`, `docs/PLAN.md` row for #1835
- [x] T011 `cargo test`, `pnpm ci:local`, file-size check in the Rust build slot

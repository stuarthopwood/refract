# Tasks: Degraded-only agent health readouts

- [x] T001 Add `Win32_System_ProcessStatus` to `src-tauri/Cargo.toml` (FR-004)
- [x] T002 `omp/process/latency.rs` and the `process.rs` hook, within the file-size baseline (FR-002)
- [x] T003 `SessionAgent::process_handle` accessor (FR-003)
- [x] T004 `session/health.rs` thresholds, hysteresis, working-set read, debug force hooks, monitor loop (FR-003, FR-004, FR-008)
- [x] T005 `session:health` event and `emit_session_health` in `events.rs`; start from `shell/memory.rs` (FR-003)
- [x] T006 IPC key, bridge method, init-stores subscription (FR-003, FR-009)
- [x] T007 `session-health-store.ts` (FR-005)
- [x] T008 `HealthReadouts.tsx` and mount in `ComposerStatusLine.tsx` (FR-001, FR-006, FR-007)
- [x] T009 `pnpm typecheck`, `pnpm test`, `check:file-size`, `check:parity`
- [x] T010 `docs/PLAN.md` row 4b, `CONTEXT.md` note
- [x] T011 Review gate (code-reviewer, test-reviewer, security-auditor, accessibility-auditor, ui-architect-v3)
- [x] T012 Build slot: merge `origin/main`, `pnpm ci:local`, live check with the force hooks
- [ ] T013 PR (not merged)

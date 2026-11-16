# Tasks: Pause mode (spec 056)

- [x] T001 Backend `session/pause.rs` and `AgentState` field (FR-001..004)
- [x] T002 `send` hold, turn-settle transition, queue withdrawal (FR-002, FR-003)
- [x] T003 Registry persistence and paused relaunch (FR-003)
- [x] T004 `pause` in `session:status`, list and runtime view (FR-007)
- [x] T005 IPC `chat.pause/resume/pauseAll/resumeAll` and `/pause` toggle (FR-001, 004, 005, 006)
- [x] T006 Shared types, bridge, store plumbing (FR-007)
- [x] T007 Status display: paused entry, "Pausing…" label (FR-008)
- [x] T008 PausedOverlay, inert blur (FR-008)
- [x] T009 Controls: row menu, header button, Pause all/Resume all (FR-009)
- [x] T010 Space resume, shortcuts dialog, palette, announcement (FR-010, FR-011)
- [x] T011 PLAN.md, CONTEXT.md, verify script and screenshots
- [x] T012 Five-reviewer gate, ci:local (build slot), live check, PR

## Phase 2: Convergence

- [x] T013 Add a unit test for the `setAllPaused` "Resumed N, M failed to start" notice per FR-005 (pauseActions.test.ts)
- [x] T014 Confirm no verify script still clicks the removed paused-overlay Start agent button, and fix any that does, per FR-008 (verify-tauri-1890.mjs asserts it is absent; other Start agent clicks are unrelated stopped-bar flows)
- [x] T015 Run unit tests and `pnpm ci:local`; prove the resume regression test fails with the start call removed per FR-004 (mutation: 3 tests fail; clippy, build, check:ui-text green; one pre-existing git-timeout flake passes alone)
- [x] T016 Live check on a scratch copy: Resume starts the agent and sends the held message; Stop idle shows the skipped line per FR-004, FR-012 (7/7 at 6917cb68)
- [x] T017 Update the docs/PLAN.md row for #1890 (in review row present)

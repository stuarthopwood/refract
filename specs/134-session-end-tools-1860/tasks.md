# Tasks: Agents archive, stop, pause, resume and delete Sessions (#1860)

Test work is part of each task (AGENTS.md Testing rule: new logic gets co-located unit tests using the shared test utilities; every guard's test must fail when the guard is removed, proven by mutating then restoring). Run tasks in order within a phase; phases run in order. Files stay under the 600-line cap: `ipc/sessions_lifecycle.rs` (582), `agent_tools/router.rs` (556), `ipc/sessions_agent.rs` (516) and `store/registry.rs` (557) are near it, so Phase 1 extracts first and none of them grows. None is in `scripts/file-size-baseline.json`, so none may be added to it. Do not run `ci:local` before T031. Commit and push after each phase (`feat(sessions): ... (#1860)`).

## Phase 1: Make room and expose the existing actions (no behaviour change)

- [X] T001 (done; no test: prototyping rule) archive_core/restore_core in `ipc/sessions_lifecycle/archive_core.rs`.
- [X] T002 (done) delete_precheck/delete_core in `ipc/sessions_lifecycle/delete_core.rs`.
- [X] T003 (done) stop_core in `ipc/sessions_agent/stop_core.rs`.
- [X] T004 (done) run_native moved to `agent_tools/router_native.rs`.

## Phase 2: Shared guards and the approval table

- [X] T005 EndTool, parse_args, error codes in `agent_tools/sessions_end.rs`; tests in `sessions_end.test.rs`.
- [X] T006 ancestors_of, refuse_target; tests in `sessions_end.test.rs`.
- [X] T007 needs_card (all 24 rows), card_for; tests in `sessions_end.test.rs`.
- [X] T008 EndHost and AppEndHost; fake host (`FakeHost`) in `sessions_end.test.rs`.

## Phase 3: The six tools

- [X] T009 archive single target: `sessions_end_tools.rs` + `sessions_end_tools.test.rs`.
- [X] T010 archive cascade, one card, deepest first, recheck under gate.
- [X] T011 unarchive through the child limit gate.
- [X] T012 stop.
- [X] T013 pause and resume.
- [X] T014 delete: precheck, card even in yolo, then delete_core.
- [X] T015 tool fns live in `sessions_end_tools.rs`; guards and table stay in `sessions_end.rs`.

## Phase 4: Delete re-rooting (ADR 0009)

- [x] T016 Verify, do not re-implement: re-rooting already happens in `Registry::remove_session` (`store/registry.rs:471-511`, live children get `parent_session_id = None` in the same persist, archived keep their link, rolled back on write failure), called by the background delete at `delete_in_flight.rs:147-153`. Covered by `registry_tests.rs::removing_a_session_re_roots_its_live_children_in_the_same_write`. (FR-009, SC-005)

## Phase 5: Registration everywhere names are listed

- [x] T017 `src-tauri/src/agent_tools/sessions.rs`: six name constants, extend `SESSION_TOOLS`, descriptions and parameters in `sessions_end_schema.rs`, with a test that each has a non-empty description and a closed object schema.
- [x] T018 `src-tauri/src/agent_tools/router_native.rs`: dispatch the six names to `sessions_end_tools::run`; router tests per tool and for an unlisted name.
- [x] T019 Tool-name lists: `agent_tools/mod.test.rs`, `agent_tools/overlay.rs`, `omp/token_guard/rules.rs`, `src-tauri/resources/refract-rules.md` carry the six names and the approval wording. (FR-010)
- [x] T020 `EndHost::is_yolo` reads `agent.tool_is_yolo()`, the same read as the router gate; no change needed.

## Phase 6: Live check, docs, gate

- [x] T021 `scripts/verify-tauri-1860.mjs`: live check per `quickstart.md` cases 1-13 with the fake omp over CDP (pattern of `verify-tauri-1858.mjs`); never `pnpm dev`; scratch `REFRACT_DATA_DIR`; record head sha and `dirty: false`. Screenshots of the one-card cascade and the yolo delete card. (SC-001 to SC-005)
- [x] T022 Run the live check from a clean committed tree (`pnpm exec tauri build --debug --no-bundle`, `CARGO_TARGET_DIR=C:/Users/shopwood/.cargo-target/refract`); fix regressions only; keep evidence under the scratch folder. Passed at `d94b335d`, `dirty: false`, exe sha256 `b040a739d43737f7033e999d92a78e0a3550c06bf923a23280ffbb9747dc578f`: `evidence/live-check.md`.
- [x] T023 `docs/PLAN.md` row 1c.4: mark #1860 done with PR and spec 134; `docs/adr/0009-session-tree-rules.md` one line that the end tools use the same gates; `CONTEXT.md` add **End tool** if the term is used. (FR-010) PLAN row (done-pending-PR, PR number added at merge) and ADR line are in; the term is not used outside the ADR, so no glossary entry.
- [ ] T024 `pnpm ci:local`; fix regressions only; `pnpm check:file-size` and `pnpm check:comment-density` clean. (SC-006)

## Dependencies

T001 -> T002 -> T003 -> T004 (all touch capped files, in order) -> T005 -> T006 -> T007 -> T008 -> T009 -> T010 -> (T011, T012, T013, T014) -> T015; T016 after T002 and T014; T017 after T005; T018 after T004 and T008; T019 after T017; T020 any time after T008; T021 after T014, T018 and T019; T022 after T021; T023 after T022; T024 last. Phase 1 may be done by one worker, phases 2-3 by one worker (same files), phases 4-6 after.

## Coverage

FR-001 T005, T017; FR-002/003 T006; FR-004 T007, T009 to T014; FR-005 T007, T010; FR-006 T001, T009; FR-007 T001, T011; FR-008 T003, T012, T013; FR-009 T002, T014, T016; FR-010 T004, T017 to T019, T023; FR-011 T009, T010, T014; FR-012 T009, T010; FR-013 T008; FR-014 every guard task. SC-001 to SC-005 T021; SC-006 T015, T024.

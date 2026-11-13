# Tasks: Agents create and nest Sessions (#1859)

Test tasks are part of each task (AGENTS.md Testing rule: new logic gets co-located unit tests; each guard's test must fail when the guard is removed, proven by mutating then restoring). Files stay under the 600-line cap; `router.rs` gets dispatch lines only. Each slice is about 40 requests and ends with a commit and push. Do not run `ci:local` until the last task.

## Slice 1: registry and tree rules (one worker; Rust, no tool files)

- [x] T001 `src-tauri/src/store/registry.rs` (+ test): `Session.parent_session_id` (`serde(default, skip_serializing_if)`), `SessionPatch.parent_session_id` tri-state applied by `update_session`. Tests: a registry JSON without the field loads with no parents, round trip, `Some(None)` clears. (FR-012, SC-003)
- [x] T002 `src-tauri/src/store/session_tree.rs` (+ `session_tree.test.rs`): `depth_of`, `live_children`, `descendants`, `in_tree`, `validate_parent`. Tests: depth table, cycle and dangling parent count as root, 4th child ok and 5th refused, archived not counted while stopped and hidden are, self and descendant parent refused, deeper-descendant refused. (FR-005, FR-006, FR-009)
- [x] T003 `src-tauri/src/ipc/sessions_lifecycle.rs`, `store/registry.rs` (+ test): delete re-roots live children in the same persist as the removal; archive keeps links. `src/shared/model.ts`: `parentSessionId?` on the Session type. Tests: delete re-roots live and leaves archived, archive keeps. (FR-011, FR-012)

## Slice 2: Rust tool files (one worker; new files only plus the extraction)

- [x] T004 `src-tauri/src/ipc/sessions_lifecycle.rs`: extract `create_session_record` from `sessions.create` (Worktree plus registry steps), both callers use it; no behaviour change. Existing `sessions.create` tests stay green. (FR-004)
- [ ] T005 `src-tauri/src/agent_tools/tree_gate.rs` and `approval.rs` (+ tests): process-wide async gate; Session-action approval card; own-tree decision helper. Tests: gate serialises two callers, card carries action and target, own-tree rule table. (FR-003, FR-006, FR-010)
- [ ] T006 `src-tauri/src/agent_tools/sessions_create.rs` (+ test): tool def with the rule-of-thumb description, check order, project and parent resolution, card unless `yolo`, creation, role, start, first turn (undecorated), result. Tests: every error code in order, denial creates nothing, `yolo` skips the card, first-turn text with and without parent, role validation and no inheritance, two racing creates yield one success at 3 live children, start failure keeps the Session and names its id, a caller deleted mid-create is answered `cancelled` and writes no link. (FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-013)
- [ ] T007 `src-tauri/src/agent_tools/sessions_update.rs` (+ test): tool def, check order, own-tree card rule, rename, role via `choose_role`, nest and un-nest. Tests: inside tree no card, outside tree card, deny changes nothing, self and descendant `invalid_parent`, `depth_limit`, `child_limit`, stopped target role change is `session_not_running`. (FR-008, FR-009, FR-010, FR-013)

## Slice 3: access, dispatch, rules (one worker)

- [ ] T008 `src-tauri/src/agent_tools/mod.rs`, `router.rs`, `session/agent/launch.rs`: `ToolAccess::for_depth`, Root arm adds the two defs, both launch sites pass the real depth from the registry, dispatch lines. Tests: Root lists all five, Child row still empty and a Child-role call is `unknown_tool`, a depth-2 and a depth-3 launch both register the five, a call from a shutting-down Session is `cancelled`, a child's `send_session_message` to its parent counts toward the per-pair limit. (FR-001, FR-015, FR-017)
- [ ] T009 `src-tauri/src/agent_tools/sessions.rs`, `sessions_status.rs` (+ tests): `parentId` on list rows and status. Test: present only when set. (FR-016)
- [ ] T010 `src-tauri/resources/refract-rules.md`, `src-tauri/src/omp/token_guard/rules.rs` (+ test): rule-of-thumb block (at most 900 characters) and the raised size bound. Test: the shipped rules contain the three-way choice and stay in bounds. (FR-014)

## Slice 4: live check and docs (one worker, after 1 to 3)

- [ ] T011 `scripts/verify-tauri-1859.mjs` and tape support in `scripts/verify-tauri-fake-omp.mjs`, run with the `pnpm verify:tauri` harness: create in `yolo` and under the card (approve and deny), 4th and 5th child, depth-3 refusal, update nest and un-nest and rename, delete re-roots, old registry loads, child first turn names the parent, a child report reaches the parent and the 11th is `rate_limited`, every error with no toast. Screenshots and timings recorded. (SC-001, SC-002, SC-003, SC-004)
- [ ] T012 `docs/adr/0009-session-tree-rules.md`, `CONTEXT.md` (Child Session update, **Own tree**), `docs/PLAN.md` row 1c.3. (FR-018)
- [ ] T013 `pnpm ci:local`; fix regressions only. (SC-005, SC-006)

## Dependencies

T001 -> T002 -> T003 -> T004 -> T005 -> (T006, T007) -> T008 -> T009; T010 independent; T011 after T008, T009 and T010; T012 -> T013. T003 and T004 both edit `sessions_lifecycle.rs`, so slices 1 and 2 run in order.

# Tasks: Agent tool channel and panel tools (#1193)

No test tasks: the prototyping rule forbids new tests; existing tests are only run. Chunks A and B touch disjoint files and can run in parallel after T001. Chunk C needs both.

## Wave 0: contract (one worker, first)

- [x] T001 `contracts/panel-actions.json` (new): the v1 action table from the spec's Decisions (panel id, action name, description, JSON Schema `inputSchema`, `mutates`, optional `openInputSchema`). Confirm whether the `jsonschema` crate is already in `src-tauri/Cargo.lock`; record the choice in the plan's "Single source of truth" paragraph. (FR-009, FR-013, FR-017) Done: `jsonschema` is NOT in `Cargo.lock`, so both sides use the small hand check (see plan).

## Chunk A: Rust channel and registration (files: `src-tauri/**` only)

- [ ] T002 `src-tauri/src/agent_tools/mod.rs`, `panels.rs`: `ToolAccess`, `tools_for`, `host_tool_defs`, the embedded contract, `is_mutating`, argument validation. (FR-001, FR-004, FR-012)
- [ ] T003 `src-tauri/src/agent_tools/router.rs`: pending map, `handle_call`, `handle_cancel`, `answer`, `drop_all`, 10 s timeout, 8 KiB cap, error codes (`unknown_tool`, `unknown_panel`, `unknown_action`, `invalid_input`, `panel_unavailable`, `denied`, `timeout`, `cancelled`, `result_too_large`, `renderer_unavailable`). (FR-003, FR-005 to FR-008)
- [ ] T004 `src-tauri/src/agent_tools/approval.rs`: Refract-owned approval for mutating actions, skipped in `yolo`; `src-tauri/src/session/agent/requests.rs` and `types.rs`: `answer_request` completes ids prefixed `refract-tool-`. (FR-013)
- [ ] T005 `src-tauri/src/agent_tools/overlay.rs`; `src-tauri/src/omp/process_args.rs` and `omp/process.rs`: `extra_config` option and `--config` pairs. (FR-002)
- [ ] T006 `src-tauri/src/session/agent/frame.rs` (two arms), `launch.rs` (one register call, overlay path), `session/agent/mod.rs` (router field and accessor), `lib.rs` (`mod agent_tools`). Keep edits to the lines named in the plan. (FR-001, FR-003, FR-008)
- [ ] T007 `src-tauri/src/events.rs`: `AGENT_TOOLS_CALL` and `emit_agent_tools_call`; `src-tauri/src/ipc/agent_tools.rs` and `ipc/mod.rs`: `agent_tools.result`. (FR-005)

## Chunk B: Renderer panel registry and actions (files: `src/renderer/**` only)

- [ ] T008 `src/renderer/features/right-pane/panel-registry.ts`: `actions` on `HostedPanelDescriptor`, derived from `contracts/panel-actions.json`. (FR-009)
- [ ] T009 `src/renderer/features/right-pane/agent-panel-actions.ts` (new): handler map for the seven v1 actions, reusing `git-changes-store` (`stage`, `unstage`, file selection), the File Explorer, Subagent and pinned pull-request stores; add any missing select or reveal entry point to that store. Worktree-relative path validation. (FR-017)
  - Investigation (not implemented): the #1155 open path is `usePullRequestsStore.getState().openPullRequest(repositoryId, number)` (`src/renderer/state/pull-requests-store.ts:140`) followed by `useViewStore.getState().openPullRequests()` (`view-store.ts:63`); callers: `features/chat/ItemRefLink.tsx:92-97`, `features/right-pane/pinned/PinnedPullRequestPanel.tsx:20-21`, `features/home/HomeGitHubSections.tsx:58-59`. Those switch the whole window to the Pull requests view, which is NOT a right-pane open. The right-pane `pull-request` panel is shown by `usePinnedPanelsStore.pin('pull-request', { repositoryId, number })` (`state/pinned-panels-store.ts:42`), which also does `requestAnimationFrame(... .focus())` at line 54 when the panel is already active (a swap moves focus), so `open_pull_request` needs a no-focus option on `pin` to honour FR-011/FR-015. `repositoryId` comes from the front Session's `repositoryId` (`ItemRefLink.tsx:82`).
- [ ] T010 `src/renderer/features/right-pane/agent-tool-dispatch.ts` (new): `listPanels`, `openPanel` (`{ focus: false }`), `invokePanelAction`, front-Session check. (FR-010 to FR-012, FR-014, FR-016)
- [ ] T011 `src/renderer/features/right-pane/AgentOpenedAnnouncer.tsx` and `src/renderer/state/agent-announcement-store.ts` (new): polite live region, announced once per open. (FR-015)

## Chunk C: wiring and live check (after A and B; files: shared contract, bridge, entry, scripts, docs)

- [ ] T012 `src/shared/ipc.ts`, `src/tauri-bridge/index.ts`, `contracts/ipc.md`, typings: event and command. (wire contract)
- [ ] T013 `src/renderer/features/right-pane/agent-tools-bridge.ts` (new) and `src/renderer/App.tsx`: subscribe, dispatch, reply, mount the announcer; no toast path. (FR-005, FR-007)
- [ ] T014 `scripts/verify-tauri-1193.mjs` and a tape for `scripts/verify-tauri-fake-omp.mjs`: each tool, each error code, cancel, timeout, focus stays in the composer. (SC-001, SC-002)
- [ ] T015 Real omp 18.17.0, ask mode, screenshots: read call shows no `Allow tool:` prompt, mutating call shows one card, Deny gives a tool error. If it fails, apply the plan's fallback and update ADR 0007. (SC-003)
- [ ] T016 `CHANGELOG.md`; set `docs/PLAN.md` row 1c.1 to in review with the PR number; `pnpm ci:local`. (FR-018, SC-004)

## Dependencies

T001 before A and B. A and B run in parallel (disjoint trees). C after A and B. Within A: T002 before T003 to T007; T003 before T004.

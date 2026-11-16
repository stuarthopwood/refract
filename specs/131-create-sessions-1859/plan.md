# Implementation Plan: Agents create and nest Sessions

**Spec**: [spec.md](spec.md) | **Issue**: #1859 | **Route**: specify (spec 131) | **Builds on**: spec 129 (#1858), spec 124 (#1193), ADR 0007

## Summary

Two Host tools, `refract_create_session` and `refract_update_session`, answered in Rust like the spec 129 tools. A pure tree module computes depth, live children, descendants and re-parent validity from registry rows. Creation reuses the hand-made Session path through one extracted function. The registry gains `parent_session_id`. Every Refract launch registers the Session tools (the Child row stays empty), and the rules file gains the rule-of-thumb block.

## Grounding (read at origin/main 7149e691; verify again at implement time)

- `src-tauri/src/agent_tools/mod.rs:26-48`: `Role {Root, Child}`, `ToolAccess { role, depth }`, `ToolAccess::root()` (depth 1), `tools_for(access)`; Child arm empty. `session/agent/launch.rs:188` and `:293` pass `ToolAccess::root()` for both registrations.
- `agent_tools/{sessions,sessions_send,sessions_limit}.rs`, `approval.rs` (`needs_approval(mutates, yolo)`, card builder with `REQUEST_PREFIX`), `router.rs` (`handle_call`, ~549 lines at 7149e691, dispatch only; split `Plan` out if it would pass 600).
- Creation: `ipc/sessions_lifecycle.rs:26-90` `sessions.create` calls `git/worktrees.rs:117` `add_worktree_with_generated_name(repo, base_branch)` then `registry.add_session`. `registry.rs:322` `add_session` rejects duplicate paths.
- Registry: `store/registry.rs:35` `Session`, `:93` `SessionPatch` (tri-state patterns for `archived_at`, `hidden_at`), `:396` `update_session`, `:462` `remove_session`, `:488` `get_session`.
- Rename: registry `update_session_name`. Role: `session/pending_selection.rs:226` `choose_role` with `model::known_role_list()` (`ipc/model.rs:110`).
- Send: `SessionAgent::send` with the #1858 undecorated entry; start: `SessionManager::get_or_create_agent(id)` then `SessionAgent::start`.
- Rules: `omp/token_guard/args.rs:56` pushes `--append-system-prompt <rules file>` from `rules.rs` (`resources/refract-rules.md`); the test `shipped_rules_are_about_one_and_a_half_k_chars` bounds it to 1000..=2000.

## Design

### Registry and tree (Rust)

- `Session.parent_session_id` and the `SessionPatch` tri-state; `update_session` applies it.
- New `store/session_tree.rs` (pure functions on `&[Session]`, no I/O): `depth_of`, `live_children`, `descendants`, `in_tree(caller, id)`, `validate_parent(sessions, id, new_parent) -> Result<(), TreeError>` returning `InvalidParent | DepthLimit | ChildLimit`, with cycle-safe walks and dangling parents treated as roots.
- Delete path (`ipc/sessions_lifecycle.rs` and the registry remove) re-roots live children in the same persist as the removal.

### Tools (Rust)

- `agent_tools/sessions_create.rs`: validate input, resolve parent and Project, take the tree gate, check depth and width, raise the card (unless `yolo`), call the extracted creation function, apply role, start, send the first turn, return the row. The gate is a process-wide `tokio::sync::Mutex<()>` in `agent_tools/tree_gate.rs`.
- `agent_tools/sessions_update.rs`: validate, own-tree test, `validate_parent`, card when outside the own tree, then patch rename, role and parent.
- Extraction: `ipc/sessions_lifecycle.rs` `sessions.create` body becomes `pub(crate) async fn create_session_record(...)` used by both the IPC handler and `create_session` (the Worktree and registry steps stay the single copy).
- Approval: `approval.rs` gains a Session-action card (target `sessions`, action `create_session` or `update_session`, details name/prompt head/parent); denial maps to the spec 124 error.
- `agent_tools/mod.rs`: `ToolAccess::for_depth(depth)` (Root role, real depth); `tools_for` Root arm adds the two defs; the launch sites compute depth from the registry. `router.rs`: dispatch lines.
- `agent_tools/sessions.rs` and `sessions_status.rs`: add `parentId` to rows and status.

### Rules

- `refract-rules.md` gains the block (at most 900 characters); the size test's upper bound is raised to match. The `create_session` description repeats it.

### Docs

ADR `0009-session-tree-rules.md`, `CONTEXT.md` (Child Session wording, **Own tree**), contract 131, `docs/PLAN.md` row 1c.3.

## Tests (AGENTS.md Testing rule: co-located; each guard's test fails when the guard is removed)

- `session_tree` (depth table, cycle, dangling parent, 4th ok and 5th refused, archived not counted, stopped and hidden counted, self and descendant parent refused, deeper-descendant refused).
- Registry (old JSON loads with no parent, round trip, tri-state patch, delete re-roots live children only, archive keeps).
- `sessions_create`/`sessions_update` (check order, own-tree card rule, `yolo`, denial creates nothing, first-turn text, role validation, project mismatch, atomic race of two creates, start failure keeps the Session).
- `mod` (`tools_for` Root lists all five, Child still empty, `unknown_tool`), rules size.
- Live: `scripts/verify-tauri-1859.mjs` on the fake-omp harness; timings and screenshots in the PR.

## Risks

- `sessions.create` may carry IPC-only concerns (events, visibility); extraction must keep them in the handler and move only the shared steps.
- `router.rs` headroom is small: dispatch only, split `Plan` into `plan.rs` if needed.
- `choose_role` on a mid-launch agent may queue rather than apply; the contract says "now if idle, else at next idle".

# Implementation Plan: Agents archive, stop, pause, resume and delete Sessions

**Branch**: `feat/1860-session-end-tools` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

## Summary

Add six native Host tools (Rust answers them, no renderer round trip, spec 124) that call the code behind the Archive, Restore, Stop, Pause, Resume and Delete actions. A new `agent_tools/sessions_end.rs` owns argument parsing, the shared guards (self, ancestor, Personal Agent, state) and the approval table; the actions themselves are lifted out of the IPC handlers into plain `pub(crate)` core functions that both the handler and the tool call, so there is one implementation per action. Delete re-rooting already lives in `Registry::remove_session` and is reused through the #1591 background delete.

## Technical Context

**Language**: Rust (Tauri backend), no renderer change. **Storage**: the existing registry JSON; no schema change. **Testing**: Rust unit tests co-located (`*.test.rs` via `#[path]`, shared test utilities), plus a live check `scripts/verify-tauri-1860.mjs` with the recorded-frame fake omp. **Constraints**: no file over 600 lines (baseline must not grow), why-only comments, `pnpm check:comment-density`.

## Constitution / Rules Check

- Rust owns every check and write (ADR 0007, spec 124); the tree gate serialises writes (spec 131). PASS.
- ADR 0009: delete re-roots, archive keeps links, no tool bypasses the 4-live-children gate. PASS: unarchive calls the same gate code; archive never touches children.
- AGENTS.md Testing rule: each guard has a test that fails when the guard is removed. PASS (tasks name them).
- File-size cap: `ipc/sessions_lifecycle.rs` (582), `agent_tools/router.rs` (556), `ipc/sessions_agent.rs` (516) are near the cap, so extraction tasks come first and tool code goes in new files.

## Code map (verified on `e82fb419`)

| Concern | Location |
|---|---|
| Tool names, schemas, descriptions, `SESSION_TOOLS` | `agent_tools/sessions.rs:13-26` |
| Dispatch of native tools | `agent_tools/router.rs:399-412` (`run_native`) |
| Card, `needs_approval`, `session_card` | `agent_tools/approval.rs` |
| Own-tree check, gate | `agent_tools/tree_gate.rs` (`inside_own_tree`, `lock`) |
| Host trait pattern (card, yolo, registry) | `agent_tools/sessions_update.rs` (`Host`, `update_with`, `commit_update`) |
| `yolo` read | `session/agent/tool_host.rs:46` (`tool_is_yolo`) |
| Other lists of tool names | `agent_tools/mod.test.rs:15`, `agent_tools/overlay.rs:40`, `omp/token_guard/rules.rs:45`, `src-tauri/resources/refract-rules.md:33` |
| Archive / restore | `ipc/sessions_lifecycle.rs:214` / `:262` (4-live-children gate `:282`) |
| Stop | `ipc/sessions_agent.rs:467` (`sessions_stop_agent`) |
| Pause / resume | `SessionAgent::pause` / `resume` (`session/agent/pause.rs:186,231`), handlers `ipc/chat_pause.rs:42,49` |
| Delete refusals / delete | `ipc/sessions_lifecycle.rs:318` / `:385`; background `ipc/sessions_lifecycle/delete_in_flight.rs` (`claim`, `start`) |
| Delete re-rooting | `store/registry.rs:471-511` (`remove_session`), called from `delete_in_flight.rs:147-153` |
| Tree helpers | `store/session_tree.rs` (`descendants`, `in_tree`, `live_children`, `MAX_LIVE_CHILDREN`) |

## Design

1. **Core extraction.** `archive_core(state, id)`, `restore_core(state, id)`, `stop_core(state, id)` and `delete_core(state, id)` become `pub(crate)` async fns that return `Result<_, IpcError>`; the IPC handlers shrink to argument parsing plus the core call. Pause and resume need no extraction: the tool calls `agent.pause()` / `agent.resume()` exactly like `chat_pause`. The extraction moves code unchanged.
2. **Shared guards (`sessions_end.rs`).** `parse_id`, then in order: `not_found` (unknown or other Project), `invalid_target` (self, ancestor, Personal Agent), `invalid_state` (per tool), approval, re-check under the gate, act. Pure functions over `&[Session]` so tests need no process.
3. **Approval table** is a pure function `needs_card(tool, in_own_tree, yolo) -> bool`: archive/stop = `!yolo`; pause/resume/unarchive = `!in_own_tree && !yolo`; delete = `true`.
4. **Archive cascade.** Under the Project tree gate compute the cascade set (`descendants` plus the target, minus already archived), refuse if any member is deleting, raise one `session_card` whose details list every name, then archive each member through `archive_core`, deepest first so a failure leaves a still-valid tree. The set is recomputed after approval; a difference returns `cancelled`. The write runs in a spawned task that the call awaits (spec 131 pattern).
5. **Unarchive** takes the gate and calls `restore_core`, which already enforces the 4-live-children gate and returns `child-limit`; the tool maps that to `child_limit`.
6. **Delete** runs the refusal checks of `sessions_delete_check`/`sessions.delete`, asks always, then `delete_core` claims the in-flight set and calls `delete_in_flight::start`; the tool returns `{ outcome: "deleting" }`.
7. **Registration.** Names, descriptions, parameter schemas in `sessions.rs` (split into a `sessions_end_schema.rs` if the file nears the cap), dispatch lines in `run_native`, and each of the four other name lists.
8. **Mode read.** Same `tool_is_yolo` as the update tool.

## Project Structure

```text
specs/134-session-end-tools-1860/   spec.md plan.md data-model.md contracts/tools.md quickstart.md tasks.md analysis.md
src-tauri/src/agent_tools/sessions_end.rs          (new: parse, guards, approval table, Host, six tool fns)
src-tauri/src/agent_tools/sessions_end.test.rs     (new)
src-tauri/src/ipc/sessions_lifecycle/archive_core.rs  (new: archive/restore/stop cores moved out of capped files)
scripts/verify-tauri-1860.mjs                      (new live check)
```

## Complexity Tracking

No violations. One deliberate duplication-avoider: the IPC handlers and the tools share the cores, so there is no second archive, stop or delete implementation.

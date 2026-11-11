# Implementation Plan: Agent tool channel and panel tools

**Spec**: [spec.md](spec.md) | **Issue**: #1193 | **Route**: specify (spec 124)

## Summary

Refract registers three host tools with omp on every launch and serves them over the RPC stream it already reads. Rust owns registration, access, approval, timeout and cancel; the renderer owns panel state and answers each call. No new tests (prototyping rule); a fake-omp tape and one real-omp run prove it.

## Grounding (read from origin/main 4a2ac76)

- `src-tauri/src/omp/process_args.rs:4-8`: `build_args` fixes `--mode rpc-ui`, `--approval-mode`, `--no-session` and appends the token-guard args. `token_guard/args.rs:34-35` already pushes `--config <overlay>`; `--config` is repeatable (omp://cli-reference.md), so a second overlay is additive.
- `src-tauri/src/omp/process.rs:61-75`: `OmpProcessOptions` carries per-launch options. `send_raw` (`process.rs:~371`) writes a frame.
- `src-tauri/src/session/agent/launch.rs:265`: `send_set_ask_dialog(self, &proc)` is the existing pattern for a post-attach, pre-prompt setup frame. Tools register next to it.
- `src-tauri/src/session/agent/frame.rs:16-18`: `match frame_type`; `:113` `handle_extension_ui_request`. `extension_ui_response` is the only reply frame today.
- `src-tauri/src/session/agent/requests.rs:92`: `APPROVAL_PREFIX = "Allow tool:"` and `types.rs:95` `PendingRequest::Approval { request_id, tool, target, details, options }` is the approval card's payload. `request:pending` / `request:resolved` events carry it to the renderer.
- `src/renderer/features/right-pane/panel-registry.ts`: `PanelId`, `HOSTED_PANELS` (`id, name, icon, hasCount`). `RightPaneShell.tsx` renders the front Session's panel (`App.tsx:300`: `sessionId={frontSessionId}`), so the pane is single and shows the front Session.
- `src/renderer/state/right-pane-store.ts:17`: `openPanel(id, { focus?: boolean })`, so `{ focus: false }` already gives "no focus move".
- `src/renderer/state/git-changes-store.ts:191-198`: `stage` and `unstage` exist.
- No MCP or host-tool code exists in `src-tauri`.

## Design

### Single source of truth for actions

`contracts/panel-actions.json` (new) lists, per panel id, each action's `name`, `description`, `inputSchema` (JSON Schema) and `mutates`, plus per-panel optional `openInputSchema`. Rust embeds it with `include_str!`; the renderer imports it (`resolveJsonModule`). `panel-registry.ts` joins it with a handler map, so `mutates` cannot drift between the process that gates approval and the process that runs the action. Both sides validate `input` against the same schema with a small hand check of `type/required/properties/additionalProperties` (plus `minimum` for integers): the `jsonschema` crate is not in `Cargo.lock` (confirmed in T001), so no new dependency is added.

### Rust: `src-tauri/src/agent_tools/` (new module)

| File | Responsibility |
| --- | --- |
| `mod.rs` | `ToolAccess { role, depth }`, `tools_for(access)` table (tool name to minimum access), `host_tool_defs(access)` for `set_host_tools`, constants (`TOOL_PREFIX`, `RENDERER_TIMEOUT_MS = 10_000`, `MAX_RESULT_BYTES = 8192`). |
| `panels.rs` | Embeds `contracts/panel-actions.json`; builds the three tool definitions and their `parameters` schemas; `is_mutating(panel, action)`. |
| `router.rs` | `ToolRouter` per SessionAgent: `pending: HashMap<id, Pending>`; `handle_call(frame)`, `handle_cancel(frame)`, `answer(call_id, result)`, `drop_all()`. Emits `agent-tools:call`. Enforces timeout with `tokio::time::timeout`. |
| `approval.rs` | Raises the card for a mutating action by inserting a `PendingRequest::Approval` with a Refract-owned request id into the existing pending map, awaiting a `oneshot`, and resolving it through `answer_request` for ids it owns. |
| `overlay.rs` | Writes the per-launch `tools.approval` overlay file next to the token-guard overlay and returns its path. |

Integration points kept to one line each, so #1785 (`launch.rs`) and #1837 (`frame.rs`) merge cleanly:

- `frame.rs`: two new match arms, `"host_tool_call" => self.agent_tools().handle_call(frame).await` and `"host_tool_cancel" => ...handle_cancel(frame).await`. No other change to the file.
- `launch.rs`: one call after `send_set_ask_dialog`: `crate::agent_tools::register(self, &proc, access).await`, plus the overlay path set on `opts` before `connect_with_warnings`.
- `process_args.rs`: `OmpProcessOptions.extra_config: Vec<PathBuf>` appended as `--config` pairs.
- `events.rs`: `AGENT_TOOLS_CALL: &str = "agent-tools:call"` and `emit_agent_tools_call`.
- `ipc/agent_tools.rs` (new) and `ipc/mod.rs` registration: `agent_tools.result`.
- `session/agent/types.rs` / `requests.rs`: `answer_request` learns to complete a Refract-owned approval (a request id prefixed `refract-tool-`) by signalling the oneshot instead of writing `extension_ui_response`. This is the only edit to those files.

`pending` entries are removed on result, timeout, cancel and process exit (`settle_turn_pending` neighbours `drop_all` in the exit path). Each removal that owned a card emits `request:resolved`.

### Call flow

1. omp sends `host_tool_call { id, toolCallId, toolName, arguments }`.
2. Rust: `toolName` in the Session's registered set, else `unknown_tool`.
3. `refract_invoke_panel_action` only: validate `panelId` and `action` exist, else `unknown_panel` or `unknown_action`; validate `input` against the schema, else `invalid_input`. If the action mutates and the mode is not `yolo`, raise the card and await. Denied gives `denied`.
4. Emit `agent-tools:call { callId: id, sessionId: <stream owner>, tool, args }`.
5. Renderer `agent-tools-bridge.ts` dispatches to `panel-actions` and replies `agent_tools.result`.
6. Rust sends `host_tool_result { id, result: { content: [{ type: "text", text }] } }`, with top-level `isError: true` on failure. Text is short JSON capped at 8 KiB.

### Renderer

- `panel-registry.ts`: `HostedPanelDescriptor` gains `actions` derived from the contract; the handler map lives in a new `agent-panel-actions.ts`.
- `agent-tool-dispatch.ts` (new): `listPanels(sessionId)`, `openPanel(sessionId, panelId, input)`, `invokePanelAction(...)`. Checks the Session is the front Session (`panel_unavailable` otherwise) and calls `useRightPaneStore.getState().openPanel(id, { focus: false })`.
- `agent-tools-bridge.ts` (new): subscribes to `agent-tools:call`, calls the dispatcher, posts the result. It never calls the toast API.
- `AgentOpenedAnnouncer.tsx` (new, mounted once in `App.tsx`): a `role="status"` polite region fed by `useAgentAnnouncementStore`.
- Existing store actions are reused for the five v1 panels; any missing "select file" or "reveal path" entry point is added to that panel's own store, nowhere else.

### Wire contract

`contracts/ipc.md`, `src/shared/ipc.ts` (`IPC_EVENTS.AGENT_TOOLS_CALL`, command `agent_tools.result`), `src/tauri-bridge/index.ts` (`window.refract.agentTools.result`) and the matching typings.

### Docs

`docs/adr/0007-agent-tool-channel.md`, `CONTEXT.md` terms and **Child Session** rule, `docs/PLAN.md` row 1c.1, `CHANGELOG.md`.

## Risks

- **omp ignores the overlay key for a host tool.** Then OMP's own `Allow tool:` prompt appears first and a mutating call asks twice. SC-003 proves this live before merge; the fallback is to mark the three tools `prompt`-exempt by name in the overlay only, and to accept OMP's prompt as the single card for every host tool in ask mode (known limitation, noted in ADR 0007).
- **`host_tool_result isError` untested.** Proven in SC-002.
- **PR collisions.** #1785 and #1837 touch `launch.rs` and `frame.rs`; the plan keeps each edit to one or two lines.
- **Approval card for a Refract-owned id.** The card's options come from `PendingRequest::Approval.options` (`["Approve", "Deny"]`), so no renderer change.

## Chunks (file-disjoint)

See [tasks.md](tasks.md): Wave 0 contract, then A (Rust channel), B (renderer panels) in parallel, then C (wiring and live check).

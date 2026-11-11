# Feature Specification: Agent tool channel and panel tools

**Feature Branch**: `feat/1193-tool-channel`
**Created**: 2026-11-10
**Status**: Draft
**Input**: GitHub issue #1193 (P0 Agent Sessions slice 1, child of epic #1304; siblings #1858-#1862). Grilled with Stuart 2026-10-23 (issue body) and again 2026-11-10 (final decisions below). Route: specify.

## Problem

Refract launches `omp --mode rpc-ui`, but no Refract-defined tool reaches the agent. Every right-pane panel opens only when the developer opens it, so when the agent says "look at the diff for `foo.ts`" the developer has to find it. Slices 2-6 of #1304 (Session tools) also need a way to give the agent Refract-owned tools, and each needs the same plumbing: registration, routing, approval, errors, cancel.

This slice builds that plumbing (the **Tool channel**) and the first three tools on it, which let the agent list, open and drive Refract's own right-pane panels.

## Decisions

### Decided (Stuart, 2026-11-10, final)

1. **Channel is OMP host tools.** Refract registers tools with `set_host_tools` and serves `host_tool_call` frames with `host_tool_result` on the RPC stream it already reads. A probe against omp 18.17.0 (`--mode rpc-ui`) passed, so no loopback MCP server is built. The MCP fallback is recorded in ADR 0007 as reserved, not built.
2. **Names** carry the `refract_` prefix: `refract_list_panels`, `refract_open_panel`, `refract_invoke_panel_action`.
3. **Access is per launch.** Each launch registers only the tools that Session may use, filtered by role and depth. Rust also checks every call against the Session id that owns the RPC stream, never against a tool argument.
4. **Mutating tools raise Refract's approval card.**
5. **Slice 1 scope:** the channel (registration on launch, routing omp to Rust to renderer and back with a timeout, error results returned as tool errors and never toasts, cancel and disconnect handling) plus the panel tools. Each right-pane panel declares actions (name, description, input schema, mutates flag).

### Decided (Skippy, delegated by Stuart 2026-11-10)

6. **Approval reconciliation.** `RpcHostToolDefinition` has no per-tool approval field (omp://rpc.md "set_host_tools payload": `name`, `label`, `description`, `parameters`, `hidden`, `loadMode`, `readsSkillUris` only), and a tool without a declared tier resolves to `exec`, which prompts in every mode except `yolo` (omp://approval-mode.md). A user policy `tools.approval.<tool>: allow | deny | prompt` overrides the mode, and OMP's `--config <file>` overlay, which Refract already passes for token guard, can carry it. So:
   - Each launch writes a `tools.approval` overlay that sets all three tools to `allow`, so OMP never prompts for them.
   - Refract owns the one approval for a mutating action: when `refract_invoke_panel_action` names an action with `mutates: true`, Rust raises Refract's existing approval card (the `request:pending` path) before it routes the call to the renderer. Read and navigation actions run straight away.
   - Refract skips its own card when the Session's approval mode is `yolo`, as for any other tool call (issue #1193, "like any tool call"). It never asks twice for one call.
   - Rejected alternative: leave OMP's `Allow tool:` select as the only prompt. It cannot tell a read action from a mutating one (both go through `refract_invoke_panel_action`), so it prompts for reads in ask mode and breaks "read and navigation actions run straight away".
7. **v1 action set** (from the issue proposal, plus the two mutating actions needed to prove the gate; Commit, Discard and Merge are later slices):

   | Panel | Action | Mutates | Effect |
   | --- | --- | --- | --- |
   | `git-changes` | `show_file` | no | Selects a changed file and shows its diff |
   | `git-changes` | `stage_file` | yes | Stages one path (existing `gitChanges.stage`) |
   | `git-changes` | `unstage_file` | yes | Unstages one path (existing `gitChanges.unstage`) |
   | `file-explorer` | `reveal` | no | Reveals a path in the tree |
   | `subagents` | `select_agent` | no | Selects a Subagent in the panel |
   | `pull-request` | `open_pull_request` | no | Opens a pull request (reuses #1155's open path) |
   | `side-chat` | `open` | no | Opens Side chat |

   Other panels (`outline`, `session-usage`, `issue`, `fdb-knowledge`, `agent-builder`) declare no actions in this slice, so they list with `actions: []` and can be opened but not driven.
8. **Right pane is the Session's own.** The right pane shows the front Session only. A call from a Session that is not the front Session returns `panel_unavailable` and never opens a panel in the other pane of a Split.
9. **Child Session rule.** The rule is depth 3 with at most 4 live children per parent (#1304 amended 2026-11-04; #1859). This slice adds no `create_session`, so the registration filter has only the `root` role and depth 1 populated; the filter's input type already carries role and depth so #1859 changes a table, not a signature.

### Decided (Stuart, 2026-11-11, grill for #1888)

10. **A mutating action never reports `timeout` once it has started.** The first real-omp run returned `timeout` after the file was staged. When the renderer's window runs out after a mutating action has started, Rust returns the distinct tool error `outcome_unknown` ("the action started and its outcome is unknown, so check the panel before you retry"). `timeout` keeps one meaning: the action never started, so a retry is safe.
11. **File-changing actions get a 30 s window; reads keep 10 s.** The renderer tells Rust when a mutating action is about to change files (`agentTools.started`). Until then, Rust waits for that signal or a reply; after it, Rust waits for the reply. Each wait is 30 s. A `started` that arrives after Rust has already given up is refused (`accepted: false`) and the renderer changes nothing.
12. **The pre-action Git reload runs before `started`, so the action's own window never includes it.** The reload stays (the Git watcher only runs while the panel is mounted, so a cached snapshot can predate the agent's own edits). The reload after the action is not awaited on the agent path: the result does not depend on it.

## Clarifications

### Session 2026-11-10 (from the grill and the probe, no questions put to Stuart)

- Q: Does omp accept host tools before the agent is ready? -> A: Yes. `set_host_tools` works before `ready` and before the first prompt; a later call replaces the whole set. Refract sends it once per launch, next to `send_set_ask_dialog`.
- Q: Which `loadMode`? -> A: `essential`. With the default `discoverable` the tool is mounted at `xd://<name>` and the model must read it and then `write` JSON, which it fumbled once in the probe.
- Q: What happens if stdin closes with a call pending? -> A: omp ends the call with an error and exits 0. Rust drops its own pending entries when the process exits, so no result is sent to a dead stream.
- Q: What fields do cancel and update frames carry? -> A: `host_tool_cancel` is `{ id, targetId }` where `targetId` is the call's `id` (omp://rpc.md). `host_tool_update` is `{ id, partialResult: { content } }`; this slice sends none.
- Q: How does the renderer learn of a call? -> A: Rust emits a typed event `agent-tools:call` with `{ callId, sessionId, tool, args }`, and the renderer answers through an IPC command `agent_tools.result` with `{ callId, ok, value | error }`. `sessionId` always comes from the stream owner, never from `args`.
- Q: What is the timeout? -> A: Reads: 10 s from emit to the renderer's answer (`RENDERER_TIMEOUT_MS`). A mutating action: 30 s (`MUTATION_TIMEOUT_MS`) for the renderer to signal `started` or reply, then 30 s more for the reply. Time spent waiting on the developer's approval card does not count; the card has no timeout of its own and ends with the call (cancel, process exit, or answer).
- Q: What does the agent get when a mutating action's window runs out? -> A: Before `started`: `timeout` (nothing changed). After `started`: `outcome_unknown` (the action may or may not have finished; check before retrying).
- Q: Was the first-action cause found? -> A: See the Cold-start trace under Success Criteria (SC-005).
- Q: Result size? -> A: Capped at 8 KiB of text. A larger result becomes the tool error `result_too_large`. Tools return short JSON.
- Q: Are there true unknowns? -> A: None that block. Whether omp 18.17.0 honours a `tools.approval` overlay key for a host tool name is a documented rule (omp://approval-mode.md) that the live check proves (SC-003).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent shows what it is talking about (Priority: P1)

The agent calls `refract_open_panel` with `git-changes` and a file path. The Git changes panel appears in the right pane on that file's diff, and the developer's cursor stays in the composer.

**Why this priority**: it is the issue's headline value and exercises the whole channel.

**Independent Test**: replay a fake-omp tape that sends `host_tool_call` for `refract_open_panel`; assert the panel is active, the composer keeps focus and the `host_tool_result` is short JSON.

**Acceptance Scenarios**:

1. **Given** a ready Session and a closed right pane, **When** the agent opens `git-changes` with `{ path }`, **Then** the pane opens on Git changes with that file selected, focus stays where it was, and a polite live region announces "Agent opened Git changes".
2. **Given** a panel the developer closed, **When** no tool call arrives, **Then** it stays closed; only a new call reopens it.
3. **Given** `side-chat`, **When** the agent opens it, **Then** the composer keeps focus (the Side chat input is not focused).

### User Story 2 - The agent lists and drives panels (Priority: P1)

`refract_list_panels` returns each panel with its availability and actions. `refract_invoke_panel_action` runs a read or navigation action immediately and returns short JSON.

**Independent Test**: tape calls `refract_list_panels`, then `refract_invoke_panel_action` for `file-explorer.reveal`; assert the listing shape and the reveal.

**Acceptance Scenarios**:

1. **Given** any Session, **When** `refract_list_panels` runs, **Then** the result is `{ panels: [{ id, name, available, actions: [{ name, description, inputSchema, mutates }] }] }`.
2. **Given** `reveal` with `{ path }`, **When** invoked, **Then** the File Explorer opens, expands to the path and selects it, and the result is `{ ok: true }`.

### User Story 3 - Mutating actions ask first (Priority: P1)

`refract_invoke_panel_action` for `git-changes.stage_file` raises Refract's approval card and stages the file only after the developer approves.

**Independent Test**: tape calls `stage_file` in ask mode; assert the card appears before any renderer event, Deny returns a tool error `denied`, and Approve stages the file; in `yolo` no card appears.

**Acceptance Scenarios**:

1. **Given** ask mode, **When** the agent invokes a mutating action, **Then** one card appears, naming the panel, action and arguments, and OMP shows no `Allow tool:` prompt.
2. **Given** the developer denies, **When** the call completes, **Then** omp receives `isError: true` with text `denied` and nothing is staged.
3. **Given** a read action in ask mode, **When** invoked, **Then** no card appears.

### User Story 4 - Failures are tool errors, never toasts (Priority: P2)

**Acceptance Scenarios**:

1. **Given** an unknown panel, unavailable panel, unknown action or invalid input, **When** the tool is called, **Then** `host_tool_result` carries `isError: true` and a text body `{ "error": "<code>", "message": "..." }`, and the renderer shows no toast.
2. **Given** the renderer does not answer a read within 10 s, or a mutating action does not start within 30 s, **Then** the call ends with `timeout` and nothing changed.
2a. **Given** a mutating action has started and the renderer does not reply within 30 s, **Then** the call ends with `outcome_unknown`, not `timeout` or `action_failed`.
2b. **Given** a mutating action succeeded, **When** the reply is slow (for example a slow Git reload around it), **Then** the result is still the success, as long as it arrives within the window.
3. **Given** omp sends `host_tool_cancel` while the call waits on the card or the renderer, **Then** the card closes as cancelled, no result is sent, and a late renderer answer is dropped.
4. **Given** the omp process exits with calls pending, **Then** Rust drops them and the renderer closes any card they raised.

### User Story 5 - Each launch gets only its tools (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a launch, **When** Rust builds the tool set, **Then** it registers only tools the Session's role and depth allow (all three for a root Session in this slice).
2. **Given** a `host_tool_call` for a name not registered for that Session, **Then** Rust returns `unknown_tool` without reaching the renderer.
3. **Given** a call whose arguments carry a `sessionId`, **Then** Rust ignores it and uses the stream owner's id.

### Edge Cases

- A second `set_host_tools` replaces the first, so Rust sends the full set on every launch and never patches it.
- A call that arrives while the Session is shutting down is answered `cancelled`.
- A call with the right pane collapsed opens the pane (an open of the pane itself, no focus move).
- Two calls in flight run independently; each has its own `id`.
- Panel actions that need a path validate it as a relative path inside the Session's Worktree; `..` or an absolute path returns `invalid_input`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each launch MUST send `set_host_tools` with the tools its Session may use, each with `loadMode: "essential"` and the `refract_` prefix, before the first prompt.
- **FR-002**: Each launch MUST pass a `--config` overlay that sets `tools.approval` to `allow` for every registered Refract host tool, so OMP does not prompt for them in any approval mode.
- **FR-003**: Rust MUST route each `host_tool_call` through the SessionAgent that owns the stream and MUST use that Session id, never an argument, for access checks and renderer routing.
- **FR-004**: A call to a name not registered for that Session MUST return `unknown_tool` without reaching the renderer.
- **FR-005**: Rust MUST emit `agent-tools:call` to the renderer and accept exactly one `agent_tools.result` per call; the first answer wins and later ones are dropped.
- **FR-006**: A call to a read or navigation action MUST end with `timeout` if the renderer does not answer within 10 s. A call to a mutating action MUST end with `timeout` if the renderer neither signals `started` nor replies within 30 s (approval wait excluded).
- **FR-007**: Every failure MUST reach omp as `host_tool_result` with `isError: true` and a JSON text body with `error` and `message`; the renderer MUST NOT show a toast for a tool failure.
- **FR-008**: On `host_tool_cancel`, Rust MUST drop the pending entry, close any card it raised as cancelled and send no result. On process exit it MUST drop every pending entry and emit `request:resolved` for each card it raised.
- **FR-009**: Each right-pane panel descriptor MUST declare `actions` (name, description, input schema, mutates). A panel with no actions declares an empty list.
- **FR-010**: `refract_list_panels` MUST return every `HOSTED_PANELS` entry with `available` for the calling Session and its actions.
- **FR-011**: `refract_open_panel(panelId, input?)` MUST open or activate the panel in the front Session's right pane and MUST NOT move keyboard focus; the optional `input` MUST be validated against the panel's declared open input, if any.
- **FR-012**: `refract_invoke_panel_action(panelId, action, input)` MUST validate `input` against the action's schema and return short JSON.
- **FR-013**: For an action with `mutates: true`, Rust MUST raise Refract's approval card before routing to the renderer, unless the Session's approval mode is `yolo`. Rust learns `mutates` from the same declaration the renderer owns, delivered once as a static schema table generated into the registration (see plan, "Single source of truth").
- **FR-014**: A panel the developer closed MUST stay closed until a new tool call.
- **FR-015**: An agent-opened panel MUST be announced once through a polite live region ("Agent opened Git changes") and MUST NOT take focus.
- **FR-016**: A call from a Session that is not the front Session MUST return `panel_unavailable`.
- **FR-017**: The v1 actions in the Decisions table MUST ship; `show_file` and `reveal` MUST accept only Worktree-relative paths.
- **FR-018**: `CONTEXT.md` MUST define **Tool channel**, **Host tool** and **Panel action**, and MUST state the Child Session depth rule; ADR 0007 MUST record the decisions; `docs/PLAN.md` row 1c.1 MUST show in progress with spec 124.
- **FR-019**: A mutating action MUST signal `agentTools.started` after its checks (including the pre-action Git reload) and immediately before it changes files. It MUST proceed only if the answer is `accepted: true`.
- **FR-020**: If a mutating action has started and the renderer does not reply within 30 s, Rust MUST end the call with `outcome_unknown`, never `timeout` or another failure. The message MUST say the action started, its outcome is unknown, and the agent should check before retrying.
- **FR-021**: The Git reload that follows a staging or unstaging done for the agent MUST NOT delay the reply.

### Key Entities

- **Host tool**: a tool Refract registers with omp for one launch and serves over the RPC stream.
- **Tool channel**: registration, routing, approval, timeout and cancel for Host tools, in `src-tauri/src/agent_tools/`.
- **Panel action**: a named operation a right-pane panel declares for the agent.

## Accessibility (WCAG 2.1 AA)

- An agent-opened panel never moves focus (2.4.3); the opening is announced once through a polite live region (4.1.3).
- The approval card for a mutating action is the existing keyboard-accessible card; it names panel, action and arguments as text (1.3.1).
- Errors reach the agent only; nothing visual changes, so there is no new notification to make accessible.

## Success Criteria *(mandatory)*

- **SC-001**: Live (fake-omp harness, `scripts/verify-tauri-1193.mjs`): a tape that calls each of the three tools returns the expected short JSON for every v1 action, and the composer keeps focus throughout.
- **SC-002**: Live: unknown panel, unavailable panel, unknown action, invalid input, timeout, cancel and denial each produce a tool error and no toast.
- **SC-003**: Live against real omp 18.17.0 in ask mode: a read call shows no `Allow tool:` prompt, a mutating call shows exactly one card, and Deny ends the call as a tool error (screenshot of the card and the transcript).
- **SC-004**: `pnpm ci:local` passes. New logic carries unit tests co-located with it (AGENTS.md Testing rule, 2026-11-11; this supersedes the prototyping no-new-tests rule the original slice shipped under).
- **SC-005**: Live on a cold start (`scripts/verify-tauri-1888.mjs`): the first call after launch is `stage_file`; after Approve the result is a success, the file is staged, and the cold-start timings of `gitChanges.list` and `gitChanges.stage` are recorded. With `agentTools.result` held back past 30 s the result is `outcome_unknown`; with `agentTools.started` held back past 30 s it is `timeout`, nothing is staged, and the released `started` is refused.
- **Known evidence gap**: `isError: true` on `host_tool_result` is documented but untested in the probe; SC-002 proves it against real omp.

## Out of scope

Session tools (#1858-#1862), third-party canvases (#1194, which reuses these tools), the MCP fallback, Commit/Discard/Merge actions, streaming `host_tool_update`.

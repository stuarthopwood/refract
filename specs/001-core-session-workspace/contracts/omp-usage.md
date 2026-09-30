# Contract: how Pinion uses OMP

Pinion drives `omp --mode rpc-ui` over stdio (newline-delimited JSON). This file lists exactly what Pinion sends and consumes. OMP behaviour cited here comes from [FINDINGS](../../../docs/spike/FINDINGS.md) (probed on omp 18.4.4) or `omp://rpc.md` (read, not probed, and labelled so).

## Launch

```
omp --mode rpc-ui --approval-mode=<always-ask|write|yolo> [--resume <conversation file>]
```

- `cwd` is the Session's `worktreePath`. This is required: `switch_session` across cwds is cancelled (FINDINGS C16, item 5).
- No `--model`, no `--session-dir`, no `--no-*` flags. OMP's own default model and default per-cwd session directory apply (session-dir probe, 2026-09-30).
- `spawn` with `windowsHide: true`, `stdio: 'pipe'`, no shell. Immediately after `spawn` returns, the pid is assigned to Pinion's Job Object (research.md decision 4) and recorded in `processes.json`.
- `--approval-mode` comes from `Settings.approvalMode` at launch time (`ask` = `always-ask`, `edit-freely` = `write`, `auto` = `yolo`).

## Start-up sequence per Session

1. Wait for the `ready` frame (timeout 60 s, then `stopped`/`start-failed`).
2. Send `negotiate_protocol` `{protocolVersion: 2}` if `ready.supportedProtocolVersions` includes 2. From then on, reassemble `rpc_chunk` frames (validate `chunkId`, `index`, `count`, `byteLength`; strict UTF-8; reject interleaving; 64 MiB ceiling). Pinion implements its own decoder because OMP's `RpcFrameDecoder` is raw `.ts` and needs Bun (FINDINGS C22b).
3. `get_state`. If launched with `--resume`, verify per data-model.md ("Reattach verification"). Record `sessionFile`, `messageCount`, and (first time) `sessionDir = dirname(sessionFile)`.
4. `get_messages` to build the transcript from history (the response can exceed 1 MiB; v2 framing carries it).
5. Mark the Session `idle`.

`available_commands_update` frames arrive at startup and later; Pinion keeps the latest list per Session for the slash-command menu.

## Commands Pinion sends

| Purpose | Frame | Notes |
|---|---|---|
| Send a message, idle | `{type:'prompt', message}` | Field is `message`, never `text` (constitution II). Response `data.agentInvoked === false` means a local slash command: no turn, no `prompt_result`. |
| Send a message, working | `{type:'prompt', message, streamingBehavior:'followUp'}` | Becomes a queue chip. Render chips from `queue_update`, not from local state. |
| Remove a queued chip | `{type:'remove_queued_message', message, queue:'followUp'}` | Hide the chip only when `data.removed === true`. |
| Send now (steer) | `remove_queued_message` for the chip, then `{type:'steer', message}` | If `removed` is false the message already left the queue; do nothing more. |
| Stop | `{type:'abort'}` | Then wait for `prompt_result.status === 'aborted'` and `session_settled` before accepting another prompt (constitution II, FINDINGS C5). |
| New Conversation | `{type:'new_session'}` | Same process, same cwd, same Session. Requires the Session to be idle. Clears the transcript; `currentConversation` updates when the first message is written. |
| Open an earlier Conversation | `{type:'switch_session', sessionPath}` | Requires idle. Success is `data.cancelled === false`; then run reattach verification and reload the transcript with `get_messages`. `success:true, cancelled:true` is a failure. |
| Slash command | `{type:'prompt', message:'/name args'}` | Only names present in the latest `available_commands_update` or Pinion's native set; unknown names are refused locally (FR-033). |
| Answer a dialog | `{type:'extension_ui_response', id, value}` or `{..., confirmed}` or `{..., cancelled:true}` | See "Dialogs". |
| Shut down | close stdin, keep reading stdout until exit; after 10 s `taskkill /PID <pid> /T /F` | |

Not used in this spec: `set_model`, thinking-level commands, `compact`, `handoff`, `branch`, `set_subagent_subscription` (stays `off`), host tools, `set_event_filter` (left `null`; unknown events are ignored).

## Frames Pinion consumes

| Frame | Effect |
|---|---|
| `agent_start` | Session status `working` (also covers turns started by a queued message or background job). |
| `message_start` / `message_update` / `message_end` | Build assistant items. Each `message_update` carries the whole `message` so far (`message.content[]` parts: `text`, `thinking`, `toolCall`): replace the item's content with that snapshot instead of concatenating deltas. `messageId` identifies the message. Coalesce IPC updates to at most one per 50 ms per Session. |
| `tool_execution_start` | Add a `tool` item with status `running`: `toolName`, `args`, `intent`. |
| `tool_execution_end` | Set `status` (`isError`), `durationMs`, and `output` from `result.content` text parts. |
| `queue_update` | Replace `queue` (`steering`, `followUp`). |
| `extension_ui_request` | See "Dialogs". |
| `prompt_result` | `status: 'error'` adds a `notice` (error) with `error.message`; `'aborted'` adds an info notice. |
| `session_settled` | Status `idle` (if no request pending). Then `get_state`: update `lastMessageCount`, `lastActivityAt`, `sessionDir`, `currentConversation`. If `pendingMode` is set, run the mode-change restart. |
| `available_commands_update` | Replace the Session's command list. |
| `command_output` | Add an info `notice` (local slash command output; can arrive before or after its acknowledgement). |
| `notice` | Add a `notice` with the given level. |
| process `exit` | If Pinion did not ask for it: status `stopped`, `stopReason: 'agent-exited'`, with the exit code. |

Every other frame type is ignored (recorded frames also include `turn_start`, `turn_end`, `advisor_cost_changed`, `thinking_level_changed`, `todo_reminder`).

### Message parts

- `role: 'user'`: a `user` item (content is a string or text parts).
- `role: 'assistant'`: `text` parts become `assistant-text`; `thinking` parts become `thinking` only when their text is non-empty (with the tested model the reasoning arrives empty and encrypted); `toolCall` parts correspond to `tool` items keyed by the call id.
- `role: 'toolResult'`: attach the output to the `tool` item with the same `toolCallId` (history loading only; live output comes from `tool_execution_end`).
- `role: 'custom'` and `role: 'developer'`: hidden, unless a custom message has `display: true`, in which case it is a `notice`.

### Tool row fields

- `tool` = `toolName`. `target` = the tool's primary argument: `path` for `read`, `edit`, `write`; `command` for `bash`; `pattern` for `grep`, `glob`; otherwise the first string argument, else empty. Truncate to 200 characters.
- `diff` for an `edit`/`write` row: **unverified** how OMP reports the change. Before building the diff view, read the `tool_execution_end` `result.details` of a real `edit` call; if it carries a diff, use it, otherwise build the diff from the call arguments. This is a required first check of the chat work (tasks.md).

## Dialogs (`extension_ui_request`)

| Frame | Pinion treats it as | Answer |
|---|---|---|
| `method:'select'`, `title` starts `Allow tool:` | Approval. First line is the tool name; later lines are details (origin, reason, command, path). Options `Approve`, `Deny`. | `{value:'Approve'}` or `{value:'Deny'}` |
| `method:'select'`, any other title | Question with options (`options`, optional aligned `optionDetails`) | `{value: <chosen option>}` or `{cancelled:true}` |
| `method:'input'` or `'editor'` | Question with free text | `{value: <text>}` or `{cancelled:true}` |
| `method:'confirm'` | Question with Yes / No | `{confirmed: boolean}` or `{cancelled:true}` |
| `method:'cancel'` for a pending id | Remove that request (OMP withdrew it) | none |
| `notify` | Info/warning `notice` | none |
| `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url` | Ignored | none |

Every `select`, `confirm`, `input`, and `editor` request MUST be answered, or the turn stalls (constitution II). Requests with a `timeout` resolve to a default inside OMP when it elapses; the request is removed from the UI when a `cancel` frame or the turn's end arrives. A request pending when the process exits is dropped and a notice is added.

## Approval mode change (FR-020)

1. The user changes `Settings.approvalMode`. Every live Session with a different `launchedMode` gets `pendingMode` set (chip in the chat header).
2. When that Session reaches `session_settled` with no pending request: stop the process (stdin close, 10 s, then force), spawn with the new `--approval-mode` and `--resume <currentConversation>`, run reattach verification, and reload the transcript.
3. If reattach verification fails, the Session is `stopped` with the reason and a Recover action.
4. A Session that is not running simply launches with the current mode the next time it is opened.

## Failure handling

| Failure | Handling |
|---|---|
| `ready` not seen in 60 s | `stopped`, `start-failed`, keep stderr tail for the setup message |
| Unparseable stdout line | Log it and continue (never crash the reader) |
| Chunk validation error | Fail the current request, log, keep the process |
| `success:false` response | Add an error `notice` naming the command; do not change status |
| `omp --version` is not `18.4.4` | Readiness check fails and names the version found (FR-036). Supporting another version is a constitution amendment after the probes are rerun (Principle IV). |
| Worktree folder missing at open | `stopped`, `worktree-missing`, offer Recreate, Archive, Delete (FR-035); the agent is not started |

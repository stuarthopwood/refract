# Contract: how Refract uses OMP

Refract drives `omp --mode rpc-ui` over stdio (newline-delimited JSON). This file lists exactly what Refract sends and consumes. OMP behaviour cited here comes from [FINDINGS](../../../docs/spike/FINDINGS.md) (probed on omp 18.4.4) or `omp://rpc.md` (read, not probed, and labelled so).

## Launch

```
omp --mode rpc-ui --approval-mode=<always-ask|write|yolo>
```

- `cwd` is the Session's `worktreePath`. This is required: `switch_session` across cwds is cancelled (FINDINGS C16, item 5).
- No `--model`, no `--session-dir`, no `--no-*` flags. OMP's own default model and default per-cwd session directory apply (session-dir probe, 2026-09-30).
- `spawn` with `windowsHide: true`, `stdio: 'pipe'`, no shell. The pid is recorded in `processes.json`. No explicit Job Object call is needed per process: Refract's main process already joined the kill-on-close job at startup, so the child and all its descendants inherit it (research.md decision 4).
- `--approval-mode` comes from `Settings.approvalMode` at launch time (`ask` = `always-ask`, `edit-freely` = `write`, `auto` = `yolo`).

## Start-up sequence per Session

1. Wait for the `ready` frame (timeout 60 s, then `stopped`/`start-failed`).
2. Send `negotiate_protocol` `{protocolVersion: 2}` if `ready.supportedProtocolVersions` includes 2. From then on, reassemble `rpc_chunk` frames (validate `chunkId`, `index`, `count`, `byteLength`; strict UTF-8; reject interleaving; 64 MiB ceiling). Refract implements its own decoder because OMP's `RpcFrameDecoder` is raw `.ts` and needs Bun (FINDINGS C22b).
3. If the Session has a current Conversation, `switch_session` with its `sessionPath` (never `--resume`, FINDINGS item 17), then `get_state` and verify per data-model.md ("Reattach verification"). Record `sessionFile`, `messageCount`, and (first time) `sessionDir = dirname(sessionFile)`. Only record `currentConversation` and `lastMessageCount` once `messageCount > 0` (`get_state` returns a `sessionFile` before the first message is written).
4. `get_messages` to build the transcript from history (the response can exceed 1 MiB; v2 framing carries it).
5. Mark the Session `idle`.

`available_commands_update` frames arrive at startup and later; Refract keeps the latest list per Session for the slash-command menu.

## Commands Refract sends

| Purpose | Frame | Notes |
|---|---|---|
| Send a message, idle | `{type:'prompt', message}` | Field is `message`, never `text` (constitution II). Response `data.agentInvoked === false` means a local slash command: no turn, no `prompt_result`. |
| Send a message, working | `{type:'prompt', message, streamingBehavior:'followUp'}` | Becomes a queue chip. Render chips from `queue_update`, not from local state. |
| Remove a queued chip | `{type:'remove_queued_message', message, queue:'followUp'}` | Hide the chip only when `data.removed === true`. |
| Send now (steer) | `remove_queued_message` for the chip, then `{type:'steer', message}` | If `removed` is false the message already left the queue; do nothing more. |
| Stop | `{type:'abort'}` | Then wait for the running prompt's `prompt_result` with any status (`aborted`, or `completed`/`error` if the turn ended just before the abort landed), then `session_settled`, before accepting another prompt (constitution II, FINDINGS C5). Never wait for `aborted` specifically. |
| New Conversation | `{type:'new_session'}` | Same process, same cwd, same Session. Requires the Session to be idle. Clears the transcript; `currentConversation` updates when the first message is written. |
| Open an earlier Conversation | `{type:'switch_session', sessionPath}` | Requires idle. Success is `data.cancelled === false`; then run reattach verification and reload the transcript with `get_messages`. `success:true, cancelled:true` is a failure. |
| Slash command | `{type:'prompt', message:'/name args'}` | Only names present in the latest `available_commands_update` or Refract's native set; unknown names are refused locally (FR-033). |
| Ghost-text word prediction | `{type:'predict_word', text, cursor}` → `data:{suffix: string\|null}` | For a composer that renders its own input box (FR/T103 scope). `text` is the whole draft, `cursor` a UTF-16 offset. Gated server-side (mid-word cursor, non-end-of-line cursor, file-path-shaped or slash-command-shaped drafts all answer `suffix:null`); independent of the session's chat model (FINDINGS item 28). Per session only the newest in-flight request is answered; match responses on `id` and treat an answer of `suffix:null` for a request you still care about as "superseded by a newer one", not as "no suggestion". |
| Ghost-text acceptance feedback | `{type:'predict_word_feedback', text, cursor, suggestion, accepted}` | Send once per shown suggestion, `accepted:true` if the user took it, `false` if they typed past it. No `data` payload on success. |
| Answer a dialog | `{type:'extension_ui_response', id, value}` or `{..., confirmed}` or `{..., cancelled:true}` | See "Dialogs". |
| Shut down | close stdin, keep reading stdout until exit; after 10 s `taskkill /PID <pid> /T /F` | |

Not used in this spec: `set_model`, thinking-level commands, `compact`, `handoff`, `branch`, `set_subagent_subscription` (stays `off`), host tools, `set_event_filter` (left `null`; unknown events are ignored).

## Frames Refract consumes

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
| process `exit` | If Refract did not ask for it: status `stopped`, `stopReason: 'agent-exited'`, with the exit code. |

Every other frame type is ignored (recorded frames also include `turn_start`, `turn_end`, `advisor_cost_changed`, `thinking_level_changed`, `todo_reminder`).

### Message parts

- `role: 'user'`: a `user` item (content is a string or text parts).
- `role: 'assistant'`: `text` parts become `assistant-text`; `thinking` parts become `thinking` only when their text is non-empty (with the tested model the reasoning arrives empty and encrypted); `toolCall` parts correspond to `tool` items keyed by the call id.
- `role: 'toolResult'`: attach the output to the `tool` item with the same `toolCallId` (history loading only; live output comes from `tool_execution_end`).
- `role: 'custom'` and `role: 'developer'`: hidden, unless a custom message has `display: true`, in which case it is a `notice`.

### Tool row fields

- `tool` = `toolName`. `target` = the tool's primary argument: `path` for `read`, `edit`, `write`; `command` for `bash`; `pattern` for `grep`, `glob`; otherwise the first string argument, else empty. Truncate to 200 characters.
- `diff` for an `edit` row: `tool_execution_end` `result.details.oldText` and `.newText` carry the full before/after file text (present and verified); build a unified diff from them client-side for react-diff-view. Do not use `result.details.diff` (a non-unified, line-numbered summary string, e.g. `" 1|line\n-2|old\n+2|new"`) or expect a unified diff anywhere over RPC. For a `write` row: it shows `args.content` as plain text labelled `"Wrote N lines to <path>"`; `result.details` carries only `resolvedPath` and the text is `"Successfully wrote N bytes"`, so created vs overwritten is unknown over RPC, and there is no per-path content cache. `edit` needs a snapshot tag from a prior `read` of the same path in the same session; without one it fails (`isE…

## Dialogs (`extension_ui_request`)

| Frame | Refract treats it as | Answer |
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
2. When that Session is idle with no pending request (at `session_settled`, or immediately if it already is): stop the process (stdin close, 10 s, then force), spawn with the new `--approval-mode`, `switch_session` to `<currentConversation>`, run reattach verification, and reload the transcript.
3. If reattach verification fails, the Session is `stopped` with the reason and a Recover action.
4. A Session that is not running simply launches with the current mode the next time it is opened.

## Model readout (T061)

A probe of the read-only RPC surface (`get_state`, `get_available_models`, `get_available_thinking_levels`, `get_available_commands`; FINDINGS item 21) found no `role`/`modelRole`/`roleId` field anywhere: `get_state.model` and `get_available_models` entries carry only provider/id plus capability/cost metadata. Config-side **model roles** (`default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `task`, `advisor`, per `omp://models.md`) pick which model answers a request but are never reported back for the live session. The message-box readout shows **provider, model, and effort/thinking-level only**.

## Chat line wire shapes (T071)

Probed with `chat-lines-probe.mjs` (FINDINGS item 22):

- A multiple-choice `ask` answer is read from the resulting `toolResult.details.selectedOptions` (or `content[0].text`); no correlation with the `extension_ui_request` dialog is needed once history is loaded.
- Free-text `ask` is two dialogs in sequence (`select` offering "Other (type your own)", then `method: "editor"`); the rendered answer is still `toolResult.details.customInput`.
- A cancelled `ask` is `toolResult.isError: true` with a fixed sentence and an empty `details` (no `question`/`options`) — render from the error text, not from `details`.
- `todo` progress is available per call (`toolResult.details.phases`) and as live session state (`get_state().todoPhases`, same shape).
- A batch `task()` call's own `tool_execution_end` completes almost immediately with `details.progress[]` stuck at `"pending"`; the authoritative per-subagent completion is a later `custom`/`async-result` message's `details.jobs[]` (`jobId`/`label`/`durationMs`/`schema.data`). `agent_start`/`agent_end` frames carry no subagent id and cannot be correlated to one. `set_subagent_subscription` does not exist in `get_available_commands` on 18.4.10.

## Word prediction (`predict_word`/`predict_word_feedback`) (T102)

Probed with `predict-word-probe.mjs` against an isolated, credential-free profile (FINDINGS item 28):

- Wire shapes exactly as documented in `omp://rpc.md`: `{id?, type:"predict_word", text, cursor}` → `data:{suffix: string|null}` (no `cursor` echoed back); `{id?, type:"predict_word_feedback", text, cursor, suggestion, accepted}` → `success:true` with no `data` payload for both `accepted:true` and `accepted:false`.
- Gating confirmed live: cursor mid-word, cursor not at the end of its line (more text follows on the same line), a file-path-shaped draft, and a slash-command-shaped draft all answered `suffix:null`. A plausible partial prose word at the end of a line answered a real `suffix`.
- **The prediction engine does not depend on the session's configured chat model.** Every call above, including the cold-start measurement, ran against a session whose only configured chat model was deliberately unreachable (`baseUrl: http://127.0.0.1:1`); every `predict_word` call still returned real suggestions. `rpc.md` itself supports this: answers come "from the engine selected by `spelling.autocomplete`" — a boolean (`auto`/`off`), not a model/provider selector. Refract can therefore exercise ghost text in an isolated or stub-model profile; no live chat-capable credential is required, only `spelling.autocomplete` left at its default.
- One-in-flight-replaces-older confirmed: with a burst of identical requests fired back to back (no await between sends), the first (already dispatched) and the last (left waiting when the first finished) each answered for real; every request in between answered `suffix:null` (superseded). A gap of only two requests was not reliably wide enough to reproduce this on a warm engine (both resolved for real in 1-9 ms) — do not use a two-request test as a regression check for this behaviour; use a wider burst.
- Cold start measured 7-16 ms for the first `predict_word` call on a brand-new isolated profile/process — far below `rpc.md`'s documented "worst case about two minutes." The shared prediction daemon is almost certainly a machine-wide singleton that was already warm from an earlier process; treat this number as "warm daemon," not as a refutation of the documented worst case, and do not assume Refract's own first keystroke-triggered `predict_word` call will always be this fast on a machine where the daemon has never run.

## Slash command classification (T092)

`slash-commands-probe.mjs` (FINDINGS item 23) sent every command from `get_available_commands` through an isolated, credential-free profile and classified each by observed behaviour:

| Class | Meaning | Count |
|---|---|---|
| `works-local` | Completes synchronously (`agentInvoked:false`) or completes a local turn without leaving the session unsettled | 80 |
| `starts-agent-turn` | Dispatches a real idle agent turn; needs a signed-in profile to confirm | 3 (`/ratchet`, `/green`, `/init`) |
| `needs-decision` | Denylisted (config/credential/model/plugin/destructive-shaped); never sent | 105 |

**Stale classification, do not build T093 from this table as-is:** this run used the script's EARLIER, narrower denylist, before `copy`, `edit`, `import`, `stats`, `trace`, `review`, `security`, `wt`, `move`, `ssh`, `pin`, `browser`, and `computer` were added to it. The script's own header comment documents that this same run really did overwrite Stuart's clipboard (`/todo copy`) and really did start local dashboards/servers (`/stats`, `/trace`) on his desktop, alongside `/todo edit`/`import`, `/review`, `/security scan`/`import`/`disposition`, `/wt`, `/move`, `/ssh add`/`remove`, `/session pin`, `/browser visible`, and `/computer on`. Every one of those command names IS denylisted (`needs-decision`) under the current, fixed denylist and so was wrongly counted inside the 80 `works-local` figure above -- it was classified `works-local` only because the denylist had not yet been fixed. The denylist regex matches a substring of the full command name with no word boundary, so the exclusion scope differs per command: for `stats`, `trace`, `review`, `security`, `wt`, `move`, `ssh`, `browser`, and `computer`, the whole parent command and every one of its subcommands is denylisted (the bare name itself matches the regex). For `todo` and `session`, only the specific subcommands actually seen (`todo copy`/`edit`/`import`, `session pin`) are denylisted -- the bare `/todo` and `/session` commands, and any OTHER `todo`/`session` subcommand not named copy/edit/import/pin, still match neither the old nor the new denylist and so were correctly classified `works-local`; do not exclude them. Any T093 supported set drawn from this run MUST exclude every individually-named command above, the whole `stats`/`trace`/`review`/`security`/`wt`/`move`/`ssh`/`browser`/`computer` families, and only the named `todo`/`session` subcommands -- not those two parent commands wholesale. A rerun of `slash-commands-probe.mjs` with the current denylist is needed to get an accurate `works-local` count and set.

## Failure handling

| Failure | Handling |
|---|---|
| `ready` not seen in 60 s | `stopped`, `start-failed`, keep stderr tail for the setup message |
| Unparseable stdout line | Log it and continue (never crash the reader) |
| Chunk validation error | Fail the current request, log, keep the process |
| `success:false` response | Add an error `notice` naming the command; do not change status |
| `omp --version` is not `18.4.x` | Readiness check fails and names the version found (FR-036). Supporting another minor/major version is a constitution amendment after the probes are rerun (Principle IV). |
| Worktree folder missing at open | `stopped`, `worktree-missing`, offer Recreate, Archive, Delete (FR-035); the agent is not started |

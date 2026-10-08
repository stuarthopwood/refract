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

1. Issue #512: queues for a process-wide start slot (at most 2 concurrent `omp` starts; `startQueue.ts`), defers briefly under low system memory while another start has already spawned a process (`memory.ts`'s threshold, `spawnedInFlight`, `OmpProcess.ts`'s `deferStartIfMemoryLow`; a start merely holding a slot but not yet spawned does not count), then waits for the `ready` frame. 60 s in with no `ready` frame, the UI may offer "Keep waiting"/"Cancel" (`ReadyWaitController`'s `'prompt'` stage); the wait itself keeps going regardless until a 180 s ceiling, where it fails outright (`stopped`/`start-failed`, stderr/omp-log tails and free/total memory kept for the setup message) unless a user cancel arrived first. A ceiling failure (not a cancel) retries exactly once automatically before giving up. The readiness and login-providers probes use shorter overridable thresholds and skip both the start queue (`useStartQueue: false`) and the memory defer (`deferForMemory: false`) entirely, bounded by an overall deadline across every phase so a slow Session start elsewhere can never hold them hostage.
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
| Remove a queued chip | `{type:'remove_queued_message', message, queue}` -- `queue` is the chip's own `'followUp'` or `'steering'` (issue #540: hard-coding `'followUp'` made a steering chip's Remove always report `removed:false`) | Hide the chip only when `data.removed === true`. |
| Send now (steer) | `{type:'promote_queued_message', message}` (issue #540; replaces the old remove-then-steer) | Offered only for a follow-up chip -- `promote_queued_message` only ever matches a queued follow-up, never a steering-queue one. Atomic: moves the message (attachments included) to the end of the steering queue, no reprocessing, no duplicate. `data.promoted === false` means it was no longer pending at dispatch time (e.g. already delivered); show a notice rather than doing nothing. |
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
| `tool_execution_end` | Set `status` (`isError`), `durationMs`, and `output` from `result.content` text parts; `details` is kept as-is (T072's `ask` answer, T078's batch-subagent `progress[]`). |
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

1. The user changes `Settings.approvalMode`. Every live Session with a different `launchedMode` gets `pendingMode` set (shown as "<mode> after this turn" on the Approval mode pill above the message box, next to the session's still-current `launchedMode`).
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
- A subagent-to-parent IRC message's wire shape was never confirmed (the probe's prompt reported sending one but no matching frame was observed within its timeout) — left open for a longer-timeout or narrower-prompt re-probe.

### Built from the above (T072-T079)

- **Ask (T072/T073)**: the `ask` tool's own `toolCall` message part plus its `tool_execution_end`/history `details` builds the answered-question row directly — no correlation with the `extension_ui_request`/`PendingRequest` the dialog raised is needed once that item resolves. The question/options are read from `args.questions[0]` (live-verified, FINDINGS item 27: the real shape batches under `questions[]`, each `{question, options: [{label}]}` — a flat `args.question`/`args.options` is kept only as a defensive fallback), and the answer from `details.selectedOptions`/`details.customInput`/`output` as item 22 already established. The `request` item (driven by the dialog, survives only in memory) stays the live card while pending, and is superseded by the `ask` tool item once it resolves.
- **Subagents (T078)**: a `task` toolCall's `args.tasks[]` yields one `subagent` `TranscriptItem` per entry (`subagent:<toolCallId>:<index>`), never a generic `tool` item. `tool_execution_end`'s `details.progress[]` flips a subagent to `done`/`error` only once its own entry says so (otherwise it stays `running`); the later `custom`/`async-result` message's `details.jobs[]` is matched by the `id` recorded from `progress[]` (falling back to matching `label` against the subagent's `name`) and is the only source of `durationMs` and the plain-text result. A malformed/argument-less `task` call falls back to the plain `tool` item path instead of being silently dropped.
- **Agent messages (T079)**: FINDINGS item 22(f) left the wire shape open, so this is read defensively rather than against one exact assumed shape: a `custom` message whose `customType` names one of a few plausible IRC-message spellings, or whose `details` carries `from`/`sender` fields, becomes an `agent-message` item (`main.ts`'s `transcript.ts`); `SessionAgent.onFrame`'s `default` case additionally shape-detects the same fields on an unrecognised top-level frame, covering the alternative hypothesis that OMP sends it outside the message lifecycle entirely. Revisit once a real occurrence is observed.

## Word prediction (`predict_word`/`predict_word_feedback`) (T102)

Probed with `predict-word-probe.mjs` against an isolated, credential-free profile (FINDINGS item 28):

- Wire shapes exactly as documented in `omp://rpc.md`: `{id?, type:"predict_word", text, cursor}` → `data:{suffix: string|null}` (no `cursor` echoed back); `{id?, type:"predict_word_feedback", text, cursor, suggestion, accepted}` → `success:true` with no `data` payload for both `accepted:true` and `accepted:false`.
- Gating confirmed live: cursor mid-word, cursor not at the end of its line (more text follows on the same line), a file-path-shaped draft, and a slash-command-shaped draft all answered `suffix:null`. A plausible partial prose word at the end of a line answered a real `suffix`.
- **The prediction engine does not depend on the session's configured chat model.** Every call above, including the cold-start measurement, ran against a session whose only configured chat model was deliberately unreachable (`baseUrl: http://127.0.0.1:1`); every `predict_word` call still returned real suggestions. `rpc.md` itself supports this: answers come "from the engine selected by `spelling.autocomplete`" — a boolean (`auto`/`off`), not a model/provider selector. Refract can therefore exercise ghost text in an isolated or stub-model profile; no live chat-capable credential is required, only `spelling.autocomplete` left at its default.
- One-in-flight-replaces-older confirmed: with a burst of identical requests fired back to back (no await between sends), the first (already dispatched) and the last (left waiting when the first finished) each answered for real; every request in between answered `suffix:null` (superseded). A gap of only two requests was not reliably wide enough to reproduce this on a warm engine (both resolved for real in 1-9 ms) — do not use a two-request test as a regression check for this behaviour; use a wider burst.
- Cold start measured 7-16 ms for the first `predict_word` call on a brand-new isolated profile/process — far below `rpc.md`'s documented "worst case about two minutes." The shared prediction daemon is almost certainly a machine-wide singleton that was already warm from an earlier process; treat this number as "warm daemon," not as a refutation of the documented worst case, and do not assume Refract's own first keystroke-triggered `predict_word` call will always be this fast on a machine where the daemon has never run.

## Slash command classification (T092, re-run on omp 18.5.1)

`slash-commands-probe.mjs` (FINDINGS item 23) sends every top-level command and subcommand from
`get_available_commands` through an isolated, credential-free profile and classifies each by
observed behaviour. The run this table reflects used the script's current, fixed denylist
unchanged (constitution IV: the T092 run against omp 18.4.10 used an earlier, narrower denylist
and its per-command results were never trustworthy enough to build T093 from -- see FINDINGS item
23 -- so this 18.5.1 run supersedes it outright rather than diffing against it name-by-name):

| Class | Meaning | Count |
|---|---|---|
| `works-local` | Completes synchronously (`agentInvoked:false`) or completes a local turn without leaving the session unsettled | 57 |
| `starts-agent-turn` | Dispatches a real idle agent turn; needs a signed-in profile to confirm | 3 (`/ratchet`, `/green`, `/init`) -- same three names as the superseded 18.4.10 run |
| `needs-decision` | Denylisted (config/credential/model/plugin/destructive-shaped); never sent | 138 |

198 commands/subcommands were discovered in total (188 on the superseded 18.4.10 run; the two runs
used different denylists so the raw counts are not a like-for-like diff). `/effort` (`Set or show
reasoning effort (thinking level, intelligence)`) is present and `works-local`, confirming it is
new since 18.4.10 as expected for an 18.5.0 feature. `/changelog` and `/jobs` are also present and
`works-local`: both still answer over RPC with a plain-text `command_output` (a changelog excerpt
and a background-jobs summary respectively), so whatever 18.5.0 changed about their *interactive*
presentation (moving TUI output to a native sheet/page) is TUI-only and does not remove or alter
the `command_output` frame Refract reads -- it does not affect T093/T094. `/mcp` and `/ssh` remain
name-matched by the denylist (`mcp`, `ssh`), so this probe still never sends them and cannot
confirm or rule out the same TUI-only/RPC-unaffected conclusion for them directly; this stays an
open item, moot for T093/T094 either way since both names are hidden regardless of the answer.

The 57 `works-local` top-level command names: `fast` (+`on`/`ultra`/`off`/`status`), `slow`
(+`on`/`off`/`status`), `extended-context` (+`on`/`off`/`status`), `prewalk` (+`restart`), `effort`
(+`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`auto`), `dump` (+`all`), `todo`
(+`expand`/`collapse`/`append`/`start`/`done`/`rm`), `session` (+`info`), `jobs` (+`full`), `usage`
(+`show`), `changelog` (+`full`/`last`), `tools`, `context`, `fresh`, `shake`
(+`elide`/`images`/`thinking`), `retry`, `rename`, `add-dir`, `dirs`, `force`, `autoresearch`,
`annotate`, and `switch`.

**`src/shared/slash-commands.ts`'s T093 supported set deliberately excludes `switch` from the 57**
even though it completed cleanly (bare `/switch` only echoes `Current model: <provider>/<id>`; it
is read-only without an argument): its description is `Switch model for this session only`, i.e. a
model write by another name, and T092's own instructions flag "/model writes" for Stuart's
decision before Refract exposes them -- this is a judgment call recorded here, not a probe result,
because the denylist regex (name-only) does not catch it. The 3 `starts-agent-turn` names
(`/ratchet`, `/green`, `/init`) are excluded for the reason the class itself states: unverified
against a real model. Every `works-local` command actually included in the supported set was
checked against its raw recorded frames for this run: all 56 produce a visible `command_output`,
`notice`, or `extension_ui_request` dialog (never a silent `agentInvoked:false` with no observable
effect), so none needed to be dropped under FR-032's "cannot run to a visible result" rule.
`/annotate` and `/autoresearch` raise `select`/`notify` dialogs Refract already answers generically
(`dialogs.ts`); none of the 56 needed new main-process or renderer code beyond the T093 filter
itself.

## Failure handling

| Failure | Handling |
|---|---|
| `ready` not seen by the 180 s ceiling (issue #512) | `stopped`, `start-failed` (one automatic retry first, unless cancelled); stderr/omp-log tails (filtered to warnings/errors) and free/total memory kept for the setup message |
| Unparseable stdout line | Log it and continue (never crash the reader) |
| Chunk validation error | Fail the current request, log, keep the process |
| `success:false` response | Add an error `notice` naming the command; do not change status |
| `omp --version` is not `18.4.x` or `18.5.x` | Readiness check still passes for any other `18.x.y` (warns, naming the version found and that it is outside the specifically verified range, FR-036) -- Stuart's 2026-10-05 decision after 18.6.1 tripped the old exact-minor allowlist for the third time. Only a different MAJOR version is a hard failure. A specifically-verified addition to `18.4.x`/`18.5.x` (no warning shown) still needs the probes rerun and a FINDINGS entry, per Principle IV. |
| Worktree folder missing at open | `stopped`, `worktree-missing`, offer Recreate, Archive, Delete (FR-035); the agent is not started |

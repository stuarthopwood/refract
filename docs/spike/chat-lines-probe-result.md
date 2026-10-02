# Chat-lines wire-shape probe (T071)

- Date: 2026-10-02
- OMP version: `omp/18.4.10`
- Method: `docs/spike/chat-lines-probe.mjs`, run against the real signed-in default
  OMP profile (scratch `--session-dir`, scratch git repo cwd,
  `--approval-mode=always-ask`, every tool-approval dialog denied except the
  `task` tool's own "Allow tool: task" gate — approved so batch-subagent
  frames could be observed; every dialog a subagent itself triggers is still
  denied). No `/login` or config-changing command was ever sent. Six fresh
  `omp` processes were run, one prompt each, frames captured to a temp
  scratch dir (never this repo) and redacted here to shapes/lengths.

## (a) ask tool, multiple-choice, answered "A"

The question is a plain `extension_ui_request` (`method: "select"`) whose
`title` is the question text (not prefixed "Allow tool:") and whose `options`
are the literal choice labels (`"A (Recommended)"`, `"B"`,
`"Other (type your own)"`), plus an `optionDetails` array with per-option
`description`. Answering with `{value: "A"}` (a prefix of the full label) was
accepted.

The answer surfaces in `get_messages` as a `toolResult` message:
`content[0].text = "User selected: A"`, `details = {question, options, multi,
selectedOptions: ["A"]}`. No separate "answer" event; it's the tool's own
result.

**Consequence:** render the ask tool's question from `toolResult.details.question`
/`.options`, and read the rendered answer straight from
`toolResult.details.selectedOptions` (or `content[0].text`) — no extra request
pairing or correlation with the `extension_ui_request` is needed; the
tool-result message alone carries both the question and the answer.

## (b) ask tool, free text, answered "hello"

Free text is NOT a single `input` dialog. It's two dialogs in sequence: first
a `select` whose only option is `"Other (type your own)"` (sometimes with
other real choices too), then — once `"Other (type your own)"` is chosen — a
second `extension_ui_request` with `method: "editor"` (`promptStyle: true`)
that takes the actual free text as its `value`. (A probe bug that answered
only `select`/`input` and not `editor` made the ask tool retry this dialog
pair indefinitely until our 2-minute per-scenario timeout; fixing the
responder to answer `editor` too resolved it immediately.)

The completed answer in `get_messages`: `toolResult.content[0].text =
"User provided custom input: hello"`, `details = {question, options: [],
multi: false, selectedOptions: [], customInput: "hello"}`.

**Consequence:** a UI must handle the ask tool's free-text path as two
dialog turns, not one; the authoritative rendered answer is still read from
`toolResult.details.customInput` (or `content[0].text`) after the fact, same
as (a) — the two-step dialog shape only matters for a live-answering client,
not for a transcript renderer reading finished history.

## (c) ask tool, cancelled

Cancelling (`{cancelled: true}`) makes the tool result an error:
`toolResult.isError = true`, `content[0].text = "Ask tool was cancelled by
the user"`, `details = {}` (no `question`/`options` at all — the context is
lost).

**Consequence:** a cancelled ask is distinguishable only by `isError: true`
plus that fixed sentence; `details` carries no structured data for it, so a
transcript renderer must special-case the empty-details + isError shape and
fall back to the result text, not to `details.question`.

## (d) todo tool, create two tasks, mark first done, reply done

Every `todo` call (`init`, then two `done` calls) returns a `toolResult` whose
`details` is `{op, phases: [{name, tasks: [{content, status}]}], storage:
"session", completedTasks?: [...]}` and whose `content[0].text` is a
human-readable progress summary ("Remaining items (N): ... Overall: X/Y
done..."). `get_state().todoPhases` mirrors the current phase/task list shape
(`[{name, tasks: [{content, status}]}]`) independent of any particular tool
call — it's live session state, not just the last tool result.

**Consequence:** a todo-progress chat line can be rendered purely from
`toolResult.details.phases`/`content[0].text` per call; a persistent todo
widget (not tied to one message) should instead poll/track
`get_state().todoPhases`, which has the same `{name, tasks:[{content,
status}]}}` shape.

## (e) batch `task()` with two subagents ("Alpha", "Beta")

There is no `tool_call_update` frame type. The batch `task` tool call itself
is fire-and-forget: its own `tool_execution_start` → `tool_execution_update`
(repeated) → `tool_execution_end` all return almost immediately
(`totalDurationMs` ~16ms) with the same `details` shape:
```
details: {
  projectAgentsDir: null,
  results: [],
  totalDurationMs: <n>,
  progress: [
    { index, id: "Alpha", agent: "task", agentSource: "bundled",
      modelRole: "task", status: "pending", task, assignment,
      recentTools: [], recentOutput: [], toolCount, requests, tokens,
      cost, durationMs },
    { index, id: "Beta", ... }
  ],
  async: { state: "running", jobId: "Alpha", type: "task" }
}
```
i.e. `progress[]` IS the per-subagent id/name/status/timing array (`id` is
the subagent's own display name, `status` starts `"pending"`), but within our
capture window it only ever showed the two jobs as `"pending"` — the tool
call completes (`tool_execution_end`, `isError: false`) before either
subagent finishes; completion is reported later, out of band.

Completion surfaces as a separate `custom` message in `get_messages`:
`role: "custom"`, `customType: "async-result"`, whose `content` is a
human-readable `<system-notice>` block with one `<task-result id="..."
agent="..." status="completed" duration="4.5s"><output>...</output>
</task-result>` per subagent, and whose `details.jobs` is the structured
twin: `[{jobId, type, label, durationMs, schema: {source, mode, status,
data}}]` — `jobId`/`label` is the subagent name, `durationMs` its wall time,
`schema.data` its final reply (here the literal strings `"Alpha"`/`"Beta"`).
The separate `agent_start`/`agent_end` session frames carry NO id/name at all
(`agent_end.messages` has only the raw subagent transcript) — they cannot be
correlated to a specific subagent without matching message content, so they
are not a usable source for a per-subagent indicator.

`set_subagent_subscription` does not exist in `get_available_commands` on
18.4.10 (checked explicitly); the default-subscription and "subscribed" runs
behaved identically (no extra per-subagent live frames appeared either way;
the "subscribed" run instead hit our 2-minute scenario timeout once, which is
scenario timing variance, not a subscription effect).

**Consequence:** a batch-subagent chat line cannot be driven from the `task`
tool's own `tool_execution_*` frames past the initial "spawned" state — build
it from the `custom`/`async-result` message's `details.jobs[]` array
(`jobId`/`label`/`durationMs`/`schema.data`) for the completed-state summary,
and from the initial `tool_execution_end.result.details.progress[]` only for
the "N agents starting" transient state (names only, no live status updates
observed in-process).

## (f) subagent "Pinger" sends an IRC-style message to its parent

Could not trigger within this probe. Prompt used: *"Start a subagent named
Pinger and have it send an IRC-style message to its parent saying hi."* The
model did call `task` (approved, since it's the orchestration gate we allow)
with a batch containing one subagent and a schema requiring `{message:
string, sentViaTool: boolean}`, i.e. it modeled the request as "have the
subagent report back it sent an IRC message," not as an actual inter-agent
`write agent://<id>` call. The outer turn then ran past our 2-minute
per-scenario timeout waiting for Pinger to finish and was aborted
(`prompt_result.status: "aborted"`); no `write agent://`-shaped frame (or any
frame containing "irc") was ever observed.

**Consequence:** nothing to design against yet — still open. If a future
probe lets this scenario run to completion (longer timeout, or a narrower
prompt that explicitly asks the subagent to call `write agent://<parent>`),
re-run before building a UI affordance for subagent→parent messages.

## `<advisory` scan of existing session files (read-only, role/customType only)

Scanned `~/.omp/agent/sessions/**/*.jsonl` for lines containing `<advisory`:
5,199 matching lines, all with `role: null` (the field isn't set on these
entries at the top level the scan checked) and `customType: "advisor"` for
4,944 of them (the rest had neither field present at all). This matches the
`customType: "advisor"` shape seen live in scenario (a)'s `get_messages`
output above (a `role: "custom"` message with `customType: "advisor"`), i.e.
existing history uses the same `custom`/`advisor` message shape the live
probe observed — no separate/legacy shape was found.

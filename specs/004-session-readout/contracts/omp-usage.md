# Contract: how Refract uses OMP — Session readout additions

Extends spec 001's contract (`specs/001-core-session-workspace/contracts/omp-usage.md`). This
spec reads three OMP behaviours that are **unverified on the supported version (18.4.x)** per
constitution IV; each is resolved by a Phase 1 probe task in `tasks.md`, which updates this file
with the exact field or frame name once run. Nothing below is a field name yet — these are the
questions the probes answer, not an assumed answer.

## Unverified wire usage, resolved by Phase 1 probes

### a. Context window usage (Context window usage chip, FR-003)

**Question**: does OMP report the running agent's context-window usage at all, and if so where —
an existing `get_state` field (the response type already has `[key: string]: unknown`, so an
undocumented field is possible today), a dedicated request such as `get_session_stats`, or only as
a side effect of a `/context` slash command's `command_output` (FINDINGS "Available over RPC":
`/context` is already listed as available)?

**Probe**: `docs/spike/context-usage-probe.mjs` — start a Session, run a turn of some size, call
`get_state` and (if it exists) `get_session_stats`, and also run `/context` and capture its
`command_output`, comparing all three for a consistent token-used/window-size pair.

**Recorded as**: a new numbered FINDINGS item, plus the resolved field/request name entered here.

### b. Task-list ("todo") progress (Todo progress chip, FR-021)

**Question**: spec 001 FR-052 already hides the agent's own `todo` tool calls from the chat
(spec 001 task T086). Does OMP expose the resulting task list's done/total counts anywhere a
client can read them without parsing the hidden tool calls itself — a `get_state` field (the
spec's own wording, "todoPhases", names the shape to look for first), a frame pushed alongside
`tool_execution_end` for the `todo` tool, or only the hidden tool call's own `args`/`result`
(meaning Refract must read the hidden call after all, just not render it)?

**Probe**: `docs/spike/todo-progress-probe.mjs` — run a turn that creates and partially completes
a task list, and inspect `get_state` and the `todo` tool's own call/result for a done/total shape.

**Recorded as**: a new numbered FINDINGS item, plus the resolved source entered here.

### c. Per-subagent id, status, timing, and live stream (Subagents chip and panel, FR-007, FR-017 to FR-020)

**Question**: FINDINGS C6 already proves subagent progress exists as `tool_call_update` progress
on the `task` tool, and spec 001 task T071(d) separately probes just enough of this for one
collapsed chat line per subagent. This spec needs more: a *stable id* per subagent usable as a
React key and as the argument to `chat.setVisibleSubagent`, and the *live stream* of a selected
subagent — its own text and tool calls, not just its overall status — arriving incrementally
enough to drive `subagent:patch` within SC-006's 2 s. Does `tool_call_update` progress (or a
`set_subagent_subscription` frame, named in FINDINGS C6) carry a per-subagent text/tool-call
stream, or only a status/timing summary (in which case per-subagent text must come from somewhere
else, such as nested `message_start`/`message_end` frames scoped to the subagent)?

**Probe**: extends spec 001 task T071(d)'s probe run rather than repeating it — start a turn with
two or more subagents, subscribe with `set_subagent_subscription`, and specifically check whether
each `tool_call_update` (or any other frame received while subagents run) carries enough to build
a per-subagent `TranscriptItem[]` stream, not just a count.

**Recorded as**: an extension to FINDINGS C6 (not a new row — C6 already exists for this frame
family) noting the additional fields found, plus the resolved shape entered here.

## Verified, reused from spec 001 — not re-probed

- `agent_start` / `session_settled`: already relied on for the whole status machine (spec 001
  data-model.md); this spec reuses them unchanged for `turnStartedAt` (research.md item 8).
- `tool_execution_start` / `tool_execution_end` for the `task` tool: already the basis of spec 001
  task T078's one-collapsed-line-per-subagent chat rendering; this spec's subagent tracking reads
  the same calls, just builds a richer in-memory structure from them (id, status, stream) instead
  of only a chat row.

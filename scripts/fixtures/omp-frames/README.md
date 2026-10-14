# Recorded-frame `omp` fixtures

Fixtures for `scripts/verify-tauri-fake-omp.mjs` (issue #795 part 2, R12a). Each `.jsonl` file is
a strict **linear tape**: the engine starts at the first line and works down it, one frame at a
time, pausing only at a `__wait__` line until a matching command arrives from the real caller
(the Rust build's `omp::process::OmpProcess`, or a direct script talking to the fake `omp` the
same way).

## Tape syntax

Every non-comment line is JSON. Four shapes:

- An ordinary OMP wire frame (has a `type` field): emitted verbatim, after substituting any of the
  three sentinels below.
- `{"__wait__": ["type1", "type2", ...]}`: pause until the next command read from stdin has a
  `type` in this list; anything else is logged to stderr and dropped (a fixed-script replay, not a
  model, so it cannot answer a command it was not written to expect). Resolving a wait sets the
  sentinels for every frame that follows, until the next wait resolves.
- `{"__delay__": <ms>}`: pause the tape for `ms` milliseconds before continuing. Used so a
  streamed reply's incremental `message_update` deltas land as genuinely separate renders a
  polling harness can observe mid-stream, not one instantaneous final paint.
- `{"__exit__": {"code": <number>}}`: exit the process immediately with this code. Simulates `omp`
  crashing or exiting unexpectedly.

**Every fixture's second step (right after `ready`) is the `negotiate_protocol` handshake**
(`__wait__: ["negotiate_protocol"]` then its `response`): `omp::process::OmpProcess` sends this
unconditionally for every connection once `ready.supportedProtocolVersions` includes 2
(contracts/omp-usage.md "Start-up sequence per Session" step 2), before any other command --
omitting it stalls the real caller until its 60s/180s ready-wait ceiling with no visible error
(found live; see `session.jsonl`'s own provenance note).

**Every `prompt` wait is followed by its own `response` ack** (`{"...,"command":"prompt",
"success":true}`), before any of the turn's own frames: `OmpProcess::request`/`dispatch_frame`
only resolves a pending request once a matching `response` frame arrives, and `ipc/chat.rs`'s
`chat.send` waits on exactly that for 60s. A tape that went straight from the `prompt` wait to
`agent_start` (an earlier draft did) left the real caller's own `chat.send` call hanging for the
full 60s and then failing with a "prompt failed" notice, even though the harness's own DOM checks
passed well before that -- `scripts/verify-tauri.mjs`'s `waitForStreamedReply` now also asserts no
such notice ever appears, so this class of bug fails loudly instead of silently.

### Sentinels

Substituted as a bare string value only (never inside a longer string), anywhere in a frame:

| Sentinel | Set when a wait resolves on... | Value |
|---|---|---|
| `$lastId` | any command | that command's own `id` |
| `$turnId` | a `prompt` command | that command's own `id` (stays set across the whole turn's frames, even past a later unrelated wait, e.g. an approval's `extension_ui_response`) |
| `$lastMessage` | a command with a `message` or `question` string field (`prompt`, `btw`) | that field's value, so a fixture always echoes back whatever the live caller actually sent |

Lines starting with `//` are treated as comments (used here only for provenance notes) and
skipped; they are not part of the OMP wire format itself.

## Scenario selection

`REFRACT_FAKE_OMP_SCENARIO=<name>` selects `<name>.jsonl`. Unset, the engine picks `readiness`
when argv carries `--no-session` (the Rust readiness probe's own scratch, non-Session
`OmpProcess`) or `session` otherwise (a real Session's `OmpProcess`).

**`scripts/verify-tauri.mjs` never sets this env var itself.** It only ever drives two scenarios,
chosen implicitly by which kind of `OmpProcess` the Rust code itself spawns: `readiness` (the
`--no-session` scratch probe `ipc/readiness.rs` runs as part of `readiness.check`, exercised by
US1) and `session` (a real Session's process, exercised by US4). `side-chat.jsonl`,
`subagents.jsonl`, `failure.jsonl` and `exit.jsonl` are **not driven by anything in this PR** --
they exist for the R3/R5/R6 lanes to select directly (by setting the env var themselves) once
they port the matching channel, and are not proven to work end to end by this harness.

## Provenance

Every row below states plainly what was actually captured versus what was written by hand against
the documented contract -- a run being green proves only what its own row says it proves.

| File | Source | What is genuinely recorded vs. hand-written |
|---|---|---|
| `readiness.jsonl` | Recorded live with `node scripts/verify-tauri-record.mjs --out <path> --readiness` against a real, signed-in `omp` (`negotiate_protocol`, `get_state`, `get_available_models`, `get_login_providers`, in that order, matching `ipc/readiness.rs`'s own `probe_signed_in` sequence exactly) | Field names, nesting, and the `provider`+`id` match between `get_state.model` and a `get_available_models` entry (what the readiness probe's own `ok`/`ok:false` branch checks for) are all real. Provider/model/account ids replaced with placeholders. |
| `session.jsonl` | Recorded live with `node scripts/verify-tauri-record.mjs --out <path>` against a real, signed-in `omp`: `negotiate_protocol`, `get_state`, a one-tool-call turn (`write` with a prompted approval), a queued follow-up (`queue_update`), a local slash command (`/tools`, `command_output`), `get_messages`. `get_messages_page`'s own response shape (`{"messages":[],"totalMessages":0}`, no `nextCursor` key at all for an empty page) was separately confirmed live against the same real `omp` (a bare `get_state` + `get_messages_page` round trip, no model turn). **Hand-edited after recording, not a byte-for-byte replay:** the queued follow-up and slash-command exchange were dropped from the shipped tape (the engine's generic `__wait__`/sentinel mechanism still supports scripting them; a later lane can add them back), the chat text and the assistant's own reply were replaced with a placeholder/token (`xyzzy9` -- `scripts/verify-tauri.mjs`'s own scripted prompt deliberately never contains this string, so a check against it can only ever match the assistant's own reply), and a `{"__delay__": 2000}` was inserted between the assistant's two streamed deltas (not present in the real capture, which streamed far more and far smaller deltas) so a CDP poller can reliably observe a strict, partial prefix of the token (`"xy"`) before the full token arrives, proving the reply streamed in rather than painting in one shot. `agent_end`'s three fields (`messages`, `isTerminal`, `yielded`) and the `response` ack immediately following the `prompt` wait are both exactly as captured live, not guessed. |
| `side-chat.jsonl` | Synthesized from `src/shared/frames.ts` (`BtwCommand`/`BtwDeltaFrame`/`BtwRecordFrame`/`BtwHistoryThread`) and spec 014's gate-fix notes | No live capture at all: the Rust build has no `btw` channel yet (`session/agent/mod.rs`'s own header). Not driven by `verify-tauri.mjs`; for the R6 lane (#789) to select directly once it ports the channel. |
| `subagents.jsonl` | Synthesized from `src/shared/frames.ts`'s `ToolExecutionUpdateFrame` (spec 004 FR-007/FR-017 to FR-020); the `get_state`/`get_messages_page` preamble reuses the same genuinely-recorded shapes as `session.jsonl` | No live capture of the `task()`/subagent frames themselves: a batch run was out of the tiny-prompt budget. Not driven by `verify-tauri.mjs`; for the R5 lane (#788) once it ports subagent rendering. |
| `failure.jsonl` | Synthesized from `src/shared/frames.ts`'s `PromptResultFrame`/`PromptResultError` and contracts/omp-usage.md's "Frames Refract consumes" table; same genuinely-recorded preamble as `session.jsonl` | No live capture of a real provider error: forcing one was out of scope for the tiny-prompt budget. Not driven by `verify-tauri.mjs`. |
| `exit.jsonl` | Synthesized (the `__exit__` engine directive, not an OMP frame) | For the R3 lane (#786, termination/recovery as a typed state machine). Not driven by `verify-tauri.mjs`. |

No real chat text, file paths, account identifiers, or provider names from any recording session
are checked in anywhere in this directory; every string that came from a live model turn was
replaced with a short placeholder before being committed. The raw, unsanitised capture never left
the machine it was recorded on (a scratch temp directory, never this repository -- `--out` refuses
to write inside the repo at all).

## Re-recording

Re-run `node scripts/verify-tauri-record.mjs --out <path>` (or `--readiness` for the
`get_state`/`get_available_models`/`get_login_providers` sequence) against a real, signed-in `omp`
on `PATH` whenever the wire protocol changes (a new `omp` version, a new frame type Refract starts
depending on) and diff the result against these fixtures by field name and frame-type sequence,
never by exact chat text. Update the sanitized `.jsonl` files here by hand; never check in the raw
capture itself (and note which lines, if any, were edited after recording in this table, the same
way `session.jsonl`'s own row does).

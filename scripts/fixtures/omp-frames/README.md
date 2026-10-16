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

**Every Session-shaped tape's `get_state` response is followed by a `set_ask_dialog`
wait/response** (issue #572, contracts/omp-usage.md "Start-up sequence per Session" step 4):
`launch()` sends `{type:"set_ask_dialog", enabled:true}` right after reattach verification and
before `get_messages`/`get_messages_page`, on every Session launch. Omitting this step does not
hang the tape (the fake omp logs and drops an unexpected command rather than stalling its own
read loop), but it DOES stall the real caller for the full 60s `DEFAULT_REQUEST_TIMEOUT_MS`
before it moves on to fetch history -- found exactly this way while building #572, the same
class of silent-stall bug the `negotiate_protocol` note above already warns about. Not needed by
the `--no-session` readiness probe's own tape (`readiness.jsonl`), which never calls `launch()`.

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
| `$conversationFile` | process start (seeded once, never updated by a wait) | `process.env.REFRACT_FAKE_OMP_CONVERSATION_FILE`, a real, literal absolute path the caller pre-created on disk -- needed only by a fixture scripting a genuine reattach/reopen round trip, since `assert_conversation_file_exists` (`launch_support.rs`) checks the persisted `current_conversation` path actually exists before sending `switch_session` |
| `$histTodayAt` / `$histYesterdayAt` / `$histThisYearAt` / `$histPastYearAt` | process start (seeded once, never updated by a wait) | `process.env.REFRACT_FAKE_OMP_HIST_TODAY_AT` / `_HIST_YESTERDAY_AT` / `_HIST_THIS_YEAR_AT` / `_HIST_PAST_YEAR_AT`, each a real epoch-ms number the caller computes relative to its own "now" at run time (`null` when unset or non-numeric) -- needed only by a fixture whose canned `get_messages_page` history must embed timestamps that land in specific day-aware buckets (today/yesterday/this year/a past year) regardless of which real calendar day the run happens on |

Lines starting with `//` are treated as comments (used here only for provenance notes) and
skipped; they are not part of the OMP wire format itself.

## Scenario selection

`--no-session` on argv ALWAYS selects `readiness` (the Rust readiness probe's own scratch,
non-Session `OmpProcess`), regardless of `REFRACT_FAKE_OMP_SCENARIO` (issue #856: a live check's
override for the Session's own `OmpProcess` must never also hijack the unrelated readiness
probe's tape). Otherwise, `REFRACT_FAKE_OMP_SCENARIO=<name>` selects `<name>.jsonl`; unset, that
defaults to `session` (a real Session's `OmpProcess`).

**`scripts/verify-tauri.mjs` never sets this env var itself.** It only ever drives two scenarios,
chosen implicitly by which kind of `OmpProcess` the Rust code itself spawns: `readiness` (the
`--no-session` scratch probe `ipc/readiness.rs` runs as part of `readiness.check`, exercised by
US1) and `session` (a real Session's process, exercised by US4). `side-chat.jsonl`,
`subagents.jsonl`, `subagents-background-turn.jsonl`, `failure.jsonl` and `exit.jsonl` are **not
driven by anything in this PR** -- they exist for the R3/R5/R6 lanes to select directly (by
setting the env var themselves) once they port the matching channel, and are not proven to work
end to end by this harness.

## Provenance

Every row below states plainly what was actually captured versus what was written by hand against
the documented contract -- a run being green proves only what its own row says it proves.

| File | Source | What is genuinely recorded vs. hand-written |
|---|---|---|
| `readiness.jsonl` | Recorded live with `node scripts/verify-tauri-record.mjs --out <path> --readiness` against a real, signed-in `omp` (`negotiate_protocol`, `get_state`, `get_available_models`, `get_login_providers`, in that order, matching `ipc/readiness.rs`'s own `probe_signed_in` sequence exactly) | Field names, nesting, and the `provider`+`id` match between `get_state.model` and a `get_available_models` entry (what the readiness probe's own `ok`/`ok:false` branch checks for) are all real. Provider/model/account ids replaced with placeholders. |
| `session.jsonl` | Recorded live with `node scripts/verify-tauri-record.mjs --out <path>` against a real, signed-in `omp`: `negotiate_protocol`, `get_state`, a one-tool-call turn (`write` with a prompted approval), a queued follow-up (`queue_update`), a local slash command (`/tools`, `command_output`), `get_messages`. `get_messages_page`'s own response shape (`{"messages":[],"totalMessages":0}`, no `nextCursor` key at all for an empty page) was separately confirmed live against the same real `omp` (a bare `get_state` + `get_messages_page` round trip, no model turn). **Hand-edited after recording, not a byte-for-byte replay:** the queued follow-up and slash-command exchange were dropped from the shipped tape (the engine's generic `__wait__`/sentinel mechanism still supports scripting them; a later lane can add them back), the chat text and the assistant's own reply were replaced with a placeholder/token (`xyzzy9` -- `scripts/verify-tauri.mjs`'s own scripted prompt deliberately never contains this string, so a check against it can only ever match the assistant's own reply), and a `{"__delay__": 2000}` was inserted between the assistant's two streamed deltas (not present in the real capture, which streamed far more and far smaller deltas) so a CDP poller can reliably observe a strict, partial prefix of the token (`"xy"`) before the full token arrives, proving the reply streamed in rather than painting in one shot. `agent_end`'s three fields (`messages`, `isTerminal`, `yielded`) and the `response` ack immediately following the `prompt` wait are both exactly as captured live, not guessed. **Hand-added later (issue #572, not from the original recording):** the `set_ask_dialog` wait/response right after `get_state`, matching the real `launch()` sequence's new step 4 -- without it this tape silently stalled the real caller for a full 60s per launch (this README's own note above). |
| `side-chat.jsonl` | Synthesized from `src/shared/frames.ts` (`BtwCommand`/`BtwDeltaFrame`/`BtwRecordFrame`/`BtwHistoryThread`) and spec 014's gate-fix notes | No live capture at all: the Rust build has no `btw` channel yet (`session/agent/mod.rs`'s own header). Not driven by `verify-tauri.mjs`; for the R6 lane (#789) to select directly once it ports the channel. |
| `subagents.jsonl` | Synthesized from `src/shared/frames.ts`'s `ToolExecutionUpdateFrame` (spec 004 FR-007/FR-017 to FR-020); the `get_state`/`get_messages_page` preamble reuses the same genuinely-recorded shapes as `session.jsonl` | No live capture of the `task()`/subagent frames themselves: a batch run was out of the tiny-prompt budget. Not driven by `verify-tauri.mjs`; for the R5 lane (#788) once it ports subagent rendering. |
| `subagents-background-turn.jsonl` | Synthesized from `src/shared/frames.ts`'s `ToolExecutionEndFrame`, `transcript.ts`'s own `jobsFromDetails`/`applyAsyncResultJobs`, and the vendored `scripts/fixtures/omp-schema/rpc-wire.schema.json`'s `SubagentStatus`/`GetSubagentsResult` defs | No live capture: a genuinely async, multi-turn `task()` batch was out of the tiny-prompt budget. Exercises a subagent still `running` when turn 1 settles, surviving into turn 2, settled only by a later `wait` tool call's own `jobs[]` -- for the R5 lane (#788, #712) live-check round 2. |
| `failure.jsonl` | Synthesized from `src/shared/frames.ts`'s `PromptResultFrame`/`PromptResultError` and contracts/omp-usage.md's "Frames Refract consumes" table; same genuinely-recorded preamble as `session.jsonl` | No live capture of a real provider error: forcing one was out of scope for the tiny-prompt budget. Not driven by `verify-tauri.mjs`. |
| `exit.jsonl` | Synthesized (the `__exit__` engine directive, not an OMP frame) | For the R3 lane (#786, termination/recovery as a typed state machine). Not driven by `verify-tauri.mjs`. |
| `session-two-turns-answered.jsonl` | Hand-extended copy of `session.jsonl` (issue #856 live-check) | Identical through `session.jsonl`'s own final `get_state` response; appends a second `prompt`/`agent_start`/streamed-reply/`session_settled`/`get_state` cycle so a manual two-`chat.send` check can confirm turn 2 still streams once the first turn's settle-time `get_state` IS answered. Not driven by `verify-tauri.mjs`'s own committed proof (a scratch driver selects it via `REFRACT_FAKE_OMP_SCENARIO`). **Hand-added later (issue #572, not from the original recording):** the `set_ask_dialog` wait/response right after the first `get_state`, matching the real `launch()` sequence's new step 4 -- the same insertion point `session.jsonl`'s own note documents. |
| `session-two-turns-withheld.jsonl` | Hand-extended copy of `session.jsonl` (issue #856 live-check) | Same as `session-two-turns-answered.jsonl` except the first turn's post-`session_settled` `get_state` is never waited for at all (the tape moves straight to waiting for the second `prompt`), so that command is simply dropped by `verify-tauri-fake-omp.mjs`'s own "not waiting for this type" branch -- proving turn 2 still streams even when that reply never arrives. Not driven by `verify-tauri.mjs`'s own committed proof. **Hand-added later (issue #572, not from the original recording):** the `set_ask_dialog` wait/response right after the first `get_state`, matching the real `launch()` sequence's new step 4 -- the same insertion point `session.jsonl`'s own note documents. |
| `session-settle-before-start.jsonl` | Hand-extended copy of `session.jsonl` (issue #856 live-check, round 1) | Identical through `session.jsonl`'s own `get_messages_page` response, then injects a `session_settled` frame (and its own `get_state` wait/response) BEFORE the first `prompt`/`agent_start` -- the attach-time edge case `AgentState.turn_generation`'s initial value (odd, "not yet settled") exists to handle; the rest of the tape is `session.jsonl`'s own single-turn flow, unmodified. Not driven by `verify-tauri.mjs`'s own committed proof. **Hand-added later (issue #572, not from the original recording):** the `set_ask_dialog` wait/response right after the first `get_state`, matching the real `launch()` sequence's new step 4 -- the same insertion point `session.jsonl`'s own note documents. |
| `side-chat-live.jsonl` | Synthesized from `src/shared/frames.ts` (`BtwCommand`/`BtwDeltaFrame`/`BtwRecordFrame`) and specs/014's gate-fix notes, same approach as `side-chat.jsonl` | No live capture: the Rust build had no `btw`/`predict_word` channel to record against until lane R6 (#789) landed one. Driven directly by `scripts/verify-tauri-side-chat.mjs` (not `verify-tauri.mjs`): a full Session attach, a side question whose `btw` exchange sits AFTER `agent_start` so its delta/record patches genuinely arrive mid-main-turn at the frame level, a second side question cancelled before it completes, `predict_word`/`predict_word_feedback`, a Conversation switch (`btw_cancel` then `new_session` then `get_state`), and two late unsolicited `btw_delta`/`btw_record` push frames for the already-cancelled topic AFTER the switch (cancelled-topic isolation surviving a switch, not just a cancel). Shared by a second, idle peer Session (proves cross-session isolation structurally) and a third, never-opened Session whose own first `conversations.startNew` spawns a fresh process that reattaches through this same preamble (the stopped-Session Conversation-switch gate-fix). |
| `side-chat-restart.jsonl` | Synthesized, same approach | No live capture; a brand-new fake `omp` process with no memory of the earlier run, so it always answers `get_btw_history` with the topic `side-chat-live.jsonl`'s own run asked, proving only that `sideChat.getHistory` reattaches and flattens correctly after a restart, not that OMP itself persisted the thread across the process boundary. Driven directly by `scripts/verify-tauri-side-chat.mjs`'s second launch, against the same `REFRACT_DATA_DIR` as the first. |
| `ask.jsonl` | Synthesized: the preamble through `set_ask_dialog`'s response and the empty `get_messages_page` reuses `session.jsonl`'s own genuinely-recorded shapes verbatim; the `ask` tool call, the `extension_ui_request`/`extension_ui_response` exchange, and the `tool_execution_end` are hand-written against `docs/spike/FINDINGS.md` item 59's live probe (`docs/spike/ask-dialog-probe.mjs`, a real, signed-in `omp`), which captured the real `extension_ui_request` frame field-for-field (`header`, per-option `description`, `recommended`, no `timeout` key when `ask.timeout` is at its disabled default) for the questions it actually sent. **Correction (gate round 3):** this tape's single-choice question also carries an explicit `"multi":false`, which the live probe's own captured frame did NOT have at all on that question (the real single-choice question simply omitted the `multi` key, relying on its absent-means-false default) -- that specific missing-key shape has never itself been exercised live, only this tape's own explicit-`false` variant; the probe's multi-select question's own `"multi":true` does match field-for-field. **Hand-edited after the initial commit (gate round 1):** `tool_execution_end.result.details.results[]` gained an `id` field on each entry (`"db"`/`"features"`), matching `ask.md`'s own documented batch shape -- the first cut omitted it (matching only the OLD position-based answer matching `RequestCard.tsx` used before the gate found that bug), so once the renderer started matching by `id` instead, every answer here silently fell back to "None selected". | No live capture of THIS tape's own round trip: item 59's probe exercised the same wire shape (apart from the `multi:false` difference just noted) in a separate scratch run, not this file. Scripted so a real-DOM-input live check (`scripts/verify-tauri-ask.mjs`, not driven by `pnpm verify:tauri`'s two committed scenarios) can answer "Postgres" (over the recommended "SQLite") on the single-choice question and "Auth"+"Search"+"Other: Beta" on the multi-choice question, then assert the `tool_execution_end`'s own `details.results[]` batch shape (contracts/omp-usage.md "Chat line wire shapes") renders as the expected "Asked user:" collapsed summary and per-question "Answer:" rows. |
| `user-message-time.jsonl` | Hand-extended copy of `session.jsonl` (issue #555 live-check) | Identical to `session.jsonl` line for line through the first turn, except `msg-u1`'s (and the added second turn's `msg-u2`'s) `message_start`/`message_end` frames OMIT the `timestamp` key entirely (every other fixture hardcodes `"timestamp":0` for every message, a deliberate determinism convention for golden/contract-replay tests -- but it also means `as_timestamp` in `transcript.rs` reads a real, present `0` rather than a missing field, so a live-sent user item's own `at` would become the sentinel-zero "no usable timestamp" case instead of falling back to `now_ms()`). Appends a second `prompt`/`agent_start`/`msg-u2`/streamed-reply/`session_settled`/`get_state` cycle (same shape as `session-two-turns-answered.jsonl`, no tool call this time) so a two-turn live check can assert the SECOND human turn also gets a real timestamp and the `mt-6` turn-gap margin above it. Every `get_state`'s `sessionFile` uses the new `$conversationFile` sentinel (not the usual fake `C:\scratch\...` literal), so the same session file path is a REAL file on disk the caller pre-creates -- required for `user-message-time-reopen.jsonl` below to pass `assert_conversation_file_exists` on a genuine second-launch reattach. Not driven by `verify-tauri.mjs`'s own committed proof (a scratch driver selects it via `REFRACT_FAKE_OMP_SCENARIO=user-message-time`). |
| `user-message-time-reopen.jsonl` | Hand-written companion to `user-message-time.jsonl` (issue #555 live-check; extended 2026-10-16 after gate round 1, Stuart's day-aware date rule; reordered and hardened 2026-10-16, Stuart's hide-under-a-divider amendment; a second no-timestamp message inserted 2026-10-16, gate round 3) | A SEPARATE fake-`omp` process for a SECOND app launch against the same `REFRACT_DATA_DIR` (a genuine reopen, not a same-process simulation): scripts the `switch_session`/`get_state`/`set_ask_dialog`/`get_messages_page` sequence `attach_and_verify`/`fetch_all_messages` (`launch.rs`, `launch_support.rs`) actually issue on reattaching to an existing Session's persisted Conversation, per the README's own "every Session-shaped tape" preamble notes above. The canned `get_messages_page` history response carries SEVEN messages, OLDEST FIRST: a past year, an assistant reply (realism filler, not asserted), earlier this year, a user message with NO `timestamp` key, yesterday, today, then a second user message with NO `timestamp` key -- the same message order a real reopened Conversation's own history would always already be in. Every message is processed through `items_from_history`'s `.unwrap_or(0)` path (deliberately different from the live-send `apply_message_snapshot` path's `.unwrap_or_else(now_ms)` in `user-message-time.jsonl` above): the FOUR real-timestamp `user` messages (past year, this year, yesterday, today) use the new `$histTodayAt`/`$histYesterdayAt`/`$histThisYearAt`/`$histPastYearAt` sentinels (the caller computes each epoch-ms value against its own real "now" at run time, so the history lands in the exact day-aware bucket `UserMessageRow.tsx`'s `formatMessageTime` is meant to show); the TWO no-timestamp `user` messages carry no `timestamp` key at all (asserts `at === 0` -- hidden, "hide rather than invent", on both). Of the three real-timestamp messages after the first, ONLY "this year" and "today" still get a `TimeGapDivider` directly above them (each crosses a calendar-day boundary from its own real-timestamp predecessor) -- "yesterday" does NOT, because the no-timestamp message now sitting directly in front of it breaks `showTimeGapDivider`'s own previous-turn-has-a-real-`at` guard on both sides of that gap; `UserMessageRow` therefore renders "yesterday"'s own per-message time instead of hiding it, exercising "the previous turn had no timestamp, so the label shows" (gate round 3). Neither no-timestamp message ever sits under a divider either, for the same guard reason. `get_state.messageCount` is 7, matching the actual history length, so the reattach's own message-count-drop notice (`reattach_rebaseline_notice`, `launch_support.rs`) never fires against `user-message-time.jsonl`'s own persisted count of 4. Not driven by `verify-tauri.mjs`'s own committed proof (a scratch driver, `scripts/verify-555-user-message-time.mjs`, selects it via `REFRACT_FAKE_OMP_SCENARIO=user-message-time-reopen` on its SECOND launch only). |

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

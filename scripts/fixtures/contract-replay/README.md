# Contract-replay fixtures (issue #795 part 3, R12b)

`scripts/fixtures/contract-replay/session-scenario.rust-trace.json` is the frozen golden trace
`src-tauri/tests/contract_replay.rs` diffs a live run against. It is not recomputed and compared
to itself (that would prove nothing) -- it is a checked-in snapshot of one known-good run,
hand-verified against the tape before being committed.

## Scenario

Drives the `session` scenario tape (`scripts/fixtures/omp-frames/session.jsonl`, see that
directory's own `README.md` for the tape's provenance) through a **real**
`ipc::Dispatcher`/`AppState`/`session::SessionManager`/`session::SessionAgent`/`omp::OmpProcess`,
with no Tauri window, no WebView2/CDP, and no cargo-managed binary involved at all: the test
spawns the recorded-frame fake `omp` (`scripts/verify-tauri-fake-omp.mjs`) behind the native PATH
shim (`scripts/verify-tauri-omp-shim.rs`, compiled on demand with a bare, non-Cargo `rustc`
call), by prepending a scratch directory containing a shimmed `omp.exe` onto the test process's
own `PATH` before the first spawn -- `process::executables::resolve_omp()`'s PATH lookup then
resolves to it instead of a real install, the same mechanism `scripts/verify-tauri.mjs` already
uses for the full CDP harness, with zero Rust source changes.

The scripted IPC sequence (each call driven through `ipc::Dispatcher::dispatch`, exactly as the
renderer would) is:

1. `repositories.add` -- registers a fresh scratch git repository (one commit on `main`).
2. `sessions.create` -- creates a Session off that repository's `main` branch.
3. `sessions.open` -- spawns the shimmed `omp`, driving the tape's `negotiate_protocol`,
   `get_state`, `available_commands_update`, and `get_messages_page` round trip to completion.
4. `chat.send` -- sends the one-tool-call prompt (tape's `prompt` wait/ack); the agent then
   asynchronously streams `agent_start`/`message_start`/`message_end`/`tool_execution_start`/
   `extension_ui_request` off its own frame-listener task.
5. `chat.answer` -- approves the `write` tool call (`{"approve": true}`), sending the tape's
   `extension_ui_response`; the tape then streams the assistant's reply (with the fixture's own
   `{"__delay__": 2000}` between its two deltas) and settles the turn.

Between/after these calls, the test polls `SessionAgent::status()` (public accessor) for the
expected status transition (`needs-you` once the approval request lands, `idle` once the turn
settles) with a generous, non-racy timeout -- the tape is a fixed, deterministic script, so these
are bounded waits for a known outcome, not a flaky race.

## Why transcript snapshots instead of real emitted events

The assignment asked this test to "subscribe to the SessionAgent's transcript/event stream" and
capture "the sequence of TranscriptOp/event payloads produced during the run". In practice,
`events::EventSink`'s every method is a documented no-op when `AppState::app_handle` is `None`
(see `events.rs`'s own header comment: "`app_handle` is `None` until `lib.rs`'s `setup` closure
runs; every method here silently no-ops until then") -- and this test has no real Tauri
window/`AppHandle` to construct (that is the entire point of this harness: no Tauri window, no
WebView2/CDP). There is therefore no real Tauri event for this test to ever observe.

Instead, the test captures full `SessionAgent::runtime_view()` snapshots (a `pub async fn`, the
same "narrow accessor" `ipc::sessions_agent::sessions_open`/`ipc::conversations::build_snapshot`
themselves call to build their own response envelope) at three checkpoints: right after
`sessions.open` (empty transcript), right after the approval request lands (`needs-you`, one
`tool`/one `request` row), and right after the turn settles (`idle`, plus the resolved request row
and the streamed `assistant-text` row). Each snapshot is the FULL transcript array at that point,
not a per-frame diff -- this is strictly more information than a `TranscriptOp` sequence would be
(a diff is reconstructible from consecutive full snapshots; the reverse is not true), captured
through the one public accessor available without a window.

## Normalization rules

Every run creates a fresh scratch git repository, Session, and registry entries with genuinely
random/wall-clock-dependent values; the test replaces each of the following with a fixed
placeholder before comparing against this golden file (longest string first, so a longer match,
e.g. the full worktree path, is substituted before a shorter string it happens to contain, e.g.
the bare repository folder name, can partially corrupt it):

| Placeholder | Source | Why non-deterministic |
| --- | --- | --- |
| `<WORKTREE_PATH>` | `sessions.create` response's `worktreePath` | contains a randomly generated adjective-noun branch name (`git::worktrees::add_worktree_with_generated_name`) and the scratch repo's own temp-dir path |
| `<REPO_DIR>` | `repositories.add` response's `path` | a fresh `env::temp_dir()`-rooted scratch git repository per run |
| `<REPO_NAME>` | `repositories.add` response's `name` | the scratch repo folder's own basename (includes a `uuid::Uuid::new_v4()`) |
| `<BRANCH_NAME>` | `sessions.create` response's `branch`/`name` | the same randomly generated adjective-noun branch name as `<WORKTREE_PATH>` above |
| `<SESSION_ID>` | `sessions.create` response's `id` | `uuid::Uuid::new_v4()` |
| `<REPO_ID>` | `repositories.add` response's `id` | `uuid::Uuid::new_v4()` |
| `<TIMESTAMP>` | any 24-character `new Date().toISOString()`-shaped string (`ipc::now_iso8601()`) | real wall-clock time (`addedAt`/`createdAt`/`lastActivityAt`) |
| `<TIMESTAMP_MS>` | any `startedAt`/`endedAt`/`durationMs` field on a transcript row | `omp::transcript`'s own `now_ms()` real-wall-clock stamps on `Tool`/`Subagent` rows -- bookkeeping this crate adds itself, never supplied by the fixture tape |

Everything else in the trace -- every message id (`msg-u1`, `msg-a1:0`), tool-call id (`call-1`),
dialog/request id (`dlg-1`), tool name/path/content, and the assistant's own reply text
(`xyzzy9`) -- comes straight from the literal, fixed strings in `session.jsonl` itself (the one
`OmpProcess::request` id-counter sequence, `refract-1`/`refract-2`/.../`refract-N`, is also
deterministic per process, but never surfaces in any of the captured IPC envelopes or transcript
snapshots, so it needed no placeholder of its own).

A Session this test never calls `sessions.setVisible` on: `unread: true` in the final
`after_turn_settled` snapshot is the correct, deterministic result of a `working` -> `idle`
transition on a Session that was never made visible (`SessionAgent::set_status`'s own documented
rule), not an oversight.

The final registry-level resync (`SessionAgent::on_session_settled`'s own trailing `get_state`,
which persists `lastMessageCount`/`lastModel`/`lastThinkingLevel` back onto the Session row) runs
on the background frame-listener task with no IPC call this test can block on to know it has
finished -- so, to keep this test non-racy, no `sessions.list` call is captured after the turn
settles. That final persisted-registry-state path is already covered by this crate's own
`ipc::sessions_lifecycle_tests` (registry-only, synthetic `Session` rows), not duplicated here.

## Regenerating the golden file

1. Run `cd src-tauri && CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 cargo test
   --test contract_replay -- --nocapture`.
2. The test prints `contract_replay: normalized trace:` followed by the full, already-normalized
   JSON array, then fails (comparing against the stale/edited golden file).
3. Eyeball the printed trace against `scripts/fixtures/omp-frames/session.jsonl` (and this file's
   own normalization table above) for correctness -- this is the one human-verification step; the
   test itself only ever diffs against whatever is checked in afterward.
4. Copy the printed array verbatim into `session-scenario.rust-trace.json`, replacing its entire
   contents.
5. Re-run the same command twice in a row to confirm an identical, green pass both times (proves
   nothing was accidentally baked in as a race).

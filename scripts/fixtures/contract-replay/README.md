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
on a spawned task (issue #856: no longer the frame-listener task itself, so it never blocks
later frame delivery) with no IPC call this test can block on to know it has finished -- so, to
keep this test non-racy, no `sessions.list` call is captured after the turn settles. That final
persisted-registry-state path is already covered by this crate's own `ipc::sessions_lifecycle_tests`
(registry-only, synthetic `Session` rows), not duplicated here.

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

## Electron-trace fixture and the cross-shell diff (gate-round-1 remediation, PR #834)

`scripts/fixtures/contract-replay/session-scenario.electron-trace.json` is the Electron-build
counterpart to `session-scenario.rust-trace.json`: the same `session` scenario tape, driven
through the real Electron-build IPC handlers (`src/main/ipc/repositories.ts`/`sessions.ts`/
`chat.ts`'s own `register*` functions) and a real `SessionManager`/`SessionAgent`/`OmpProcess`,
with no Electron app/`BrowserWindow` launched at all (`electron` mocked down to the one export
these handler files call at runtime, `ipcMain.handle`, used only to capture each handler function
into a plain map -- the handlers are then invoked directly, exactly like a real `ipcMain.invoke`
round trip would). Unlike the Rust build, `OmpProcessOptions`/`SessionManager`'s constructor
already expose a public `ompPath` override seam, so this points the fake-omp shim directly at
that seam -- no PATH-shim needed on this side.

Unlike the Rust trace, this fixture's final step is `kind: "events"`: the real, ordered
`ManagerEvent[]` captured off `SessionManager.onEvent` (`SessionManager.onEvent` is a plain,
Electron-independent `EventEmitter`-style subscription -- `forwardEvent`'s window-send step is a
separate, later step this never calls), not reconstructed snapshots the way the Rust trace has to
(no live-window workaround needed on this side at all).

### How it was produced

There is no live TS test reading this fixture (AGENTS.md's "no new tests while prototyping" rule
covers `src/main`/TypeScript in full for this lane; the epic #797 exception for new tests is
Rust-ports only). It is produced by a checked-in generator script,
`scripts/gen-contract-replay-electron-trace.mjs` (reusing the driving logic of the original
gate-round-1 throwaway TS test, `src/main/ipc/contractReplay.test.ts` -- deleted per the
no-new-tests rule above, but never reachable again after a squash merge to `main`, which is why
gate-round-2 (MEDIUM #4, PR #834) replaced it with this checked-in script instead of a second
throwaway one). The generator writes the normalized trace straight to this file (no manual
copy-paste step); it is never auto-run by `pnpm test`/CI (lives under `scripts/`, outside
`vitest.config.ts`'s own `include: ['src/**/*.test.ts']`, and isn't named `*.test.ts`/
`*.spec.ts` either), and needs its own one-off vitest config
(`scripts/gen-contract-replay-electron-trace.vitest.config.mjs`) to be runnable at all, since an
explicit CLI file argument alone does not override `vitest.config.ts`'s `include`. Regenerate:

```
npx vitest run --config scripts/gen-contract-replay-electron-trace.vitest.config.mjs scripts/gen-contract-replay-electron-trace.mjs
```

Eyeball the diff (if any) against `scripts/fixtures/omp-frames/session.jsonl` before committing --
see the generator's own header comment for the full rationale. Regenerate it the same way if
`src/main`'s IPC handlers or `SessionManager`/`SessionAgent` ever change in a way that should be
reflected here.

### Normalization

Same placeholder table as the Rust trace above (`<WORKTREE_PATH>`/`<REPO_DIR>`/`<REPO_NAME>`/
`<BRANCH_NAME>`/`<SESSION_ID>`/`<REPO_ID>`/`<TIMESTAMP>`/`<TIMESTAMP_MS>`), applied by the
generator's own `normalize()` helper (`scripts/gen-contract-replay-electron-trace.mjs`) -- the two
traces use the identical placeholder tokens so a cross-shell diff can compare them directly
without a translation layer.

### Why the cross-shell diff folds events instead of comparing them raw

`contract_replay.rs`'s cross-shell diff (`fold_electron_events`) never asserts an exact
`PatchCoalescer` batch boundary/shape: the fixture's own `patch` events show the assistant's
streamed reply split across two separate batches (`"xy"` then `"xyzzy9"`, straddling the
coalescer's 50ms window) -- a wall-clock-dependent split a slower regeneration run could
legitimately produce differently. Instead, the diff folds every `patch` event's ops (upsert-by-id,
reset-replaces-all) into one materialized final transcript, and compares THAT against the Rust
run's `after_turn_settled` snapshot (itself already a full, folded transcript -- see "Why
transcript snapshots instead of real emitted events" above). The Electron fixture's other event
classes (`list-changed`/`commands`/`subagents`/`readout`/`queue`/`status`/`request`/
`requestResolved`/`sideChatInterrupted`) have no Rust-side live-stream equivalent at all and are
intentionally not compared.

### Known, intentional Rust-vs-Electron divergences (the diff's allowlist)

`contract_replay.rs`'s `scrub_known_divergences` normalizes exactly these away before comparing,
so the diff only ever fails on a real, un-triaged regression:

| Field | Rust | Electron | Status |
| --- | --- | --- | --- |
| `repositories.add` response's `value.remote.kind` | `"unknown"` | `"none"` | Filed as [issue #835](https://github.com/stuarthopwood/refract/issues/835) -- a real, pre-existing design difference (`repositories.rs`'s `.add` always returns the `unknown` placeholder, computed lazily later via `.remotes`/`.rename`; the Electron handler computes it eagerly), not fixed here. |
| `chat.answer` response envelope | `{"ok":true,"value":null}` | `{"ok":true}` | Tolerated by the `value:null` scrub in `scrub_known_divergences` (an explicit `value:null` next to `ok:true` is dropped on both sides before comparing); the production wire contract itself is unchanged for every channel. |
| `sessions.open` response's `value.readout.branch` | `{"name": ..., "detached": bool} \| null` | absent (no key at all) | Lane R5, [issue #724](https://github.com/stuarthopwood/refract/issues/724)/[#788](https://github.com/stuarthopwood/refract/issues/788): a brand-new, Rust-only `SessionReadout` field (the live checked-out branch) -- Electron's own frozen `readout.ts` never computed this (epic #797 rule 5, "a feature that exists only in Rust is acceptable"), so it never appears on that shell's side at all. Dropped from both sides before comparing. |

A Session this test never calls `sessions.setVisible` on would also show a different final
`unread` flag (see "Normalization rules" above) -- the Electron fixture's own driving script DOES
call `sessions.setVisible` (needed to get `patch` events forwarded at all), so this divergence
never actually surfaces in the captured traces; it is documented here only as a reader's caution
if either harness's driving sequence ever changes.

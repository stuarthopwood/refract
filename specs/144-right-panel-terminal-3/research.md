# Research: Right-panel terminal

Feature: `specs/144-right-panel-terminal-3/spec.md`. Date: 2026-11-28. Decisions below are recorded as Away Mode decisions (Stuart delegated); figures marked INFERENCE are chosen values, not measurements.

## R-1. Can PTY output stream over the existing `refract_request` path without a new Tauri command?

**Decision: Yes. No new Tauri command, no new capability entry, no CSP change, no Principle V amendment.**

Evidence (read, not run; the live probe is task T012 and the gate is T013):

- `refract_request(window, state, channel: String, args: Vec<Value>)` in `src-tauri/src/lib.rs` is the one command. `args` is free-form JSON, so a request can carry a Tauri channel handle as one of its arguments.
- `@tauri-apps/api` 2.12.3 `Channel` serialises to the string `__CHANNEL__:<id>` (its `toJSON`), so passing a `Channel` object inside `args` reaches Rust as that string. [INFERENCE: the JS side was not opened because no `node_modules` exists in this worktree; T013 proves it.]
- Tauri 2.12.3 `src/ipc/channel.rs` (read 2026-11-28, lines 255-300): `pub struct JavaScriptChannelId` implements `FromStr` (strips the `__CHANNEL__:` prefix) and `Deserialize`, and has `pub fn channel_on<R, TSend>(&self, webview: Webview<R>) -> Channel<TSend>`. It is re-exported as `tauri::ipc::JavaScriptChannelId` (`ipc/mod.rs` line 39). `Channel::send` accepts `InvokeResponseBody::Raw(Vec<u8>)`, so output goes as binary, not JSON-encoded.
- The caller-window check lives in `lib.rs`: `refract_request` calls `ipc::clipboard::refuse_caller(&channel, window.label())` before dispatch. `Handler = fn(AppState, Vec<Value>)` (`ipc/mod.rs` line 118) never sees the window, so FR-024 is met by one change in `refuse_caller`'s neighbour: a `terminal.`-prefix refusal for any label other than `main` in the same call site (task T016, using the T007 guard). No dispatcher signature change.
- Handlers also have no webview. The terminal module resolves it as `AppState::app_handle` -> `get_webview_window("main")` -> its `Webview`, and keeps its manager in a module-level `OnceLock` (the `git_changes_watch_state` `WATCHERS` and `repositories_clone::shutdown_all` precedent), initialised once in `run()` with an `EventSink` clone. `AppState` gains no field, so no existing constructor changes.
- `capabilities/default.json` needs no entry. Channel messages of 1 KiB or less are pushed by `webview.eval` (`channel.rs` lines 284-305); larger ones are fetched by the webview through `plugin:__TAURI_CHANNEL__|fetch` over the existing `ipc:` / `http://ipc.localhost` origin already in `connect-src`, and that command is explicitly exempt from the ACL check (`webview/mod.rs` line 2082). `style-src 'unsafe-inline'` is already present, which xterm.js's inline styles need. T013 confirms all three on a real webview under the current capabilities.
- Rejected: an `app.emit` event per chunk (ADR 0016: JSON-encoded, broadcast to every listener); a second Tauri command `terminal_stream(channel: Channel<...>)` (would need a Principle V amendment and a capability row, buys nothing).

**If T013 fails** (Rust receives something other than the channel string, or `channel_on` refuses): stop. The only fallback is the ADR 0016 amendment: one extra app command `refract_terminal_stream(channel: Channel<Vec<u8>>, tab_id)`, no permission-file entry needed for an app command, Principle V text amended to say "exactly two app-defined commands", and Constitution minor version bump. Not planned.

## R-2. Output path, ordering and back-pressure

- One `std::thread` per tab reads the ConPTY master (`portable-pty` readers are blocking) in 16 KiB blocks, appends to the tab's ring buffer, and forwards to the attached sink.
- Frames are `Raw` binary, tagged by their first byte: `0x01` data, `0x02` exit (i32 LE code follows). Chunks coalesce for up to 8 ms or 64 KiB, which keeps most frames above the 1 KiB direct-eval threshold so they take the binary fetch path.
- Back-pressure: the renderer calls `terminal.ack(tabId, bytes)` from xterm's `write` callback after every 128 KiB written. Rust pauses the reader (the shell then blocks on its write, like any terminal) while unacked bytes exceed 512 KiB, and only for an attached tab. A detached tab never blocks: it keeps reading into the ring. INFERENCE: 512 KiB and 128 KiB are chosen values; T039 measures `yes` flooding.
- Order: Tauri channels deliver messages in send order (index-checked in `channel.rs`), so no sequence numbers are added.

## R-3. Which tab is attached; scrollback survives switches and reloads

The Rust ring (2 MiB per tab) is the source of truth. The renderer keeps one live `xterm.js` view, for the visible tab only. Switching tab, Panel or Session calls `terminal.detach`; showing a tab calls `terminal.attach(sessionId, tabId, channel, cols, rows)`, which resizes the PTY, replays the ring as `0x01` frames, then streams live. A renderer reload is the same path, and the dead channel is detected on the next send failure (`Channel::send` errs) and the sink dropped.
Bounds renderer memory to one xterm instance (SC-003). Replay of 2 MiB is one burst of acked writes.

- The ring drops oldest bytes first and resumes at the next `\n` after the cut, then replays with a leading `ESC[0m` so a cut mid-colour or mid-escape cannot corrupt the display (edge: binary garbage and a very long line; a line longer than the ring just keeps its tail).
- Known limit: alternate-screen state (for example `vim`) is not reconstructed on replay if the entering sequence was dropped. Accepted for v1; noted for the spec's open questions.
- xterm's own scrollback is set to 5000 lines (INFERENCE) as a cache; the 2 MiB Rust bound is the contract.

## R-4. Shell choice, cwd, environment

- Order (FR-005): `pwsh.exe`, then `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, then `%COMSPEC%`. `pwsh.exe` is searched by explicit `PATH` entries only; the current directory is never searched (`process::executables::ensure_no_default_cwd_in_exe_path` already sets that rule for the process; the lookup repeats it explicitly).
- cwd: the Session's `worktree_path` from the registry; the Personal Agent (no worktree) uses `dirs::home_dir()`. A missing folder makes the tab `failed` with a plain message naming it (US5-2), never a fallback to another folder.
- Environment: inherited from Refract, plus `TERM=xterm-256color`, `COLORTERM=truecolor`. Nothing Refract-specific is added.
- Shell kind persisted as one of `pwsh`, `powershell`, `cmd`.

## R-5. Running-child detection (FR-013)

`CreateToolhelp32Snapshot` / `Process32FirstW` is already enabled (`Win32_System_Diagnostics_ToolHelp`, used by `pid_records.rs`). New `process/child_tree.rs` exposes `has_child_process(root_pid)` and `kill_tree(root_pid)`. Descendants are matched by parent pid with the creation-time check `pid_records.rs` already applies, so a recycled pid is not mistaken for a child. The ConPTY host (`conhost.exe` / `OpenConsole.exe`) is excluded from the count by image name. No new crate and no new `windows` feature.

## R-6. "Most recent command" output (FR-020)

`%COMSPEC%` cannot mark commands, so it uses the 200-line fallback (as clarified). PowerShell shells get a prompt hook that emits OSC 133 `A` (prompt start) at every prompt:

- Spawn args: `-NoLogo -NoExit -Command <init>`; the profile still loads first. `<init>` wraps `prompt` once: `function global:prompt { "$([char]27)]133;A$([char]7)" + (& $orig) }`, keeping the user's own prompt text.
- Rust scans the byte stream for `ESC ] 133 ; A (BEL | ESC \)` (split across reads: a small state machine, tested) and records the absolute stream offset of each, last 64 kept, dropped when the offset falls before the ring start.
- Most recent command output = `[A(n-1), A(n))` when the text after the latest `A` is only the prompt line; otherwise `[A(n), end)` (a command is still printing). ANSI is stripped before sending.
- Failure mode: a profile that replaces `prompt` after the hook, or `-NoProfile` semantics, loses markers; the fallback is the same 200-line tail. INFERENCE: the hook text and the "prompt line only" test are untested on real profiles; T039 checks `pwsh` and Windows PowerShell.
- OSC 133 is left in the stream; xterm.js ignores it.

## R-7. What reaches the model

Nothing automatic (FR-018). The only data path out of a Terminal is the two context-menu actions in the renderer: "Add to chat" writes the selection to the composer draft (`useDraftStore.setText`, as `startSessionFromItem.ts` does) and does not send; "Ask agent about this" calls `window.refract.chat.send` with a prompt. Selection text comes from xterm; no-selection output comes from `terminal.readOutput` (Rust, stripped, capped). Cap: 32 KiB of text, keeping the end (INFERENCE: the figure), with a visible line "[Truncated: last 32 KiB of N shown]" and a toast (FR-021). The agent's `bash` tool never touches `TerminalManager` (FR-022): the manager exposes no API to `agent_tools/`.

## R-8. Persistence and logs (FR-011)

Saved tab records go to `<data_dir>/terminal_tabs.json` via `store::atomic_json` (Session id, tab id, name, cwd, shell kind, order, active tab). Nothing else. PTY bytes and input are never passed to any `log::` macro, `format!` that logs, `panic!` or `IpcError` message; a test greps the `terminal/` module for logging of buffers, and the SC-005 scan test prints a marker and scans the data dir. Crash dumps: Refract writes none that include heap content (no `minidump` crate in `Cargo.toml`); [INFERENCE] confirmed by that dependency check only.

## R-9. Process containment (FR-012, FR-014, FR-015)

- Refract joins a kill-on-close Job Object at startup (`process/job_object.rs`) before spawning children, and a `portable-pty` shell and its ConPTY host are descendants, so a force-killed Refract takes every shell with it.
- Graceful quit: `lib.rs`'s run-event handler already awaits `session_manager.stop_all()` under a 15 s bound; `TerminalManager::shutdown_all()` runs beside it and kills each tree through `child_tree::kill_tree`.
- Archive/delete: `ipc/sessions_lifecycle/archive_core.rs` and `delete_core.rs` already call `git_changes_watch_state::stop_watcher(id)`; each also calls `terminals.close_session(id)` at the same point. Restore never recreates shells.
- Tab close: `terminal.close` kills the tree after the confirmation rule (R-5).
- Gap: if Job Object creation failed at startup, shells could outlive a crash. `pid_records.rs` reaping covers `omp` roots only. Open question 1.

## R-10. Dependencies

- Rust: `portable-pty` (MIT, current 0.9.x; the exact version is recorded here when T002 resolves it). Enters `Cargo.toml` as a plain dependency; `windows` and `tokio` are already present.
- npm: `@xterm/xterm` and `@xterm/addon-fit` (MIT). No WebGL addon (extra GPU path; the DOM/canvas renderer suffices). No node native module.
- Both need `THIRD_PARTY_NOTICES.md` entries (task T035; the file at `src-tauri/resources/THIRD_PARTY_NOTICES.md` currently covers palettes only, so this adds a "Libraries" section).

## R-11. Renderer integration points (verified by reading)

- Panels: `features/right-pane/panel-registry.ts` (`PanelId`, `HOSTED_PANELS`), `RightPaneShell.tsx` (renders the active panel), `specs/124-tool-channel-1193/contracts/panel-actions.json` (a `terminal` entry with `"actions": []`; the registry's `declared()` tolerates absence but the contract keeps `mutates` honest). No Rust list of panel ids exists (`grep` for `agent-builder` finds none in `src-tauri`).
- Bridge: `src/tauri-bridge/index.ts` `request()` wrapper; `window.refract.*` typing from `src/shared/ipc.ts` `RefractApi`.
- Composer: `state/draft-store.ts` (`setText`). Chat send: `window.refract.chat.send(sessionId, message)`.
- `scripts/check-parity.mjs` lists a lane per `IPC_REQUESTS` key; new keys need entries.

## Open questions (carried to spec Assumptions if Stuart wants them tracked)

1. Job Object creation failure leaves crash-time shells running (R-9): accept, or record shell pids like `omp` roots?
2. Alternate-screen replay after a ring cut (R-3): accept for v1?
3. Does the OSC 133 hook survive real profiles (oh-my-posh, Starship) (R-6)? Verified only by T039.

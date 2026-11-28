# Tasks: Right-panel terminal

**Input**: `specs/144-right-panel-terminal-3/` (spec.md, plan.md, research.md, data-model.md, contracts/terminal-ipc.md, quickstart.md)

**Prerequisites**: plan.md, spec.md. Constants and wire shapes are frozen in data-model.md and contracts/terminal-ipc.md; both lanes code against those two files.

**Tests**: Required for new logic (no-new-tests phase ended, #1918). Each logic task names its co-located test file and writes it with the code. Rust tests are `*.test.rs` loaded with `#[cfg(test)] #[path = "x.test.rs"] mod tests;`; renderer tests are co-located `*.test.ts`. Run the quality gate and a live check on a build slot at the end (T040, T041).

**Organization**: Grouped by user story. Every task carries a lane label so two lanes can run in parallel.

## Format: `- [ ] [ID] [P?] [Lane] [Story?] Description with file path`

- **[P]**: different files, no dependency on an unfinished task.
- **Lane `R`**: Rust lane. Owns everything under `src-tauri/` (including `src-tauri/resources/THIRD_PARTY_NOTICES.md`) and `scripts/verify-terminal-probe.mjs`. Branch `feat/3-terminal-rust`.
- **Lane `W`**: renderer lane. Owns everything under `src/`, `package.json`, `pnpm-lock.yaml`, `scripts/check-parity.mjs`, `specs/124-tool-channel-1193/contracts/panel-actions.json`. Branch `feat/3-terminal-renderer`.
- **Lane `M`**: Main, after both lanes are merged: `scripts/verify-tauri-144.mjs`, docs, the gate record, release.
- Neither lane edits a file the other owns. A needed change in the other lane's file goes to Main.

## Phase 1: Setup

- [ ] T001 [P] [W] Add `@xterm/xterm` and `@xterm/addon-fit` to `package.json` at exact versions (no `^`), run `pnpm install` so `pnpm-lock.yaml` updates. No WebGL addon, no node native module.
- [x] T002 [P] [R] Add `portable-pty` to `src-tauri/Cargo.toml` (current 0.9.x, exact version recorded in research.md R-10), run `cargo check` to refresh `Cargo.lock`. Add no `windows` crate feature (R-5) and no Tauri plugin.
- [ ] T003 [P] [W] Create `src/shared/terminalLimits.ts` exporting the data-model.md constants verbatim (`MAX_TABS_PER_SESSION` 8, `SCROLLBACK_BYTES` 2097152, `ASK_FALLBACK_LINES` 200, `OUTPUT_CAP_BYTES` 32768, `NAME_MAX_CHARS` 40, `INPUT_MAX_BYTES` 65536, `INPUT_RATE_BYTES_PER_SEC` 1048576, `COLS_MAX` 500, `ROWS_MAX` 200, `ACK_EVERY_BYTES` 131072, `UNACKED_PAUSE_BYTES` 524288); add `terminalLimits.test.ts` asserting each value.

---

## Phase 2: Foundational (blocks every story)

**CRITICAL**: no story work starts until the T013 gate has passed.

Rust, pure logic (no transport):

- [x] T004 [R] Create `src-tauri/src/terminal/mod.rs` (`TerminalManager`, module-level `OnceLock`, `init`, stubs for `shutdown_all` and `close_session`) and `terminal/limits.rs` (same constants as T003); add `mod terminal;` to `src-tauri/src/lib.rs` and initialise the manager in `run()`. No handler yet.
- [x] T005 [P] [R] `src-tauri/src/terminal/ring.rs` + `ring.test.rs`: fixed-capacity `SCROLLBACK_BYTES` ring per data-model.md (`total_written`, `start`, `push`, `snapshot`, `tail_lines`); after dropping oldest bytes, advance `start` just past the next `\n` unless the retained data is one line. Tests: capacity bound, oldest-first drop, line-boundary resume, a single line longer than the ring keeps its tail, invariants `len <= capacity` and `total_written - start == len`. (FR-010)
- [x] T006 [P] [R] `src-tauri/src/terminal/frame.rs` + `frame.test.rs`: encode `0x01` data and `0x02` exit (i32 little-endian) frames; coalescing helper (8 ms or 64 KiB). Tests: tag bytes, negative exit codes, coalescing boundary.
- [x] T007 [P] [R] `src-tauri/src/terminal/guard.rs` + `guard.test.rs`: refuse any `terminal.` channel from a window label other than `main` (`terminal-refused`); validators for name (trimmed, 1..=40 chars), cols (1..=500) and rows (1..=200) clamping, input size (<= 65536 bytes), per-tab rate limiter (<= 1048576 bytes per second, `terminal-rate-limited`). (FR-024)
- [x] T008 [P] [R] `src-tauri/src/terminal/shell.rs` + `shell.test.rs`: shell resolution `pwsh.exe` (explicit `PATH` entries only, never the current directory) then `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` then `%COMSPEC%`; shell kind enum `pwsh|powershell|cmd`; environment adds `TERM=xterm-256color` and `COLORTERM=truecolor` only. Tests use an injected lookup so they run without the real shells. (FR-005, R-4)
- [x] T009 [R] `src-tauri/src/terminal/pty.rs` + `pty.test.rs`: the only spawn site. Open a ConPTY pair with `portable-pty`, spawn the shell in a cwd, `write`, `resize`, `kill`, blocking reader handle. Test with a real `%COMSPEC%` spawn: `echo marker` appears in the read bytes and a resize is accepted. (FR-004, FR-006)

Renderer, wire layer:

- [ ] T010 [P] [W] `src/shared/ipc-terminal.ts` (`TabInfo`, `TabState`, `TerminalOutput`, `TerminalApi`) and edits to `src/shared/ipc.ts` (the seven new `IpcErrorCode` values, `IPC_EVENTS.TERMINAL_TAB_STATE = 'terminal:tab-state'`, `RefractApi.terminal`, the eleven `IPC_REQUESTS` keys from contracts/terminal-ipc.md); add the new keys to `scripts/check-parity.mjs`.
- [ ] T011 [W] `src/tauri-bridge/terminal.ts` + `terminal.test.ts`, and `src/tauri-bridge/index.ts` exposing `window.refract.terminal`: request wrappers over `request()`; `attach` builds the `Channel`, sets `onmessage = onFrame`, passes the channel as an argument. It is the only renderer file importing `Channel`. Tests with a fake `request` and `Channel`: argument order, frame delivery, `Result` shapes.

Gate:

- [x] T012 [R] Debug-only probe: `terminal.probe` handler (`#[cfg(debug_assertions)]`) in `src-tauri/src/terminal/probe.rs` registered in `ipc/mod.rs`, which resolves the `__CHANNEL__:<id>` argument with `JavaScriptChannelId`, and sends one frame of 8 bytes and one of 4096 bytes as `InvokeResponseBody::Raw`; plus `scripts/verify-terminal-probe.mjs` that drives a dev build and prints the received bytes. Depends on T004. (R-1)
- [x] T013 [M] **GATE (R-1)**: with T011 and T012 merged into a scratch branch, run the probe on a build slot (`skill://refract-tauri-live-check-isolation`). Pass: both frames arrive byte-identical, the 4096-byte frame via the fetch path, with the current `capabilities/default.json` and CSP unchanged. Record the result under R-1 in research.md. If it fails, stop both lanes and amend ADR 0016 (one extra app command) before anything below.
- [x] T014 [R] Delete `terminal/probe.rs`, its registration and `scripts/verify-terminal-probe.mjs` after T013 passes.

**Checkpoint**: transport proven; stories can start in both lanes.

---

## Phase 3: User Story 1 - Run commands next to the chat (P1) MVP

**Goal**: opening the panel gives a working shell in the Session folder, output streams, resize works, shell fallback works.

**Independent Test**: quickstart steps 2 and 3.

- [x] T015 [R] [US1] `src-tauri/src/terminal/tab.rs` + `tab.rs` tests: tab state machine (`starting` -> `running` -> `ended`, `failed`), reader thread (16 KiB blocks into the ring and the attached sink), 8 ms / 64 KiB coalescing, ack back-pressure (reader pauses above `UNACKED_PAUSE_BYTES` while attached; a detached tab never blocks), replay of the ring as `0x01` frames with a leading `ESC[0m`, attach replaces any earlier sink and a failed send drops it. Tests: ordering, replay then live, back-pressure pause and resume, detached tab keeps reading. Depends on T005, T006, T009.
- [ ] T016 [R] [US1] `src-tauri/src/terminal/handlers.rs` + tests: `terminal.create` (Session must exist in the registry; cwd = `worktree_path`, or the home folder for the Personal Agent; `terminal-not-found`), `terminal.attach`, `terminal.detach`, `terminal.input`, `terminal.resize`, `terminal.ack` per contracts/terminal-ipc.md; register all in `src-tauri/src/ipc/mod.rs`; edit `src-tauri/src/lib.rs` so `refract_request` applies the T007 window-label refusal before dispatch (no `Handler` signature change); emit `terminal:tab-state` through a new `TERMINAL_TAB_STATE` constant in `src-tauri/src/events.rs`. Depends on T007, T008, T013, T015.
- [ ] T017 [P] [W] [US1] `src/renderer/state/terminal-store.ts` + `terminal-store.test.ts`: per-Session `{ tabs, activeTabId, loaded }`, fed by `terminal.list` and `terminal:tab-state`; holds no output. Depends on T010.
- [ ] T018 [P] [W] [US1] `src/renderer/features/terminal/terminalTheme.ts` + test: map Refract theme tokens to an xterm theme; contrast rule so text stays readable in light and dark themes.
- [ ] T019 [W] [US1] `src/renderer/features/terminal/TerminalView.tsx` and `useTerminalSession.ts` + `useTerminalSession.test.ts`: one live xterm instance with the fit addon, 5000-line cache, `attach` with measured cols/rows, write frames, ack every `ACK_EVERY_BYTES` from the write callback, send input, resize on pane resize (debounced), bracketed paste kept on. Test with a fake bridge: frames written in order, acks at the threshold, resize forwarded. Depends on T001, T011, T013, T018.
- [ ] T020 [W] [US1] Register the panel: `src/renderer/features/right-pane/panel-registry.ts` (`'terminal'` in `PanelId` and `HOSTED_PANELS`, icon, label), `RightPaneShell.tsx` (render `TerminalPanel`), `src/renderer/features/terminal/TerminalPanel.tsx` (on first open with no tabs, create one; show the one view), `specs/124-tool-channel-1193/contracts/panel-actions.json` (`terminal` with `"actions": []`); update `panel-registry.test.ts` and `RightPaneShell.test.ts`. Keyboard reachability and panel order follow existing panels. (FR-001, FR-002) Depends on T017, T019.

**Checkpoint**: US1 works end to end.

---

## Phase 4: User Story 2 - Several tabs per Session that keep running (P1)

**Goal**: tabs per Session, switch freely, nothing stops, output returns after a Session switch or reload, rename.

**Independent Test**: quickstart step 4.

- [ ] T021 [R] [US2] Extend `src-tauri/src/terminal/handlers.rs` + tests: `terminal.create` enforces `MAX_TABS_PER_SESSION` (`terminal-limit`, message states the maximum) and names tabs `Terminal N` (lowest unused N); `terminal.list` (in-memory tabs and active tab id); `terminal.rename` (trimmed, 1..=40, `invalid-argument`). Depends on T016.
- [ ] T022 [P] [W] [US2] `src/renderer/features/terminal/TerminalTabStrip.tsx` + `TerminalTabStrip.test.ts`: tabs of the active Session only, add control, inline rename, disabled add with the maximum named at 8 tabs, shell state markers. Reuse the right-pane tab strip conventions (`tab-strip-scroll.ts`). (FR-003, FR-009) Depends on T017.
- [ ] T023 [W] [US2] Extend `useTerminalSession.ts` and `TerminalPanel.tsx`: detach on tab, Panel or Session switch and re-attach on show (ring replay); on window reload call `terminal.list` and re-attach the active tab; never close a tab on unmount (FR-008). Tests: switch sequence issues detach then attach, reload re-attaches. Depends on T019, T022.

**Checkpoint**: US1 and US2 both work.

---

## Phase 5: User Story 3 - Tabs end cleanly and come back after a restart (P2)

**Goal**: confirm before killing a running job, no stray shells on any exit route, tabs restore as fresh shells, nothing on disk.

**Independent Test**: quickstart step 5 and the privacy scan in step 8.

- [x] T024 [P] [R] [US3] `src-tauri/src/process/child_tree.rs` + `child_tree.test.rs`, `pub mod child_tree;` in `src-tauri/src/process/mod.rs`: `has_child_process(root_pid)` (parent-pid match plus the creation-time check `pid_records.rs` applies; ConPTY host `conhost.exe` / `OpenConsole.exe` excluded by image name) and `kill_tree(root_pid)`. Tests spawn a real `cmd /c ping -n 30 localhost` child and assert both functions.
- [ ] T025 [R] [US3] `terminal.close` in `handlers.rs`, and `TerminalManager::close_session` and `shutdown_all` in `terminal/mod.rs` + tests: `force=false` with a running child returns `{ closed: false, needsConfirm: true }` and kills nothing; otherwise `kill_tree`, remove the tab, drop the ring. Depends on T021, T024. (FR-012, FR-013)
- [ ] T026 [R] [US3] `src-tauri/src/terminal/persist.rs` + `persist.test.rs`: save and load `<data_dir>/terminal_tabs.json` via `store::atomic_json` per data-model.md (no content); save on create, rename, close; load defensively (unknown shell kind -> `powershell`, over 8 tabs truncated, names clamped, unknown Session ids dropped); first `terminal.list` per Session per run restores saved tabs as fresh shells with the same names, folders and order. Test: a recorded marker string never appears in the file. Depends on T021. (FR-011, FR-016)
- [ ] T027 [R] [US3] Lifecycle hooks: call `terminals.close_session(id)` beside `stop_watcher(id)` in `src-tauri/src/ipc/sessions_lifecycle/archive_core.rs` and `delete_core.rs` (delete also drops saved records); call `TerminalManager::shutdown_all()` beside `session_manager.stop_all()` in the run-event handler in `src-tauri/src/lib.rs`; restore never recreates shells. Tests extend the existing archive and delete core tests. Depends on T025, T026. (FR-014, FR-015)
- [ ] T028 [P] [W] [US3] `src/renderer/features/terminal/ClosePrompt.tsx` + test, wired in `TerminalTabStrip.tsx`: a close click calls `terminal.close(tabId, false)`; on `needsConfirm` show a confirmation, and `terminal.close(tabId, true)` only if agreed. Idle tab closes without a prompt. Depends on T022.

**Checkpoint**: lifecycle complete.

---

## Phase 6: User Story 4 - Bring terminal output to the agent on purpose (P2)

**Goal**: "Add to chat" and "Ask agent about this", nothing automatic.

**Independent Test**: quickstart step 6.

- [ ] T029 [P] [R] [US4] `src-tauri/src/terminal/markers.rs` + `markers.test.rs`: OSC 133 `A` scanner as a state machine (`ESC ] 133 ; A` terminated by BEL or `ESC \`, split across reads), keeps the last 64 absolute offsets and drops those before the ring `start`; ANSI strip; recent-command extraction (`[A(n-1), A(n))` when only the prompt line follows the latest `A`, else `[A(n), end)`). Tests: split sequences, both terminators, dropped offsets, extraction cases, ANSI stripping. (R-6)
- [ ] T030 [R] [US4] Wire markers: PowerShell init args in `terminal/shell.rs` (`-NoLogo -NoExit -Command <init>` wrapping `prompt` once to emit OSC 133 `A`, profile loads first; none for `cmd`), feed `tab.rs` reader through the scanner, and add `terminal.readOutput` in `handlers.rs` (`recent-command` or `last-lines`; fall back to the last `ASK_FALLBACK_LINES` lines with `source: 'tail'`; ANSI stripped; capped to `OUTPUT_CAP_BYTES` keeping the end, `truncated` and `totalBytes` set). Tests for fallback, cap and `source`. Depends on T016, T029. (FR-020, FR-021)
- [ ] T031 [W] [US4] `src/renderer/features/terminal/TerminalContextMenu.tsx` + test, wired in `TerminalView.tsx`: "Add to chat" inserts the selection as a quoted block with `useDraftStore.getState().setText` and does not send; "Ask agent about this" sends with `window.refract.chat.send(sessionId, message)` using the selection, else `terminal.readOutput('recent-command')`; when `truncated`, put the line `[Truncated: last 32 KiB of N shown]` in the message and show a `toast` from `sonner`. No other code path reads terminal output into a message. Depends on T019, T030. (FR-018 to FR-021)

**Checkpoint**: US4 works; SC-006 holds because no code path other than T031 sends output.

---

## Phase 7: User Story 5 - Understandable failures (P3)

**Goal**: an ended or unstartable shell says so and offers "Restart shell".

**Independent Test**: quickstart step 7.

- [ ] T032 [R] [US5] `tab.rs` and `handlers.rs` + tests: missing cwd -> `failed { message }` naming the folder (never a fallback folder); spawn failure -> `terminal-spawn-failed` with a content-free message; reader EOF -> `ended { code }` with the `0x02` frame; `terminal.restart` for `ended` or `failed` tabs only (`terminal-not-ended`), same id, name, cwd and order, empty ring; `terminal:tab-state` emitted on each change. Depends on T021. (FR-017)
- [ ] T033 [P] [W] [US5] `src/renderer/features/terminal/EndedBanner.tsx` + test, wired in `TerminalPanel.tsx`: "Shell ended with code N" or the failure message, and a "Restart shell" button calling `terminal.restart`. Depends on T022.

**Checkpoint**: all five stories complete.

---

## Phase 8: Polish and cross-cutting

- [ ] T034 [R] Privacy tests: `src-tauri/src/terminal/privacy.test.rs` asserts no `log::`, `tracing::`, `println!`, `eprintln!`, `dbg!`, `panic!` or error `format!` in `src-tauri/src/terminal/` takes a buffer, and an end-to-end test prints `PRIVACY-MARKER-144` through a tab and scans a temp data dir for it (SC-005). Depends on T027.
- [ ] T035 [P] [R] `src-tauri/resources/THIRD_PARTY_NOTICES.md`: add a Libraries section with `@xterm/xterm`, `@xterm/addon-fit` (MIT) and `portable-pty` (MIT), each with its copyright line.
- [ ] T036 [M] Parity test `src-tauri/src/terminal/limits.test.rs` that reads `src/shared/terminalLimits.ts` and asserts every constant equals its `limits.rs` twin. Needs both lanes merged.
- [ ] T037 [P] [W] Accessibility pass on `features/terminal/`: tab strip is a labelled `tablist`, context menu and close prompt work by keyboard, Ended banner is announced, focus returns to the terminal after the prompt; tests for the roles and focus return.
- [ ] T038 [M] `scripts/verify-tauri-144.mjs`: live check on a build slot covering quickstart steps 2 to 8 where scriptable, screenshots into the PR.
- [ ] T039 [M] Run the whole quickstart.md on a build slot (isolated data per `skill://refract-tauri-live-check-isolation`), including step 9 (flood, SC-003) and the `pwsh`, Windows PowerShell and oh-my-posh/Starship checks for R-6; record results in the PRs and carry any new open question back to research.md.
- [ ] T040 [M] Quality gate (`skill://quality-gate`): lane R `cargo test`, `cargo clippy`; lane W `pnpm typecheck`, `pnpm test`, lint; parity script.
- [ ] T041 [M] Update docs: `docs/PLAN.md` row #3 to implemented, CONTEXT.md if the glossary changed, `docs/adr/0016` status unchanged unless T013 forced an amendment. Release per the epic rules.

---

## Dependencies and execution order

- Phase 1 tasks are independent. T001/T003 are lane W; T002 is lane R.
- Phase 2: T004 first in R; T005 to T008 in parallel; T009 after T002; T012 after T004; T010 then T011 in W. T013 needs T011 and T012. Everything marked "Depends on T013" waits; everything else runs while the gate is pending.
- Lane R order after the gate: T015, T016, T021, then T024 and T026 in parallel, T025, T027, T029 (can start any time), T030, T032, T034.
- Lane W order: T017, T018 any time after T010; T019, T020 after the gate; T022 any time after T017; T023, T028, T033 after T022; T031 after T030's `readOutput` shape is merged (contract is frozen, so it can be coded against a fake earlier).
- User stories after Phase 2 are independent except: US2's T021 and US3/US4/US5 Rust tasks extend `handlers.rs`, so lane R runs them in the order above (same-file edits are never parallel).

### Parallel lanes

| Window | Lane R | Lane W |
|--------|--------|--------|
| Setup | T002 | T001, T003 |
| Foundation, before the gate | T004 to T009, T012 | T010, T011 |
| Gate | (wait for T013) | (wait for T013) |
| After the gate | T014 to T016, T021, T024 to T027, T029, T030, T032, T034 | T017 to T020, T022, T023, T028, T031, T033, T035, T037 |
| After both merge | T036, T038 to T041 (Main) | |

## Implementation strategy

- MVP is Phase 1 to Phase 3 (US1): a working shell with streaming, resize and fallback. Ship nothing to users before US3 is done, because a terminal that leaks shells or confirms nothing is not safe to release; but each phase is independently testable.
- Release after the epic's rules: lane R merges first, then lane W stacked on it.

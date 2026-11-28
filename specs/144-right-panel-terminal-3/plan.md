# Implementation Plan: Right-panel terminal

**Branch**: `spec/3-terminal` (spec only; the implementation branches are cut later, one per lane) | **Date**: 2026-11-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/144-right-panel-terminal-3/spec.md` (Clarified), [ADR 0016](../../docs/adr/0016-terminal-uses-portable-pty-and-xterm.md).

## Summary

A Terminal **Panel** in the right pane: tabs per Session, each tab one real shell (PowerShell 7, then Windows PowerShell, then `%COMSPEC%`). Rust owns every shell through the `portable-pty` crate (ConPTY) and keeps a 2 MiB in-memory ring per tab; the renderer draws one live `xterm.js` view for the visible tab. Output streams from Rust to the renderer on a Tauri `Channel` whose handle is passed as an argument of the existing `refract_request` command, so **no new Tauri command, capability or CSP change is needed** (research R-1; the live probe T012 and the gate T013 prove it). Input, resize, ack, close and the other actions are plain `terminal.*` channels on `refract_request`. Shells are contained by the existing kill-on-close Job Object plus an explicit shutdown, archive and delete path. Only a content-free tab list is saved to disk. Nothing reaches the model except through the two context-menu actions.

## Technical Context

**Language/Version**: Rust (the `src-tauri` crate's edition and toolchain, unchanged); TypeScript 7 with React 19 and Zustand in the renderer.

**Primary Dependencies**: Tauri 2.12.3 (existing); new: `portable-pty` (Rust, MIT, 0.9.x pinned at T002), `@xterm/xterm` and `@xterm/addon-fit` (npm, MIT, pinned exactly at T001). No node native module, no WebGL addon, no new `windows` crate feature, no new Tauri plugin.

**Storage**: One new file, `<data_dir>/terminal_tabs.json`, written with `store::atomic_json`: Session id, tab id, name, working folder, shell kind, order, active tab. No content. Scrollback lives in Rust memory only.

**Testing**: `cargo test` with co-located `*.test.rs` files (`#[cfg(test)] #[path = "x.test.rs"] mod tests;`, as `process/pid_records.rs` does); `vitest` with co-located `*.test.ts`; a live check on a build slot with `scripts/verify-tauri-144.mjs` and the quickstart (T038, T039). Tests for new logic are required (no-new-tests phase ended, #1918).

**Target Platform**: Windows 11 only (Constitution, Platform and Stack).

**Project Type**: Desktop app (Tauri: Rust backend in `src-tauri/`, React renderer in `src/`).

**Performance Goals**: A usable prompt within 2 s of opening the panel (SC-001); a flooding tab leaves other interactions responsive (SC-003): output frames coalesce for 8 ms or 64 KiB and the renderer acks 128 KiB so Rust pauses the reader above 512 KiB unacked (INFERENCE: the figures; T039 measures).

**Constraints**: Scrollback and input never reach disk, logs or error messages (FR-011, SC-005). Renderer starts no process (FR-006). Renderer-callable surface stays `refract_request` plus the existing opener route (FR-023). 8 tabs per Session, 2 MiB per tab, 200-line and 32 KiB agent caps (Away Mode decisions, INFERENCE figures; see data-model.md).

**Scale/Scope**: Up to 8 shells per Session; one live xterm instance at a time. About 11 new Rust files and 8 new renderer files, listed below.

## Constitution Check

*GATE: re-checked after Phase 1 design.*

| Principle | Result | Notes |
|-----------|--------|-------|
| I. OMP Is the Engine | Pass | No OMP launch, flag or RPC command changes. The agent's own `bash` tool never touches `TerminalManager` (FR-022; the manager exposes nothing to `agent_tools/`). |
| II. RPC Wire Contract | Pass | "Ask agent about this" sends a normal `message` turn through the existing `chat.send`; no new RPC frame. |
| III. Session and Process Lifecycle | Pass, with work | Shells end on tab close, Session archive and delete, graceful quit (beside `stop_all`) and force-kill (Job Object). Restore never recreates shells. Tasks T025, T027. |
| IV. Evidence Before Design | Pass | The one unproven claim (a Channel in `refract_request` args) is a gate task, T013 (probe T012), run before any dependent task. ADR 0016 records the stack. |
| V. Tauri Security Baseline | Pass | No new command, no capability row, no CSP change, no shell or process plugin permission (research R-1 gives the evidence). Rust validates window label, Session, tab ownership, sizes and rates (FR-024). Fallback if T013 fails is an ADR amendment, not planned. |
| Platform and Stack | Pass | Windows 11 only. Two new dependencies, both MIT, both listed in `THIRD_PARTY_NOTICES.md` (T035). |
| Development Workflow | Pass | Tests co-located and written with the code; quality gate and a live check on a build slot (T038 to T040). |

No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/144-right-panel-terminal-3/
├── spec.md
├── plan.md              # this file
├── research.md          # R-1 .. R-11 and open questions
├── data-model.md        # tab, ring, saved record, frames, constants
├── contracts/
│   └── terminal-ipc.md  # requests, event, frames, Principle V checklist
├── quickstart.md        # live verification steps
├── checklists/requirements.md
└── tasks.md             # /speckit.tasks output
```

### Source code (repository root)

New files are marked `+`; edits to existing files are marked `~`.

```text
src-tauri/
├── Cargo.toml                          ~ portable-pty (T002)            [lane R]
└── src/
    ├── lib.rs                          ~ mod terminal; init manager; refuse non-main callers; shutdown_all in run-event handler
    ├── events.rs                       ~ TERMINAL_TAB_STATE + emitter
    ├── ipc/mod.rs                      ~ register terminal handlers
    ├── ipc/sessions_lifecycle/archive_core.rs, delete_core.rs
    │                                   ~ terminals.close_session(id) beside stop_watcher(id)
    ├── process/mod.rs                  ~ pub mod child_tree
    ├── process/child_tree.rs (+ .test.rs)           + has_child_process, kill_tree
    └── terminal/                       + new module
        ├── mod.rs                      TerminalManager (module-level OnceLock), init, shutdown_all, close_session
        ├── limits.rs                   constants (mirrors src/shared/terminalLimits.ts)
        ├── frame.rs                    channel frame encode (0x01 data, 0x02 exit)
        ├── guard.rs                    window-label refusal, argument validation, input rate limiter
        ├── shell.rs                    shell resolution and PowerShell init args
        ├── pty.rs                      the only spawn site: portable-pty spawn, write, resize, kill
        ├── ring.rs                     bounded scrollback ring
        ├── tab.rs                      tab state machine, reader thread, coalescing, ack back-pressure
        ├── markers.rs                  OSC 133 scanner, last-command extraction, ANSI strip
        ├── persist.rs                  terminal_tabs.json load and save (no content)
        └── handlers.rs                 the eleven terminal.* channels
        (each with a co-located *.test.rs)

src/
├── shared/
│   ├── terminalLimits.ts (+ test)      + constants and the Rust parity test           [lane W]
│   ├── ipc-terminal.ts                 + wire types, IPC_REQUESTS keys, TerminalApi
│   └── ipc.ts                          ~ IpcErrorCode additions, IPC_EVENTS.TERMINAL_TAB_STATE, RefractApi.terminal
├── tauri-bridge/
│   ├── terminal.ts (+ test)            + request wrappers; the only importer of Channel
│   └── index.ts                        ~ expose window.refract.terminal
└── renderer/
    ├── state/terminal-store.ts (+ test)                 + tabs per Session, no output
    └── features/
        ├── right-pane/panel-registry.ts, RightPaneShell.tsx   ~ 'terminal' panel
        └── terminal/                   + new feature folder
            ├── TerminalPanel.tsx       panel body: strip + one view
            ├── TerminalTabStrip.tsx    add, rename, close, states
            ├── TerminalView.tsx        the single xterm.js instance
            ├── useTerminalSession.ts   attach, detach, ack, resize, reload re-attach
            ├── TerminalContextMenu.tsx Add to chat, Ask agent about this
            ├── ClosePrompt.tsx         running-child confirmation
            ├── EndedBanner.tsx         exit code and Restart shell
            └── terminalTheme.ts        Refract theme tokens to xterm theme
        (each with a co-located *.test.ts)

specs/124-tool-channel-1193/contracts/panel-actions.json   ~ `terminal` entry, "actions": []
src-tauri/resources/THIRD_PARTY_NOTICES.md                 ~ Libraries section (T035, lane R)
scripts/check-parity.mjs                                   ~ entries for the new IPC_REQUESTS keys
scripts/verify-terminal-probe.mjs (T012, deleted T014), verify-tauri-144.mjs (T038)   + probe and live check
```

**Structure Decision**: Follow the existing split: a Rust feature module under `src-tauri/src/terminal/`, wire types and constants in `src/shared/`, one bridge file, a renderer store in `state/`, and a feature folder under `features/`. No new top-level folder.

## Lanes and file ownership

Two lanes can run in parallel from the first task, because they touch disjoint trees and meet only at `contracts/terminal-ipc.md` and `data-model.md`, which are frozen by this plan. `tasks.md` carries the authoritative task-to-lane assignment.

| Lane | Owns (only this lane edits) | Tasks |
|------|-----------------------------|-------|
| **R** (Rust) | everything under `src-tauri/` (including `src-tauri/resources/THIRD_PARTY_NOTICES.md`), `scripts/verify-terminal-probe.mjs` | T002, T004 to T009, T012, T014 to T016, T021, T024 to T027, T029, T030, T032, T034, T035 |
| **W** (renderer) | everything under `src/`, `package.json`, `pnpm-lock.yaml`, `scripts/check-parity.mjs`, `specs/124-tool-channel-1193/contracts/panel-actions.json` | T001, T003, T010, T011, T017 to T020, T022, T023, T028, T031, T033, T037 |
| **Main** (after both merge) | `scripts/verify-tauri-144.mjs`, the parity test, docs, release | T013 (gate), T036, T038 to T041 |

Cross-lane rules:

- The only cross-lane dependency is the **T013 gate**, which needs lane W's `T011` (the bridge `attach`) and lane R's `T012` (the probe handler). Lane W does `T010` and `T011` first; lane R does `T002`, `T004` to `T009`, `T012` (pure logic, no transport, then the probe) while it waits.
- No task that depends on the channel transport (`T016` onward in lane R, `T019` onward in lane W) starts before T013 passes. If T013 fails, both lanes stop and the ADR 0016 amendment (research R-1) is decided first.
- Neither lane edits a file the other owns. If a lane needs a change in the other's file, it asks Main.
- Each lane is one branch and one PR (`feat/3-terminal-rust`, `feat/3-terminal-renderer`); lane R merges first because lane W's live check needs the Rust side (stack them if W finishes first).

## Phase 0 and Phase 1 outputs

- Phase 0: [research.md](research.md) settles the IPC question (R-1), output path and back-pressure (R-2), attach and scrollback (R-3), shell choice (R-4), running-child detection (R-5), most-recent-command markers (R-6), what reaches the model (R-7), persistence and logs (R-8), process containment (R-9), dependencies (R-10) and renderer integration points (R-11). Three open questions are carried, none blocks the plan.
- Phase 1: [data-model.md](data-model.md), [contracts/terminal-ipc.md](contracts/terminal-ipc.md), [quickstart.md](quickstart.md).

## Complexity Tracking

None. No Constitution violation, and no new Tauri command.

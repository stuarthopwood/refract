# Implementation Plan: Rust (Tauri v2) build

**Branch**: `016-tauri-rust-build` (work lands on `feat/780-tauri-rust`, per `docs/PLAN.md`'s
existing per-spec-branch convention) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md) |
**Input**: Feature specification from `specs/016-tauri-rust-build/spec.md`

## Summary

Add a second, EXPERIMENTAL desktop shell for Refract on Tauri v2, living entirely under a new
`src-tauri/` Rust crate plus a thin `src/tauri-bridge/` TypeScript shim, while `src/renderer` and
`src/shared` are reused completely unchanged. One generic Tauri command,
`refract_request(channel, args)`, dispatches to Rust handlers keyed by the exact string values
already defined in `src/shared/ipc.ts`'s `IPC_REQUESTS`, returning the same `Result<T>` envelope;
anything not yet ported returns a typed `unsupported` error (research.md decision 4). Rust emits
Tauri events under the exact `IPC_EVENTS` string values. Milestone 1 ports the core loop: OMP
process spawn/stdio framing (`omp/process.rs`, a Rust port of `OmpProcess.ts`), transcript
assembly and diffing (`omp/transcript.rs`, `omp/diff.rs`), the session registry and settings
stores (`store/`, a Rust port of `src/main/store/atomicJson.ts` + `registry.ts`/`settings.ts`), git
worktree/branch operations (`git/`), the Session/agent core loop (`session/agent.rs`,
`session/manager.rs`, ports of `SessionAgent.ts`/`SessionManager.ts`), and Windows process
containment via a kill-on-close Job Object (`process/job_object.rs`). A separate Vite config and
HTML entry keep the Tauri build's dev/build pipeline fully isolated from the Electron one; no
Electron file changes.

## Technical Context

**Language/Version**: Rust stable (MSVC toolchain, matching `tauri` 2.12.3's `rust-version =
1.95` floor) for `src-tauri/`; TypeScript (`strict: true`) and React 19 for the unchanged
`src/renderer`, same as the Electron build.

**Primary Dependencies**: `tauri = "2.12.3"` (features: `default` -- no extra window-effects or
tray features needed for milestone 1), `tauri-build = "2.7.2"` (build-dependency, required by
`src-tauri/build.rs`), `tokio = "1.53"` (features: `rt-multi-thread`, `process`, `io-util`,
`time`, `sync` -- async child-process I/O and the request-timeout/correlation machinery), `serde =
"1.0.229"` (feature `derive`), `serde_json = "1.0.154"`, `windows = "0.62.2"` (feature `Win32_*`
subset for `CreateJobObjectW`/`SetInformationJobObject`/`AssignProcessToJobObject`/`TerminateJobObject`,
replacing the Electron build's `koffi` FFI calls in `jobObject.ts` with native `windows-rs`
bindings). On the TypeScript side: `@tauri-apps/cli@2.12.2` and `@tauri-apps/api@2.12.3` (both dev
dependencies, new; no other renderer dependency changes).

**Storage**: Two JSON files (`registry.json`, `settings.json`) under `%APPDATA%\refract-tauri`,
same shapes and the same atomic-write/quarantine-corrupt-file pattern as
`src/main/store/atomicJson.ts` (FR-014/FR-015). No database.

**Testing**: None -- Refract is a prototyping-phase project with no automated test suite
(repository `AGENTS.md`); every milestone-1 user story is verified manually by running the app per
`quickstart.md`.

**Target Platform**: Windows 11 only, same as the Electron build; WebView2 Runtime assumed present
(ships with Windows 11).

**Project Type**: desktop-app. Adds a second, parallel backend process type (a Tauri/Rust binary)
alongside the existing Electron main process; the two are never run against the same data
directory and share no runtime state.

**Performance Goals**: no specific latency target for milestone 1 beyond "a chat turn streams
visibly, same as the Electron build"; the one explicit measurement is the footprint comparison
(spec.md SC-005), not a performance gate.

**Constraints**: Every `omp` process MUST be spawned with its Session's worktree as cwd, framed
over stdio JSONL, negotiated to protocol v2 with `rpc_chunk` reassembly, and correlated
request/response by id with a timeout (constitution II, spec.md FR-001 to FR-003) -- all
unchanged from the Electron build's own wire contract, just re-implemented in Rust. The renderer
(`src/renderer`) MUST NOT be modified; every behavioural difference is absorbed in
`src/tauri-bridge/` or accepted as a documented difference (native window decorations, spec.md
Assumptions).

**Scale/Scope**: One new Rust crate (`src-tauri/`, roughly a dozen modules per the Project
Structure below), one new TypeScript bridge directory (`src/tauri-bridge/`, two files), one new
Vite config and HTML entry, two new `package.json` scripts and two new dev dependencies. Milestone
1 covers 23 of 86 request channels and 8 of 20 event channels (parity.md); the remaining 63
requests and 12 events are explicitly `unsupported` until later slices.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design.* Constitution v2.0.0. This spec
raises no version-change claim (Governance: no version bump per feature, per clause) -- it instead
explicitly **suspends** two principles for this experimental build only, per Stuart's own decision
on issue://780 ("the constitution stays unchanged unless the Rust build is promoted").

| Principle | Status | How the design meets it (or why it is suspended) |
|---|---|---|
| I. OMP Is the Engine, Refract Is the Host | **Applies, unchanged** | `omp/process.rs` spawns `omp --mode rpc-ui --approval-mode=<mode>` exactly as `OmpProcess.ts` does -- no SDK, no ACP, no disabling flags (FR-001). |
| II. RPC Wire Contract | **Applies, unchanged** | `message` field, `session_settled` wait after abort, native `btw` handling (deferred to a later slice, returns `unsupported` until ported), `extension_ui_request`/`select` answering, allowlisted slash commands, `rpc_chunk` reassembly -- all re-implemented in Rust with the identical wire behaviour (FR-002, FR-003). |
| III. Session and Process Lifecycle | **Applies, unchanged** | Session listing by scanning the worktree's own session directory, reattach-by-`switch_session` (not `--resume`), cwd-per-worktree spawn, stdin-close-then-`taskkill /T /F` stop, and the kill-on-close Job Object joined before any `omp` spawn -- all ported to `session/`, `omp/process.rs`, `process/job_object.rs` (FR-004, FR-005). |
| IV. Evidence Before Design | **Applies, unchanged** | Milestone 1 behaviour is verified against the same supported `omp` version and the same `docs/spike/FINDINGS.md` evidence base the Electron build relies on; no new unverified OMP behaviour is introduced. |
| **V. Electron Security Baseline** | **Suspended (not applicable)** | This principle is written in Electron-specific terms (`BrowserWindow`, `contextIsolation`, `nodeIntegration`, `contextBridge`). Tauri v2's own security model (capabilities/permissions, no Node integration in the webview by construction, `invoke`-only IPC) is the equivalent baseline for this build, documented in `contracts/bridge.md`, but is a *different* mechanism, not a literal instance of Principle V's Electron-specific clauses. Per issue://780's own decision, this principle does not block the experimental build; it would need its own amendment (or a Tauri-specific sibling clause) before promotion. |
| **Platform and Stack** | **Suspended (not applicable) for the backend stack line** | "Electron main and preload processes plus a Vite + React renderer" names the Electron process model specifically. This build keeps "Windows 11 only" and "Vite + React renderer, TypeScript with `strict: true`" (both still true), but replaces "Electron main and preload" with a Tauri/Rust backend -- an explicit, Stuart-approved deviation for this experimental build only, not a silent violation. |

No unresolved violation: both suspended rows are an explicit, cited, user-approved deviation
(issue://780), not an unacknowledged gap, so `Complexity Tracking` below has no entries requiring
justification beyond this table.

## Project Structure

### Documentation (this feature)

```text
specs/016-tauri-rust-build/
├── spec.md
├── plan.md              # this file
├── research.md
├── contracts/
│   └── bridge.md
├── parity.md
├── quickstart.md
└── tasks.md
```

No `data-model.md`: this feature introduces no new persisted entity (spec.md "Key Entities"). It
reuses `Registry`/`Session`/`Repository`/`Settings` from `src/shared/model.ts` unchanged; that
file's own JSDoc and the existing `specs/001-core-session-workspace/data-model.md` remain the
entity reference. No `contracts/` entry beyond `bridge.md` either: there is exactly one Tauri
command (FR-006), so the IPC contract is the dispatch table itself (`parity.md`), not a
per-endpoint contract file per request channel.

### Source code (repository root, additions only)

```text
src-tauri/
├── Cargo.toml                    # tauri, tauri-build (build-dep), tokio, serde, serde_json, windows
├── build.rs                      # tauri_build::build()
├── tauri.conf.json                # window config (decorations: true), CSP, bundle identifier,
│                                   #   data dir, initialization script wiring for theme bootstrap
├── capabilities/
│   └── default.json               # Tauri v2 permissions: shell-open (external links), dialog
│                                   #   (folder picker), clipboard-write, fs scoped to worktrees
└── src/
    ├── main.rs                    # entry point, Job Object join before any spawn, Builder wiring
    ├── lib.rs                     # tauri::Builder assembly, generate_handler![refract_request]
    ├── ipc/
    │   └── mod.rs                 # refract_request dispatch table: channel string -> handler fn
    ├── events.rs                  # IPC_EVENTS string constants + typed emit helpers
    ├── omp/
    │   ├── process.rs             # OmpProcess.rs port: spawn, stdio framing, rpc_chunk reassembly,
    │   │                           #   request/response correlation + timeout, stop/taskkill
    │   ├── transcript.rs           # transcript.ts port: frame -> TranscriptItem
    │   └── diff.rs                 # transcriptDiff.ts port + 50 ms coalescing window, O(n)
    │                               #   map-based, last-write-wins per id (research.md decision 9)
    ├── session/
    │   ├── agent.rs                # SessionAgent.ts port: one per opened Session
    │   └── manager.rs              # SessionManager.ts port: registry + settings stores, live
    │                               #   agents, event fan-out
    ├── store/
    │   ├── atomic_json.rs          # atomicJson.ts port: write-tmp-fsync-rename, corrupt quarantine
    │   ├── registry.rs             # registry.ts port
    │   └── settings.rs             # settings.ts port
    ├── git/
    │   └── worktrees.rs            # worktrees.ts port: CLI wrappers for repo checks, branches,
    │                               #   worktree create/remove
    └── process/
        └── job_object.rs           # jobObject.ts port: windows-rs CreateJobObjectW +
                                    #   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, joined at startup

src/tauri-bridge/
├── index.ts                       # RefractApi built over @tauri-apps/api invoke/listen,
│                                   #   method-for-method mirror of src/preload/index.ts
└── entry.ts                       # assigns window.refract, then imports the renderer's entry

tauri.vite.config.ts                # separate Vite config, points at tauri/index.html
tauri/
└── index.html                      # separate HTML entry; imports src/tauri-bridge/entry.ts

package.json                       # + "dev:tauri", "build:tauri" scripts;
                                    # + devDependencies "@tauri-apps/cli", "@tauri-apps/api"
```

**Structure Decision**: `src-tauri/` holds the entire Rust backend as its own Cargo crate, kept at
the repository root (Tauri's own convention) rather than nested under `src/`, so `cargo` commands
run from the repo root exactly as `tauri.conf.json`'s `build.beforeDevCommand` expects. `src/`
gains only two small, additive directories (`tauri-bridge/`, and the `tauri/` HTML entry sitting
beside the existing Electron-only files) -- `src/renderer`, `src/shared`, `src/main`, and
`src/preload` are untouched, so a `git diff` against this feature touches no existing file except
`package.json` (two new scripts, two new devDependencies).

## Complexity Tracking

*No entries.* The two Constitution Check rows marked "Suspended" are an explicit, cited,
Stuart-approved deviation for an experimental build (issue://780), not an unjustified violation of
an applicable principle -- there is nothing here that needs a "simpler alternative rejected
because" justification.

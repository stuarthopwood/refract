---

description: "Task list for spec 016: Rust (Tauri v2) build"
---

# Tasks: Rust (Tauri v2) build

**Input**: Design documents from `specs/016-tauri-rust-build/` (spec.md, plan.md, research.md,
contracts/bridge.md, parity.md, quickstart.md)

**Tests**: None new. Refract has an existing automated vitest suite (`src/` test files, run via
the repository's existing test script); this feature adds no new tests to it, since `src-tauri/`
is a separate, experimental Rust backend verified manually per `quickstart.md`, matching plan.md's
own Technical Context ("Testing: None [new]").

**Organization**: Phase 1 is project scaffolding (owned by a separate, concurrent worker -- listed
here only so Phase 2's dependency on it is explicit, not duplicated). Phases 2 through 4 are this
task list's own scope, grouped by Rust module ownership so three slices of Phase 2 can run as
independent parallel workers once Phase 1 lands.

## Format: `[ID] [P?] Description`

- **[P]**: can run in parallel with other `[P]` tasks in the same phase (different files, no
  dependency on each other).
- Every task names the exact file(s) it creates/edits and the Electron TypeScript file it is a
  Rust port of.

---

## Phase 1: Setup (scaffold -- in progress by another worker, not duplicated here)

**Owner**: a separate, concurrently-running worker. Listed for dependency visibility only --
Phase 2 cannot start until this phase's files exist.

- T001 `src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`
  (research.md version pins; window config `decorations: true`, title "Refract (Rust preview)").
- T002 `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` (`tauri::Builder` assembly,
  `generate_handler![ipc::refract_request]`, calls the Job Object stub below before any spawn).
- T003 `src-tauri/src/ipc/mod.rs` (dispatch-table skeleton: `refract_request` signature,
  `unsupported` default match arm per `contracts/bridge.md`).
- T004 `src-tauri/src/events.rs` (`IPC_EVENTS` string constants; emit-helper skeleton, bodies
  filled in by Phase 3).
- T005 `src-tauri/src/process/job_object.rs` (stub `join_kill_on_close() -> Result<()>` returning
  `Ok(())`; Phase 2(a) replaces the body with the real Win32 calls).
- T006 `src/tauri-bridge/index.ts`, `src/tauri-bridge/entry.ts` (`RefractApi` built over
  `@tauri-apps/api` `invoke`/`listen`, theme bootstrap read from
  `window.__REFRACT_THEME_BOOTSTRAP__`).
- T007 `tauri.vite.config.ts`, `tauri/index.html` (CSP extended per `contracts/bridge.md`).
- T008 `package.json` (`dev:tauri`, `build:tauri` scripts; `@tauri-apps/cli`/`@tauri-apps/api` dev
  dependencies), `.gitignore` (`src-tauri/target`, `out/tauri-web`).
- T009 First real channel end to end: `settings.get` + the `theme:bootstrap` sync channel, proving
  the whole `refract_request`/window-creation pipeline actually works before Phase 2 builds on it.

**Checkpoint**: window opens, shows the readiness/empty-repositories screen with the correct theme
pre-applied, every other channel returns `unsupported`. Phase 2 can start once this lands.

---

## Phase 2: Core modules (three independent parallel slices)

**Purpose**: the three pieces milestone 1's actual channels are built from, each touching a
disjoint set of files so all three can run as separate workers once Phase 1's checkpoint is met.

### Phase 2(a) -- omp process, Job Object, omp resolution

- T010 [P] `src-tauri/src/process/job_object.rs`: replace the Phase 1 stub with the real
  `CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject` +
  `TerminateJobObject` calls via `windows-rs` (research.md decision 6). Port of
  `src/main/process/jobObject.ts`'s `koffi`-based FFI, same win32 call sequence and limit flags,
  re-expressed as static `windows-rs` bindings.
- T011 [P] `src-tauri/src/omp/process.rs`: port of `src/main/omp/OmpProcess.ts` -- spawn `omp
  --mode rpc-ui --approval-mode=<mode>` with the Session's worktree as cwd, `CREATE_NO_WINDOW`
  (FR-001), protocol v2 negotiation after the `ready` frame, `rpc_chunk` reassembly before JSON
  decode (FR-002), request/response correlation by id with a per-request timeout via `tokio::time`
  (FR-003), stop via stdin close then `taskkill /PID <pid> /T /F` after the 10 s grace period
  (FR-004). Includes the PATH-only `omp` resolution (research.md decision 7) and sets the
  `NoDefaultCurrentDirectoryInExePath`-equivalent safety before the first spawn, porting
  `src/main/index.ts`'s own top-of-file env var line, scoped to `omp` spawns.
- T012 [P] `src-tauri/src/process/mod.rs`: wires `job_object` into the crate tree; `src-tauri/src/
  omp/mod.rs`: wires `process` (and the Phase 2(c) `transcript`/`diff` submodules once they land)
  into the crate tree.

**Checkpoint**: `omp` can be spawned, framed, stopped, and force-killed via the Job Object from a
standalone Rust test binary or `cargo run` smoke check, independent of any IPC command wiring.

### Phase 2(b) -- stores, git, repositories/sessions/conversations commands

- T013 [P] `src-tauri/src/store/atomic_json.rs`: port of `src/main/store/atomicJson.ts`
  (write-tmp-then-fsync-then-rename, corrupt-file quarantine).
- T014 [P] `src-tauri/src/store/registry.rs`: port of `src/main/store/registry.ts` (`Registry`/
  `Repository`/`Session` CRUD over `atomic_json`, same `Registry`/`Repository`/`Session` JSON
  shapes as `src/shared/model.ts`, FR-015), reading/writing `registry.json` under
  `%APPDATA%\refract-tauri` (FR-014).
- T015 [P] `src-tauri/src/store/settings.rs`: port of `src/main/store/settings.ts` (`Settings`
  CRUD including `approvalMode`), completing the Phase 1 `settings.get`-only stub with
  `settings.setApprovalMode`'s real mutation and persistence; reads/writes `settings.json` under
  the same data directory.
- T016 [P] `src-tauri/src/git/worktrees.rs`: port of `src/main/git/worktrees.ts` (repo-validity
  checks, branch listing CLI wrapper used by `repositories.branches`, worktree create used by
  `sessions.create`).
- T017 [P] `src-tauri/src/ipc/repositories.rs`: `repositories.list`, `.add`, `.remove`,
  `.branches`, `.pickFolder` (Tauri `dialog` plugin, permission already granted in
  `capabilities/default.json` by Phase 1), `.userName` -- full port of the matching arms in
  `src/main/ipc/repositories.ts`, backed entirely by `store::registry` + `git::worktrees`; none of
  these need a live `SessionAgent`.
- T018 [P] `src-tauri/src/ipc/conversations.rs`: `conversations.list` only (directory scan via the
  Rust port of `src/main/conversations.ts`'s `listConversations` helper) -- no live agent needed.
  `conversations.startNew`/`.open` are deliberately NOT implemented here; they require the live
  `SessionAgent` (Phase 3) and are left as explicit follow-up arms Phase 3 fills in.
- T019 `src-tauri/src/ipc/sessions.rs`: `sessions.create` and `sessions.rename` (registry-only
  mutations, port of the matching arms in `src/main/ipc/sessions.ts`), plus the registry-only half
  of `sessions.list` (returns one `SessionSummary` per registry `Session`, with the live-runtime
  fields -- provider/model/thinking level/status -- left at their "absent until the first
  `get_state`" default, matching the Electron contract's own documented behaviour for a Session
  that has never been opened this run, data-model.md). Registers (but does not yet implement the
  body of) the `sessions.open`, `.stopAgent`, `.setVisible` match arms, each calling into a
  `session::manager` function Phase 3 provides -- **depends on Phase 3 landing before these three
  arms compile against a real `session::manager`; sequence this file's registry-only arms (create,
  rename, list) ahead of its agent-backed arms within the same PR if Phase 3 has not landed yet.**

**Checkpoint**: Repositories can be added/listed/removed/branch-listed/named entirely through the
Rust store, independent of any live `omp` process; `registry.json`/`settings.json` round-trip
correctly under `%APPDATA%\refract-tauri`.

### Phase 2(c) -- transcript port and diff/coalescer

- T020 [P] `src-tauri/src/omp/transcript.rs`: port of `src/main/omp/transcript.ts` (OMP frame ->
  `TranscriptItem` assembly, same item shapes as `src/shared/model.ts`'s `TranscriptItem`).
- T021 [P] `src-tauri/src/omp/diff.rs`: port of `src/main/omp/transcriptDiff.ts` plus the 50 ms
  coalescing window, O(n) map-based, last-write-wins-per-id design (research.md decision 9) --
  same batching window and algorithmic shape as the Electron build, so `transcript:patch` fires at
  the same cadence/granularity on both backends.

**Checkpoint**: given a recorded sequence of raw `omp` frames (from a fixture or a live capture),
`transcript.rs` + `diff.rs` together produce the same `TranscriptOp[]` sequence the Electron
build's own `transcriptDiff.ts` would, verified by manual comparison against a live Electron run
using the same input.

---

## Phase 3: Session agent/manager, chat/approval/queue, events

**Purpose**: the live per-Session process loop and its event fan-out -- the piece every
agent-dependent channel from Phase 2(b) was left stubbed for.

**Depends on**: Phase 2(a) (`omp::process`), Phase 2(b) (`store::registry`, `store::settings`,
the `ipc::sessions`/`ipc::conversations` arm skeletons), and Phase 2(c) (`omp::transcript`,
`omp::diff`) all landed.

- T022 `src-tauri/src/session/agent.rs`: port of `src/main/omp/SessionAgent.ts` -- one instance
  per opened Session, owns an `omp::process::OmpProcess`, the Session's runtime status/snapshot,
  `availableCommands` (slash commands), the approval-mode-aware turn loop (send/stop/answer),
  `startNewConversation`/`openConversation` (used by `conversations.startNew`/`.open`'s
  agent-backed path), and the "stopped Session" conversation-switch path (port of
  `src/main/omp/conversationSwitch.ts`'s `startStoppedSessionOnConversation`).
- T023 `src-tauri/src/session/manager.rs`: port of `src/main/SessionManager.ts` -- owns
  `store::registry` + `store::settings`, the live `agents: HashMap<SessionId, SessionAgent>` map,
  `summaries()` (now completing `sessions.list`'s live-runtime fields, superseding Phase 2(b)'s
  registry-only placeholder), `get_or_create_agent`, `set_visible`, and the event fan-out (one
  internal channel every `SessionAgent` event is forwarded through, mirroring `ManagerEvent` in
  the Electron source).
- T024 Complete `src-tauri/src/ipc/sessions.rs`'s `sessions.open`, `.stopAgent`, `.setVisible`
  bodies (left as stubs by T019), wiring them to `session::manager`.
- T025 Complete `src-tauri/src/ipc/conversations.rs`'s `conversations.startNew`/`.open` bodies
  (left unimplemented by T018), wiring them to the live `SessionAgent` via `session::manager`,
  including the stopped-Session path.
- T026 `src-tauri/src/ipc/chat.rs`: `chat.send`, `.stop`, `.answer`, `.commands` -- port of the
  matching arms in `src/main/ipc/chat.ts`, each validating arguments then delegating to
  `session::manager`'s `get_or_create_agent(...)`.
- T027 Complete `src-tauri/src/events.rs`'s 8 milestone-1 emit helpers (`session:status`,
  `session:list-changed`, `transcript:patch`, `queue:update`, `request:pending`,
  `request:resolved`, `commands:update`, `settings:changed`), each wired to fire on the matching
  `session::manager` event (port of `src/main/ipc/register.ts`'s per-event-type `match` and
  `src/main/ipc/broadcast.ts`'s `settings:changed` broadcast).
- T028 Complete `src-tauri/src/ipc/settings.rs`'s `settings.setApprovalMode` arm (left partially
  stubbed by T015, which only persisted the value) so it also triggers the `settings:changed`
  broadcast from T027.

**Checkpoint**: a Session can be created, opened, chatted with (streamed `transcript:patch`),
asked to approve a tool call, and stopped, entirely through the Rust backend -- User Stories 1
through 5 are mechanically reachable, pending Phase 4's actual live verification.

---

## Phase 4: Integration, live verification, footprint measurement

**Purpose**: wire everything together at the `lib.rs`/`main.rs` level, then prove it against
`quickstart.md` with the real app, not just per-module reasoning.

**Depends on**: Phase 3 complete.

- T029 `src-tauri/src/lib.rs`/`main.rs`: confirm `session::manager` is constructed at startup from
  the real `store::registry`/`store::settings`, `process::job_object::join_kill_on_close()` is
  actually called before any `omp` spawn is possible (not just present as a stub, T005), and every
  milestone-1 `ipc::*` module (`repositories`, `sessions`, `conversations`, `chat`, `settings`,
  `clipboard`, `readiness`) is registered into `ipc::mod`'s dispatch table alongside the
  `unsupported` default. **Done** -- see `verification.md`.
- T030 Live-verify User Story 1 (run the Rust build, see Repositories, zero-flash theme) per
  `quickstart.md`. **Done** -- see `verification.md`.
- T031 Live-verify User Story 2 (add a repository) per `quickstart.md`. **Done (partial)** -- see
  `verification.md`: verified via the typed-path fallback; the native folder picker itself was
  not driven live.
- T032 Live-verify User Story 3 (create and open a Session, real `omp` child process with the
  worktree as cwd) per `quickstart.md`. **Done** -- see `verification.md`.
- T033 Live-verify User Story 4 (chat with a streamed answer, `transcript:patch` upserts) per
  `quickstart.md`. **Done** -- see `verification.md`.
- T034 Live-verify User Story 5 (answer an approval request) per `quickstart.md`. **Done** -- see
  `verification.md`: required the `PendingRequest` `rename_all_fields` fix (`2a78831`).
- T035 Footprint measurement (SC-005): run the procedure in `quickstart.md` against both builds
  with the same two-Session state, record both private-memory totals side by side. **Done** --
  see `verification.md` for the recorded app-side and omp-side totals for both builds.
- T036 Update `parity.md`'s "Rust status" column from `todo` to `done` for every one of the 32
  milestone-1 rows (23 requests + 8 events + the bootstrap) landed by T010-T028; leave the
  remaining 75 rows `todo`. **Done, updated parity.md honestly**: 21 of 32 milestone-1 rows done,
  1 partial (`repositories.pickFolder`), 10 not exercised live (see `verification.md` for the
  full breakdown) -- not "all 32 done".

**Checkpoint**: met except where `verification.md` says otherwise: User Stories 1-7 and the Job
Object force-kill passed live, US2 without the native folder picker, SC-005 measured, and the 10
milestone-1 rows listed in `verification.md` are implemented but not exercised live.
`parity.md` reflects exactly that.

---

## Dependencies & Execution Order

- **Phase 1 (scaffold)**: owned externally; blocks all of Phase 2.
- **Phase 2(a)/(b)/(c)**: no dependency on each other -- three independent workers once Phase 1's
  checkpoint is met. Within Phase 2(b), T013-T018 ([P]) can run in parallel with each other; T019
  depends on T014 (`store::registry`) and T016 (`git::worktrees`) from the same slice.
- **Phase 3**: depends on all three Phase 2 slices landing (T022 needs `omp::process` from 2(a)
  and `omp::transcript`/`diff` from 2(c); T023-T028 need `store::registry`/`settings` and the
  `ipc::sessions`/`conversations` skeletons from 2(b)).
- **Phase 4**: depends on Phase 3 complete.

## Parallel Example: Phase 2

```text
Worker A: T010, T011, T012              (omp process + Job Object)
Worker B: T013, T014, T015, T016, T017, T018, T019   (stores + git + repositories/sessions/conversations)
Worker C: T020, T021                    (transcript + diff)
```

All three can start the moment Phase 1's checkpoint (T001-T009) is confirmed.

## Notes

- No test tasks anywhere in this list: this feature adds no new automated tests (Refract's
  existing vitest suite is unaffected; `src-tauri/` is verified manually per `quickstart.md`), so
  every checkpoint above is a manual run.
- Every task names the exact Rust file(s) it owns and the Electron TypeScript file it ports, so no
  two tasks across Phase 2's three slices touch the same file.

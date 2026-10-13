# Feature Specification: Rust (Tauri v2) build

**Feature Branch**: `016-tauri-rust-build` (work lands on `feat/780-tauri-rust`; this directory is
the Spec Kit record, not a literal git branch)

**Created**: 2026-10-13

**Status**: Implemented (milestone 1), experimental. This build is a second, separate desktop
shell for Refract. The Electron build (`src/main`, `src/preload`) remains the source of truth and
is not changed by this spec. Nothing here is promoted into the supported product until Stuart
explicitly decides to promote it (see Assumptions and `plan.md` Constitution Check).

**Input**: [issue://780](https://github.com/stuarthopwood/refract/issues/780) ("Experiment: Rust
(Tauri v2) build of Refract with a Rust-native backend, separate from the Electron build") and
Stuart's decision comment on that issue, dated 2026-10-13.

## Clarifications

### Already decided (cited, not re-asked)

- **Q (issue://780, Stuart 2026-10-13)**: Node sidecar process vs. a Rust-native backend? ->
  **Rust-native backend** (not a Node sidecar); same repository under `src-tauri/`, sharing
  `src/renderer` and `src/shared` unchanged.
- **Q (issue://780, Stuart 2026-10-13)**: separate repository vs. same repository? -> **same
  repository**, new `src-tauri/` directory alongside the existing Electron `src/main`.
- **Q (issue://780, Stuart 2026-10-13)**: ship full IPC parity before anything runs, or ship a
  working core loop first? -> **milestone 1 is the core loop** (readiness, repositories, Sessions,
  Conversations, chat, settings subset, the theme bootstrap, and the eight core-loop events); a
  parity checklist against every `IPC_REQUESTS`/`IPC_EVENTS` entry is generated now
  (`parity.md`) and closed out in later slices.
- **Q (issue://780, Stuart 2026-10-13)**: run this through Spec Kit? -> **yes**, as spec 016,
  explicitly marked experimental; the constitution stays unchanged unless/until the Rust build is
  promoted.
- **Q (issue://780, Stuart 2026-10-13)**: data directory? -> its own, `%APPDATA%\refract-tauri`,
  never the Electron build's `%APPDATA%\pinion` -- the two builds must never write the same
  registry or session store.
- **Q (issue://780, Stuart 2026-10-13)**: separate build/dev scripts? -> **yes**, `dev:tauri` /
  `build:tauri`; the existing Electron `dev` / `build` scripts are untouched.

### Carved out, not blocking

- Full IPC parity (all 86 `IPC_REQUESTS` and 20 `IPC_EVENTS` entries): tracked row-by-row in
  `parity.md`; only the milestone-1 subset is in scope for this spec's user stories.
- Custom window chrome / caption overlay parity: milestone 1 ships native OS window decorations
  (`decorations: true`); the renderer's own custom caption spacer may show a visible gap under
  Tauri. Documented as a known, accepted difference (Assumptions), not a defect to fix here.
- CDP-based automated verification: the existing Electron CDP verification tooling does not attach
  to a Tauri/WebView2 process; manual verification only (`quickstart.md`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run the Rust build and see Repositories (Priority: P1)

A developer runs `pnpm dev:tauri` instead of `pnpm dev`, and the app window opens showing the same
Repositories-first screen as the Electron build, themed correctly from the very first paint.

**Why this priority**: without a window that opens, themes correctly, and shows real readiness,
every other story is unreachable; this is the floor the whole experiment stands on.

**Independent Test**: run `pnpm dev:tauri`, confirm the window opens with native WebView2 content,
the `readiness.check` result renders (omp found/not found, as applicable), and the saved theme's
CSS class is already applied on the very first frame (no flash of the wrong theme).

**Acceptance Scenarios**:

1. **Given** `omp` is on PATH and at least the minimum supported version, **When** the developer
   launches the Rust build, **Then** the Repositories screen (or the readiness/empty-state screen
   if no repository is added yet) renders with the previously saved theme applied immediately.
2. **Given** a repository and Session already exist in `%APPDATA%\refract-tauri`'s `registry.json`
   from a prior run, **When** the app launches, **Then** the Repository and Session both appear in
   the list exactly as the Electron build would show them (User Story 7 covers the full reopen
   case).

---

### User Story 2 - Add a repository (Priority: P1)

A developer picks an existing git repository folder on disk and Refract adds it to the list.

**Why this priority**: the first real write path; nothing about Sessions is reachable without at
least one Repository.

**Independent Test**: click "Add repository", pick a folder via the native folder picker, and
confirm it appears in the Repositories list with its name and branch list populated.

**Acceptance Scenarios**:

1. **Given** the Repositories screen is open, **When** the developer picks a valid git repository
   folder, **Then** it is added to `registry.json` under `%APPDATA%\refract-tauri` and appears in
   the list with its branches available (`repositories.branches`).
2. **Given** the developer picks a folder that is not a git repository, **When** the add completes,
   **Then** a clear error is shown and nothing is added (mirrors Electron's own `not-a-repo` error
   code).

---

### User Story 3 - Create and open a Session (Priority: P1)

A developer creates a new Session against a Repository and base branch, and its chat pane opens.

**Why this priority**: the Session is the unit everything else (chat, approvals, stop) operates
on; this is the first story that spawns a real `omp` child process.

**Independent Test**: from an added Repository, create a Session on its default base branch, and
confirm a new git worktree is created on disk and the Session's pane opens showing an empty
transcript, ready to chat.

**Acceptance Scenarios**:

1. **Given** a Repository with at least one branch, **When** the developer creates a Session,
   **Then** a new worktree is created under `<repo>/../pinion-worktrees/<repoName>/<name>`, the
   Session is persisted to `registry.json`, and `sessions.open` auto-starts its `omp` process in
   that worktree's directory.
2. **Given** the Session was just created, **When** its agent finishes starting, **Then**
   `session:status` reports it as running and the chat composer becomes usable.

---

### User Story 4 - Chat with a streamed answer (Priority: P1)

A developer sends a message and watches the assistant's answer stream into the transcript.

**Why this priority**: the core value proposition of the whole app -- without a working chat loop,
Sessions are inert shells.

**Independent Test**: type a message into an open Session's composer, send it, and confirm the
transcript shows the user message immediately and the assistant's reply streams in via
`transcript:patch` upsert operations, ending in a settled turn.

**Acceptance Scenarios**:

1. **Given** a running Session with an idle agent, **When** the developer sends a message via
   `chat.send`, **Then** the transcript shows the new user item immediately and assistant text
   streams in as a sequence of `transcript:patch` events, each one a monotonically-growing partial
   of the same streaming item (same coalescing behaviour as `transcriptDiff.ts`, batched per
   `diff.rs`'s 50 ms window).
2. **Given** a turn is in flight, **When** the assistant's turn completes, **Then** the queue
   (`queue:update`) empties and the composer is ready for the next message.

---

### User Story 5 - Answer an approval request (Priority: P1)

A developer is asked to approve a tool call and answers it from the chat pane.

**Why this priority**: Approval mode `Ask` is the default; without being able to answer a pending
tool-approval request, every tool-using turn stalls forever (constitution Principle II: "Refract
MUST answer every `select`... request").

**Independent Test**: start a Session in Approval mode `Ask`, prompt a turn that calls a tool, and
confirm the pending approval request renders in the chat pane and `chat.answer` (`Approve` or
`Deny`) unblocks the turn.

**Acceptance Scenarios**:

1. **Given** a running Session with a pending tool-approval request (`request:pending`, title
   starting with `Allow tool:`), **When** the developer clicks Approve, **Then** `chat.answer` is
   sent with the approval, `request:resolved` fires, and the tool call proceeds.
2. **Given** the same pending request, **When** the developer clicks Deny instead, **Then** the
   tool call is skipped and the turn continues (or ends) without executing it.

---

### User Story 6 - Stop the agent (Priority: P2)

A developer stops a Session's agent mid-turn or while idle.

**Why this priority**: a working stop path is required before chat is safe to use at all (an
unkillable runaway agent is worse than a missing feature), but it is not load-bearing for the
*first* successful turn the way Stories 1-5 are, hence P2.

**Independent Test**: with a Session running (mid-turn or idle), click Stop and confirm the `omp`
process for that Session exits (stdin closed, graceful exit awaited, `taskkill /T /F` fallback
after the grace period) and `session:status` reports it stopped.

**Acceptance Scenarios**:

1. **Given** a Session mid-turn, **When** the developer clicks Stop, **Then** `sessions.stopAgent`
   closes the process's stdin, waits up to the stop grace period, and force-kills the whole
   process tree if it has not exited by then; `session:status` reports `stopped`.
2. **Given** a Session already idle, **When** the developer clicks Stop, **Then** the same shutdown
   path runs without error (idempotent).

---

### User Story 7 - Reopen the app and see Sessions and history (Priority: P2)

A developer closes the app entirely and reopens it; their Repositories, Sessions, and each
Session's prior transcript history are all still there.

**Why this priority**: persistence across a full app restart is what makes the Rust build usable
for real work rather than a single-run demo; P2 because Stories 1-6 must each work once before a
restart is meaningful to test.

**Independent Test**: after completing Stories 2-4 once, fully quit the Rust build (not just close
the window), relaunch it, and confirm every Repository and Session from before still appears, and
opening a Session's prior Conversation shows the same transcript as before the restart.

**Acceptance Scenarios**:

1. **Given** a Repository and Session created in a previous run, **When** the developer relaunches
   the Rust build, **Then** `repositories.list` and `sessions.list` both return them, read from the
   same `registry.json` under `%APPDATA%\refract-tauri` used before the restart.
2. **Given** a Session with prior chat history, **When** the developer opens it after relaunch,
   **Then** `conversations.list` / `conversations.open` return the same transcript history as
   before the restart (reattach, not a fresh empty session).

---

### Edge Cases

- **`omp` missing from PATH**: `readiness.check` reports it as not found; the UI shows the same
  not-ready state the Electron build shows, no Session can be created or opened.
- **Start timeout**: an `omp` process that never reaches its `ready` frame within the configured
  ceiling fails the start with a clear error (same `ReadyCeilingError` concept as
  `OmpProcess.ts`); the Session is left `stopped`, not stuck `starting` forever.
- **Unported channel called from the renderer**: any `IPC_REQUESTS`/`IPC_EVENTS` entry not yet
  implemented in Rust (per `parity.md`) returns `{ ok: false, error: { code: 'unsupported',
  message: 'Not available in the Rust build yet: <channel>' } }` through the same `refract_request`
  envelope; the renderer's existing `unsupported` handling (already a real `IpcErrorCode`) renders
  it exactly as it would any other backend-reported failure, with no renderer code change needed.
- **`omp` process crash**: the child process's `exit` event fires unexpectedly (non-zero code, not
  requested); the Session's status moves to `stopped` with its last error surfaced the same way
  `OmpProcess.ts`'s own stderr-tail/log-tail diagnostics do today, not a silently stuck "running"
  state.
- **App killed mid-turn**: the whole Refract-Tauri process is killed (task manager, crash, forced
  shutdown) while a Session's `omp` process (and any of its own tool subprocesses) is still
  running. The Windows Job Object (`process/job_object.rs`), joined with kill-on-close before any
  `omp` child is spawned, ensures Windows itself tears down the entire `omp` process tree the
  instant the parent handle closes -- no orphaned `omp` or tool subprocess is left running.

## Requirements *(mandatory)*

### Functional Requirements

**Process and transport (constitution I, II, III apply unchanged -- see `plan.md`)**

- **FR-001**: The system MUST spawn `omp --mode rpc-ui --approval-mode=<mode>` as a child process
  per Session, with the Session's own worktree as its cwd, `CREATE_NO_WINDOW`, and JSONL framing
  over stdio, exactly as `OmpProcess.ts` does today; Refract-Tauri MUST NOT pass
  `--no-extensions`, `--no-skills`, `--no-tools`, `--no-rules`, or `--no-ui`.
- **FR-002**: The system MUST negotiate protocol v2 after the `ready` frame and reassemble
  `rpc_chunk` frames before decoding JSON, same as the Electron build's own frame handling.
- **FR-003**: The system MUST correlate every RPC request/response by id and enforce a per-request
  timeout; an unanswered timed-out request MUST fail that one call, not hang the whole process.
- **FR-004**: The system MUST stop a Session by closing stdin and waiting for the process to exit,
  then force-stop with `taskkill /PID <pid> /T /F` if it has not exited within the stop grace
  period (10 s).
- **FR-005**: The system MUST join a Windows Job Object with kill-on-close before spawning any
  `omp` process, so a forcibly killed Refract-Tauri main process takes the whole `omp` tree with
  it (Edge Cases).

**IPC surface**

- **FR-006**: The system MUST expose exactly one Tauri command, `refract_request(channel: String,
  args: Vec<serde_json::Value>) -> serde_json::Value`, returning the same `Result<T>` envelope
  shape as `src/shared/ipc.ts`'s `Result<T>` for every request channel.
- **FR-007**: A request channel not yet implemented in Rust MUST return `{ ok: false, error: {
  code: 'unsupported', message: 'Not available in the Rust build yet: <channel>' } }`, using the
  `unsupported` `IpcErrorCode` that already exists in `src/shared/ipc.ts` (not modified by this
  feature).
- **FR-008**: The system MUST emit Tauri events under exactly the `IPC_EVENTS` string values (for
  example `transcript:patch`), with the same JSON payload shapes the Electron build sends on the
  matching channel.
- **FR-009**: `src/tauri-bridge/index.ts` MUST build a `RefractApi`-shaped object (the type already
  defined in `src/shared/ipc.ts`) over `@tauri-apps/api`'s `invoke('refract_request', {channel,
  args})` and `listen`, matching `src/preload/index.ts` method-for-method, so `src/renderer` loads
  completely unchanged against either backend.

**Theme bootstrap**

- **FR-010**: Before creating the main window, the Rust backend MUST read the persisted theme from
  `settings.json` and inject it via a `WebviewWindowBuilder` initialization script that sets
  `window.__REFRACT_THEME_BOOTSTRAP__ = { theme: "<id>" }` before any page script runs.
- **FR-011**: `src/tauri-bridge/index.ts`'s `themeBootstrap()` MUST read
  `window.__REFRACT_THEME_BOOTSTRAP__` synchronously (no IPC round trip), matching the Electron
  preload's own synchronous `ipcRenderer.sendSync` contract, so `main.tsx`'s very first line
  (`initThemeStore(window.refract.themeBootstrap().theme)`) still never paints before the correct
  theme class is set.

**Milestone 1 scope**

- **FR-012**: Milestone 1 MUST implement the following request channels in Rust (see `parity.md`
  for the full table): `readiness.check`; `repositories.list`, `.add`, `.remove`, `.branches`,
  `.pickFolder`, `.userName`; `sessions.list`, `.create`, `.open`, `.stopAgent`, `.setVisible`,
  `.rename`; `conversations.list`, `.startNew`, `.open`; `chat.send`, `.stop`, `.answer`,
  `.commands`; `settings.get`, `.setApprovalMode`; `clipboard.writeText`; plus the theme bootstrap.
  Every other channel returns `unsupported` (FR-007) until a later slice.
- **FR-013**: Milestone 1 MUST emit these events: `session:status`, `session:list-changed`,
  `transcript:patch`, `queue:update`, `request:pending`, `request:resolved`, `commands:update`,
  `settings:changed`. No other event is emitted until a later slice.

**Storage and data isolation**

- **FR-014**: The system MUST store `registry.json` and `settings.json` under
  `%APPDATA%\refract-tauri`, using the same atomic write-tmp-then-rename-with-fsync pattern and
  the same corrupt-file quarantine behaviour as `src/main/store/atomicJson.ts`, and MUST NOT read
  or write anything under the Electron build's `%APPDATA%\pinion`.
- **FR-015**: The system MUST use the same JSON shapes (`Registry`, `Settings`, `Repository`,
  `Session`) as `src/shared/model.ts`, so a developer comparing the two builds' store files sees
  structurally identical data (values will differ once the two builds' own data directories
  diverge in content).

**Build and packaging**

- **FR-016**: The system MUST add `dev:tauri` and `build:tauri` scripts to `package.json` without
  modifying the existing Electron `dev`/`build` scripts, and MUST add a separate Vite config
  (`tauri.vite.config.ts`) and HTML entry (`tauri/index.html`) without modifying any file under
  `src/renderer`.

### Key Entities

This feature introduces no new persisted entity: it reads and writes the existing `Registry`,
`Session`, `Repository`, and `Settings` shapes from `src/shared/model.ts` unchanged (FR-015). The
only new runtime concept is the Rust-side `refract_request` dispatch table (`ipc/` module), which
is an internal routing detail, not a persisted entity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can complete User Stories 1 through 5 end to end (open the app, add a
  repository, create and open a Session, chat with a streamed answer, and answer an approval
  request) in the Rust build with no renderer code change relative to the Electron build.
- **SC-002**: 100% of the milestone-1 channels listed in FR-012/FR-013 are implemented and verified
  per `quickstart.md`; every other channel in `parity.md` returns the `unsupported` error shape
  (FR-007) rather than crashing or hanging.
- **SC-003**: The theme bootstrap shows zero frames of the wrong theme on cold start, verified by
  visual inspection against the Electron build's own zero-flash guarantee (FR-010/FR-011).
- **SC-004**: Killing the Refract-Tauri process (task manager "End task" on the main process) while
  a Session's agent is mid-turn leaves zero `omp.exe` (or any tool subprocess it spawned) processes
  running afterward, verified via Windows Task Manager or `Get-Process omp`.
- **SC-005**: With the same two Sessions open and settled (one idle, one having completed at least
  one chat turn) in both builds, a measured private-memory footprint comparison is recorded: total
  private bytes (`WorkingSetPrivate`/`PrivateUsage` via `Win32_Process`, summed across the Rust
  build's own process tree vs. the Electron build's own process tree, both including their spawned
  `omp` subprocesses) is captured once per build and the two numbers are reported side by side. No
  specific percentage-saving target is set: issue://780's own context notes the expected saving is
  mainly the Node main process, since WebView2's own Chromium renderer/GPU process persists either
  way [INFERENCE] -- this success criterion is about having a real, reproducible *measurement*, not
  a predetermined pass/fail threshold.

## Assumptions

- Windows 11 only, same as the Electron build; WebView2 Runtime is assumed present (it ships with
  Windows 11) rather than bundled.
- `omp` on PATH, minimum supported version per constitution Principle IV, same requirement as the
  Electron build.
- Native window decorations (no custom caption/title bar) are accepted for milestone 1; the
  renderer's existing custom caption spacer rendering a visible gap under Tauri is a known,
  intentionally deferred difference (quickstart.md documents it), not a defect this spec fixes.
- This build is never installed/distributed to end users during the experimental phase; it is a
  developer-run comparison build only. No installer/auto-update work is in scope.
- "Promotion" (making the Rust build the shipped product, or retiring the Electron build) is
  explicitly out of scope for this spec; it requires a separate, future decision and its own
  constitution amendment (plan.md Constitution Check).
- The parity count in issue://780's own body (84 requests / 20 events) is stale relative to the
  live `src/shared/ipc.ts` at the time this spec was written (86 requests / 20 events, see
  `parity.md`); this spec's counts are read directly from the source file, not copied from the
  issue.

# Quickstart: verifying the Rust (Tauri v2) build

Refract-Tauri is an EXPERIMENTAL, developer-run comparison build (spec.md Assumptions): no
automated test suite covers it (repository `AGENTS.md`), so every check below is a manual run of
the app, per user story in [spec.md](spec.md). Everything here applies once milestone 1
(FR-012/FR-013, `parity.md`'s milestone-1 rows) is implemented; `tasks.md` tracks which phase lands
each piece.

## Prerequisites

- **Windows 11** (same target platform as the Electron build; WebView2 Runtime is assumed present,
  spec.md Assumptions -- do not install a bundled copy).
- **Rust stable, MSVC toolchain** (`rustup default stable-msvc`), matching `tauri` 2.12.3's own
  `rust-version = 1.95` floor (research.md).
- **Visual Studio 2022 Build Tools**, "Desktop development with C++" workload, plus the **Windows
  11 SDK** component -- required by the MSVC linker Tauri's Rust build depends on; without this,
  `cargo build`/`pnpm dev:tauri` fails at link time, not compile time, so confirm this first if a
  build fails with an `link.exe` or `LNK` error.
- **`omp` on PATH**, at least the minimum supported version (constitution Principle IV), same
  requirement as the Electron build -- `readiness.check` (milestone 1) reports it missing
  otherwise, same UI treatment as the Electron build (spec.md Edge Cases).
- `pnpm install` at the repository root (installs `@tauri-apps/cli`/`@tauri-apps/api` alongside the
  existing Electron dependencies; `pnpm`'s own `onlyBuiltDependencies` list is unaffected).
- An isolated scratch instance with its own data directory -- never Stuart's real profile. The Rust
  build already writes to its own `%APPDATA%\refract-tauri` (FR-014, never
  `%APPDATA%\pinion`), so running it side by side with a real Electron Refract session is safe by
  construction, but still use a scratch repository/worktree for any destructive check (delete,
  recreate worktree) once those later-milestone channels are ported.

## Commands

- `pnpm dev:tauri` -- starts the separate Tauri dev pipeline (`tauri.vite.config.ts` serving
  `tauri/index.html`, `cargo` building and launching `src-tauri/` against it). Does not touch
  `pnpm dev`'s own Electron dev server or port.
- `pnpm build:tauri` -- builds the Tauri renderer bundle (`out/tauri-web`) and the Rust binary via
  `@tauri-apps/cli`'s `build` command. No installer/auto-update step is produced or expected (spec.md
  Assumptions: this build is never distributed during the experimental phase).
- `pnpm dev` / `pnpm build` -- unchanged, still the Electron build; running them is the comparison
  baseline for the footprint check below, not a step this build's own verification depends on.

## Checks per story (milestone 1, FR-012/FR-013)

**Story 1 -- Run the Rust build and see Repositories (P1, spec.md)**

1. Run `pnpm dev:tauri` with `omp` on PATH at a supported version. Expect: a native window titled
   "Refract (Rust preview)" opens with native OS decorations (no custom caption bar -- an accepted
   difference, see "Known differences" below), showing the Repositories screen.
2. Confirm the saved theme's CSS class is already applied on the very first rendered frame -- no
   flash of the wrong theme (`contracts/bridge.md` "Theme bootstrap"; FR-010/FR-011, SC-003).
3. Confirm the readiness state matches `omp`'s real PATH state (found-and-supported, or not found,
   per spec.md Edge Cases) -- same UI treatment the Electron build shows for the same condition.
4. Stop `omp` from PATH (rename the executable or edit `PATH` for the shell only) and repeat: the
   Repositories screen still renders, with the same "omp not found" affordance the Electron build
   shows.

**Story 2 -- Add a repository (P1, spec.md)**

1. Click "Add repository", pick a real git repository folder via the native folder picker
   (`repositories.pickFolder`). Expect: it appears in the Repositories list with its name and
   branch list populated (`repositories.add`, `.branches`, `.userName`).
2. Attempt to add a folder that is not a git repository. Expect: the same rejection the Electron
   build gives (`not-a-repo` `IpcErrorCode`, unchanged on the wire).

**Story 3 -- Create and open a Session (P1, spec.md)**

1. From an added Repository, create a Session on its default base branch (`sessions.create`).
   Expect: a new git worktree is created on disk under that Repository, and the Session's pane
   opens (`sessions.open`) showing an empty transcript.
2. Confirm the `omp --mode rpc-ui --approval-mode=<mode>` child process is actually running with
   that worktree as its cwd (Task Manager / `Get-Process omp` with `-IncludeUserName`, or a
   `wmic process where name='omp.exe' get processid,commandline` listing) -- FR-001.

**Story 4 -- Chat with a streamed answer (P1, spec.md)**

1. Type a message into the open Session's composer and send it (`chat.send`). Expect: the user
   message appears immediately, and the assistant's reply streams in via `transcript:patch` upsert
   operations (same event payload shape as the Electron build), ending in a settled turn.
2. Confirm `session:status` and `queue:update` events update the UI live while the turn is
   in-flight (spinner/queue indicators behave the same as the Electron build).

**Story 5 -- Answer an approval request (P1, spec.md)**

1. Start a Session in Approval mode `Ask` (default), prompt a turn that calls a tool. Expect: the
   pending approval request renders in the chat pane (`request:pending` event).
2. Answer it (`chat.answer`, `Approve` or `Deny`). Expect: the turn unblocks, and `request:resolved`
   fires, matching the Electron build's own `select`-request-answering contract (constitution
   Principle II).

**Settings subset (FR-012, no dedicated story)**

1. Confirm `settings.get` returns the same `Settings` shape as the Electron build's own
   `%APPDATA%\pinion\settings.json` would, but read from `%APPDATA%\refract-tauri\settings.json`
   instead (FR-014/FR-015 -- never the Electron build's own file).
2. Change the Approval mode (`settings.setApprovalMode`) and confirm a `settings:changed` event
   updates every open pane immediately, same as the Electron build.
3. Copy some chat text (`clipboard.writeText`) and paste it outside the app, confirming the system
   clipboard actually received it.

## Footprint measurement (SC-005)

1. In the **Electron** build: open two Sessions, settle them both (one left idle, one after
   completing at least one chat turn). Using PowerShell, sum private bytes across the whole process
   tree (main + renderer + GPU + utility + every spawned `omp.exe` and its own tool subprocesses):
   ```powershell
   Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'electron.exe','omp.exe' } |
     Measure-Object -Property WorkingSetSize -Sum
   ```
   (Use `PrivateUsage` via `Get-Process` if a more precise private-bytes figure than
   `WorkingSetSize` is needed; `Win32_Process` does not expose `PrivateUsage` directly, so cross-
   reference by PID against `Get-Process -IncludeUserName | Select-Object Id,PM,PrivateMemorySize64`
   for the same process set.) Record the total.
2. Quit the Electron build fully (not just close the window) so no process from step 1 is still
   running.
3. In the **Rust** build: recreate the same two-Session state (one idle, one settled after a chat
   turn) against its own `%APPDATA%\refract-tauri` data directory, then repeat the same
   `Win32_Process`/`Get-Process` measurement, substituting the Tauri binary's own process name for
   `electron.exe` (its name is whatever `tauri.conf.json`'s `productName` resolves to) and the same
   `omp.exe` filter.
4. Report both totals side by side. No specific percentage-saving target is required (SC-005): the
   acceptance bar is a real, reproducible measurement recorded once per build, not a pass/fail
   threshold -- WebView2's own Chromium renderer/GPU process persists in both builds either way.

## Known, accepted differences (not defects)

- **Window chrome**: native OS decorations (`decorations: true`), not the Electron build's hidden
  title bar + custom `AppMenuBar.tsx`; the renderer's own custom caption spacer may show a visible
  gap (research.md decision 5, spec.md "Carved out, not blocking").
- **Unported channels**: any channel outside `parity.md`'s milestone-1 rows returns the
  `unsupported` error shape (`contracts/bridge.md`) rather than crashing or hanging (SC-002) -- this
  is expected, not a bug, until a later milestone ports it.
- **No CDP-based automated verification**: the existing Electron CDP verification tooling does not
  attach to a Tauri/WebView2 process (spec.md "Carved out, not blocking"); every check above is
  manual.

## Full-gate checks

- `pnpm typecheck` passes (covers `src/tauri-bridge/` and `tauri.vite.config.ts` alongside the
  existing Electron TypeScript; `src-tauri/` is checked separately by `cargo check`/`cargo build`,
  which is not part of the existing `pnpm typecheck` script).
- `cargo check` (run from the repository root, or `cd src-tauri && cargo check`) passes with no
  warnings on the milestone-1 module set.
- `pnpm build:tauri` completes and the built binary launches and passes Story 1 above.

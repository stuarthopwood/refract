# Phase 0 Research: Rust (Tauri v2) build

1. **Rust-native backend, not a Node sidecar process.** Decided by Stuart on issue://780
   (2026-10-13, cited verbatim in spec.md Clarifications) and confirmed here on independent
   technical grounds: a Node sidecar would keep every `src/main` TypeScript file working almost
   unchanged, but it spawns a second JS runtime (Node + V8) *inside* a shell that already hosts
   WebView2's own Chromium process -- directly defeating the one thing this experiment exists to
   measure (spec.md SC-005, the private-memory footprint comparison; issue://780's own context
   notes the expected saving is mainly "the Node main process"). A sidecar would also add a second
   IPC hop (Tauri command -> sidecar RPC -> `omp` stdio) that duplicates every piece of
   process-lifecycle code this spec already has to write once in Rust anyway (the Job Object
   kill-on-close join, FR-005; the stdin-close-then-`taskkill` stop sequence, FR-004) without
   eliminating either. **Rejected**: Node sidecar -- reuses proven TS port code 1:1, but keeps a
   full second Node process alive per run and still needs a Rust (or native) process-containment
   layer around it, so it does not actually simplify anything this spec has to build, while
   permanently capping the possible footprint win at "maybe" instead of "yes".

2. **Same repository, new `src-tauri/` directory, not a separate repository.** Decided by Stuart
   on issue://780 (cited in spec.md Clarifications). Rationale: `src/renderer` and `src/shared`
   are reused completely unchanged (FR-009, FR-015); a separate repository would have to either
   vendor/duplicate those directories (immediately diverging from "zero renderer code change
   relative to the Electron build", spec.md SC-001) or consume them as a package dependency,
   which is real packaging work with no payoff for a build Stuart may discard entirely once the
   experiment concludes. A second repository also means a second CI setup, a second place branch
   protection and `AGENTS.md` conventions have to be kept in sync, and a second clone for every
   contributor who wants to touch both builds -- all recurring cost for a feature explicitly
   marked **EXPERIMENTAL** and not promoted (spec.md status line). **Rejected**: separate
   repository -- cleaner isolation from the Electron build in principle, but the isolation this
   spec actually needs (no Electron file changes, FR-016; no shared runtime state, plan.md
   Technical Context "Project Type") is already achieved by keeping `src-tauri/` and
   `src/tauri-bridge/` as new, additive directories inside the same repository, at a fraction of
   the ongoing cost.

3. **Milestone 1 ships the core loop first; full IPC parity is a tracked checklist, not a
   blocking gate.** Decided by Stuart on issue://780 (cited in spec.md Clarifications). Of the 86
   `IPC_REQUESTS` and 20 `IPC_EVENTS` entries in `src/shared/ipc.ts`, 23 requests and 8 events
   (FR-012/FR-013) was the original milestone-1 target at the time this document was written --
   exactly the surface User Stories 1 through 5 exercise (readiness, repositories, Sessions,
   Conversations, chat, approval answers, the settings subset those stories touch, clipboard, and
   the theme bootstrap). The live, current count of implemented channels is whatever `pnpm
   check:parity`'s generated report says, not a number recorded in this document. Every
   not-yet-ported channel returns the `unsupported` error shape (FR-007) rather than silently
   doing nothing or crashing. **Rejected**: full parity before anything runs -- porting all 106
   channels before the first window ever opens risks months of Rust work with zero runnable
   verification of the one thing this experiment is actually testing (whether a Rust/Tauri backend
   is viable at all for this app's process model); a developer could not run `quickstart.md`'s
   manual verification against any of it until the very end, the opposite of "evidence before
   design" (constitution Principle IV, plan.md Constitution Check).

4. **One generic `refract_request(channel, args)` Tauri command, not one typed `#[tauri::command]`
   per channel; the `unsupported` fallback (FR-007) is this same decision's natural consequence.**
   Rationale: `src/shared/ipc.ts` already fixes the IPC surface as a flat table of string channel
   names (`IPC_REQUESTS`) each paired with its own positional argument shape and `Result<T>` return
   type; `src/preload/index.ts` already funnels every one of those 86 channels through a single
   `request<T>(channel, ...args)` helper around `ipcRenderer.invoke`. Mirroring that exact shape on
   the Rust side with one command, `refract_request(channel: String, args: Vec<serde_json::Value>)
   -> serde_json::Value` (FR-006), lets `src/tauri-bridge/index.ts` be a near-mechanical,
   method-for-method port of `src/preload/index.ts` (FR-009) with a single `invoke('refract_request',
   { channel, args })` call site, and lets the Rust dispatch table (`ipc/mod.rs`) grow one `match`
   arm per newly-ported channel without touching `lib.rs`'s command registration. It is also the
   only shape that makes the `unsupported` fallback a single default `match` arm -- `{ ok: false,
   error: { code: 'unsupported', message: 'Not available in the Rust build yet: <channel>' } }` --
   instead of 63 individually-absent command registrations; "channel not in the table" and
   "channel not yet implemented" collapse into the same code path by construction. **Rejected**:
   typed per-channel Tauri commands (`#[tauri::command] fn repositories_add(path: String) -> ...`)
   -- more idiomatic by Tauri's own conventions and gives compile-time argument type-checking Rust
   does not otherwise get here, but each of the 86 channels has its own distinct positional
   argument shape (`chat.send(sessionId, text, images?)` vs. `readiness.check()` vs.
   `pullRequests.submitReview(repositoryId, number, input)`), so 86 commands means 86 distinct
   generated function signatures, 86 entries in `generate_handler!`, and a capabilities/permissions
   allowlist edit (`capabilities/default.json`) for every single one as it is ported -- all to
   duplicate type safety the TS side already owns via `RefractApi`'s own types, for a build that
   may never be promoted. It also has no single place to put an `unsupported` default: an unported
   channel would need either a hand-written stub command per channel (same cost as porting it) or
   the renderer calling a Tauri command name that does not exist at all, which Tauri surfaces as an
   opaque "command not found" failure, not the typed `IpcError` shape FR-007 requires.

5. **`tokio` as the one async runtime, reused for `omp` child-process I/O, not a second
   executor.** Rationale: `tauri` 2.12.3 already runs its own event loop on a `tokio` runtime
   (`tauri::async_runtime` is `tokio`-backed by default); giving the `omp/process.rs` port of
   `OmpProcess.ts` its own separate runtime (for example a bespoke thread-per-process model, or a
   second embedded executor) would mean two schedulers competing for the same OS threads inside one
   application, with no benefit. `tokio`'s `process` feature covers child-process spawn/stdio
   exactly as `OmpProcess.ts` needs; `io-util` covers the stdio JSONL framing/`rpc_chunk`
   reassembly; `time` backs the per-request timeout (FR-003); `sync` backs the request/response
   correlation channels (`oneshot`/`mpsc` per in-flight request id). **Rejected**: a dedicated
   single-threaded executor per `omp` child process -- isolates one Session's I/O from another's in
   theory, but Node's own single-threaded event loop already proves this workload does not need
   per-process isolation to stay responsive (the Electron build runs every Session's `OmpProcess`
   on the same one Node event loop today), and a second runtime type is one more thing to reason
   about for no measured benefit.

6. **`windows-rs` direct bindings for the kill-on-close Job Object, not a `koffi`-style dynamic
   FFI loader.** The Electron build's `src/main/process/jobObject.ts` uses `koffi` (a Node native
   dynamic-FFI library) to call `CreateJobObjectW`/`SetInformationJobObject`/
   `AssignProcessToJobObject`/`TerminateJobObject`, because Node has no built-in way to call an
   arbitrary Win32 function without either a native addon or a dynamic loader like `koffi`. Rust
   has no such limitation: `windows` (Microsoft's own, actively-maintained crate, matching the
   `Win32_*` feature subset plan.md's Technical Context already pins at `0.62.2`) provides
   statically-typed, compile-time-checked bindings to the exact same four Win32 calls, so
   `process/job_object.rs` calls them directly -- no dynamic symbol loading, no `koffi`-equivalent
   dependency needed at all. **Rejected**: the older, less actively maintained `winapi` crate (an
   earlier, now largely superseded set of raw Win32 bindings) -- `windows-rs` is Microsoft's own
   current crate for this purpose and the one `tauri` itself already depends on transitively, so
   using it avoids pulling in a second, overlapping Win32-bindings crate.

7. **`omp` resolution is a plain PATH lookup, not a port of the multi-root `resolveExecutable.ts`
   pattern spec 015 built for VS Code.** `src/main/process/executables.ts`'s `resolveExecutable`
   (used by spec 015's `fileExplorer.openInVSCode`) searches several documented, fixed install
   roots because VS Code is not reliably on `PATH` on a typical Windows machine. `omp` is
   different: spec.md's own Assumptions and Edge Cases treat "`omp` on PATH" as the sole
   precondition and "`omp` missing from PATH" as the only failure mode considered -- there is no
   multi-root install convention for `omp` to search. The Rust port therefore does a direct PATH
   lookup (equivalent to letting `std::process::Command::new("omp")` resolve it, or an explicit
   `PATH`-splitting existence check first so `readiness.check` can report "not found" without
   actually spawning) rather than building a generalised multi-candidate resolver. The Electron
   build's own defensive `process.env['NoDefaultCurrentDirectoryInExePath'] = '1'` (set once, at
   the very top of `src/main/index.ts`, before anything could spawn) is ported as the equivalent
   environment-variable set before `src-tauri`'s own `main()` spawns anything, for the same reason:
   Windows otherwise resolves a bare executable name against the spawning process's own cwd before
   `PATH`, which this app must never rely on. **Rejected**: porting `resolveExecutable.ts`'s full
   multi-root logic for `omp` too -- solves a problem `omp` does not have (no fixed-install-root
   convention exists for it), and keeping the two resolution strategies textually close to their
   respective Electron originals (one simple PATH lookup here, one multi-root scan if/when
   `fileExplorer.openInVSCode` is ever ported in a later slice) is clearer than forcing both into
   one generalised Rust abstraction neither fully needs.

8. **Native OS window decorations (`decorations: true`) for milestone 1, not a custom caption bar
   matching the Electron build's `titleBarStyle: 'hidden'` + `AppMenuBar.tsx`.** Decided by Stuart
   on issue://780 (spec.md "Carved out, not blocking" and Assumptions). Rationale recorded here:
   Electron's `titleBarOverlay` option (which themes the native minimise/maximise/close buttons to
   match the active theme, `currentTitleBarOverlay()` in `src/main/index.ts`) has no direct Tauri
   v2 equivalent on Windows; reproducing it would mean either drawing a fully custom
   `decorations: false` caption bar with manually-themed system buttons (real, theme-sensitive UI
   work) or chasing a WebView2-specific workaround, neither of which is load-bearing for proving
   out the core chat loop (User Stories 1-5). The known cost is a visible gap where the renderer's
   own custom caption spacer expects hidden decorations (documented as an accepted difference, not
   a defect, in `quickstart.md`). **Rejected**: replicate the Electron chrome immediately --
   correct long-term if this build is ever promoted, but disproportionate effort for an
   experimental milestone whose own success criteria (SC-001 through SC-005) never mention window
   chrome.

9. **Transcript diffing keeps the Electron build's own coalescing design: a 50 ms debounce
   window, an O(n) map keyed by `TranscriptItem.id`, last-write-wins per id.** `omp/diff.rs` is a
   direct port of `src/main/omp/transcriptDiff.ts`'s own algorithm and batching window, not a
   redesign: a fast-streaming turn can produce many raw OMP frames in well under 50 ms, and
   diffing/emitting `transcript:patch` on every single one would multiply the IPC event volume far
   beyond what the Electron build emits for the same turn -- a real behavioural difference a
   side-by-side comparison build must not introduce, even though the JSON payload shape on the wire
   would still technically match FR-008. Keeping the identical window and map-based (not list-scan)
   diffing keeps the emitted `transcript:patch` cadence and granularity identical on both backends,
   so Story 4's streamed-answer verification (`quickstart.md`) is actually comparing like with
   like. **Rejected**: no coalescing (diff and emit per raw frame) -- simpler to implement but
   changes observable behaviour (far more, smaller `transcript:patch` events) relative to the
   Electron build. **Rejected**: a longer debounce window (for example 200 ms) -- would make the
   Rust build's own chat feel laggier than the Electron build's, the opposite of what a fair
   comparison needs.

## Crate and package versions (pinned consistently with plan.md Technical Context)

| Package | Version | Where |
|---|---|---|
| `tauri` | `2.12.3` | `src-tauri/Cargo.toml` (default features only for milestone 1) |
| `tauri-build` | `2.7.2` | `src-tauri/Cargo.toml` (`[build-dependencies]`, used by `src-tauri/build.rs`) |
| `tokio` | `1.53` | `src-tauri/Cargo.toml` (features: `rt-multi-thread`, `process`, `io-util`, `time`, `sync`) |
| `serde` | `1.0.229` | `src-tauri/Cargo.toml` (feature: `derive`) |
| `serde_json` | `1.0.154` | `src-tauri/Cargo.toml` |
| `windows` | `0.62.2` | `src-tauri/Cargo.toml` (`Win32_*` subset for `CreateJobObjectW`/`SetInformationJobObject`/`AssignProcessToJobObject`/`TerminateJobObject`) |
| `@tauri-apps/cli` | `2.12.2` | `package.json` `devDependencies` (exact, `pnpm add -D -E`) |
| `@tauri-apps/api` | `2.12.3` | `package.json` `devDependencies` (exact, `pnpm add -D -E`) |

Rust toolchain: stable MSVC, matching `tauri` 2.12.3's own `rust-version = 1.95` floor. No other
renderer dependency changes (`react`, `react-dom`, `@vitejs/plugin-react`, `@tailwindcss/vite`,
`tailwindcss` stay at the versions already pinned in `package.json`; `tauri.vite.config.ts` reuses
them, FR-016).

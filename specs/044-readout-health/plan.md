# Implementation Plan: Degraded-only agent health readouts

**Spec**: [spec.md](spec.md) | **Issue**: #561

## Approach

Rust samples, the renderer only displays.

1. **Sample** (`src-tauri/src/omp/process/latency.rs`, child of `process.rs` so it reaches `Inner`): `request()` times each tracked command and records the latest sample and a slow streak. `OmpProcess::rpc_latency()` returns it when no older than 60 s.
2. **Decide** (`src-tauri/src/session/health.rs`): a 5 s loop over `SessionManager::live_agents()` applies the enter, clear and minimum-display rules per Session (pure functions `rpc_next` and `memory_next`), reads the working set with `GetProcessMemoryInfo`, and emits only on change plus a 15 s repeat while degraded. Started from `shell::memory::start_monitor` so `lib.rs` (598 lines) does not grow.
3. **Transport**: `session:health` through `EventSink::emit_session_health`; `IPC_EVENTS.SESSION_HEALTH`, `onSessionHealth` in `shared/ipc.ts` and `tauri-bridge`.
4. **Display**: `state/session-health-store.ts`; `features/chat/readout/HealthReadouts.tsx` (`RpcSlowReadout`, `AgentMemoryReadout` over the shared readout classes); mounted in `ComposerStatusLine.tsx` after `LongConversationChip`.

## File-size plan

`omp/process.rs` baseline 1094: the new field, init and record call are offset by condensing two stale header comments. `shared/ipc.ts` at its baseline: the multi-line tokenGuard import collapses to one line to pay for the new lines. `session/readout.rs`, `session/manager.rs` (600) and `lib.rs` are untouched.

## Constitution check

Principle V (Tauri security baseline): no capability, CSP or IPC request added; the Win32 handle is query-only, on a pid we spawned, and always closed. No new tests (prototyping phase).

## Verification

`pnpm typecheck`, `pnpm test`, `check:file-size`, `check:parity`; `pnpm ci:local` and a scratch-exe live check using the debug force hooks (build slot).

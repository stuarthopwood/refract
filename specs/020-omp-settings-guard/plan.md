# Implementation Plan: OMP settings guard

**Branch**: `feat/1184-omp-settings-guard` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/020-omp-settings-guard/spec.md`

## Summary

A new Rust module `src-tauri/src/omp/config_guard.rs` holds the grilled baseline, reads `omp config list --json` once (cached 5 s), compares normalised values, resets drift through `omp config set`, and detects Project overrides in `<worktree>/.omp/config.yml` without editing it. It runs at app start (`lib.rs` setup) and before `OmpProcess::connect` in `session/agent/launch.rs`, under a timeout, and emits one `omp-guard:reset` event when it changed or failed anything. The renderer turns that event into one sonner toast with a Details action that opens a dialog built from the shared `Dialog`.

## Technical Context

**Language/Version**: Rust 2021 (Tauri v2 backend); TypeScript 5 / React 19 (renderer)
**Primary Dependencies**: existing `omp::config` (`run_json`, `set_config`), `ipc::model_roles::set_model_role`, sonner, shared `ui/dialog`
**Storage**: None (baseline is built in; item 5 moves it to settings in #691)
**Testing**: `cargo test` unit tests for the pure compare, normalise and override-scan logic only; no renderer or shared tests (prototyping rule). Live check on a scratch debug build.
**Target Platform**: Windows desktop
**Constraints**: 600-line cap per file; reusable components (ADR 0003); `pnpm check:parity` must pass

## Constitution Check

- Principle I/III (OMP is the engine; lifecycle): the guard only reads and writes OMP's own config through its CLI before spawn; the process flags, cwd and approval mode are untouched.
- Principle V (Tauri security baseline): no new IPC command, one new backend-to-renderer event with a plain data payload. The config key validator is widened to dotted identifiers (`^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$`), which still cannot start with `-`.
- File size (issue #806): the guard lives in its own module with a sibling `config_guard_tests.rs`.

## Decisions (research)

1. **Isolation for verification.** `omp` honours `PI_CODING_AGENT_DIR` (confirmed live: `omp config path` follows it, a fresh dir starts with `advisor.reviewMode` turn and `task.softRequestBudget` 200). The scratch build runs with it set, so the real `~/.omp/agent/config.yml` is never touched.
2. **Dotted keys work with `omp config set`.** Confirmed live (`advisor.reviewMode`, `compaction.idleEnabled`, `task.maxConcurrency`, and the record `compaction.modelThresholds`, which takes a whole JSON object). `modelRoles.advisor` is not a key (`Unknown setting`); it is an entry of `modelRoles`, so the guard resets it with `ipc::model_roles::set_model_role("advisor", ...)`, which owns the read-merge-write lock. `config.rs::validate_config_key` rejected every dotted key, so it is widened (its existing test line for a dotted key is updated to match).
3. **One read.** `omp config list --json` (about 100 KB, under the 1 MiB cap) via `run_json`, held in a static `(Instant, Value)` cache for 5 s. A run that writes invalidates the cache; a run with no drift leaves it.
4. **Serialisation.** One static async mutex wraps cache read, compare and writes, so concurrent launches queue behind one run and the next sees a fresh cache.
5. **Compare.** Normalise to a string: strings trimmed, integers without a fractional part, booleans as `true`/`false`; so `120000`, `120000.0` and `"120000"` are equal. A missing key or a null is drift only when the key exists in the list; a key absent from the list (older OMP) is skipped.
6. **Record keys.** `compaction.modelThresholds` is compared per baseline model; extras survive. The write sends the current record merged with the drifted baseline entries, so nothing else is lost.
7. **Timeout.** At launch the whole guard is wrapped in `tokio::time::timeout(6 s)`; on expiry it is logged and the launch continues. A failure to read is logged, no notice.
8. **Project overrides.** A small indentation-based scanner collects dotted key paths of mappings in `<worktree>/.omp/config.yml` (comments, list items and quoted keys handled; flat dotted keys accepted). A guarded key is overridden when a path equals it or extends it (`modelThresholds` entries, `modelRoles.advisor`). The file is only ever read.
9. **Event.** `omp-guard:reset` with `{ id, resets: [{key, old, new}], failures: [{key, old, new, error}], overrides: [{key, file}] }`. `EventSink::emit_omp_guard_reset` in `events.rs`; `IPC_EVENTS.OMP_GUARD_RESET` and `RefractApi.onOmpGuardReset` in `src/shared/ipc.ts`; bridge `on(...)` in `src/tauri-bridge/index.ts`; `EVENT_LANES` entry in `scripts/check-parity.mjs`.
10. **Start-up race.** The start-up run may finish before the renderer subscribes. It emits and also keeps the notice as pending; the next launch-time run emits its own notice, or re-emits the pending one once. The renderer ignores an `id` it already showed.
11. **Renderer.** `omp-guard-store.ts` (zustand) holds the last shown id and the notice open in Details. `init-stores.ts` subscribes; the handler calls `toast.warning(summary, { id, duration: Infinity, closeButton: true, action: { label: 'Details', onClick } })`. Sonner's toast list is the live region (announced once); the action is a real button. `OmpGuardDetailsDialog.tsx` (shared `Dialog`, mounted in `main.tsx` beside `Toaster`) lists resets as `key: old → new`, failures with reason, overrides with file.
12. **Logging.** Each reset logs at `info`: `omp settings guard: reset <key> (was <old>) -> <new>`.

## Project Structure

```text
specs/020-omp-settings-guard/
├── spec.md
├── plan.md
├── tasks.md
└── checklists/requirements.md

src-tauri/src/omp/
├── config_guard.rs          # new: baseline, compare, reset, override scan, run
├── config_guard_tests.rs    # new: pure-logic unit tests
├── config.rs                # dotted-key validator
└── mod.rs                   # module declaration
src-tauri/src/events.rs      # OMP_GUARD_RESET + emit method
src-tauri/src/lib.rs         # start-up run
src-tauri/src/session/agent/launch.rs   # pre-launch run
src/shared/ipc.ts, src/shared/ompSettingsGuard.ts   # event name, payload type, API
src/tauri-bridge/index.ts, scripts/check-parity.mjs
src/renderer/state/omp-guard-store.ts, init-stores.ts
src/renderer/components/OmpGuardDetailsDialog.tsx, main.tsx
scripts/verify-1184-omp-settings-guard.mjs
```

## Quickstart (validation)

Run the driver: it sets `advisor.reviewMode` to `turn` in a scratch agent dir (`PI_CODING_AGENT_DIR`), launches a scratch debug build with CDP, and asserts the toast, Details and the reset value.

## Complexity Tracking

None.

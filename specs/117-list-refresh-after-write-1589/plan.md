# Implementation Plan: PR and issue lists refresh after a merge, close or Session write

**Branch**: `feat/1589-lane` | **Spec**: [spec.md](./spec.md)

## Summary

A new `github:changed` event `{ repositoryId?, kind, number }` is emitted by the backend (in-app PR merge and close handlers; every live Session write that #1587's detector reports, except comments). The renderer subscribes once in `init-stores.ts` and a small scheduler (`github-changed-refresh.ts`) refreshes the PR list, PR badge count, Issues list and Home quietly, debounced 1 s per list with one trailing refresh while one is in flight. Stores gain a quiet refresh path (no `loading`, no `error`, old rows kept) and hand selection to the next row when the selected row disappears.

## Technical Context

Rust (Tauri 2) backend, React + Zustand renderer. No new dependency. No polling timer. The detector already exists: `src-tauri/src/session/github_writes/mod.rs` (`detect`, `GithubWrite`, `WriteAction`). The live fan-out is `readout_touched.rs::record_writes`; `rebuild_from_history` is a replay and must not emit.

## Constitution Check

No new tests while prototyping; comments are "why" only; files under 600 lines; no new CSS; reuse existing stores and components.

## Source files to change

- `src-tauri/src/events.rs`: `GITHUB_CHANGED` const and `EventSink::emit_github_changed`, plus `emit_github_changed_app` for IPC handlers.
- `src-tauri/src/ipc/pull_requests/handlers.rs` and `extra_handlers.rs`: emit after a successful merge / close.
- `src-tauri/src/session/readout_touched.rs`: emit from `record_writes` (skip `Comment`), repo to Project id via `project_ids_by_repo`.
- `src-tauri/src/session/github_writes/mod.rs`: drop the `#[allow(dead_code)]` markers once `action` is read.
- `src/shared/ipc.ts`, `src/tauri-bridge/index.ts`, `scripts/check-parity.mjs`: event const, `GithubChangedPayload`, `onGithubChanged`.
- `src/renderer/state/github-changed-refresh.ts` (new): scheduler.
- `src/renderer/state/init-stores.ts`: subscribe.
- `pull-requests-store.ts`, `issues-store.ts`, `home-store.ts`: quiet refresh; selection handoff via a shared helper in `selection-handoff.ts` (new).
- `CHANGELOG.md`, `docs/PLAN.md`, verify driver `scripts/verify-tauri-1589.mjs`.

## Design notes

- Scheduler: per list `{ timer, inFlight, dirty }`. Event: set timer if none (1 s). Timer fires: if in flight mark dirty, else run. Run finishes: if dirty, clear and run once more.
- Gate: GitHub status `ready`; a list never loaded (`fetchedAt === null`) is skipped.
- Selection handoff: compare old items to new; if selected missing, pick the item now at the old index, else the last, else null.
- Backend caches: `forget_cache` only clears a stale-on-error cache, not a TTL list cache, so a refetch after a write is fresh.

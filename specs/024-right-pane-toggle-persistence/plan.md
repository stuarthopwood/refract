# Implementation Plan: Right pane toggle, persistence and rail counts

**Spec**: [spec.md](spec.md) | **Issue**: #538

## Technical context

Tauri v2 Rust (`src-tauri/`) plus React renderer (`src/renderer`). Persistence mirrors `sessionListCollapse` (#735) and `pullRequestsListWidthPx` (#930). No new tests (prototyping phase); existing tests must pass.

## Constitution check

- Principle V (Tauri security baseline): one new `settings.setRightPane` IPC channel, argument validated in Rust, no new capability or permission.
- 600-line cap: `App.tsx` must not grow (baseline 727); new keydown and persistence logic go in new small files. `settings.rs` is 579 lines, so the new parse and setter live in a child module `right_pane.rs` like `agent_stopped_bar.rs`.
- Reusable UI components: the badge is a shared component under `components/ui/`; the count uses `DiffStatCounts`.

## Structure

- Renderer: `features/right-pane/IconRail.tsx` (toggle, badges), `PanelCountBadge` (shared), `panel-registry.ts` (git zero to null, count carries files), `PanelLauncher.tsx`, `PanelTabBar.tsx`, new `use-right-pane-shortcut.ts`, new `right-pane-persistence.ts`, `state/right-pane-store.ts` (`toggleCollapsed`, `restore`), `state/init-stores.ts` (restore).
- Shared and bridge: `src/shared/model.ts`, `src/shared/ipc.ts`, `src/tauri-bridge/index.ts`.
- Rust: `store/right_pane.rs` (new), `store/settings.rs`, `ipc/settings.rs`; `scripts/check-parity.mjs`.
- Docs: `docs/design/index.md`, `docs/design/components.md`, `CONTEXT.md`, `docs/PLAN.md`, `KeyboardShortcutsDialog.tsx`.

## Phases

1. Counts: git zero to null, `DiffStatCounts`, rail badges.
2. Toggle: store action, rail button, Ctrl+Shift+B, focus rules.
3. Persistence: Rust and TS plumbing, debounced writer, restore.
4. Docs and PLAN.

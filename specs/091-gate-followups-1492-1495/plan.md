# Plan (spec 091)

Edits are in place in existing files; no new component. Renderer: `ui/button.tsx`, `IconButton.tsx`, `CompactList.tsx`, `GitChangesFileRow.tsx`, `ChatHeader.tsx`, `MessageMenu.tsx`, `PanelTabBar.tsx`, `RepositoryGroup.tsx`, `ShowHiddenToggle.tsx`, `SessionDetailsCard.tsx`, `state/theme-store.ts`. Rust: `omp/advisor_roster.rs` (`openable_target` replaces `is_openable`), `ipc/advisor_roster.rs`.

Verification: typecheck, vitest, `check:*` scripts, `ci:local` under the build slot, then `scripts/verify-tauri-091.mjs` from the committed HEAD.

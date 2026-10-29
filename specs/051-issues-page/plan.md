# Plan 051: Issues page

- Rust: `github/gh_issue_list.rs` (list, view, URL check), `ipc/issues.rs` (`issues.list`, `issues.view`, JoinSet with 4 permits, dedupe, skipped list).
- Contract: `shared/ipc-issues.ts`, `ISSUES_LIST`/`ISSUES_VIEW` in `ipc.ts`, parity map, `tauri-bridge`.
- Renderer shared: `ListDetailSplit`, `FilterTabs`, `ScreenHeader` window-controls prop.
- Renderer feature: `state/issues-store.ts`, `features/issues/*`, `MainView 'issues'`, nav group in `SessionList.tsx`.
- The list column width reuses the Pull requests remembered width.

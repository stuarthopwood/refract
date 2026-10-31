# Plan: spec 093

- Renderer: `ProjectListPane.tsx` (refresh, full stop, focus ring), `PullRequestRow.tsx` (no check segment), `pull-requests-store.ts`, `init-stores.ts`, `ViewsNavGroup.tsx`, `PullRequestList.tsx` (cross-Project count), `ReportIssueDialog.tsx`, `IssuesView.tsx`.
- Rust: `list_across.rs` (`limit + 1` exact `has_more`, no `view_check_state` fan-out).
- Shared: `ipc-pull-requests.ts` (`PullRequestAcrossItem` omits `checkState`).
- Live check: `scripts/verify-tauri-093.mjs`.

# Plan 057: Cross-Project Pull requests view

- Rust: `src-tauri/src/ipc/pull_requests/extra_handlers/list_across.rs` registers `pullRequests.listAcross` (resolve Projects, dedupe by owner/repo, rate-limit check, one batched `gh search prs`, map rows to Projects by `repository.nameWithOwner`, check states via the cached `view_check_state`). `mod.rs` is at the 600-line cap and does not grow. Search helpers go in a new small file beside `gh_pull_requests.rs` if it would pass the cap.
- Contract: new `src/shared/ipc-pull-requests.ts`; one `PULL_REQUESTS_LIST_ACROSS` constant in `ipc.ts` (+1 line, cap 902); `pullRequests: PullRequestsAcrossApi & {`; `tauri-bridge` method; parity entry.
- Renderer shared: `components/ProjectListPane.tsx` extracted from `IssueList`; `IssueList` refactored onto it.
- Renderer feature: `PullRequestList` and `PullRequestsView` rewritten onto the pane and `ListDetailSplit`; `PullRequestRow` shows the Project; `state/pull-requests-store.ts` becomes a flat cross-Project store and keeps the active-count slice; `GitHubNavGroup` and `Readouts` call sites updated.
- Verify: `scripts/verify-tauri-874.mjs` with a fake gh (search, rate_limit, pr view) and a call log.
- Docs: `docs/PLAN.md` row, `docs/design/components.md`.

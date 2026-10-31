# Plan: spec 094

- Rust: new `src-tauri/src/session/readout_pr.rs` (GraphQL lookup via `gh_graphql`, parsing, JSON shape). `readout.rs` swaps its `PullRequestState` for it. `github/pr_lookup.rs` is deleted (no other caller). `SessionReadout.pull_request` and the `pull-request` kind leave `store/settings*.rs` and `ipc/settings.rs`; the loader ignores the stale key.
- Shared: `shared/model.ts` gains `SessionPullRequest`, drops the readout kind.
- Renderer state: `state/pinned-panels-store.ts` holds the pinned PR and issue (per window) and the live PR state published by `PullRequestDetail`.
- Panels: `panel-registry.ts` adds pinned descriptors (`pull-request`, `issue`); `RightPaneShell.tsx` renders `PinnedPullRequestPanel` and `PinnedIssuePanel`. `right-pane-persistence.ts` keeps pinned ids out of the saved row.
- Header: `features/chat/header/` has `PullRequestBadge`, `LinkedIssueBadge`, `HeaderPrControls`. `ChatHeader.tsx` mounts them before `ConversationSwitcher`. Narrow layout uses a container query on the header.
- Theme: state colour tokens plus `theme-contrast-pairs.mjs` pairs in every theme.
- Live check: `scripts/verify-tauri-094.mjs` with a fake `gh` (Rust, as in 093) and the recorded-frame fake `omp`.

# Tasks 057

1. Contract: `ipc-pull-requests.ts`, `ipc.ts` constant, bridge, parity.
2. Rust: `list_across.rs` handler, rate-limit check, batched search, dedupe, skipped, register in `extra_handlers.rs`.
3. Shared `ProjectListPane`; refactor `IssueList` onto it.
4. Flat PR store with the active-count slice kept; update `GitHubNavGroup`, `Readouts`, `view-store`.
5. Rewrite `PullRequestList`, `PullRequestsView`, `PullRequestRow`.
6. `docs/PLAN.md`, `docs/design/components.md`.
7. `verify-tauri-874.mjs` and fake gh.
8. Light checks: typecheck, vitest, `check:file-size`, `check:parity`.
9. Five-reviewer gate, `ci:local`, live check with screenshots, PR (Closes #874).

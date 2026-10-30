# Plan 059: Home view

- Rust: new `src-tauri/src/ipc/home.rs` (`home.lastMessages`, `home.closedBranches`) registered from `ipc/mod.rs`; `session/last_user_message.rs` (bounded tail reader over `contained_history_file`); `github/gh_closed_branches.rs` (`gh pr list --state closed`).
- Contract: new `src/shared/ipc-home.ts`; `ipc.ts` gains no lines; `tauri-bridge` methods; `check-parity.mjs` entries.
- Shared components: `ScreenHeader` back button optional; `AddProjectMenu` `toolbar` variant; new `components/ScreenSection.tsx` and `components/ListCardButton.tsx`.
- Feature `features/home/`: `HomeView` and one component per section.
- State: `home-store.ts` (cached sections, one Refresh); `view-store` `home`/`openHome`; `split-store` `targetSession` also leaves Home; `App.tsx` swaps `EmptyChatState` for Home (net zero lines).
- Nav: `GitHubNavGroup` Home item with needs-you count.
- Verify: `scripts/verify-tauri-869.mjs`, fake gh, fake omp, call-log proof.
- Docs: `docs/PLAN.md`, `CONTEXT.md`, `docs/design/components.md`.

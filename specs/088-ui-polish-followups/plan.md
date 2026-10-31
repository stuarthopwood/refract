# Plan: spec 088

Renderer-only change in `src/renderer` plus docs and one live-check script. No Rust, IPC, theme token or `globals.css` change.

## Approach

1. Shared primitives: `ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx` (invalid ring, popper default, formatting), `ui/button.tsx` (drop `destructive-outline`), `ui/copy-button.tsx` (`aria-describedby`).
2. Right pane: delete `WindowControlsSpacerRow.tsx`; `RightPaneShell.tsx` and `PanelTabBar.tsx` drop it.
3. Detail headers: new `components/OpenOnGitHubButton.tsx`; new `features/pull-requests/PullRequestActions.tsx` (New session, Review, Merge, draft reason); `PullRequestDetail.tsx` and `IssueDetail.tsx` use them.
4. Small call sites: `RequestCard.tsx`, `ManageSessionsToolbar.tsx`, `PerModelThresholdTable.tsx`, `MultiSelectChecklist.tsx`, `App.tsx` comment, `SelectContent position="popper"` overrides.
5. Docs: `accessibility.md`, `components.md`, `docs/PLAN.md` row.
6. Live check: `scripts/verify-tauri-088.mjs`, modelled on `verify-tauri-087.mjs`.

## Risks

- Popper default changes every select: the live check opens one and compares its top with the trigger bottom.
- The PR header no longer wraps: check the narrowest pane for the title and actions.
- File-size and comment-density baselines: `PullRequestDetail.tsx` shrinks, new files stay small.

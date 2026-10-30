# Plan: spec 066

Renderer only.

1. `features/issues/IssueDetail.tsx`: import `CopyButton`; replace the Copy link button, the `copied` state, `copyLink` and the status `<p>`.
2. `features/pull-requests/PullRequestDetail.tsx`: `const actionsHidden = detail.state === 'merged' || detail.state === 'closed'`; wrap the three buttons; drop the header `border-b border-border`; simplify the New session disabled title (only draft can still be disabled).
3. `CommentBox.tsx` and `ChecksSection.tsx`: replace the `border-t ... p-4` class with `px-4 pt-2 pb-4` (one class each).
4. `components/ProjectListPane.tsx`: export `FILTER_PICKER_CLASS`; use it on the Project picker. `IssueList.tsx` uses it on the Label trigger.
5. Docs: `docs/PLAN.md` rows, `docs/design/accessibility.md` region-divider exception, `docs/design/components.md` if it names these widths or lines.
6. Update `scripts/verify-1121-pr-polish.mjs` and `scripts/verify-tauri-568.mjs` only if they expect Merge, Review or New session on a merged pull request.

Verification: `pnpm ci:local`, `pnpm check:ui-text`, live check with screenshots.

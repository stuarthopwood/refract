# Spec 102: Issues and Pull requests list follow-ups (issue #1508)

Status: in progress. Source: follow-ups from the #1347 and #1361 gates, decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1508. Closes #1508.

## Requirements

- FR-1 The sidebar Pull requests badge uses `HOME_PROJECTS_MAX` from `shared/ipc-home.ts` instead of a private copy of the Project limit.
- FR-2 The badge shows `30+` when the count is partial (over 40 Projects, or any Project skipped) and its aria-label reads "Pull requests, N open pull requests across your Projects".
- FR-3 On default filters (tab all, state open, no Project chosen, empty query, one page, at most 40 Projects) the list search also feeds the badge, so opening the view and Refresh issue one search, and the startup badge fetch is deduped per Project set.
- FR-4 The "Showing the first 200" note shows at exactly 200 results with no Show more button.
- FR-5 After Show more, focus lands on the first newly loaded row, including at the cap; with no new row it falls back to the cap note or the list.
- FR-6 A skipped Project name echoed in the list is capped at 80 characters with an ellipsis.
- FR-7 Creating an issue while a filter would hide it clears the filters, selects the new issue and focuses its row when the dialog closes; otherwise it refreshes with the applied (not typed) query.
- FR-8 `verify-tauri-504.mjs` and `verify-1121-pr-polish.mjs` wait for "Add project", not the old "Add repository".
- FR-9 `scripts/verify-tauri-102.mjs` supersedes `verify-tauri-093.mjs` (kept as history, not run).

## Already handled or skipped

- Real `gh search prs --limit 201`: accepted and returned 201 results (read-only search); maximum is 1000, so no clamp is needed.
- Rust raw-id echo of a skipped Project (`list_across.rs`): left as is; the 80-character cap is renderer-only.
- Per-row check segment in `PullRequestRow`: skipped, owned by lane #1511; the live check asserts only that no row shows one.

## Out of scope

New automated tests (prototyping phase). ChatHeader, `chat/header/*`, HeaderPrControls, LinkedIssueControls, PullRequestRow, StatePill, InlineStatus, pinned PR and issue panels, `toggle-right-pane.ts`, src-tauri gh PR-lookup code (owned by lane #1511).

## Acceptance

`pnpm ci:local` green and `verify-tauri-102.mjs` reports PASS from the pushed HEAD.

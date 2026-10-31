# Spec 093: Issues page and cross-Project Pull requests follow-ups (#1347, #1361)

Converges spec 051 (Issues page) and spec 057 (PR view across Projects) with the decisions on #1347 and #1361 ("Decided (Skippy, delegated by Stuart 2026-10-31)").

## Requirements

### #1347

- FR-1 Issues use the shared `ProjectListPane`. Already on main (`IssueList.tsx`, #1357).
- FR-2 The Issues fetch allows 200 Projects. Already on main (`src-tauri/src/ipc/issues.rs` `MAX_PROJECTS`).
- FR-3 The New issue dialog opened from the Issues page is titled "New issue"; the Report an issue entry keeps its title (`ReportIssueDialog` `title` prop).
- FR-4 After a successful create, the Issues list refreshes and selects the new issue (`ReportIssueDialog` `onCreated`, `IssuesView`).
- Out of scope: Start a Session from an issue (#1310), the comments timeline, the Sort control.

### #1361

- FR-5 The sidebar Pull requests badge counts the same cross-Project set the view shows by default (one `listAcross` call over all Projects, `pull-requests-store.ts`).
- FR-6 A deep-linked pull request keeps the Project filter visible. Already on main (`ProjectListPane` Filters panel).
- FR-7 The cap note shows only when the fetch returned more than the cap (`list_across.rs` fetches `limit + 1`).
- FR-8 Row detail loads for the selected row only; the list issues no per-row `gh pr view` (check state leaves the row).
- FR-9 The skipped-Projects disclosure uses `outline-solid` for its focus ring.
- FR-10 Refresh clears `askedForMore`.
- FR-11 The shared `addRepository` verify helper matches the post-#867 dialog. Already on main; older PR-view scripts that still look for "Add repository" are listed in the follow-up issue.
- FR-12 The failed-Show-more alert reads "... Try Show more again." with a full stop before the sentence.

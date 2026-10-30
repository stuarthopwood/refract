# Spec 057: Cross-Project Pull requests view (#874)

The Pull requests view follows the Issues view (spec 051): it lists pull requests from every selected Project on one shared list shell.

## Clarifications

Decided (Skippy, delegated by Stuart 2026-10-30); also recorded on #874. Binding grill decision: Stuart, #504 grill Q5, 2026-10-15.

- Step 0: nothing for #874 had shipped on origin/main 67fe5748. The view still had a single-Project Select and per-repository state.
- One shared component, `ProjectListPane` in `src/renderer/components/`, owns FilterTabs, the single Filters toggle and panel frame, Refresh, results summary, "N projects skipped" disclosure, gh error alert, the empty state with "Clear filters", and optional "Show more". `IssueList` and `PullRequestList` become thin users with slots (extra filters, rows). Reason: ADR 0003 and the #1347 item.
- Tabs: All, Authored by me, Assigned to me, Involves me, Review requested (#499 grill). UI ruling: confirmed.
- Header: the shared `ScreenHeader` ("Pull requests", Back to chat), as `IssuesView`. The Project Select and its width-measuring code go. UI ruling: confirmed.
- State labels: Open, Closed, Any state (same as Issues). UI ruling.
- Each row shows the Project name; owner/repo only in a `data-*` attribute and the detail pane. No extra `aria-label`; the visible text names the row. Rows are keyed `repositoryId#number`. UI ruling.
- Paging: 50 rows, "Show more pull requests" raises the limit 50 to 200. At 200 the button becomes "Showing the first 200, narrow with filters". UI ruling.
- Backend: new `pullRequests.listAcross`. One batched `gh search prs` with one `--repo` per distinct owner/repo. Two Projects on one GitHub repository list a PR once (first Project wins). Before searching it reads `gh api rate_limit`; when the search budget is exhausted it returns `rate-limited`.
- The single-Project `pullRequests.list` stays: the sidebar active count uses it.
- Opening a PR from Home or a readout sets the Project filter to that Project, tab All, state Any, and selects the PR.
- All Review actions and confirmations in `PullRequestDetail` are unchanged.
- Project wording everywhere (#1355).

## Functional requirements

- FR-001: The Pull requests view lists PRs from every selected Project, all selected by default, newest update first.
- FR-002: Filters: tab, State, Project multi-select, search (applies on Enter).
- FR-003: A repository shared by two Projects yields each PR once.
- FR-004: Projects with no GitHub remote or a gh failure appear in a collapsed "N projects skipped" disclosure.
- FR-005: Issues and Pull requests share one Filters toggle and one empty state component.
- FR-006: Inputs reaching `gh` are validated and passed as argv after `--`; nothing reaches a shell.
- FR-007: The search rate limit is checked before each cross-Project search.
- FR-008: The detail pane, Review actions and confirmations are unchanged.

## Deferred

Batched GraphQL for check states, a Sort select, Home aggregation (#869).

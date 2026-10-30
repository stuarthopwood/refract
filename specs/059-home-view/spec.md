# Spec 059: Home view (#869)

Home answers "what needs me, and where was I?": Sessions waiting on you, recent Sessions with a derived summary, your open pull requests and issues across the added Projects, and quick actions and tidy-up.

## Clarifications

Grill outcomes are Stuart's (2026-10-15, grill-with-docs, recorded on #869). Items marked Skippy are decided by the director on Stuart's behalf (2026-10-30) and binding.

- Step 0 (origin/main 9e117c7c): reused as is. `pullRequests.listAcross` (#874, `gh_pr_search_across.rs`, `list_across.rs`, `ipc-pull-requests.ts`) for My pull requests; `issues.list` (#504, `ipc/issues.rs`, `gh_issue_list.rs`, `ipc-issues.ts`) for My issues, tabs `assigned` and `authored`, state `open`; the Add project menu and Clone flow (#867); the Pause mode status (#477); `sessions.archive`, `sessions.deleteCheck`; the shared `ScreenHeader`, `FilterTabs`, `Empty`, `RelativeTime`, `StatusDot`, `RefreshButton`. Nothing in Home runs an unscoped `gh search`: both calls take the ids of added Projects, and Rust skips those with no GitHub remote (reported as skipped in the section's error line).
- **Term:** Home is a view, not a pane. Label "Home".
- **Launch:** saved panes and Split are restored. Home shows when no Chat pane is open (including after closing the last one) and when the Home menu item is clicked. It replaces the "Select a Session or create one." empty state.
- **Nav:** a Home item directly above Pull requests in the GitHub nav group (HouseIcon, `aria-current`). Badge: needs-you count only, in the accessible name ("Home, 2 need you"), hidden at 0.
- **Needs you:** non-archived Sessions with status `needs-you`, newest first; shows what is waiting (approval or question) when the pending request is known; the card opens the Session. Empty: one line "Nothing is waiting on you".
- **Recent Sessions:** the 8 most recently active non-archived Sessions of any status, excluding those in Needs you. Card: name, project, branch, status dot plus text, relative time, +N -M changes, pull request chip, todo n of m, last message line. "Show all" opens Manage sessions. Derived only, no model call.
- **Last message line (Skippy):** the last user prompt, one line, from a new Rust channel `home.lastMessages` that reads the tail of each card's current Conversation file (256 KiB window doubling to 2 MiB, at most 8 Sessions, text truncated to 160 characters), reusing the `contained_history_file` containment check. The existing preview reader scans only the head (#862), so a tail variant is needed.
- **My pull requests:** tabs Authored by me and Review requested from me through `pullRequests.listAcross` (state open, first 10 shown); the account is whichever `gh` account owns the Project's host, exactly as #874. Click opens the PR in the Pull requests view.
- **My issues:** tabs Assigned to me (default) and Authored by me, open only, 10 per tab, through `issues.list`. Click opens the issue in the Issues page (#504). "See all" opens the Issues page.
- **Quick actions:** New session (Project picker menu; quick create on the Project's default branch), Add project and Clone from GitHub (the shared Add project menu, new `toolbar` variant).
- **Tidy-up:** Sessions whose pull request is merged or closed, from a new Rust channel `home.closedBranches` (one `gh pr list --state closed --repo <slug>` per distinct owner/repo, core API, matched to Session branches in the renderer). Each row shows Uncommitted changes / Unpushed commits when `sessions.deleteCheck` reports them. **Archive** is one click, no confirm, keeps the Worktree (`sessions.archive`). **Archive all clean** archives only Sessions with no uncommitted changes and no unpushed commits. Home never deletes.
- **Refresh:** GitHub sections and Tidy-up fetch once when Home first opens, are cached for the app life with their fetched time, and refetch only on the explicit Refresh button; no polling. Each shows a one-line error (not signed in, rate limited, Projects skipped for no GitHub remote) instead of a blank.
- **Accessibility:** Home is a `region` landmark named Home with an `h1`; focus lands on the heading when Home opens by click; each section is a `section` with an `h2` and a `ul`, count in its accessible name; cards are single buttons with full accessible names; status uses an icon shape plus text; Refresh results are announced in a polite live region.
- **Untrusted text:** PR and issue titles, labels, branch names and message lines render as text only; no remote images.
- **Split (Skippy):** one PR. My pull requests and My issues reuse existing channels and add roughly 300 lines, so splitting would double the gate for little review benefit.

## Functional requirements

- FR-001: `MainView` gains `'home'`; Home shows for view `home`, and for view `chat` with no pane open.
- FR-002: The Home nav item sits directly above Pull requests; its accessible name carries the needs-you count.
- FR-003: Needs you lists `needs-you` Sessions newest first and is never repeated in Recent Sessions.
- FR-004: Recent Sessions shows at most 8 cards with derived fields only.
- FR-005: `home.lastMessages(sessionIds)` accepts at most 8 ids, reads only each contained current Conversation file, and returns one line or null per id.
- FR-006: My pull requests and My issues are scoped to Projects with a GitHub remote.
- FR-007: `home.closedBranches(repositoryIds)` accepts at most 40 ids, passes the slug as argv (no shell), and returns closed or merged pull requests by head branch.
- FR-008: Tidy-up Archive keeps the Worktree and needs no confirmation; Archive all clean archives only clean Sessions.
- FR-009: Refresh refetches all GitHub sections and Tidy-up; failures show as a one-line error under the section heading.
- FR-010: `ipc.ts` gains no lines: the contract is in `src/shared/ipc-home.ts`.

## Deferred

Model-written recaps (#702); PR and issue counts on the badge.

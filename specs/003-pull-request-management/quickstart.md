# Quickstart: verifying pull request management

Refract is a prototype with no automated tests. Each check below is a manual run of the app. Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in [data-model.md](data-model.md) and [contracts/ipc.md](contracts/ipc.md).

## Prerequisites

- Everything in spec 001's quickstart.md Prerequisites (Windows 11, Git for Windows, Node 24+, `pnpm`, `omp` 18.4.x or 18.5.x signed in).
- The GitHub CLI (`gh`) on `PATH`, signed in (`gh auth status` shows an active account) (FR-027).
- A repository already added to Refract whose `origin` remote points at a real GitHub repository, with:
  - at least one open pull request with an unresolved review thread, a label, and a reviewer or assignee;
  - at least one pull request assigned to, authored by, or requesting review from the signed-in account, for the non-Open tabs;
  - at least one open, mergeable pull request safe to merge during this check (a scratch repository's own throwaway branch is recommended, not a shared project);
  - at least one draft, closed, or merged pull request;
  - ideally, one pull request with a diff large enough to trigger GitHub's own truncation, to check FR-011 (not required if unavailable — note the gap in the report instead).

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: browse pull requests (FR-001 to FR-006, FR-029, FR-030)**

1. Select the repository's "Pull requests" entry. Expect: the main area swaps to a pull request list, the Open tab is active by default, and a "last updated" indicator is shown.
2. Switch to each other tab (Authored by me, Assigned to me, Involves me, Review requested). Expect: the list changes to match each tab, and a pull request that doesn't match the new tab disappears from view.
3. Use the narrowing filter to match a known title or label. Expect: only matching rows remain.
4. Click refresh. Expect: the "last updated" indicator changes to the current time, and the rows reflect GitHub's current state.
5. Look at one row. Expect: title, number, check status (by icon or text, not colour alone), repository, time since last updated, and author are all visible.
6. Using only the keyboard: Tab to the filter tabs, move between them, Tab to a row, and open it. Expect: a visible focus indicator at every step.

**Story 2: read a pull request (FR-007 to FR-011)**

1. Open the pull request with a reviewer, labels, a description, a review thread, and changed files. Expect: the Overview tab shows title, number, state, base branch, head branch, reviewers, assignees, labels, and description.
2. Still on Overview. Expect: the timeline shows commits, comments, reviews, and review threads in order; if this pull request has an automated-reviewer (Copilot) review, its findings show with a severity.
3. Switch to the Changes tab. Expect: changed files, total additions/deletions, and each file's diff.
4. If a pull request has checks still running, watch its check status. Expect: it updates to passed or failed once GitHub finishes, without a manual refresh (allow up to the polling interval recorded in research.md).
5. If a large-diff pull request is available, open its Changes tab. Expect: as much of the diff as can be shown, a stated truncation, and an "Open in browser" action that opens the real pull request's Files tab in the system browser.

**Story 3: take review actions (FR-012 to FR-021, FR-028)**

1. On an open pull request, add a comment. Expect: it appears in the timeline; repeat with an action expected to fail (for example, no network) and confirm the exact failure is shown instead of a silent no-op.
2. Reply to the open review thread. Expect: the reply appears under that thread.
3. Resolve the thread, then unresolve it. Expect: it shows resolved, then unresolved again.
4. Submit a review marked Approve. Expect: a confirmation names the pull request and "approve" before anything happens; confirming submits the review.
5. On the mergeable pull request prepared for this check, choose to merge it. Expect: a confirmation names the pull request and the chosen merge method; confirming merges it and reports the result.
6. Open the prepared draft, closed, or merged pull request. Expect: review and merge actions are disabled, each with its reason shown.
7. If a pull request with merge conflicts or a failing required check is available, attempt to merge it. Expect: the merge is refused with the reason shown.
8. With a pull request open in the detail view, change it on GitHub from another machine or the GitHub website (for example, add a label), then attempt an action in Refract before refreshing. Expect: the view says it is out of date before the action proceeds.

**Story 4: start a session from a pull request (FR-022)**

1. From an open pull request's detail view, select "New session". Expect: a new Session is created whose worktree has that pull request's head branch checked out, following spec 001's Session creation rules, and it is selected and open.
2. If a pull request whose head branch cannot be checked out is available (for example, its source branch was deleted), select "New session" on it. Expect: an actionable reason is shown and no half-created Session appears in the list.

## Untrusted-content and security checks (FR-023 to FR-027, constitution V)

1. Open a pull request whose description or a comment contains a Markdown image or an HTML tag. Expect: no raw HTML renders, the image shows as its alt text with a link instead of loading, and no network request for the image reaches the app window (check DevTools' Network panel while on this pull request). Separately, look at the author, reviewers, and assignees anywhere they're shown (rows, Overview header, timeline): expect a name or initials only, never an avatar image or an avatar network request.
2. Click a link inside a pull request's description or a comment. Expect: it opens in the system browser, never inside the Refract window.
3. Confirm no GitHub token appears in `registry.json`, `settings.json`, or any new file Refract writes.

## Checkpoint sequence

Run Story 1, then Story 2, then Story 3, then Story 4, then the untrusted-content checks, each on the built app (`pnpm build` then launch `out/`) in an isolated instance, per the repo's convention (spec 001 FINDINGS, `docs/spike/`). `pnpm typecheck` and `pnpm build` must both pass with no warnings before any of this is run.

## First-task gates

These `gh` CLI and GitHub API facts are unverified and are checked before the work that depends on them (research.md "Summary of UNVERIFIED items"):

- The exact `--json` field names `gh pr list`/`gh search prs` return, and the search qualifiers that reproduce the four non-Open filter tabs.
- The exact `--json` field names `gh pr view` returns for Overview, mergeability, changed files, and the large-diff/truncation signal.
- The GraphQL `reviewThreads`/`timelineItems` shapes, the resolve/unresolve/reply mutations, and how an automated reviewer's findings and severity actually appear.
- `gh api rate_limit`'s fields and the exact signal `gh` gives on a rate-limited response.
- Fetching a pull request's head branch (including from a fork) into a new, isolated worktree without leaving a half-created Session on failure.

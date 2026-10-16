# Feature Specification: Pull request management

**Feature Branch**: `003-pull-request-management` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: "Add Pull request management modelled on the GitHub Copilot desktop app screenshot
(`Screenshot 2026-10-02 085157.png`): a left-nav 'Pull requests' entry; a middle list with a
repository dropdown, filter tabs (Open, Authored by me, Assigned to me, Involves me, Review
requested), a filter icon, and rows showing state, title, number, check status, repository, age,
and author; and a right detail pane with Overview and Changes tabs, reviewers/assignees/labels
chips, a description, a timeline (commits, an automated-reviewer overview with findings by
severity, review threads with diff hunks and comments, a reply box and a resolve button), and
header actions for New session, Review, and merge/checks status."

## Clarifications

### Session 2026-10-02

- Q: What belongs in v1 of pull request management? -> A: Browse + review actions - browse pull
  requests, view them, and take review actions: comment, resolve a thread, approve or request
  changes, and merge.
- Q: Where does pull request management live in the app? -> A: A left-nav view like the
  screenshot - a "Pull requests" entry that swaps the main area to a pull request list plus
  detail, scoped to the selected repository.
- Q: Should a pull request offer "New session" (User Story 4)? -> A: Keep it.

### Session 2026-10-16

- Q: Does the pull request detail view need to surface a reviewer-consensus summary? -> A: Yes -
  a new FR-031: the Overview tab shows counts of approved / changes-requested / commented above
  the pull request body, whenever at least one review exists. Placement is the top of the
  Overview tab; counts are derived client-side from the existing timeline review verdicts, using
  only each reviewer's most recent verdict; no new IPC field is added.
- Q: Should the pull request state badge change shape for this restyle? -> A: Yes - a solid-fill
  `StatePill` replaces the outline `Badge` used today, adding a new `--pr-merged` purple token;
  Open, Draft and Closed alias the existing severity/state tokens rather than adding new colours
  for them.
- Q: Is the `isDraft` search-field data bug (drafts showing as Open on the four relation tabs)
  in scope? -> A: Yes - `SEARCH_FIELDS` is fixed to request `isDraft` so those four searches
  correctly report Draft instead of silently Open.
- Q: Should the list row's and detail view's two existing Refresh controls stay separate? -> A:
  No - both call sites are unified behind one shared `RefreshButton` component.
- Q: Should the Overview/Changes tab pair adopt an underline style, and does that affect the
  five filter tabs? -> A: The Overview/Changes pair gets a local underline style scoped to this
  view only; the five filter tabs keep their existing pill style unchanged (an app-wide tab
  convention is deferred to issue #499).
- Q: Is the `PullRequestsView.tsx` header's `border-b` divider still needed? -> A: No - it is
  removed, closing out a previously-flagged inconsistency with the rest of the app's panel
  headers.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse pull requests (Priority: P1)

A developer opens the "Pull requests" entry in the left nav for a repository already added to
Refract. The main area switches to a list of that repository's pull requests, starting on the
"Open" tab. The developer switches between tabs (Open, Authored by me, Assigned to me, Involves
me, Review requested) to find the ones that matter to them, and can ask the list to refresh.

**Why this priority**: Without a list there is nothing to read or act on. This is the entry point
for every other story.

**Independent Test**: With a repository that has a GitHub remote and at least one open pull
request, select "Pull requests" in the left nav, confirm the Open tab is shown with that pull
request listed, switch tabs, and refresh the list.

**Acceptance Scenarios**:

1. **Given** a repository with a GitHub remote is selected and has open pull requests, **When**
   the developer selects "Pull requests" in the left nav, **Then** the list shows every open pull
   request for that repository, the "Open" tab is active by default, and the view shows when the
   list was last updated.
2. **Given** the pull request list is open, **When** the developer selects a different filter tab
   (for example "Review requested"), **Then** the list shows only pull requests matching that
   tab, and pull requests that no longer match are removed from view.
3. **Given** the pull request list is open, **When** the developer asks it to refresh, **Then**
   the rows and the "last updated" indicator both reflect the current state of the pull requests
   on GitHub.
4. **Given** a pull request row, **When** the developer looks at it, **Then** it shows the title,
   the number, the check status, the repository, the time since it was last updated, and the
   author, with the check status conveyed by an icon or text and never by color alone.
5. **Given** the pull request list and its filter tabs are showing, **When** the developer uses
   only the keyboard, **Then** they can move focus to each tab and each row, see a visible focus
   indicator throughout, and open a row's detail.

---

### User Story 2 - Read a pull request (Priority: P1)

The developer selects a pull request from the list and reads its Overview: title, number, state,
base and head branch, reviewers, assignees, labels, description, and a timeline of commits,
comments, reviews, and review threads, including any automated-reviewer findings and their
severity. They switch to Changes to see which files changed and by how much, and check whether
the pull request's checks are running, have passed, or have failed.

**Why this priority**: Browsing without being able to read a pull request's content and status is
not useful on its own; this is what makes User Story 1's list worth opening.

**Independent Test**: Open a pull request that has reviewers, labels, a description, at least one
review thread, and changed files; confirm the Overview and Changes tabs both show their content
and the check status is visible.

**Acceptance Scenarios**:

1. **Given** an open pull request, **When** the developer selects it from the list, **Then** the
   Overview tab shows its title, number, state, base branch, head branch, reviewers, assignees,
   labels, and description.
2. **Given** the same pull request, **When** the developer reads the Overview, **Then** the
   timeline shows its commits, comments, reviews, and review threads in order, and any
   automated-reviewer findings appear with their severity.
3. **Given** a pull request with changed files, **When** the developer selects the Changes tab,
   **Then** it shows the changed files, the total additions and deletions, and, for each file, its
   diff.
4. **Given** a pull request with checks still running, **When** the developer views it, **Then**
   the current check status is shown, and it updates to passed or failed once the checks finish.
5. **Given** a pull request whose diff is too large to show in full, **When** the developer opens
   Changes, **Then** the view shows as much as it can, states that the diff was too large to show
   in full, and offers opening it in the browser.

---

### User Story 3 - Take review actions (Priority: P2)

The developer acts on a pull request they are reading: they add a comment, reply to a review
thread, resolve or unresolve a thread, submit a review (comment, approve, or request changes), or
merge it using one of the methods the repository allows. Approving, requesting changes, and
merging each ask the developer to confirm first, naming the pull request and what the action will
do.

**Why this priority**: Reading is useful on its own (User Story 2); acting is the next increment
of value and depends on being able to read a pull request first.

**Independent Test**: On an open, mergeable pull request with an unresolved review thread, add a
comment, reply to the thread, resolve it, submit an approving review, and merge it, confirming
each action's result; separately, confirm a draft pull request and one with failing checks refuse
the corresponding actions with a reason.

**Acceptance Scenarios**:

1. **Given** an open pull request, **When** the developer adds a comment, **Then** the comment
   appears in the timeline, and the app reports success or the exact failure.
2. **Given** an open review thread, **When** the developer replies to it, **Then** the reply
   appears under that thread.
3. **Given** an unresolved review thread, **When** the developer resolves it, **Then** the thread
   shows as resolved, and unresolving it afterwards returns it to unresolved.
4. **Given** an open pull request, **When** the developer submits a review marked "Approve" or
   "Request changes", **Then** the app shows a confirmation naming the pull request and what the
   action will do, and only submits the review once the developer confirms.
5. **Given** a mergeable open pull request, **When** the developer chooses to merge it and
   confirms, **Then** the app shows a confirmation naming the pull request and the chosen merge
   method, then merges it and reports the result.
6. **Given** a draft, closed, or merged pull request, **When** the developer looks at the
   available actions, **Then** merge and review actions are disabled, each with the reason shown.
7. **Given** a pull request with merge conflicts or failing required checks, **When** the
   developer attempts to merge it, **Then** the merge is refused and the reason is shown.
8. **Given** a pull request open in the detail view, **When** it changes on GitHub before the
   developer takes an action, **Then** the view says it is out of date before that action
   proceeds.

---

### User Story 4 - Start a session from a pull request (Priority: P3)

From a pull request's detail view, the developer selects "New session" to start a Refract Session
whose worktree already has that pull request's head branch checked out, so they can keep working
on it using the existing Session workflow.

**Why this priority**: It connects pull request management to the rest of Refract, but browsing,
reading, and reviewing (User Stories 1-3) deliver value without it.

**Independent Test**: From an open pull request's detail view, select "New session" and confirm a
Session is created with its worktree on that pull request's head branch, following the Session
creation rules from spec 001.

**Acceptance Scenarios**:

1. **Given** an open pull request, **When** the developer selects "New session", **Then** a new
   Session is created whose worktree has that pull request's head branch checked out, following
   the existing Session creation rules.
2. **Given** a pull request whose head branch cannot be checked out into a new worktree, **When**
   the developer selects "New session", **Then** the app shows an actionable reason and leaves no
   half-created Session behind.

## Edge Cases

- The selected repository has no GitHub remote: the "Pull requests" view says so and offers no
  pull request list.
- GitHub access is not available (not signed in, offline, or rate limited): the view shows an
  actionable message instead of an empty or broken list.
- A pull request or its diff is too large to show in full: the view shows what it can, says so,
  and offers opening it in the browser.
- The pull request is a draft, closed, or merged: review and merge actions are disabled, each
  with the reason shown.
- The pull request has merge conflicts or a failing required check: a merge attempt is refused
  with the reason shown.
- The pull request changes on GitHub while it is open in the app: the view says it is out of date
  before any action acts on the stale state.
- Pull request text (titles, bodies, comments, automated-reviewer output, branch names) is
  untrusted: none of it is ever rendered as raw HTML; markdown goes through the same sanitiser as
  the rest of the app.
- Images referenced in pull request text and author avatars are never loaded into the app window:
  authors show as a name or initials, and images show as their alt text with a link instead of the
  image.
- Links to GitHub or to other sites from pull request content open in the system browser, never
  inside the app window.
- Approve, request changes, merge, and resolve never run without an explicit user action; there
  is no automatic or background variant of any of them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The left nav MUST include a "Pull requests" entry. Selecting it MUST swap the main
  area to a pull request list and detail view scoped to the currently selected repository.
- **FR-002**: The view MUST require the selected repository to have a GitHub remote; when it does
  not, the view MUST say so instead of showing a list.
- **FR-003**: The list MUST offer the filter tabs Open, Authored by me, Assigned to me, Involves
  me, and Review requested, defaulting to Open, and switching tabs MUST re-filter the list to
  match the chosen tab.
- **FR-004**: The list MUST offer a way to narrow the current tab's results further (for example
  by matching text against title or label).
- **FR-005**: Each row MUST show the pull request's title, number, check status, repository, time
  since it was last updated, and author, with check status conveyed by an icon or text, never by
  color alone.
- **FR-006**: The list MUST support an on-demand refresh and MUST show when it was last updated.
- **FR-007**: Selecting a pull request MUST show an Overview with its title, number, state, base
  branch, head branch, reviewers, assignees, labels, and description.
- **FR-008**: The Overview MUST show a timeline of the pull request's commits, comments, reviews,
  and review threads, in order, including any automated-reviewer findings with their severity.
  **Known deviation (remediation round, High finding):** `findings` is currently always `[]` --
  no GitHub GraphQL field distinguishes an automated/bot review from a human one, and no live
  Copilot/bot review sample was available this session to confirm the body-parsing convention a
  heuristic would need (research.md decision 4). Implementing an unverified parser risked
  fabricating findings/severities from a convention nobody confirmed, which is worse than the
  current honest gap. `SEVERITY_LABEL`/the findings-rendering branch in `Timeline.tsx` are kept
  ready for whichever severity-extraction approach is chosen once a real sample is available.
- **FR-009**: The detail view MUST offer a Changes tab showing changed files, their total
  additions and deletions, and, per file, its diff.
- **FR-010**: The detail view MUST show the pull request's current check status (for example
  running, passed, or failed) and MUST update it as checks complete.
- **FR-011**: When a pull request or a file's diff is too large to show in full, the view MUST
  show what it can, state that it was truncated, and offer opening it in the browser.
- **FR-012**: Users MUST be able to add a comment to an open pull request and see its outcome
  (the comment appearing, or the exact failure).
- **FR-013**: Users MUST be able to reply to a review thread and see the reply appear under that
  thread.
- **FR-014**: Users MUST be able to resolve and unresolve a review thread.
- **FR-015**: Users MUST be able to submit a review as a comment, an approval, or a request for
  changes.
- **FR-016**: Users MUST be able to merge a mergeable pull request, choosing from the merge
  methods the repository allows; the merge action MUST NOT be offered when the pull request is
  not mergeable.
- **FR-017**: Approving, requesting changes, and merging MUST each require an explicit
  confirmation naming the pull request and what the action will do, before the action runs.
- **FR-018**: Every review action (comment, reply, resolve, unresolve, submit review, merge) MUST
  report success or the exact failure, and MUST NOT leave the view showing state that no longer
  matches the action's outcome.
- **FR-019**: Draft, closed, and merged pull requests MUST have their Approve, Request changes,
  and Merge actions disabled, each with the reason shown. The comment composer and each review
  thread's Reply/Resolve/Unresolve controls remain available regardless of pull request state.
- **FR-020**: A merge attempt MUST be refused, with the reason shown, when the pull request has
  merge conflicts or a failing required check.
- **FR-021**: Before any action acts on a pull request that has changed since it was loaded, the
  view MUST say it is out of date.
- **FR-022**: A "New session" action on a pull request MUST create a Session whose worktree has
  that pull request's head branch checked out, following the Session creation rules in spec 001;
  when the branch cannot be checked out, it MUST show an actionable reason and leave no
  half-created Session.
- **FR-023**: All pull request text (titles, bodies, comments, automated-reviewer output, branch
  names) MUST be treated as untrusted: it MUST NOT be rendered as raw HTML, and markdown MUST go
  through the app's sanitiser.
- **FR-024**: Images referenced in pull request text and author avatars MUST NOT be loaded into
  the app window; authors MUST be shown as a name or initials, and images MUST be shown as their
  alt text with a link instead of the image.
- **FR-025**: Links to GitHub or any other site from pull request content MUST open in the system
  browser, never inside the app window.
- **FR-026**: When GitHub access is unavailable (not signed in, offline, or rate limited), the
  view MUST show an actionable message rather than an empty or broken list.
- **FR-027**: The app MUST NOT store a GitHub access token; it MUST read access from the
  developer's already signed-in GitHub CLI.
- **FR-028**: Approve, request changes, merge, and resolve MUST each run only as the direct result
  of an explicit user action, never automatically or in the background.
- **FR-029**: The pull request list, its filter tabs, and the detail view's timeline MUST be fully
  operable by keyboard, with a visible focus indicator at every step.
- **FR-030**: Every status shown in the list or detail view (check status, pull request state,
  review outcome) MUST be conveyed by an icon or text, never by color alone.
- **FR-031**: The pull request detail Overview tab MUST show a reviewer-consensus summary (counts
  of approved / changes-requested / commented, derived from each reviewer's most recent review
  verdict) above the PR body, when at least one review exists.

### Key Entities

- **Pull request**: a proposed change on GitHub, with a title, number, state (open, draft,
  closed, or merged), base branch, head branch, author, reviewers, assignees, labels,
  description, and check status.
- **Review**: a reviewer's submitted verdict on a pull request (comment, approve, or request
  changes), with its own comments.
- **Review thread**: a comment thread anchored to a location in the diff, with a resolved or
  unresolved state.
- **Check**: a status check reported against the pull request's current commit (for example
  running, passed, or failed).
- **Automated-reviewer finding**: an issue reported by an automated reviewer (for example
  Copilot), with a severity.
- **Changed file**: one file in the pull request's diff, with its added and removed line counts
  and its diff.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a repository with a GitHub remote, a developer can open the Pull requests view
  and see its Open list within 3 seconds under normal network conditions.
- **SC-002**: Switching filter tabs updates the list to match the chosen tab every time, without a
  full page reload.
- **SC-003**: Opening a pull request shows its Overview, including the timeline, within 2 seconds
  for a pull request of typical size.
- **SC-004**: After a developer submits a comment, a thread resolution, or a review, the view
  reflects the new state within 2 seconds without a manual refresh.
- **SC-005**: A merge is refused with its reason shown 100% of the time the pull request has
  conflicts or a failing required check, and the merge action is offered only when GitHub reports
  the pull request as mergeable.
- **SC-006**: Approving, requesting changes, and merging are each preceded by an explicit
  confirmation step naming the pull request, 100% of the time; resolving a thread is a single
  explicit action that can be undone by unresolving it.
- **SC-007**: No pull request text is ever rendered as raw HTML and no remote image from pull
  request content or an avatar is ever loaded into the app window.
- **SC-008**: The pull request list, its filter tabs, and the detail view's timeline are fully
  operable using only the keyboard, with a visible focus indicator throughout.

## Assumptions

- Out of scope for this feature: creating pull requests (tracked separately as backlog issue #2,
  "Commit, push, and pull request controls per Session"); editing a pull request's title or
  description; editing its reviewers, assignees, or labels; and any non-GitHub host.
- The app stores no GitHub token for this feature; access comes from the developer's own,
  already signed-in GitHub CLI, consistent with how the rest of Refract treats external
  credentials.
- User Story 4 ("New session" from a pull request) is in scope; Stuart confirmed keeping it on
  2026-10-02.
- Spec 004 (session readout) adds a pull request chip above the message box that opens a
  Session's pull request in this view; this spec defines the view, and spec 004 defines the chip.
- The repository dropdown scopes the pull request list to one repository already added to
  Refract at a time, the same scoping the rest of the app uses for Sessions.
- The filter icon narrows the current tab's results further (for example by label or by text
  match); it does not add a sixth top-level tab.
- Merge method choices offered to the developer are limited to whatever the repository allows
  for that pull request; the app does not invent a method GitHub would refuse.
- "Review" and "Checks running" in the detail view's header surface the same submit-review action
  and check status covered by User Stories 2 and 3; they are not a separate feature.
- Access to GitHub is the active GitHub account of the profile menu (spec 008); switching account applies to the next request.

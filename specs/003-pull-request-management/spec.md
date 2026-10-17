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

- Q: Should the list row keep its bordered-button chrome? -> A: No - rows become a true
  `divide-y` flat list (zero-box rule), with the shared `bg-active-indicator` left-edge bar (the
  same selected cue `SessionRow.tsx`/`SessionList.tsx`/`GroupHeader.tsx` already use) marking the
  selected row instead of a border/fill, and a new 3-line layout (title+number; a metadata line
  of state, check, repository and time; an author line).
- Q: Does the metadata line use the mock's literal monospace styling? -> A: No - the mock's
  "mono line" instruction is rejected in favour of the written typography rule (monospace is
  reserved for code-shaped data only); the metadata line and the author line render in the App
  font. Mono stays reserved for the detail header's own branch tokens, which are genuinely
  code-shaped.
- Q: Does the pull request detail view need to surface a reviewer-consensus summary? -> A: Yes -
  a new FR-031: the Overview tab shows counts of approved / changes-requested / commented above
  the pull request body, whenever at least one review exists. Placement is the top of the
  Overview tab; counts are derived client-side from the existing timeline review verdicts, using
  each reviewer's standing opinionated verdict (approve/request-changes), never a later
  comment-only review, and excluding the pull request's own author; no new IPC field is added.
- Q: Should the pull request state badge change shape for this restyle? -> A: Yes - a solid-fill
  `StatePill` replaces the outline `Badge` used today, adding a new `--pr-merged` purple token;
  Open, Draft and Closed copy the matching severity/state token VALUES (not `var()` aliases to
  them) rather than adding new colours.
- Q: Is the `isDraft` search-field data bug (drafts showing as Open on the four relation tabs)
  in scope? -> A: Yes - `SEARCH_FIELDS` is fixed to request `isDraft` so those four searches
  correctly report Draft instead of silently Open; Draft only applies while the pull request's
  own state is OPEN, so a closed or merged draft still reads as Closed/Merged.
- Q: Should the list row's and detail view's two existing Refresh controls stay separate? -> A:
  No - both call sites are unified behind one shared `RefreshButton` component.
- Q: What does the larger detail title and the lighter action-button layout look like? -> A: The
  title grows to `text-lg`, up to two lines; Merge stays the one filled/primary button, and New
  session and Review become ghost buttons on the same row (no new row added) so the title leads.
- Q: Should the Overview/Changes tab pair adopt an underline style, and does that affect the
  five filter tabs? -> A: The Overview/Changes pair gets a local underline style scoped to this
  view only; the five filter tabs keep their existing pill style unchanged (an app-wide tab
  convention is deferred to issue #394, not #499 - #499 owns only the filter tabs' own
  selection-mechanism redesign).
- Q: Is the `PullRequestsView.tsx` header's `border-b` divider still needed? -> A: No - it is
  removed, closing out a previously-flagged inconsistency with the rest of the app's panel
  headers. The mock's "Done" close button is explicitly rejected, not built: Pull requests is a
  permanent left-nav view entry with no dismissible-panel equivalent in Refract today.
- Q: Does the Overview tab's commit row move out of the chronological timeline, matching the
  mock's own separate placement? -> A: No - the commit row stays inside the existing
  chronological `Timeline` component, with no structural change; the mock's separate-looking
  placement most plausibly reflects its own single-commit example pull request, not a reordering
  mandate.
- Q: Do any of the restyled surfaces need their own forced-colors (Windows High Contrast)
  handling? -> A: Yes - the `StatePill` and the selected row's active-indicator bar both get an
  explicit `forced-colors:` fallback (matching the existing active-indicator-bar pattern), so
  state is never carried by hue alone once the system repaints author colours away.

#### Gate round 1 amendments (2026-10-16)

The five-reviewer quality gate on the first build found the underline-tab decision's own class
string produced a box, not an underline, plus several smaller departures. Amending this
session's own record rather than re-opening earlier sessions:

- Decision 3 (tab style), amended: the call-site override must ALSO zero the shared
  `TabsTrigger`'s own base `border` (all four sides) before re-applying a bottom-only 2px border,
  or the base class's 1px all-sides border wins visually. The corrected override is
  `border-0 border-b-2 border-transparent data-[state=active]:border-b-accent-text
  hover:border-b-border`, kept in one shared constant so the Overview and Changes triggers can't
  drift apart; `tabs.tsx` itself stays untouched.
- Metadata-line separators: the record's own `· ` (space-dot-space) instruction does not survive
  being split across sibling flex items (each one's leading/trailing whitespace collapses) -
  the separator is a bare, `aria-hidden` middle-dot span with a `gap-1` on the flex container
  providing the visual spacing instead, and the line keeps `flex-wrap` so it still wraps at
  narrow widths rather than clipping.
- Decision 1's row hover, amended: `hover:bg-accent/50` (an opacity-modified token class)
  contradicts the written rule against Tailwind opacity modifiers on token classes;
  `hover:bg-surface-hover` is the correct token.
- Decision 5, clarified further: the literal-value instruction for Open/Draft/Closed was not
  followed in the first build (they were `var()` aliases); fixed to literal copies in all three
  theme blocks.
- Decision 6, amended: `isDraft` alone is not sufficient - GitHub keeps `isDraft: true` on a
  draft that was later closed without being marked ready, so the fix also gates on the pull
  request's own state being OPEN (see the Q/A entry above).
- Decision 7's action row, amended: the header action cluster's `shrink-0` must become
  `min-w-0` so its own `flex-wrap` can take over at narrow widths - otherwise the three action
  buttons overflow the detail pane invisibly instead of wrapping.
- FR-031, amended: "most recent review verdict" is read as the reviewer's most recent
  OPINIONATED verdict (approve or request-changes); a later comment-only review never overrides
  a standing approval or changes-requested, matching GitHub's own review semantics.

#### Gate round 2 amendments (2026-10-16)

Gate round 1's own dismissed-review handling (filtering a dismissed reviewer's reviews out of
`build_timeline` entirely) regressed FR-008: it deleted that reviewer's whole review history
from the Overview `Timeline` tab, not just from the consensus count.

- FR-031 / decision 10, amended again: a dismissed review is now a real `Timeline` entry (a new
  `dismissed` `ReviewVerdict`, shown in the Overview as "{author}'s review was dismissed" --
  gate round 3 fix: not "{author} dismissed their review", which wrongly implies the reviewer
  dismissed their own review rather than a maintainer or GitHub's stale-review automation doing
  so; the original approve/request-changes verdict a dismissed review HAD isn't in this query's
  data, so the wording stays generic rather than guessing which), never filtered out
  server-side. `ReviewConsensus.tsx` alone decides what a dismissal means: folding each
  reviewer's reviews in chronological order, a dismissal RESETS their standing verdict to
  none (it does not let an earlier, different review resurface as current); only a later
  approve or request-changes sets a new standing verdict.
- New Clarification: `timelineItems(first: 100)` (the GraphQL query backing both the Overview
  Timeline and FR-031's own consensus rollup) has no pagination -- a pull request with more than
  100 combined commits/comments/reviews silently loses everything past the 100th item from both
  surfaces. Pre-existing, not introduced by this story; tracked separately as issue #918, not
  fixed here.

#### Gate round 3 amendments (2026-10-16)

- Decision 10's own "{author} dismissed their review" wording, amended: it reads as though the
  REVIEWER dismissed their own review, which is never the case (a maintainer, or GitHub's own
  stale-review-on-push automation, does the dismissing). Changed to "{author}'s review was
  dismissed". The original approve/request-changes verdict a review had before being dismissed
  isn't available from this query's data (GitHub overwrites `state` to `DISMISSED` outright), so
  the wording stays generic rather than guessing which it was.
- FR-031, amended again: a reviewer whose entire history is a single, now-dismissed review (no
  comment ever submitted) has nothing to report and is left out of the consensus counts
  entirely, rather than being folded into "commented" by default. "Commented" now means a
  reviewer has no standing opinionated verdict AND has submitted at least one real comment
  review.
- `SubmitReviewInput.verdict` (contracts/ipc.md, data-model.md) narrowed to
  `Exclude<ReviewVerdict, 'dismissed'>`: a dismissal is a real state an already-submitted review
  can be in, never a choice a NEW submission can carry.

### Session 2026-10-16 (#569 sidebar pull request count)

- Q: What counts as the "active" pull request count shown next to the left-nav "Pull requests"
  entry? -> A: The current/default repository only, reusing the existing per-repository
  `involves`+`is:open` search (no new scope); never a cross-repository aggregate. Matches the
  single-repository scoping already established by FR-001/FR-002.
- Q: How does the count refresh? -> A: Event-driven only -- app start, default-repository
  change, window focus (throttled), and active-account change, plus the view's own explicit
  refresh -- never a timer/polling interval.
- Q: How is the count rendered? -> A: Plain trailing text ("N active") with no box or chip,
  matching the existing count-is-its-own-span convention; no new visual treatment.
- Q: When is the count hidden? -> A: Whenever no positive count is known yet for the default
  repository: before its first successful fetch, when the last fetch failed or is unavailable
  (signed out, offline, erroring), or when the real count is zero. A background refresh of an
  already-shown count keeps the last known value on screen instead of flickering to hidden
  (amended 2026-10-16, gate round 2: the original wording said "hidden while loading", which
  would have wrongly hidden an already-known count during every refresh).

### Session 2026-10-16 (#499 filter redesign, #930 resizable column)

Both issues' own decision records (not an interactive grill): recorded here to converge the spec,
not re-litigated.

- Decided (#499, 2026-10-16): inactive Filter tabs are ghost (no fill, no border), the active tab
  gets a subtle background plus a non-colour shape cue (an underline bar, matching
  `PanelTabBar.tsx`'s own established fix for the identical WCAG 1.4.11 contrast problem flagged
  on this same issue by #568's gate round 1). One row that scrolls sideways with a soft fade at
  the clipped edge, never wraps; the active tab scrolls into view. A ghost Filters button (funnel
  icon) and the ghost Refresh icon sit pinned at the row's right end and never scroll. Filters
  toggles a section holding the search field and the State control (Open, Closed incl. Merged,
  All -- the 2026-10-07 decision); closing the section never resets either. The first tab is
  renamed from "Open" to "All" (every pull request in the Project, narrowed by the separately
  selected State, default Open); the Project selector and column-width questions are out of
  scope here (#930).
- Decided (#930, 2026-10-16): the Pull requests list column becomes resizable (the shared
  `ResizablePanel`/`ResizableHandle` every other pane uses), 280px up to half the view, default
  320px remembered across restarts (one width for every Project). The header's Project selector
  shrinks and truncates to the column's own current width instead of the whole window's.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse pull requests (Priority: P1)

A developer opens the "Pull requests" entry in the left nav for a repository already added to
Refract. The main area switches to a list of that repository's pull requests, starting on the
"All" tab narrowed to the Open state. The developer switches between Filter tabs (All, Authored
by me, Assigned to me, Involves me, Review requested) and the separate State control (Open,
Closed, All) to find the ones that matter to them, and can ask the list to refresh.

**Why this priority**: Without a list there is nothing to read or act on. This is the entry point
for every other story.

**Independent Test**: With a repository that has a GitHub remote and at least one open pull
request, select "Pull requests" in the left nav, confirm the All tab is shown with that pull
request listed, switch tabs, and refresh the list.

**Acceptance Scenarios**:

1. **Given** a repository with a GitHub remote is selected and has open pull requests, **When**
   the developer selects "Pull requests" in the left nav, **Then** the list shows every open pull
   request for that repository, the "All" tab is active by default with the State control
   defaulting to Open, and the view shows when the list was last updated.
2. **Given** the pull request list is open, **When** the developer selects a different Filter tab
   (for example "Review requested") or State option (for example Closed), **Then** the list shows
   only pull requests matching that tab and state, and pull requests that no longer match are
   removed from view.
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
- **FR-003**: The list MUST offer the Filter tabs All, Authored by me, Assigned to me, Involves
  me, and Review requested, defaulting to All, in one non-wrapping row that scrolls sideways when
  too narrow for the column, with the active tab scrolled into view; switching tabs MUST re-filter
  the list to match the chosen tab (issue #499, 2026-10-16 decision).
- **FR-004**: The list MUST offer a way to narrow the current tab's results further (matching text
  against title or label) and a State control (Open, Closed, All -- Closed includes Merged, as on
  github.com) that narrows whichever tab is active, independent of it; both live behind a Filters
  disclosure that keeps applying while closed, with an accessible indicator when either is set to
  a non-default value (issue #499, 2026-10-16 decision).
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
  of approved / changes-requested / commented, derived from each reviewer's most recent
  opinionated verdict -- approve or request-changes, never superseded by a later comment-only
  review, and reset by a dismissal rather than reverting to an earlier verdict -- counting a
  reviewer with no standing opinionated verdict as "commented" only if they have at least one
  actual comment review, and excluding both the pull request's own author and a reviewer whose
  entire history is a since-dismissed review with no comment) above the PR body, when at least
  one review exists.
- **FR-032**: The left-nav "Pull requests" entry MUST show a trailing count of open pull
  requests involving the active account (author, assignee, mentioned, or review-requested) for
  the default repository only (the focused pane's Session's repository, independent of the Pull
  requests view's own repository dropdown) -- the same single-repository scoping as
  FR-001/FR-002, never a cross-repository aggregate. The count MUST render as plain text with no
  box, and MUST be shown only when a positive count is known for that repository: hidden before
  the first successful fetch, when the last fetch failed or is unavailable, or when the real
  count is zero -- a background refresh of an ALREADY-shown count MUST keep the last known value
  on screen, never flicker to hidden while that refresh runs. The count MUST be refreshed only on
  app start, a default-repository change, window focus (throttled), an active-account change, and
  the view's own explicit refresh -- and MUST NOT be refreshed on a timer.
- **FR-033**: The Filters disclosure's accessible indicator MUST name the number of active
  filters (for example "Filters, 1 active") whenever the search text is non-empty or the State
  control is not at its default (Open), and MUST never rely on colour alone (issue #499).
- **FR-034**: The list column MUST be resizable by a drag handle (280px to half the view, default
  320px), remembered across restarts as one width for every Project; the handle MUST be
  keyboard-operable (arrow keys resize it while focused) and a double-click on the handle MUST
  reset it to the default (issue #930; amended 2026-10-18, Decided (Skippy, delegated by Stuart
  2026-10-18): the issue's own decision record never asked for a keyboard-equivalent RESET, only
  for arrow-key RESIZING as the handle's keyboard alternative to dragging -- `react-resizable-
  panels` has no built-in reset key either; double-click stays the sole reset affordance).
- **FR-035**: The Project selector in the header MUST shrink and truncate to the list column's
  own current width, not only to the window's unrelated minimum width (issue #930).

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

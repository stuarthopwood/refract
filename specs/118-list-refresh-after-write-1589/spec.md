# Feature Specification: PR and issue lists refresh after a merge, close or Session write

**Feature Branch**: `feat/1589-lane`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1589 "PR and issue lists refresh after a merge or close, in the app or by a Session agent", grilled with Stuart 2026-11-02 (outcomes in the issue body and `docs/PLAN.md` line 1035). Builds on #1587's write detector (spec 115).

## Clarifications

### Session 2026-11-04 (from grill)

Decided (Stuart, grill-with-docs 2026-11-02):

- Q: What triggers a refresh? -> A: (1) a merge or close done in Refract's UI; (2) a PR or issue write by any Session's agent, detected by #1587's existing detector (`gh pr merge`, `gh pr close`, `gh issue close`, `gh issue create`, `gh api` POST/PATCH on pulls or issues, and so on). No second detector.
- Q: What refreshes? -> A: The open PR list, the Issues list and Home's active counts, in the background. Selection, scroll and focus stay put. No polling timer.
- Q: How often? -> A: Debounced about 1 s per list; a refresh is never doubled while one is in flight (one trailing refresh runs after it).
- Q: Spinner? -> A: No. The refresh is quiet: nothing blurs or covers the rows and the previous rows stay on a failure.
- Q: A row disappears (merged or closed)? -> A: Selection moves to the next row, as the existing list does on Refresh.
- Q: Live region? -> A: The list is never dumped into a live region.
- Q: Event? -> A: `github:changed` `{ repositoryId?, kind: 'pr' | 'issue', number }`.
- Q: Open questions in the issue? -> A: None.

Details the grill did not fix (the plan chooses a default; Stuart can overrule):

- Comment-only Session writes (`WriteAction::Comment`) do not emit: a comment changes neither list membership nor active counts.
- A `kind: 'pr'` event refreshes the PR list, the PR badge count and Home; a `kind: 'issue'` event refreshes the Issues list and Home. Lists that were never loaded are not fetched.
- A write whose repository is not a registered Project still emits, with no `repositoryId`; the renderer refreshes anyway because the list spans every Project.
- The existing "results" summary line in the list pane stays a polite live region; its count text may change on refresh. Rows are not announced.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Merge in the app and see the list update (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the PR list is open with a PR selected, **When** the user merges another PR (or this one) from the detail pane, **Then** the list drops the merged row within about 1 s with no spinner, and scroll and focus are unchanged.
2. **Given** the selected row is the one removed, **When** the refresh lands, **Then** selection moves to the next row (previous row if it was last, none if empty).

### User Story 2 - A Session agent merges or closes (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a Session runs `gh pr merge N` or `gh issue close N` successfully, **When** the tool call ends, **Then** the PR list, Issues list and Home counts refresh in the background.
2. **Given** a burst of several writes inside 1 s, **When** they land, **Then** each list is fetched once (plus at most one trailing fetch if one was already in flight).

### User Story 3 - Quiet and accessible (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a background refresh, **When** it runs, **Then** no spinner, blur or loading state is shown, and a failed refresh keeps the old rows without an error banner.
2. **Given** focus is on a row or elsewhere, **When** the refresh lands, **Then** focus does not move.

### Edge Cases

- GitHub not connected: the event is ignored.
- Event arrives while the list is mid-refresh: one trailing refresh after it.
- Replaying a Conversation's history (`rebuild_from_history`) never emits.

## Requirements *(mandatory)*

- **FR-001**: The backend MUST emit `github:changed` `{ repositoryId?, kind, number }` after a successful in-app PR merge or close.
- **FR-002**: The backend MUST emit `github:changed` for every live Session write the #1587 detector reports, except comments, mapping the repository to a Project id when one is registered.
- **FR-003**: The renderer MUST refresh the loaded PR list, PR badge count, Issues list and Home in the background, debounced about 1 s per list and coalesced to one trailing refresh while one is in flight.
- **FR-004**: Background refresh MUST NOT set a loading state or an error, and MUST keep old rows on failure.
- **FR-005**: When the selected row disappears, selection MUST move to the next row.
- **FR-006**: No polling timer is added.
- **FR-007**: Focus and scroll MUST NOT change.

## Success Criteria

- **SC-001**: One fetch per list per burst, observed by the live driver.
- **SC-002**: After an agent `gh issue close` the row is gone in about 1.5 s with no spinner.

# Requirements Checklist: Pull request management

**Purpose**: Validate the quality, clarity, and completeness of `spec.md`'s requirements before planning.
**Created**: 2026-10-02
**Feature**: [spec.md](../spec.md)

**Review Ownership**: This checklist is a reviewer-owned requirements-quality review artifact. Mark an item `[x]` only when the reviewer determines the requirements-quality criterion is satisfied.
**Marker Semantics**: `[x]` means the criterion has been reviewed and satisfied for requirements quality. It does not mean implementation work is complete.

## Requirement Completeness

- [x] CHK001 Every user-facing capability named in the Input screenshot description (list, filter tabs, filter icon, rows, Overview, Changes, timeline, review threads, reply/resolve, header actions) has a corresponding FR (FR-001 to FR-022).
- [x] CHK002 Every review action named in User Story 3 (comment, reply, resolve, unresolve, submit review, merge) has its own FR (FR-012 to FR-016) and its own acceptance scenario.
- [x] CHK003 Untrusted-content handling (no raw HTML, sanitised markdown, no remote images, external links) is specified for every surface that renders pull request text, not only the description (FR-023 to FR-025).
- [x] CHK004 The spec states what happens when GitHub access is unavailable for every entry point that depends on it (the list, the detail view, a review action) (FR-026, Edge Cases).

## Requirement Clarity

- [x] CHK005 FR-016 and FR-020 together state exactly when the merge action is offered versus refused (mergeable pull requests only; conflicts or failing required checks refuse with a reason), leaving no undefined middle case.
- [x] CHK006 FR-017 names precisely which three actions require a confirmation (approve, request changes, merge) and that each confirmation names the pull request and the action, so "confirmation" isn't left to interpretation per action.
- [x] CHK007 FR-021's "changed since it was loaded" is grounded by the Review entity and Key Entities section (pull request state, checks, mergeability) rather than left as an undefined comparison.
- [x] CHK008 FR-011's "too large to show in full" has a concrete three-part behaviour (show what it can, state truncation, offer the browser), not a vague "handle gracefully".

## Requirement Consistency

- [x] CHK009 FR-019 (draft/closed/merged pull requests disable review and merge) and Edge Cases' matching line are worded consistently, with no FR implying those actions are merely hidden rather than disabled-with-reason.
- [x] CHK010 FR-006 (on-demand refresh, last-updated shown) is consistent with Acceptance Scenario US1-AC3 and SC-001/SC-002; no requirement implies an automatic background refresh that would conflict with FR-028 ("no automatic or background variant").
- [x] CHK011 FR-022 (New session from a pull request) and US4's acceptance scenarios agree on both outcomes: success checks out the head branch following spec 001's Session rules, and failure leaves no half-created Session.
- [x] CHK012 The Assumptions section's "no GitHub token stored" statement and FR-027 state the same rule without contradiction, and both correctly scope it to this feature's own access, consistent with spec 008's later account management.

## Acceptance Criteria Quality

- [x] CHK013 Every User Story's acceptance scenarios are phrased as Given/When/Then with an observable, checkable outcome (no scenario ends on an implementation detail).
- [x] CHK014 US3's Independent Test exercises every review action listed in the story (comment, reply, resolve, approve, merge) plus the two refusal cases (draft, failing checks), so the story is independently verifiable end to end.
- [x] CHK015 SC-005 and SC-006 attach a 100%-of-the-time bar to the two safety-relevant behaviours (merge refusal, confirmation-before-action), making them objectively auditable rather than best-effort.

## Scenario Coverage

- [x] CHK016 A scenario or edge case exists for a repository with no GitHub remote (Edge Cases, FR-002), for GitHub access being unavailable (Edge Cases, FR-026), and for the pull request changing mid-session (Edge Cases, FR-021) — the three "view can't trust its own state" cases are all covered.
- [x] CHK017 A scenario or edge case covers the zero-results case for a filter tab (implied by FR-003's "re-filter to match the chosen tab" together with the row-removal clause in US1-AC2); reviewer confirms this reads unambiguously as "list can be empty", not only "list changes".

## Edge Case Coverage

- [x] CHK018 Both truncation cases are covered: the whole pull request is too large (Edge Cases) and a single file's diff is too large (US2-AC5, FR-011) — these are not conflated into one requirement that could be read as covering only one case.
- [x] CHK019 The spec states the fallback for an avatar/image in pull request content (alt text with a link, FR-024) and distinguishes it from the fallback for an author's own picture (name or initials, same FR-024), so the two cases aren't left to read as one undifferentiated rule.

## Non-Functional Requirements

- [x] CHK020 Accessibility requirements are stated for both the list (FR-029, keyboard, visible focus) and the status indicators (FR-030, never colour alone), covering the two accessibility concerns the Input's screenshot raises (keyboard-only rows/tabs; status conveyed by icon/text).
- [x] CHK021 Performance expectations are quantified and scoped to typical conditions (SC-001 "3 seconds under normal network conditions", SC-003 "2 seconds for a pull request of typical size") rather than left unbounded or over-specified for a prototype.

## Dependencies & Assumptions

- [x] CHK022 The spec names its two forward cross-spec dependencies explicitly — spec 004's pull request chip (Assumptions) and spec 008's active GitHub account (Assumptions, last line) — and states what each side owns, so neither spec needs to guess the boundary.
- [x] CHK023 The out-of-scope list (Assumptions, first bullet) is specific enough to prevent scope creep during planning: creating pull requests, editing title/description/reviewers/assignees/labels, and non-GitHub hosts are each named individually rather than lumped as "advanced features".

## Ambiguities & Conflicts

- [x] CHK024 "Severity" for automated-reviewer findings (Key Entities, FR-008) is not given a fixed enum in the spec; reviewer confirms this is an intentional implementation-level decision (the actual values GitHub's API reports are unverified pending a design-time probe) rather than a missing requirement, since the spec only requires that severity be shown, not what the severity values are.

## Notes

- No wording defects were found that needed correction. The spec's requirements are internally consistent, each has a matching acceptance scenario, and the three risk areas common to this kind of feature (untrusted content, confirmations before irreversible actions, and "can this view trust what it's showing") are each covered by at least one FR and one edge case.
- CHK024 is left as an explicit reviewer note rather than a spec change: resolving it means picking a severity scheme during planning (research.md), not rewriting the requirement, because the spec is correct to stay implementation-agnostic here.

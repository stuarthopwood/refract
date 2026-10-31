# Spec 094: Chat header PR and issue badges (#1315)

## Summary

The chat header shows the Session branch's pull request as a status badge with a **View PR** button, and the issues the PR closes as an issue badge with a **View issue** button. Each button opens a pinned panel in the right pane. The composer status line stops showing the PR chip.

## Decisions (grill outcomes, #1315 body and the 2026-10-31 comment)

1. The header owns the PR. `PullRequestReadout` (the composer chip), the `pull-request` readout kind and its Status line setting row are removed. A saved setting holding that kind loads without error; the key is dropped silently.
2. The PR badge shows state and number ("Open #123") with an icon per state (Open, Draft, Merged, Closed) and a checks dot (pass, fail, pending).
3. **View PR** opens or focuses a pinned **Pull request** panel in the right pane. The panel keeps its PR across Session switches. It hosts `PullRequestDetail` in a compact layout, with **Open in Pull requests view**, which selects the PR in the main area.
4. Linked issues come from the PR's `closingIssuesReferences`. The Session origin-issue source (#1310) is out of scope; the linked-issues list takes an ordered array so #1310 can prepend it.
5. With several linked issues the header shows the first issue's badge plus "+N". **View issue** opens a menu to pick one.
6. **View issue** opens a pinned **Issue** panel that reuses `features/issues/IssueDetail.tsx`.
7. No PR, no GitHub or a failed lookup: the header is unchanged.
8. Narrow header (split panes or a narrow window): badges drop to icon plus number; View PR and View issue become icon buttons with tooltips; the branch name truncates first.
9. Pinned panels are per-window state, not per Session, and are not restored after a restart.
10. A merge or close in the in-app PR view updates the badge without waiting for the 60 s readout poll.
11. State colours have contrast pairs in every theme; no badge relies on colour alone.

## Requirements

- FR-1 The readout `pullRequest` carries `number`, `url`, `state` (`open`, `draft`, `merged`, `closed`), `checks` (`pass`, `fail`, `pending`, or null) and `linkedIssues` (`number`, `state`, `title`). One GraphQL call in `session/readout_pr.rs` supplies them. An open PR wins; otherwise the most recently updated PR for the branch.
- FR-2 `Unavailable` lookups keep the previous reading (no flicker).
- FR-3 Accessible names: the badge reads "Pull request #N, open, checks failing"; the checks dot has a text alternative; icon-only buttons are named "View pull request #N" and "View issue #N".
- FR-4 The View issue menu works by keyboard (arrows, Esc returns focus to the button). Opening a panel moves focus into it; closing returns focus to the opener (#563).
- FR-5 Issue titles are untrusted text; they render as text only.
- FR-6 Opening a different PR replaces the pinned PR; the same for issues.

## Out of scope

#1310 (origin issue), #1200 (PR layout bug), #1193 (agent-opened panels), creating a PR.

## Clarifications

- 2026-10-31: the pinned panels are registered in `panel-registry.ts` as pinned descriptors; they appear in the tab bar only while pinned and never in the rail or launcher.
- 2026-10-31: merged and closed PRs also show, because the lookup takes the latest PR for the branch when none is open.

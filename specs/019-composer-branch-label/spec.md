# Feature Specification: Live branch label in the composer strip

**Feature Branch**: `feat/p1-composer`
**Created**: 2026-10-22
**Status**: Draft
**Input**: Issue #724: "Display the currently checked out branch. Put it after the effort level gauge with an appropriate icon. Clicking it opens the Git side panel." (Stuart, 2026-10-13; grilled 2026-10-22.)

## Clarifications

### Session 2026-10-22 (Stuart's grill; resolves the issue's open questions)

- Q: Does the Git side panel exist for the click to open? -> A: Yes. The issue text is stale: the Git changes panel (`git-changes` in the right-pane registry, spec 018) exists. Clicking the label opens it for that pane's Session, the same way the Changes readout already does. Option A ("text now, click later") is superseded.
- Q: Where does the live branch come from? -> A: The readout already carries a live `branch` (`git symbolic-ref -q --short HEAD`, falling back to `git rev-parse --short HEAD` for a detached HEAD), refreshed on attach, turn start and end, and every tool-call end. This feature adds a watch on the directory holding the worktree's own HEAD file (resolved with `git rev-parse --git-path HEAD`, never `<worktree>/.git/HEAD`), so a switch made outside a turn shows within about a second.
- Q: In a narrow strip, which item yields first? -> A: The branch truncates first; the model name keeps its space; the reasoning (effort) item never shrinks. The full name is in the tooltip and the accessible name ("Branch: <name>").
- Q: No worktree or an unreadable repository? -> A: Show nothing, never a guess.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the branch the Session is really on (Priority: P1)

A developer glances at the composer strip and sees the branch currently checked out in that pane's Session worktree, after the reasoning level, with a branch icon. When the agent (or a terminal) switches branch, the label follows.

**Why this priority**: The generated Session branch name goes stale the moment the agent switches branch; the developer needs the real one before committing or opening a pull request.

**Independent Test**: Start a Session, read the label; run `git switch -c other` in its worktree from a terminal; the label reads `other` within about a second, with no turn running.

**Acceptance Scenarios**:

1. **Given** a running Session on its generated branch, **When** the composer renders, **Then** the strip shows a branch icon and that branch name after the reasoning item.
2. **Given** the label is showing, **When** the worktree switches branch outside a turn, **Then** the label shows the new branch within about a second.
3. **Given** a detached HEAD, **When** the label renders, **Then** it reads "Detached at <short sha>".
4. **Given** a Session with no readable worktree (deleted, not a repository, never started), **When** the composer renders, **Then** no branch label is shown.
5. **Given** two panes, **When** each shows its own Session, **Then** each label shows its own Session's branch, and keeps it across a resume or reopen.

### User Story 2 - Open the Git panel from the label (Priority: P1)

The label is a button. Clicking it, or pressing Enter or Space on it, opens the Git changes panel for that pane's Session (or focuses it if already open).

**Independent Test**: Click the label; the right pane shows the Git changes panel for that Session.

**Acceptance Scenarios**:

1. **Given** the label is showing, **When** it is clicked or activated by keyboard, **Then** the Git changes panel opens for that pane's Session.
2. **Given** the label has keyboard focus, **When** a screen reader reads it, **Then** it announces "Branch: <full name>. Open Git changes panel".

### Edge Cases

- A 60-character branch name truncates with an ellipsis without pushing the reasoning item out or wrapping the label onto two lines; the full name stays in the tooltip and accessible name.
- A branch change is not announced (no live region); it is not an event worth interrupting for.
- A commit on the current branch does not change HEAD, so it does not need a refresh.
- `git` rewrites HEAD through `HEAD.lock` and a rename, so the watch is on the containing directory, filtered to HEAD.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The composer strip MUST show, after the reasoning item, a branch icon (`aria-hidden`) and the live checked-out branch of that pane's Session worktree, muted 12px text like its neighbours.
- **FR-002**: A detached HEAD MUST read "Detached at <short sha>". No readable worktree MUST show no label at all.
- **FR-003**: The label MUST refresh on attach and resume, on turn start and end, after each tool call, and within about a second of the worktree's HEAD changing outside a turn (a watch on the directory of `git rev-parse --git-path HEAD`, debounced).
- **FR-004**: The label MUST be a button whose activation opens the Git changes panel for that pane's Session; it MUST have a visible focus outline, a 24px target, and the accessible name "Branch: <full name>. Open Git changes panel".
- **FR-005**: Its tooltip (hover and keyboard focus, Esc dismisses) MUST show the full branch name, the Session's base branch, and "Session branch: <generated name>" only when the live branch differs from it.
- **FR-006**: In a narrow strip, the branch MUST truncate first (ellipsis); the model name keeps its space and the reasoning item never shrinks.
- **FR-007**: The label is a permanent part of the strip, not a Settings readout toggle.

### Key Entities

- **Live branch**: `{ name, detached }` on the Session readout; `name` is the branch, or the short sha when `detached`. `null` when unreadable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A branch switch made outside a turn shows in the label within 1 second.
- **SC-002**: A 60-character branch name never wraps the label or pushes the reasoning item out of the strip.
- **SC-003**: The label's muted text keeps at least 4.5:1 on the composer background in every built-in theme.

## Assumptions

- The Rust readout already computes the live branch (issue #724, folded into lane R5); this feature adds the HEAD watch and the renderer label.
- The pull request chip, Changes chip, and Session row still read the generated `Session.branch`; feeding them the live branch is a follow-up (out of scope).
- No branch switching, creating, or deleting; no ahead/behind counts in the strip.

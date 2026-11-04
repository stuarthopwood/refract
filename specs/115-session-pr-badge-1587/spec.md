# Feature Specification: Chat header badge tracks Session-written PRs and issues

**Feature Branch**: `feat/1587-session-pr-badge`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1587 (P1, `enhancement`) "Chat header: PR and issue badge also tracks PRs and issues the Session creates or changes (latest plus overflow menu)", grilled with Stuart 2026-11-02 (outcomes in the issue body and `docs/PLAN.md` line 1031). Extends #1315 (closed), which shows the header badge only for the Session branch's PR and the Session's origin issue.

## Clarifications

### Session 2026-11-04 (from grill)

All answers come from the issue's 2026-11-02 grill block, its "Intended behaviour", "Technical notes" and "Accessibility" sections, `docs/PLAN.md` line 1031, and the code as read on this branch. No other source was used.

- Q: What counts as "touched"? -> A: A PR or issue the Session **writes** to: `gh pr create`, `gh pr merge`, `gh pr close`, `gh pr comment`, `gh issue create`, `gh issue edit`, `gh issue close`, `gh issue comment`, and `gh api` calls on `.../pulls/N` or `.../issues/N` with `-X POST`, `-X PATCH` or `--input` (plus the URL a create prints). Reads (`view`, `list`, `search`, GET) never count, so duplicate checks do not fill the list.
- Q: What does the header show? -> A: **One** badge for the latest touched item (number, PR or issue icon, live state) and a **+N** button that opens a menu of the others, newest first. Clicking a badge or menu item opens it in the right pane, the same path as #1315's View PR and View issue controls.
- Q: How does this interact with #1315? -> A: The branch PR and origin issue keep their place first. Touched items fill the badge slot only when neither exists; otherwise they appear in the +N menu.
- Q: How long does the touched list live? -> A: Per Conversation, persisted: it survives an app restart and resets on New conversation, like the other readout fields.
- Q: Other repositories? -> A: Allowed. The badge shows `owner/repo#N` when the repository differs from the Session's, and the right pane opens it when that repository is a registered Project, otherwise on GitHub.
- Q: Where is detection done? -> A: In the backend, from completed `bash` and `eval` tool calls (arguments plus output). Write commands are parsed from command tokens, never by a regex over free text. The number comes from the arguments or from the GitHub URL a create prints.
- Q: How is state kept fresh? -> A: Lazily, at most one fetch per item per readout recompute, reusing the #1315 status fetch path.
- Q: Accessibility? -> A: The +N button's accessible name is "N more pull requests and issues"; the menu is a real menu with arrow-key navigation; state is text or a labelled icon, never colour alone.
- Q: Open questions in the issue? -> A: None.

Details the grill did not fix (the plan chooses a default and flags it; Stuart can overrule):

- The issue says "the existing command tokenizer". None exists in `src-tauri/src` or `src/` (searched on this branch). The plan adds one small quote-aware tokenizer module to the detector rather than a crate.
- "Persisted with the Conversation" is met by deriving the list from the Conversation's own saved history (OMP already persists every tool call and result there) instead of a second store.
- An `eval` call is scanned for string literals that start with `gh `; array-form subprocess calls are not detected.
- A tool call that errored (`isError`) never counts.
- The list holds at most 50 items per Conversation, oldest dropped first.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the PR a Session just created (Priority: P1)

A Session on a branch with no PR (for example one that files PRs from temporary worktrees) runs `gh pr create`. The header shows that PR's badge with its live state.

**Why this priority**: This is the reason for the issue; a Session that creates PRs elsewhere shows no badge at all today.

**Independent Test**: In a Session whose branch has no PR, run a `gh pr create` that succeeds; the header gains a PR badge with the number and state. Run `gh pr merge` on it; the badge state becomes merged.

**Acceptance Scenarios**:

1. **Given** a Session with no branch PR and no origin issue, **When** a `bash` call `gh pr create ...` succeeds and prints a PR URL, **Then** the header shows a PR badge for that number with its live state and a View control.
2. **Given** that badge, **When** the Session runs `gh pr merge N` successfully, **Then** the badge shows the merged state after the next readout recompute.
3. **Given** the badge, **When** the user clicks it or View, **Then** the PR opens in the right pane, as a #1315 PR does.

---

### User Story 2 - Latest plus an overflow menu (Priority: P1)

A Session files five issues. The header shows the latest one and **+4**; the menu lists the others.

**Independent Test**: Run five `gh issue create` calls; the badge shows the fifth with "+4"; the menu lists number, title and state, newest first, and selecting one opens it in the right pane.

**Acceptance Scenarios**:

1. **Given** five touched issues, **When** the header renders, **Then** one badge shows the newest and a +N button reads "4 more pull requests and issues".
2. **Given** the menu is open, **When** the user presses the arrow keys, **Then** focus moves between items and Enter opens the selected one in the right pane.
3. **Given** a repeated write to the same item, **When** the list updates, **Then** the item moves to the front once and is not duplicated.

---

### User Story 3 - The branch PR and origin issue keep their place (Priority: P1)

**Independent Test**: In a Session that has a branch PR, run `gh issue create`; the branch PR badge is unchanged and the issue appears only behind the +N menu.

**Acceptance Scenarios**:

1. **Given** a branch PR or an origin issue, **When** the Session touches other items, **Then** the existing badges stay first and touched items appear only in the +N menu.
2. **Given** a touched item that is the branch PR, the origin issue or one of the PR's closing issues, **When** the list is shown, **Then** it is not listed twice.

---

### User Story 4 - Survives restart, resets on New conversation (Priority: P2)

**Independent Test**: Touch an item, restart the app and reopen the Session; the badge is still there. Start a New conversation; the touched list is empty.

**Acceptance Scenarios**:

1. **Given** touched items in a Conversation, **When** the app restarts and the Conversation reattaches, **Then** the same items show, newest first.
2. **Given** touched items, **When** the user starts a New conversation or opens another Conversation, **Then** the list is rebuilt from that Conversation (empty for a new one).

---

### User Story 5 - Items from another repository (Priority: P2)

**Independent Test**: Run `gh issue create --repo other/repo`; the badge reads `other/repo#N`. When `other/repo` is a registered Project the right pane opens it; otherwise it opens on GitHub.

**Acceptance Scenarios**:

1. **Given** a touched item whose repository differs from the Session's, **When** it is shown, **Then** it displays as `owner/repo#N`.
2. **Given** that repository is a registered Project, **When** the item is opened, **Then** it opens in the right pane for that Project.
3. **Given** it is not registered, **When** the item is opened, **Then** it opens on GitHub in the external browser.

---

### Edge Cases

- Reads (`gh pr view`, `gh issue list`, `gh search`, `gh api` GET) are ignored, so a duplicate check adds nothing.
- A failed call (`isError`, or no number resolvable from arguments or output) adds nothing; the detector never guesses a number.
- Chained commands (`&&`, `||`, `;`, `|`, newlines) are split; each simple command is judged on its own. Quoted text such as `--body "gh pr merge 9"` never counts.
- `gh pr merge` with no number and no URL, and no URL in its output, is unresolved and ignored.
- `-R` / `--repo` and URL arguments set the repository; otherwise the Session's repository is assumed.
- `gh` unavailable or unauthenticated: the item is still listed with its number and an unknown state, and no error is shown.
- A very long list keeps only the 50 newest; titles are bounded and rendered as plain text.
- The same item touched by a later comment moves to the front rather than duplicating.
- Compound state: a merged PR whose `lastTouchedAt` is old stays in the list until the Conversation ends.
- Zero touched items and no branch PR or origin issue: the header shows nothing, as today.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The backend MUST detect writes from completed `bash` and `eval` tool calls: `gh pr create|merge|close|comment`, `gh issue create|edit|close|comment`, and `gh api` on `.../pulls/N` or `.../issues/N` with `-X POST`, `-X PATCH`, `-X PUT`, `-X DELETE` or `--input`.
- **FR-002**: Detection MUST work on tokenised commands (quote-aware, operator-aware), never a regex over free text; reads MUST NOT count.
- **FR-003**: The item number MUST come from the command arguments, a GitHub URL argument, or the GitHub URL in the tool output; an unresolved number MUST NOT produce an item.
- **FR-004**: Only successful tool calls MUST count.
- **FR-005**: The readout MUST carry `touched`: items `{ repo, kind: 'pr' | 'issue', number, title, state, url, lastTouchedAt }`, newest first, deduplicated by repo, kind and number, capped at 50.
- **FR-006**: The touched list MUST be per Conversation: rebuilt from the Conversation's saved history on attach and Conversation switch, extended live from tool frames, and empty after New conversation.
- **FR-007**: Item state MUST refresh lazily, at most once per item per readout recompute, using the #1315 status path with its existing back-off; a failed fetch keeps the last known state or `unknown`.
- **FR-008**: The header MUST show one badge for the latest touched item and a +N button listing the rest, newest first, only when no branch PR or origin issue exists; otherwise touched items MUST appear only in the +N menu after the #1315 controls.
- **FR-009**: Items already shown by #1315 (branch PR, origin issue, closing issues) MUST NOT be listed again.
- **FR-010**: Clicking a badge or menu item MUST open it in the right pane via the #1315 pin path; for a repository that is not a registered Project it MUST open on GitHub.
- **FR-011**: An item from another repository MUST display as `owner/repo#N`.
- **FR-012**: The +N button's accessible name MUST be "N more pull requests and issues", the menu MUST be a real menu with arrow-key navigation, and state MUST be conveyed by text or a labelled icon.
- **FR-013**: The header UI MUST be built from shared components (`Badge`, `HeaderActionButton`, `DropdownMenu`); no one-off control (ADR 0003).
- **FR-014**: The detector MUST expose its detected writes through one interface that other consumers can subscribe to, so #1589's `github:changed` event needs no second parser.

### Key Entities

- **TouchedRef**: a PR or issue the Session wrote to: repo, kind, number, title, state, url, lastTouchedAt.
- **GithubWrite**: one detected write: repo (optional), kind, number (optional), action (create, merge, close, comment, edit, api-write).
- **ToolCallRecord**: a completed tool call normalised from a live frame pair or a saved history pair: tool, arguments, output text, is-error, timestamp.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a successful `gh pr create` in a Session with no branch PR, the header shows the new PR's badge within one readout recompute.
- **SC-002**: Five created issues render as one badge plus a "+4" menu, newest first.
- **SC-003**: No read-only `gh` command or quoted mention ever adds an item.
- **SC-004**: After an app restart, 100% of a Conversation's touched items reappear; after New conversation, none do.
- **SC-005**: A Session with a branch PR or origin issue shows those first in every case.

## Assumptions

- The Rust backend (`src-tauri`) and the renderer (`src/renderer`) both change; OMP's tool frames and saved history carry tool arguments and results as read in `src-tauri/src/omp/transcript.rs`.
- Prototyping phase: no new tests are added; existing tests are kept passing.
- The #1589 `github:changed` event is out of scope; only the interface it hangs off is built here.

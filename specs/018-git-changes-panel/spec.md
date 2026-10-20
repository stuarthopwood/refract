# Feature Specification: Git changes panel (slice 1)

**Feature Branch**: `018-git-changes-panel`

**Created**: 2026-10-20

**Status**: Draft

**Input**: User description: "Right panel: a Git changes panel showing the Session's working-tree
changes in groups (Conflicts/Staged/Changes/Untracked), with per-file stage/unstage/diff/Open in
VS Code, bulk stage/unstage, a commit box, a branch + ahead/behind header, and auto-refresh" --
[issue://464](https://github.com/stuarthopwood/refract/issues/464), scoped to slice 1 only by the
"Grilled 2026-10-20" comment on that issue (slice 2, AI commit message, is
[issue://1060](https://github.com/stuarthopwood/refract/issues/1060); slice 3, discard/amend/
push+PR, is [issue://1061](https://github.com/stuarthopwood/refract/issues/1061); neither is
designed here).

## Clarifications

### Already decided (cited, not re-asked)

All of the following are settled by the issue's own "Grilled 2026-10-20" comment (Skippy,
delegated by Stuart); none is re-litigated here.

1. **Three-slice split** (decision 1): this spec covers slice 1 only -- changes list in four
   groups, per-file diff, stage/unstage (per-file and bulk), commit box, branch + ahead/behind
   header, auto-refresh. Slice 2 (AI-generated commit message) and slice 3 (discard, amend, push
   + PR controls) are separate issues, out of scope here.
2. **Hunk/line staging stays out of scope** for every slice filed so far (decision 2) -- this spec
   is file-level stage/unstage only.
3. **Refresh triggers** (decision 3): the focused pane's Session transitioning away from
   `Working`, a worktree file-system change via the existing debounced `notify` watcher
   (`fs/watch.rs`, already shared with the File explorer panel), and an explicit refetch after
   every panel action -- only while the panel is open for that Session, no background watching
   otherwise.
4. **Discard safety** (decision 4) is slice 3's own concern, noted here only as an out-of-scope
   boundary: no discard action exists in this spec.
5. **Which `git` commands** (decision 5): `git status --porcelain=v2 -z --branch` for this panel
   (not v1, which the File explorer panel already uses and which carries no branch/ahead-behind
   header); `git diff` / `git diff --cached` for diff bodies; `git add --`, `git restore
   --staged --` for stage/unstage (not `checkout`, not `--worktree`, which is slice 3's discard
   verb); `git commit -F -` with the message on stdin (never `-m`, no argv quoting/length limits).
   Every path argument is a literal post-`--` argv entry, sourced only from the already-validated
   status map's own keys -- never from free text or shell interpolation.
6. **Mid-turn behaviour** (decision 6): stage/unstage/commit stay allowed while the agent is
   mid-turn; the commit box shows a quiet inline warning when the focused Session's status is
   `Working`, never a modal, never a disabled Commit button on that basis alone. A genuine
   `index.lock` collision from git itself still surfaces as a plain error, never silently retried.
7. **Commit author/identity** (decision 7): no Refract-side override -- relies on the worktree's
   own already-configured `git config user.name`/`user.email`; an unconfigured identity surfaces
   as git's own plain error.
8. **Empty/error/huge-repo states** (decision 8): a clean worktree shows the existing honest-empty
   -state convention (icon, one line, no Sample-data badge) with the branch/ahead-behind header
   still shown; an operation failure shows a plain inline `role="alert"` error naming what failed;
   huge repos cap the status read exactly as `status.rs` already caps it for the File explorer
   (`STATUS_MAX_BUFFER_BYTES` -> not-available), and per-file additions/deletions follow
   `diff_stat.rs`'s own `MAX_FILES`/partial convention, with the same "(partial)" wording
   `sessionDisplay.tsx` already uses.
9. **Keyboard and accessibility** (decision 9): the issue's own Accessibility section stands as
   written; Ctrl+Enter commits from anywhere in the message field (matching the composer's send
   shortcut); each group's bulk action is an icon button with a tooltip and an accessible name
   including the group name, not a bare icon.
10. **Badges** (decision 10): every `+N`/`-N` figure in this panel (file rows, group headers, the
    panel's own tab/rail count) renders through the existing shared `DiffStatCounts` component
    (#925) -- no new badge component, no raw colour classes. The tab/rail count uses the already-
    defined, currently-unused `PanelCount` shape `{ kind: 'additions-deletions', additions,
    deletions }`.
11. **Panel/tab placement** (decision 11, 14, 15): a new `HOSTED_PANELS` entry `git-changes` in
    `panel-registry.ts`, wired exactly like `file-explorer`/`side-chat` (closable, tab-bar-
    eligible, shown in the centred launcher). The existing Changes readout chip (#435) becomes a
    button opening this panel for that pane's Session. A second pane (Split) shows its own
    focused Session's Git changes panel independently.
12. **AI commit-message mechanism, message style, destructive-action patterns, push/PR controls**
    (decisions 12, 13, and all of slice 3) are explicitly out of scope for this spec -- noted only
    as boundaries in Edge Cases/Assumptions below.

### #1101 UI polish (2026-10-20, Stuart's screenshot feedback; Skippy, delegated by Stuart, all
resolved, none deferred)

1. **Subject counter** (item 1): `n/72` shown only once the subject has at least one character
   (hiding the bare `0` on an empty field), muted `text-muted-foreground`, switching to a warning
   colour past 50 characters and an error colour past 72 (over-limit is visual only -- FR-024
   still enforces no format and never blocks Commit on subject length). An `sr-only` "Subject
   length" label names the value for a screen reader, since nothing previously did.
2. **Commit inputs** (item 2): both the subject and body fields reuse the composer's own surface,
   border and focus classes (ADR 0003), not the bare `Input`/`Textarea` defaults they used before.
3. **Stage/unstage in-progress state** (item 4): a stage/unstage/stage-all/unstage-all round trip
   in flight shows a spinner on the row or group button that triggered it, sets `aria-busy`, and
   disables that control against a double click; the existing app-level `role="status"`
   announcement region (`chatAreaAnnouncer.ts`) covers the screen-reader side, no new live region.
4. **Untracked file content** (item 5): an untracked file's diff shows the whole file as added
   (green) lines, not an empty box -- synthesised directly from the file's own content (`git diff`
   has no index/HEAD side to compare an untracked path against), capped and binary-checked by the
   same size/binary logic this panel's own additions/deletions count already applies to that same
   file.
5. **Back button** (item 6): the labelled outline "Back to changes" control becomes a ghost
   icon-only button (`lucide-react` `ArrowLeftIcon`), with an `aria-label` naming the file (for
   example "Back to changes from README.md") since the visible label is gone.
6. **Sticky back** (item 7): the Back button stays visible at the top of the diff pane while its
   content scrolls -- a stop-gap, simple `sticky` positioning only, **superseded once #732-
   dependent "Git diff opens in a main-area tab" (issue #1102) ships**, at which point this whole
   diff pane (Back button included) is removed.

### Layout rulings (ui-architect-v3 consult, already run, applied as given)

- Single scrollable column (header -> groups -> rows), not a list+diff split.
- Selecting a row / "Open diff" opens the diff in the main-area tab (full chat-pane width), not
  inline in the hosted pane.
- Commit box is a fixed, non-scrolling footer under a `flex-1 overflow-auto` groups/rows region.
- Branch + ahead/behind header reuses `SessionDetailsCard.tsx`'s branch-line shape (`GitBranchIcon`
  + branch + muted `from {base}`); ahead/behind is net-new muted icon+text appended to the same
  row.
- Group headers reuse `GroupHeader.tsx`'s `GroupHeaderTrigger` exactly (leading chevron, trailing
  `(N)` count, reserved actions-column slot for the bulk-action icon button).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See and stage/unstage changes (Priority: P1)

A developer with a Session that has uncommitted work wants to see every changed file, grouped by
what state it's in, and move files between the working tree and the index one at a time or in
bulk, without leaving Refract or running `git` by hand.

**Why this priority**: the feature's whole reason to exist -- without a changes list and stage/
unstage, there is nothing else in this panel to build on.

**Independent Test**: open the Git changes panel for a Session with a mix of staged, modified,
and untracked files; confirm the four groups (Conflicts, Staged, Changes, Untracked) each show the
right files with the right status icon+text and `+N`/`-N` badge; stage one file from Changes and
confirm it moves to Staged; use a group's bulk action to unstage everything in Staged and confirm
every file returns to its prior group.

**Acceptance Scenarios**:

1. **Given** a Session's worktree has one modified-and-staged file, one modified-but-unstaged
   file, and one untracked file, **When** the developer opens the Git changes panel, **Then** the
   panel shows three groups with one row apiece (Staged, Changes, Untracked), each group header
   showing its own count and each row showing a status icon+text (never colour alone) and a
   `DiffStatCounts` badge.
2. **Given** a file is listed under Changes, **When** the developer clicks its Stage action,
   **Then** the file moves to the Staged group, the Staged group's count increments, and the
   Changes group's count decrements, with no full-panel reload (the single file moves).
3. **Given** the Staged group has three files, **When** the developer clicks the group's "Stage
   all" -- actually "Unstage all" -- bulk action, **Then** all three files move back to their
   originating groups (Changes or Untracked, by what each file's worktree-vs-index state implies)
   in one action.
4. **Given** a file has a merge conflict, **When** the panel loads, **Then** that file appears
   only in the Conflicts group (never duplicated into Staged or Changes), with its own status
   icon+text.
5. **Given** the developer clicks a row's Open diff action, **When** the diff loads, **Then** it
   opens in a new or existing main-area tab at full chat-pane width, reusing `DiffView.tsx`, not
   inline in the hosted pane.
6. **Given** the developer clicks a row's Open in VS Code action, **When** it runs, **Then** it
   launches the same shared VS Code action #463's file explorer already exposes, for that file's
   path.

---

### User Story 2 - Write and submit a commit (Priority: P2)

Having staged the files they want, a developer wants to write a commit message and commit, without
switching to a terminal.

**Why this priority**: the second half of the panel's reason to exist, but depends on User Story
1's stage/unstage already working -- nothing to commit otherwise.

**Independent Test**: stage at least one file, type a commit message into the commit box, press
Commit (or Ctrl+Enter), and confirm the commit lands (verified by `git log` showing the new commit
with that message and `git status` showing the staged file no longer pending) and the panel
refreshes to an empty Staged group.

**Acceptance Scenarios**:

1. **Given** the Staged group is empty, **When** the developer looks at the commit box, **Then**
   the Commit button is disabled with a reason visible (for example "Nothing staged").
2. **Given** at least one file is staged but the message field is empty, **When** the developer
   looks at the commit box, **Then** the Commit button is disabled with a reason visible (for
   example "Write a message").
3. **Given** files are staged and a message is typed, **When** the developer presses Commit (or
   Ctrl+Enter from anywhere in the message field), **Then** the commit is created with that
   message via `git commit -F -` (message on stdin), the message field clears, and the panel
   refetches to show the post-commit state.
4. **Given** the subject line (first line) of the message grows, **When** the developer types,
   **Then** a live character counter is shown next to the subject line (a length guide, not a
   format validator -- no enforced commit-message convention).
5. **Given** the focused Session's status is `Working` (the agent is mid-turn), **When** the
   developer views the commit box, **Then** a quiet inline warning reads "Agent is working --
   review before committing", with Commit still enabled (not blocked) once staged files and a
   message exist.
6. **Given** a real git failure occurs during commit (for example an `index.lock` collision),
   **When** the commit attempt fails, **Then** a plain inline `role="alert"` error names what
   failed, and the attempt is never silently retried.

---

### User Story 3 - Branch and ahead/behind awareness with live auto-refresh (Priority: P3)

A developer wants to see which branch the Session is on, how far ahead/behind its upstream it is,
and trust that the panel reflects the worktree's true current state without manually refreshing.

**Why this priority**: necessary for the panel to feel trustworthy for daily use, but the panel is
already useful with Stories 1-2 alone even if a developer has to reopen it to see a refresh.

**Independent Test**: open the panel, observe the branch + ahead/behind header; make an external
change to the worktree (for example save a file from an editor outside Refract) and confirm the
panel's changes list updates within the debounce window with no manual action; let the focused
Session's agent finish a turn that touched files and confirm the panel refreshes again; run a
stage/unstage/commit action and confirm the panel refetches afterward too.

**Acceptance Scenarios**:

1. **Given** a Session's branch has an upstream two commits ahead and one behind, **When** the
   panel loads, **Then** the header shows the branch name, the base ("from {base}"), and a muted
   icon+text ahead/behind figure (for example "2 ahead, 1 behind"), never colour alone.
2. **Given** a Session's branch has no upstream configured, **When** the panel loads, **Then** the
   ahead/behind figure is simply omitted (no error, no "0 ahead, 0 behind" placeholder implying a
   real upstream exists).
3. **Given** the Git changes panel is open for a Session, **When** a file inside that Session's
   worktree changes on disk (outside any panel action), **Then** the changes list and header
   refetch via the existing debounced `notify` watcher, with no action from the developer.
4. **Given** the Git changes panel is open for a Session whose agent is mid-turn, **When** that
   Session's status transitions away from `Working`, **Then** the panel refetches once, matching
   the same signal already driving the Status line.
5. **Given** the Git changes panel is closed for a Session, **When** files change in that
   Session's worktree, **Then** no refetch happens for that Session until its panel is reopened
   (no background watching for a closed panel).

---

### Edge Cases

- **Clean worktree.** No groups have any rows; the panel shows the existing honest-empty-state
  convention (icon, one line, no Sample-data badge, since this is never sample content); the
  branch + ahead/behind header is still shown.
- **Huge repository or very large diff.** The status read is capped exactly as `status.rs` already
  caps it for the File explorer (`STATUS_MAX_BUFFER_BYTES`, currently 32 MiB) -- past the cap, the
  panel shows a not-available state rather than an unbounded read. Per-file additions/deletions
  follow `diff_stat.rs`'s own `MAX_FILES` (200) and partial-read convention, rendering the same
  "(partial)" wording `sessionDisplay.tsx` already uses for a capped `DiffStat`.
- **Binary files.** A binary file's diff is not rendered as text (same binary-sniff convention
  `diff_stat.rs` already applies); its row still shows in the correct group with a status mark,
  just no line-level additions/deletions figure beyond what git itself reports.
- **`index.lock` collision.** Any git command that fails because another process (including the
  agent itself) holds `index.lock` surfaces as a plain inline `role="alert"` error naming the
  failure, never retried automatically.
- **Agent mid-turn.** Stage/unstage/commit stay fully usable; only the commit box's quiet inline
  warning changes (User Story 2, Acceptance Scenario 5). No action is blocked on this basis alone.
- **Session with no upstream branch.** The ahead/behind figure is omitted entirely rather than
  showing a misleading zero (User Story 3, Acceptance Scenario 2).
- **Conflicted files present.** A file in a merge conflict appears only in the Conflicts group;
  this spec does not add a conflict-resolution action (out of scope, slice 3's successor scope is
  not filed either -- conflict RESOLUTION is not in any of the three filed slices; the Conflicts
  group here is read/stage-state-aware display only, matching `GitStatusMark::Conflicted`'s
  existing meaning).
- **Panel opened for a Session already mid-refresh from a prior action.** A second refresh trigger
  arriving before the first completes does not queue a duplicate overlapping request; the next
  trigger after the in-flight one completes is what actually causes the following refetch (same
  debounce shape `fs/watch.rs` already implements for its own event bursts).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read the Session's worktree git status via `git status
  --porcelain=v2 -z --branch`, parsing both the status entries (reusing `GitStatusMark`'s existing
  `Modified | Added | Untracked | Deleted | Ignored | Renamed | Conflicted | Staged` values) and
  the header lines carrying current branch, upstream branch (if any), and ahead/behind counts, in
  one call.
- **FR-002**: The system MUST group every non-ignored status entry into one or more of four
  groups -- Conflicts, Staged, Changes (modified/deleted/renamed, unstaged), Untracked -- with a
  conflicted entry always sorted into Conflicts regardless of any other mark it might otherwise
  also carry. **Amended (gate round 1 item 5, issue #464; decision recorded by Skippy on behalf
  of Stuart, 2026-10-20)**: a PARTIALLY STAGED file -- an ordinary or rename porcelain v2 record
  where both the X (index) column and the Y (worktree) column are non-`.` (for example `MM`,
  `AM`, `RM`) -- MUST appear as TWO SEPARATE rows for the same path, like VS Code: one in Staged
  (mark driven by the X column: `D`->Deleted, `A`->Added, else `Staged`) and one in Changes (mark
  driven by the Y column: `D`->Deleted, else `Modified` -- Y is only ever `M`/`D`/`T` for an
  ordinary entry per git's own porcelain v2 format, never `A`/`R`). A record whose Y column is
  `.` (nothing further pending in the worktree) still produces exactly one Staged row, X-column
  mark (a rename with Y == `.` keeps its `Renamed` mark here, unlike the dual-membership case
  above, where the Staged half always reads its generic X-driven mark instead). A record whose X
  column is `.` (nothing staged at all) still produces exactly one Changes/Untracked row. Every
  bulk/count figure elsewhere in this spec (FR-003's group counts, FR-004's bulk actions, any
  `MAX_FILES`-style cap) counts each PRODUCED ROW, not each underlying status line.
- **FR-003**: Each group header MUST show the group's name, its current file count, and a
  reserved actions-column slot for a bulk action, reusing `GroupHeaderTrigger`'s exact shape
  (leading chevron, trailing `(N)`).
- **FR-004**: The system MUST provide a bulk "Stage all" action on the Changes and Untracked
  groups and a bulk "Unstage all" action on the Staged group, each an icon button with a tooltip
  and an accessible name that includes the group's own name (for example "Stage all in Changes").
- **FR-005**: Each file row MUST show the file's name and containing folder, a status icon+text
  pair (never colour alone, reusing the File explorer panel's `STATUS_MARKS` icon/label mapping
  per mark), and a `+N`/`-N` badge rendered through the shared `DiffStatCounts` component.
- **FR-006**: Each file row MUST provide per-file actions: Stage (Changes/Untracked/Conflicts
  rows), Unstage (Staged rows), Open diff, and Open in VS Code (the shared action #463's file
  explorer already exposes). **Amended (gate round 1 item 11, issue #464; decision recorded by
  Skippy on behalf of Stuart, 2026-10-20)**: on a Conflicts row this same Stage action is labelled
  "Mark as resolved" (git's own standard phrase for `git add` on a conflicted path) and gated by a
  confirmation naming the file and warning that conflict markers may still be present in it --
  every other row's Stage/Unstage runs immediately, unconfirmed, as before.
- **FR-007**: Stage MUST run `git add --` with the file's own path as a literal post-`--` argv
  entry, sourced only from the current status map's own keys -- never from free text or shell
  interpolation. Unstage MUST run `git restore --staged --` the same way.
- **FR-008**: Selecting a row or its Open diff action MUST open that file's diff (via `git diff` /
  `git diff --cached`, by whether the file is staged) in the main-area tab, reusing `DiffView.tsx`,
  at the full chat-pane width -- never rendered inline inside the hosted pane. **Amended (gate
  round 1 item 14, issue #464, 2026-10-20)**: the open diff MUST show whether it is Staged or
  Unstaged, MUST refetch whenever the panel's own snapshot refreshes underneath it (the three
  FR-015 triggers), and Escape MUST return to the groups list, the same as the explicit Back
  control. **Amended (#1101 item 4, 2026-10-20)**: an Untracked-group file (no index/HEAD side to
  diff against) MUST show its whole content as added (green) lines instead of an empty patch,
  capped and binary-checked by the same size/binary logic FR-019's own additions/deletions count
  already applies to that same file -- an oversized or binary untracked file degrades to the
  existing "No changes" display, never a second, uncapped read path.
- **FR-009**: The system MUST show a fixed, non-scrolling commit box under the scrollable groups/
  rows region, containing a subject-line field with a live character counter, a body field, and a
  Commit button.
- **FR-010**: The Commit button MUST be disabled with a visible reason whenever nothing is staged
  or the message is empty (showing exactly one applicable reason). **Amended (gate round 1 item
  11, issue #464; decision recorded by Skippy on behalf of Stuart, 2026-10-20)**: an unresolved
  conflict (the Conflicts group is non-empty) disables Commit with "Resolve conflicts first",
  checked BEFORE the other two reasons -- git itself refuses to commit any staged changes while
  a conflict remains anywhere in the worktree, regardless of what else is staged or typed.
- **FR-011**: Pressing Commit, or pressing Ctrl+Enter anywhere in the message field, MUST run `git
  commit -F -` with the composed message piped on stdin (never `-m`), then clear the message field
  and trigger a panel refetch.
- **FR-012**: Whenever the focused Session's status is `Working`, the commit box MUST show a quiet
  inline warning ("Agent is working -- review before committing") without disabling Commit on that
  basis alone and without any modal interruption.
- **FR-013**: Any git-command failure during stage, unstage, or commit (including an `index.lock`
  collision) MUST surface as a plain inline `role="alert"` error naming what failed, and MUST NOT
  be retried automatically. **Amended (gate round 1 item 3, issue #464, 2026-10-20)**: this error
  (`actionError`) is tracked independently of a plain `load` failure (`loadError`) -- a background
  refresh succeeding underneath an unacknowledged action failure MUST NOT silently clear it; only
  starting another action or an explicit dismiss clears it.
- **FR-014**: The system MUST show a branch + ahead/behind header reusing `SessionDetailsCard.tsx`
  's branch-line shape (`GitBranchIcon` + branch name + muted "from {base}"), with a muted
  icon+text ahead/behind figure appended when an upstream exists, and the figure entirely omitted
  when there is no upstream.
- **FR-015**: The system MUST refetch the panel's full state (status, branch/ahead-behind) on
  three triggers, only while the panel is open for that Session: (a) that Session's status
  transitioning away from `Working`; (b) a worktree file-system change reported by the existing
  debounced `notify` watcher (`fs/watch.rs`), reused rather than duplicated; (c) immediately after
  every stage/unstage/commit action completes. **Amended (gate round 1 item 2, issue #464,
  2026-10-20)**: overlapping refetches for the same Session MUST be single-flighted (concurrent
  calls share the one in-flight request rather than each firing their own) with at most one
  coalesced trailing rerun, and a stale response MUST NOT ever overwrite a newer one.
- **FR-016**: The system MUST NOT watch or refetch for a Session whose Git changes panel is not
  currently open.
- **FR-017**: A worktree with no pending changes MUST show the existing honest-empty-state
  convention (icon, single line of text, no Sample-data badge), with the branch/ahead-behind
  header still rendered above it.
- **FR-018**: The status read MUST be capped at the same `STATUS_MAX_BUFFER_BYTES` limit
  `status.rs` already enforces for the File explorer panel; exceeding it MUST show a not-available
  state rather than attempting an unbounded read.
- **FR-019**: Per-file additions/deletions MUST follow `diff_stat.rs`'s own `MAX_FILES` cap and
  partial-result convention, rendering the same "(partial)" wording `sessionDisplay.tsx` already
  uses for a capped `DiffStat`.
- **FR-020**: The system MUST register a new `git-changes` entry in `HOSTED_PANELS`
  (`panel-registry.ts`), wired identically to `file-explorer`/`side-chat` (closable, tab-bar-
  eligible, listed in the centred launcher), with a `PanelCount` of the existing
  `{ kind: 'additions-deletions', additions, deletions }` shape.
- **FR-021**: The existing Changes readout chip (#435) MUST become a button that opens the Git
  changes panel for that pane's focused Session.
- **FR-022**: Each Split pane MUST show its own focused Session's Git changes panel independently
  of any other pane's panel state (no shared/dual-rooted panel).
- **FR-023**: Ctrl+Enter MUST commit from anywhere in the message field (subject or body), matching
  the main composer's own send shortcut. **Amended (gate round 1 item 7, issue #464, 2026-10-20)**:
  Cmd+Enter does the same, and a composing IME keystroke's own Enter MUST NOT be treated as this
  shortcut.
- **FR-024**: No commit-message format is enforced; the subject-line counter is a length guide
  only, never a validator blocking Commit.
- **FR-025**: Commit author identity MUST come solely from the worktree's own `git config
  user.name`/`user.email`; the system MUST NOT provide a Refract-side override, and an
  unconfigured identity surfaces as git's own plain error (FR-013).
- **FR-026**: After a single-file stage/unstage (or Commit), focus MUST return to that same row in
  its new group if it still exists, else the nearest surviving group trigger (gate round 1 item 7,
  issue #464, 2026-10-20). A bulk Stage-all/Unstage-all MUST focus the next group's own trigger.
  Opening a diff MUST focus its own Back control; returning from it (Back or Escape) MUST focus
  the row that opened it. A successful commit MUST focus the subject field and announce what was
  committed once (`role="status"`).
- **FR-027** (#1101 item 1): The subject field's character counter MUST be hidden on an empty
  field and show `n/72` once the subject has at least one character, muted at rest, switching to
  a warning colour past 50 characters and an error colour past 72 -- visual only, never enforced
  (FR-024 unchanged) -- with an `sr-only` "Subject length" label giving the value an accessible
  name.
- **FR-028** (#1101 item 2): The commit subject and body fields MUST reuse the composer's own
  surface, border and focus-visible classes (ADR 0003, `MessageInput.tsx`'s composer wrapper),
  not the shared `Input`/`Textarea` primitives' generic default look.
- **FR-029** (#1101 item 3): While a stage, unstage, stage-all, or unstage-all call is in flight,
  the row or group control that triggered it MUST show a spinner and `aria-busy="true"`, and MUST
  be disabled against a repeat click until that call settles; the existing app-level
  `role="status"` announcement region (`chatAreaAnnouncer.ts`) covers the screen-reader side, with
  no second, newly-added live region.
- **FR-030** (#1101 item 6): The diff pane's Back control MUST be a ghost, icon-only button
  (`ArrowLeftIcon`) with an `aria-label` naming the file (for example "Back to changes from
  README.md"), replacing the previous labelled outline button.
- **FR-031** (#1101 item 7): The Back button MUST stay visible at the top of the diff pane while
  its content scrolls (`sticky` positioning) -- a stop-gap removed entirely once #1102's
  main-area-tab diff view ships, never a tab-order or focus change.

### Key Entities *(include if feature involves data)*

- **Git changes group**: one of four fixed buckets (`conflicts | staged | changes | untracked`)
  that every non-ignored status entry sorts into exactly once, each carrying its own ordered list
  of file rows and a count.
- **Git changes file row**: one path's display state for this panel -- its relative path and
  folder, its `GitStatusMark` (reusing the existing enum, extended for exactly this purpose per
  `status.rs`'s own header comment), and its additions/deletions (capped per FR-019).
- **Git changes header**: the panel's branch-line data -- current branch name, base branch name,
  and an optional ahead/behind pair (`None` when there is no upstream).
- **Panel count** (`additions-deletions`): the existing `PanelCount` shape, reused unchanged,
  summing every visible file row's additions/deletions for the tab/rail badge.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can see every pending change in a Session's worktree, correctly grouped,
  within one panel open, with no separate action needed to load each group.
- **SC-002**: Staging or unstaging a single file updates that file's group membership and both
  affected group counts without a visible full-panel reload.
- **SC-003**: A commit the developer composes and submits in this panel is reflected by `git log`
  with the exact message typed, and the panel's Staged group is empty immediately afterward.
- **SC-004**: An external file-system change to the worktree is reflected in the open panel within
  the existing watcher's debounce window, with no developer action required.
- **SC-005**: Every status, action-disabled, and error state in this panel is conveyed by icon and
  text together, never by colour alone, verifiable by viewing the panel with colour removed.
- **SC-006**: A repository whose status read exceeds the existing size cap shows a not-available
  state instead of hanging or crashing the panel.

## Assumptions

- Windows 11 only, Tauri 2/Rust backend, React renderer -- consistent with the rest of this
  repository (constitution, Platform and Stack).
- `omp commit` (slice 2's AI-draft mechanism) is entirely out of this slice's build; this spec's
  own commit box only ever runs a plain `git commit -F -` with a developer-typed message.
- Discard, amend, push, pull, branch switching, merge-conflict resolution, stash, and hunk/line
  staging are out of scope for this spec (slice 3 or later); no UI affordance for any of them is
  designed here.
- `src-tauri/src/git/status.rs`'s existing `GitStatusMark` enum and its precedence rules
  (conflict > rename > delete/add > staged-vs-modified) are reused as-is for the status-entry
  shape; this spec's own new v2-porcelain reader builds the same mark values from a different
  input format, it does not change the enum itself.
- The existing `fs/watch.rs` debounced watcher is reused unchanged; no second watcher
  implementation is introduced.
- No new Tauri capability grant is required (plan.md's Constitution Check addresses this
  directly): git is shelled the same way `git/git.rs`'s existing `git_raw`/`git` helpers already
  do, through the already-capability-free process-spawn path every other git-backed feature in
  this app uses.

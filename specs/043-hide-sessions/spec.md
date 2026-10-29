# Feature Specification: Hide Sessions

**Feature Branch**: `hide-session-748`
**Status**: Draft
**Input**: Issue #748, "Session list: hide a Session from the list without archiving it (agent keeps running, still searchable), with a Show hidden toggle". Numbered 043: 041 is the latest; 042 is taken elsewhere.

## Clarifications

### Session 2026-10-29 (grill and clarify, Skippy delegated by Stuart; full text in the "Decided" comment on #748)

- Hide is its own flag (`hiddenAt`), independent of `archivedAt`. Hide never stops the agent or touches the Worktree.
- A hidden Session never resurfaces, even when it needs you, errors or has an Unread response; the Show hidden toggle carries the count. OS notifications still fire.
- Toggle: `Toggle variant="subtle" size="icon-xs"`, leftmost in the Collapse/Expand toolbar row, `aria-pressed`, a stable name with the count, `CountBadge tone="neutral"`. Rendered only when hidden Sessions exist or it is on. Focus goes to Collapse all if it vanishes while focused.
- Hidden row: `text-muted-foreground` title (no opacity), EyeOffIcon and "Hidden" on line 1, "Hidden" in the accessible name.
- Hidden and archived Sessions appear in the Archived group only while Show hidden is on; group counts and visibility count visible Sessions only.
- Menu: a text-only Hide / Unhide item above Archive / Restore, from the shared `sessionActions.ts` list.
- Toast "Hid <name>" with Undo, 10 s (patterns.md: only errors persist). Undo returns focus to the row.
- Focus after Hide: the archive fallback when the toggle is off; the row's menu trigger when it is on.
- Pane header: on-screen `Badge variant="secondary"` with EyeOffIcon and "Hidden".
- Manage sessions: a fourth tab, Hidden; the group label becomes "Filter sessions"; All, Active and Archived list hidden rows with a Hidden marker.
- Search (#559) matches hidden Sessions even with the toggle off and tags them Hidden; the "Showing X of Y" totals count them.
- A Project whose Sessions are all hidden disappears while the toggle is off.
- Remove repository counts hidden Sessions; auto-archive (#476) ignores hidden. Out of scope: pinning, mute, hiding Projects, bulk hide.
- Clarify pass: no remaining ambiguity that changes the implementation.

## Requirements

- **FR-001** `Session.hiddenAt` (optional ISO string) is persisted in the registry (`src-tauri/src/store/registry.rs`) and flows to the renderer in `SessionSummary` unchanged. IPC `sessions.setHidden(id, hidden)` is idempotent, stamps or clears `hiddenAt`, fires `session:list-changed`, and never touches the agent or Worktree.
- **FR-002** `Settings.sessionListCollapse.showHidden` (default false) persists the toggle with the other list view state; `session-list-store.ts` stays its only writer.
- **FR-003** With Show hidden off, hidden Sessions are absent from their Project's group and from Archived; a Project with only hidden Sessions is absent. With it on they appear, in place, in the Hidden look (FR-005).
- **FR-004** The Show hidden toggle and its badge use the same status logic as row icons (`groupWaitingState`) so the count agrees with them.
- **FR-005** The Hidden row look and accessible name; Hide/Unhide menu item and toast with Undo; focus rules; pane-header badge.
- **FR-006** Search, Manage sessions Hidden tab, Remove repository counts, per the clarifications.
- **FR-007** CONTEXT.md gains Hide / Hidden Session; patterns.md gains a Hide row and rewords Archive.

## Success criteria

- `pnpm ci:local` is green on the merged tree; a live check on a scratch exe hides, shows, unhides and searches a Session.
- Existing files stay at or under their `scripts/file-size-baseline.json` values; new files stay under 600 lines; reusable components only (ADR 0003).
- No new tests (prototyping phase); existing tests keep passing.

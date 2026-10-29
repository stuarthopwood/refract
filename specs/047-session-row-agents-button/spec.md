# Feature Specification: Session row agents button

**Feature Branch**: `session-row-agents-button`
**Status**: Draft
**Input**: Issue #507, "Session list: agents button with a subagent count on each Session row, opening the Agents panel". Numbered 047.

## Clarifications

### Session 2026-10-29 (grill and clarify, Skippy delegated by Stuart; full text in the "Decided" comment on #507)

- Origin/main check: nothing shipped. `SessionSummary.activity.runningSubagents` (#526) already carries a live per-Session running count, patched from `session:activity`, so no IPC field or `session:list-changed` emitter is needed. One Rust tweak (found by the live check): `activity_value` (`readout_activity_emit.rs`) used to return `null` whenever no turn was running, which hid a background subagent that outlives its turn; it now keeps `{runningSubagents, todo: null}` while any subagent still runs. The failed/finished breakdown is not on `SessionSummary` and is deferred.
- Count = running only. The button renders only while running > 0 (a quiet row; the Subagents chip and panel still show finished and failed).
- Button: `Button variant="ghost" size="xs"`, `UsersIcon` plus the count as real text ("9+" above 9), `text-muted-foreground`, after Resume and before the time cell. Tab order: row button, Resume, agents, the actions menu.
- Name and tooltip: "3 agents running in <Session>. Open Agents panel." (singular: "1 agent running in ..."), the tooltip also on keyboard focus.
- Click: selects the Session exactly as the row does (focused pane), then `openHostedPanel('subagents', id, { opener })`. The click does not bubble to the row.
- Ruled by ui-architect-v3: line 1 right padding grows by 40px while the button shows; on touch the time cell is hidden while it shows. The button stays local to the session-list feature (no second caller yet), in its own file.
- The ui-architect also suggested an "Open Agents panel" menu item. Deferred: `sessionActions.ts` is shared with Manage sessions, whose row sits at its file-size baseline (662), so the item would force edits there for no new capability.
- Out of scope: failed marker, expand-group-in-panel, the details card and Manage sessions counts, live "all finished" announcement, stopped-Session last-known count, the menu item.

## Requirements

- **FR-001** A Session row whose `activity.runningSubagents` is above 0 shows the agents button; at 0 or absent (including stopped Sessions) it renders nothing and reserves no space.
- **FR-002** The count updates live for background Sessions through the existing `session:activity` patch; no transcript or stream data is added to any channel.
- **FR-003** The button's accessible name and tooltip are identical and pluralised per the clarifications; the count is visible text.
- **FR-004** Clicking selects the Session and opens the Subagents panel bound to it; keyboard Enter and Space do the same.
- **FR-005** Line 1 never collides with the trailing group: padding follows the ruled table; Ctrl+1 to Ctrl+9 numbering, F2 rename and the focus fallback chain are unchanged.

## Success criteria

- `pnpm ci:local` green; a live check on a scratch exe shows the button with a count on a Session with running agents and the Agents panel opening on click.
- File-size baselines respected; no new tests (prototyping phase); existing tests pass.

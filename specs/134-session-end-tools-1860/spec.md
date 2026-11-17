# Feature Specification: Agents archive, stop, pause, resume and delete Sessions

**Feature Branch**: `feat/1860-session-end-tools`
**Created**: 2026-11-17
**Status**: Draft
**Input**: GitHub issue #1860 (P0 Agent Sessions slice 4 of 6, child of #1304); builds on spec 124 (tool channel), spec 129 (read tools, #1858), spec 131 (create and nest, #1859, ADR 0009) and spec 133 (Personal Agent). Reuses the background delete of spec 113 (#1591) and the pause path of spec 127 (#1835). Route: specify (grill done with Stuart on 2026-11-17).

## Problem

An agent can list, read, message, create and re-arrange Sessions, but it cannot end or park one. Finished or runaway work stays in the list until the developer clears it by hand. This slice adds six **Host tools** that let an agent archive, unarchive, stop, pause, resume and delete a Session, with the approval card guarding every step that loses work.

## User Scenarios & Testing

### User Story 1 - Archive a Session or a whole subtree (Priority: P1)

An agent that has finished a batch of child Sessions archives them. With `include_children: true` the target and every descendant are archived, and the developer sees one approval card listing every Session that will be archived.

**Why this priority**: Archiving is the everyday clean-up and the only cascade in the slice.

**Independent Test**: With the fake omp, call `refract_archive_session` on a Session with two children and `include_children: true`; one card lists three Sessions; approving archives all three and stops their agents.

**Acceptance Scenarios**:

1. **Given** a Session with live children, **When** the agent calls `archive_session(id)` without `include_children`, **Then** one card names that Session and only it is archived; its live children keep their link (ADR 0009).
2. **Given** a subtree of three Sessions, **When** the agent calls `archive_session(id, include_children: true)`, **Then** exactly one card lists all three names and, once approved, all three are archived and their agents stopped.
3. **Given** the developer denies the card, **When** the call resolves, **Then** it returns `denied` and nothing is archived.
4. **Given** the caller runs in `yolo`, **When** it archives any Session, **Then** no card is raised.

### User Story 2 - Stop, pause and resume (Priority: P1)

An agent stops a Session it no longer needs, or pauses one to hold its messages and resumes it later, through the existing Rust paths.

**Why this priority**: Stop and pause are the control levers for runaway work.

**Independent Test**: Pause a running child of the caller (no card, own tree), resume it, then stop an unrelated Session (card).

**Acceptance Scenarios**:

1. **Given** a running descendant of the caller, **When** the agent calls `pause_session` or `resume_session` on it, **Then** no card is raised and the Session is paused or resumed through the existing pause path.
2. **Given** a Session outside the caller's own tree, **When** the agent calls `pause_session`, `resume_session` or `unarchive_session` on it, **Then** the approval card is raised unless the caller runs in `yolo`.
3. **Given** any running Session, **When** the agent calls `stop_session`, **Then** the card is raised (skipped in `yolo`) and approval stops the agent the same way the Stop action does.

### User Story 3 - Unarchive within the tree rules (Priority: P2)

An agent restores one archived Session; the 4-live-children gate of ADR 0009 still applies.

**Acceptance Scenarios**:

1. **Given** an archived Session whose parent already has 4 live children, **When** the agent calls `unarchive_session`, **Then** it returns `child_limit` and nothing changes.
2. **Given** an archived Session with archived descendants, **When** it is unarchived, **Then** only that Session is restored.

### User Story 4 - Delete with approval, even in yolo (Priority: P1)

An agent deletes a Session. The card is raised in every mode, including `yolo`; after approval the removal runs as the background delete of #1591 and live children are re-rooted (ADR 0009).

**Acceptance Scenarios**:

1. **Given** the caller runs in `yolo`, **When** it calls `delete_session`, **Then** the card is still raised.
2. **Given** approval, **When** the delete starts, **Then** the call returns at once with `outcome: "deleting"`, the Session shows as deleting, and its live children become roots in the same registry write that removes it.
3. **Given** the worktree holds an open file or a removal is already running, **When** the agent calls `delete_session`, **Then** the same refusal the Delete Session flow gives comes back as a tool error and nothing is removed.

### Edge Cases

- **Self or ancestor target**: every tool refuses with `invalid_target`; descendants and unrelated Sessions are allowed. The check runs before any card.
- **Personal Agent target**: every tool refuses with `invalid_target`; spec 133's interim rule stands and #2018 revisits it.
- **Unknown, other-Project or already-gone id**: `not_found`.
- **State mismatches** (archive an archived Session, unarchive a live one, stop a stopped one, pause a paused one, resume a Session that is not paused, any action on a Session being deleted): `invalid_state`, no card.
- **Pause or resume of a stopped Session**: `session_not_running`; resume never starts a Session.
- **Archive cascade with a Session being deleted in the subtree**: refused whole with `invalid_state`; nothing is archived.
- **Caller deleted while the card is open**: `cancelled`, nothing changed.
- **Subtree changed while the card was open** (a descendant added or moved): the write re-checks under the Project tree gate and refuses with `cancelled` when the listed set differs, so the developer never approves one set and gets another.
- **Cancelled or shut-down call**: the write is spawned and awaited, as in spec 131, so no half-applied cascade is left.

## Requirements

### Functional Requirements

- **FR-001**: Six Host tools register for every launch, with the `refract_` prefix: `refract_archive_session(id, include_children?)`, `refract_unarchive_session(id)`, `refract_stop_session(id)`, `refract_pause_session(id)`, `refract_resume_session(id)`, `refract_delete_session(id)`. Errors use spec 124's `{ error: { code, message } }` with `isError: true`; results are capped at 8 KiB.
- **FR-002**: Every tool refuses, with `invalid_target`, a target that is the caller's own Session or any ancestor of it. Descendants and unrelated Sessions are allowed, subject to FR-004.
- **FR-003**: Every tool refuses a Personal Agent target with `invalid_target` and a message that says the Personal Agent cannot be changed by tools.
- **FR-004**: Approval: `archive_session` and `stop_session` raise the card in every mode and `yolo` skips it; `pause_session`, `resume_session` and `unarchive_session` raise it only when the target is outside the caller's own tree, and `yolo` skips it; `delete_session` raises it in every mode including `yolo`. All cards use the existing Refract-owned approval card.
- **FR-005**: `archive_session` with `include_children: true` archives the target and every descendant (live or archived children are walked; already archived ones are skipped) under one card that lists every Session it will archive. Without the flag only the target is archived and live children keep their link.
- **FR-006**: Archiving stops the Session's agent, clears its process records and stamps `archivedAt` through the same code the Archive action uses, so Explorer reset, watcher stop and disk-reclaim hooks all run.
- **FR-007**: `unarchive_session` restores only the named Session and applies the existing 4-live-children gate under the Project tree gate; a full parent returns `child_limit`.
- **FR-008**: `stop_session` stops the named Session only, through the code behind the Stop action. `pause_session` and `resume_session` act on the named Session only, through the existing Rust pause and resume path (spec 127), including its handling of held messages and subagents.
- **FR-009**: `delete_session` runs the same refusal checks as the Delete Session flow, raises the card, then hands the removal to the background delete of spec 113 and returns `outcome: "deleting"`. The registry removal re-roots live children to roots in one persist and archived children keep their link (ADR 0009); the tool adds no second re-rooting path.
- **FR-010**: The tool descriptions, names and parameter schemas appear everywhere tool names are listed: the tool list, the approval overlay, the token-guard rules, the shipped agent rules file, the registration test and the `yolo` read.
- **FR-011**: A cascading or deleting call that completes returns the affected ids so the agent can read them back with `refract_list_sessions`; no result carries secrets or paths.
- **FR-012**: A call is checked again under the Project tree gate after the card resolves, so a racing create, update or delete cannot make the approved set differ from the applied set.
- **FR-013**: No new renderer round trip: every check and write runs in Rust, and the renderer only sees the existing card and list-changed events.
- **FR-014**: No new tests are skipped: every guard (self, ancestor, Personal Agent, approval table, cascade set, 4-live-children gate, in-flight delete) has a test that fails when the guard is removed.

### Key Entities

- **Session**, **Own tree**, **Child Session**: as in CONTEXT.md and ADR 0009; archive keeps links, delete re-roots live children.
- **End tool**: one of the six tools in this slice.
- **Cascade set**: the target plus every descendant, computed under the Project tree gate and listed on the card.

## Success Criteria

- **SC-001**: With the fake omp, each of the six tools works end to end through the real tool channel, including the card (approve and deny) for each approval-table row.
- **SC-002**: In `yolo` only `delete_session` still raises a card.
- **SC-003**: Self, ancestor and Personal Agent targets are refused by all six tools before any card.
- **SC-004**: An archive cascade over a three-Session subtree raises exactly one card listing three names and archives all three.
- **SC-005**: A deleted Session's live children are roots after the delete; its archived children keep their link.
- **SC-006**: `pnpm ci:local` passes and no touched file exceeds 600 lines.

## Assumptions

- Specs 124, 129, 131, 133 and the background delete have merged; the Personal Agent is the one Session with `is_personal()`.
- Tool names, ids and the router are the identity; no new id scheme.
- The caller's mode (`yolo` or ask) is read from the same place the update tool reads it.

## Out of Scope

- Conversation tools (#1861), Session-list tree UI (#1862), unarchiving a subtree, cascading stop, pause or delete.
- Letting an agent act on the Personal Agent (#2018).
- Pausing or resuming a stopped Session, and starting any Session.

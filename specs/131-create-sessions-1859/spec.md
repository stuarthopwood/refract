# Feature Specification: Agents create and nest Sessions

**Feature Branch**: `feat/1859-create-sessions`
**Created**: 2026-11-12
**Status**: Clarified
**Input**: GitHub issue #1859 (P0 Agent Sessions slice 3 of 6, child of #1304; builds on #1858 / spec 129 and #1193 / spec 124) plus the grill with Stuart on 2026-11-12. Route: specify.

## Problem

An agent can now see and message every Session (spec 129) but cannot start a piece of long-lived, user-visible work in a Session of its own. Slices 4-6 of #1304 (archive/stop, Conversation handoff, tree UI) need Sessions that know their parent. This slice lets an agent create a Session, arrange Sessions into a tree, and learn when to use one instead of a subagent.

Two **Host tools** join the #1193 **Tool channel**: `create_session` makes a **Child Session** (own Worktree and branch, agent started with the prompt as its first turn) and `update_session` renames, re-roles, nests and un-nests Sessions. Rust enforces depth 3 and at most 4 live children per parent. Every launch also carries a short rule-of-thumb block that says when a Session is the right tool.

## Decisions

### Decided (Stuart, 2026-11-12, grill)

1. **Live child** is a child that is not archived. Stopped and hidden children count toward the limit of 4.
2. **Re-parenting.** `update_session` rejects a parent that is the Session itself or one of its descendants, and rejects a move that would put any descendant deeper than 3. Both are tool errors.
3. **Own tree** is the calling agent's Session plus its descendants. Changes inside it run without the approval card; changes to siblings, parents and other roots raise the card.
4. **Parent deleted.** Live children are re-rooted: `parent_session_id` is set to null in the registry. Archiving a parent keeps the link.
5. **Role.** When omitted, the Project default is used. An unknown role returns `invalid_input`. A child never inherits the parent's role.
6. **Report-back.** A report from a child to its parent is a Session message (#1858) and counts against the per-pair limit of 10 per 10 minutes.

### From the issue (#1859 scope, not reopened)

7. Tools `create_session(prompt, name?, base_branch?, role?, parent_id?)` and `update_session(id, name?, role?, parent_id?)`. Depth 3 and 4 live children per parent are enforced in Rust; violations are tool errors, never toasts.
8. The child is made by the existing Session creation path, so it is indistinguishable from a hand-made Session except for the parent link. Base is the Project's default branch unless `base_branch` is passed (for example the caller's own branch, to stack).
9. `create_session` raises the existing approval card unless the creating Session runs in `yolo`. A rename in the agent's own tree runs straight away; other changes outside it raise the card.
10. The child's first turn names its parent (id and name) and tells it to report back with `send_session_message`. A report is delivered to a busy parent as a queued user turn.
11. `registry::Session` gains `parent_session_id: Option<String>` with `#[serde(default)]`, so an old `registry.json` loads and every old Session has no parent.
12. Every agent launch appends the rule-of-thumb block through `--append-system-prompt`; the `create_session` tool description repeats it. Subagents and background agents stay with #712 and epic #1272.

### Decided (Skippy, delegated by Stuart, 2026-11-12; recorded by clarify)

13. **Names carry the `refract_` prefix** (spec 124 decision 2): `refract_create_session`, `refract_update_session`.
14. **Access.** `create_session` and `update_session`, with the three spec 129 tools, are registered for every Refract-launched Session at depth 1, 2 and 3. A child must be able to call `send_session_message` to report back, so the Session tools cannot stay Root-only. The `Role::Child` row (the #1858 contract) stays empty and keeps its `unknown_tool` test; Sessions made by `create_session` launch as `Role::Root` with their real `depth`. Rust enforces limits from the registry, never from `ToolAccess.depth`.
15. **Project of a new Session.** The parent's Project when `parent_id` is given, otherwise the caller's Project. A `parent_id` in another Project is `invalid_input`.
16. **`parent_id` tri-state.** Absent on `create_session` means the caller is the parent; `null` means a root Session. On `update_session` absent means unchanged and `null` un-nests.
17. **Approval mode source.** The caller's launched approval mode (the stream owner's; the card shows in the caller's chat). The parent is the caller unless `parent_id` says otherwise, so the issue's "parent's approval mode" is the caller's in the common case.
18. **Own-tree test for `update_session`.** Both the target Session and a new parent, when set, must be inside the caller's tree for the card to be skipped. Un-nesting a Session in the tree is inside.
19. **`update_session` role** goes through the existing role choice (`pending_selection::choose_role`): applied now when idle, otherwise at the next idle. A target with no live agent returns `session_not_running` with its status; nothing is started. `create_session` applies the role to the new agent right after it starts, before the first turn is sent.
20. **Rename** reuses the registry rename path and its validation.
21. **Atomicity.** One process-wide async tree gate is held from the limit check to the registry insert (create) and to the patch (update), so two creates or re-parents cannot both pass the check. The Worktree is made inside the gate; a failure removes only what the call created.
22. **Start failure.** If the row exists but the agent fails to start, the Session stays (it is an ordinary Session with a stop reason) and the tool returns `start_failed` whose message names the new id.
23. **First-turn text.** `[Parent Session: "<name>" (id <id>). When you finish, report back with refract_send_session_message to that id.]` then a blank line and the prompt. No parent line for a root Session. It is a plain user turn, not a Session-message envelope, because no Session sent it.
24. **No working-mode decoration** on the first turn, as for Session messages (spec 129 decision 14).
25. **Size limit.** `prompt` is 1 byte to 32 KB, like a Session message; otherwise `invalid_input`.
26. **Dangling links.** A parent id that is not in the registry counts as no parent everywhere (depth, own tree, limits). Only live children are rewritten on delete (decision 4); archived children keep a harmless dangling link until unarchived or re-parented.
27. **Archived parent.** `create_session` or `update_session` naming an archived parent returns `invalid_input`.
28. **Where the rule-of-thumb block lives.** Appended to the existing `refract-rules.md` (already passed with `--append-system-prompt` on every launch) rather than a second file; the shipped-rules size test bound is raised in the same task. The block is at most 900 characters.
29. **Contract 129 is extended, not replaced:** `list_sessions` rows and `get_session_status` add `parentId` when set (FR-016).
30. **New error codes:** `depth_limit`, `child_limit`, `invalid_parent`, `start_failed`; denial reuses spec 124's approval-denied error.

## Clarifications

### Session 2026-11-12 (answered from the grill; Stuart was not asked live)

- Q: When is a child "live" for the limit of 4? -> A: Decided (Stuart, 2026-11-12, grill): not archived; stopped and hidden count.
- Q: What does re-parenting refuse? -> A: Decided (Stuart, 2026-11-12, grill): self or descendant as parent, and any move that puts a descendant deeper than 3.
- Q: What is the agent's own tree and what skips the card? -> A: Decided (Stuart, 2026-11-12, grill): the agent plus its descendants; inside runs without the card, siblings, parents and other roots raise it.
- Q: What happens to children when the parent is deleted or archived? -> A: Decided (Stuart, 2026-11-12, grill): live children re-rooted on delete; archive keeps the link.
- Q: Which role does a new Session get? -> A: Decided (Stuart, 2026-11-12, grill): the Project default when omitted; unknown is `invalid_input`; never inherited.
- Q: Does a report-back count against the message limit? -> A: Decided (Stuart, 2026-11-12, grill): yes, it is a Session message.
- Q: Do the tool names carry the prefix? -> A: Decided (Skippy, delegated): decision 13.
- Q: Which Sessions get the tools, given a child must report back? -> A: Decided (Skippy, delegated): decision 14.
- Q: Which Project does a new Session belong to, and what does an omitted or null `parent_id` mean? -> A: Decided (Skippy, delegated): decisions 15 and 16.
- Q: Whose approval mode governs the card, and what is inside the own tree for a re-parent? -> A: Decided (Skippy, delegated): decisions 17 and 18.
- Q: How is a role applied, to a stopped target? -> A: Decided (Skippy, delegated): decision 19.
- Q: How are racing creates kept within 4 children? -> A: Decided (Skippy, delegated): decision 21.
- Q: What if the agent fails to start after creation? -> A: Decided (Skippy, delegated): decision 22.
- Q: Exact first-turn text and prompt limits? -> A: Decided (Skippy, delegated): decisions 23 to 25.
- Q: What about archived children of a deleted parent and archived parents? -> A: Decided (Skippy, delegated): decisions 26 and 27.
- Q: Where does the rule-of-thumb block go? -> A: Decided (Skippy, delegated): decision 28.
- Q: Does contract 129 change, and which error codes are new? -> A: Decided (Skippy, delegated): decisions 29 and 30.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent starts a Session of its own (Priority: P1)

An agent calls `create_session` with a prompt and gets back a new Session id. The new Session has its own Worktree and branch and is already working on the prompt.

**Why this priority**: the whole slice exists for this.

**Independent Test**: fake-omp tape calls `create_session` in `yolo` and in a card-raising mode; assert the registry row, the Worktree, the child's first `prompt` frame and the returned id.

**Acceptance Scenarios**:

1. **Given** a Root Session in `yolo`, **When** it calls `create_session` with a prompt, **Then** a Session exists with its own Worktree and branch from the Project's default branch, `parent_session_id` set to the caller, the agent started, and the tool returns `{id, name, branch, parentId, status}`.
2. **Given** a Session not in `yolo`, **When** it calls `create_session`, **Then** the approval card appears first; Approve creates the Session, Deny or Cancel returns a tool error and creates nothing.
3. **Given** `base_branch` set to an existing branch, **Then** the Worktree is cut from it; an unknown branch returns `invalid_input` and creates nothing.
4. **Given** `name` omitted, **Then** the existing generated name is used; **Given** `role` omitted, **Then** the Project default applies; an unknown `role` returns `invalid_input`; a child never inherits the caller's role.
5. **Given** an empty prompt or one over 32 KB, **Then** `invalid_input`.
6. **Given** `parent_id` omitted, **Then** the caller is the parent; **Given** `parent_id` is an existing Session of the same Project, **Then** that Session is the parent; **Given** `parent_id: null`, **Then** the new Session is a root.

### User Story 2 - Depth and width are enforced (Priority: P1)

**Independent Test**: Rust unit tests on the tree rules plus a tape that makes a fifth child and a depth-4 child.

**Acceptance Scenarios**:

1. **Given** a parent with 3 live children, **When** a fourth is created, **Then** it succeeds; **When** a fifth is created, **Then** the tool returns `child_limit`.
2. **Given** a Session at depth 3, **When** it calls `create_session` with itself as parent, **Then** the tool returns `depth_limit`; a depth-1 or depth-2 Session can create one.
3. **Given** an archived child, **Then** it does not count toward 4; a stopped or hidden child does.
4. **Given** two `create_session` calls racing on a parent with 3 live children, **Then** exactly one succeeds.

### User Story 3 - The child knows its parent and reports back (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a created child, **Then** its first user turn names the parent (id and name), says to report back with `send_session_message`, and then carries the prompt.
2. **Given** the child calls `send_session_message` to its parent, **Then** it is an ordinary Session message: queued as a follow-up when the parent is busy, and counted in the per-pair limit of 10 per 10 minutes.
3. **Given** a child created with `parent_id: null`, **Then** its first turn has no parent line.

### User Story 4 - The agent arranges Sessions (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a Session in the agent's own tree, **When** `update_session` renames, re-roles, nests or un-nests it, **Then** it runs without the card.
2. **Given** a target Session or new parent outside the own tree, **Then** the card is raised first; Deny returns a tool error and changes nothing.
3. **Given** a new parent that is the Session itself or one of its descendants, **Then** `invalid_parent`; **Given** a move that puts any descendant deeper than 3, **Then** `depth_limit`; **Given** a new parent that already has 4 live children, **Then** `child_limit`.
4. **Given** `parent_id: null`, **Then** the Session becomes a root; absent `parent_id` leaves the link unchanged.
5. **Given** an unknown role, **Then** `invalid_input`; an unknown id, `not_found`.

### User Story 5 - Old and deleted data stay sound (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a `registry.json` written before this change, **Then** it loads and every Session has no parent.
2. **Given** a parent is deleted, **Then** its live children are re-rooted (`parent_session_id` null); **Given** a parent is archived, **Then** the links stay.
3. **Given** a link whose parent no longer exists, **Then** every depth and own-tree calculation treats the Session as a root.

### User Story 6 - Agents learn when to use a Session (Priority: P3)

**Acceptance Scenarios**:

1. **Given** any launch, **Then** the appended rules contain the rule-of-thumb block: a bounded report is a subagent (OMP `task`), the same work in parallel is a background agent (OMP `task`, async), and an own-branch, long-lived, user-visible piece of work is a child Session.
2. **Given** the tool list, **Then** the `create_session` description repeats the block.

### Edge Cases

- A call from a Session whose process is shutting down is answered `cancelled`, as in spec 124.
- Creating while the Project's repository is gone or the Worktree cannot be made: tool error, no registry row, no leftover Worktree.
- The agent fails to start after the row exists: the Session stays (it is a normal Session) and the tool returns `start_failed` naming the new id.
- Re-parenting a Session across Projects is `invalid_input`.
- The caller is deleted while its child is being created: the call is answered `cancelled`; no orphan link is written.
- Until the tree UI (#1862) lands a child shows as a flat row; nothing here changes the Session list.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Session tools (`refract_list_sessions`, `refract_get_session_status`, `refract_send_session_message`, `refract_create_session`, `refract_update_session`) MUST be registered for every Refract-launched Session at any depth; the `Role::Child` row of `tools_for` MUST stay empty and a call to a Session tool under it is `unknown_tool`.
- **FR-002**: `create_session` MUST accept `prompt`, optional `name`, `base_branch`, `role`, `parent_id`, create the Session through the existing creation path, start its agent with the prompt as the first turn, and return `{id, name, branch, parentId, status}`.
- **FR-003**: `create_session` MUST raise the existing approval card unless the caller's approval mode is `yolo`; a denied or cancelled card MUST create nothing and return a tool error.
- **FR-004**: The new Session MUST be created by the same code the hand-made path uses, differing only by `parent_session_id`.
- **FR-005**: Rust MUST refuse a Session at depth 3 as parent with `depth_limit`, depth counted from the registry parent chain (root = 1), and a broken or cyclic chain MUST count as a root.
- **FR-006**: Rust MUST refuse a fifth live (non-archived) child under one parent with `child_limit`; check and insert MUST be atomic against concurrent creates and re-parents.
- **FR-007**: The child's first turn MUST name its parent (id and name) and instruct it to report back with `send_session_message`, then carry the prompt; the working-mode prompt decoration MUST NOT be applied to it.
- **FR-008**: `update_session` MUST accept `id` plus optional `name`, `role`, `parent_id` (absent = unchanged, `null` = un-nest, string = nest) and return the updated `{id, name, parentId}`.
- **FR-009**: Re-parenting MUST be refused with `invalid_parent` when the new parent is the Session itself or a descendant, and with `depth_limit` when any descendant would end deeper than 3, and with `child_limit` when the new parent has 4 live children.
- **FR-010**: Changes inside the caller's own tree (the caller plus its descendants, for both the target and a new parent) MUST run without the card; any other change MUST raise it. `create_session` always follows FR-003.
- **FR-011**: Deleting a Session MUST set `parent_session_id` to null on its live children; archiving MUST keep links.
- **FR-012**: `registry::Session` MUST gain `parent_session_id: Option<String>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`, and `SessionPatch` a tri-state `parent_session_id`; a registry written before this change MUST load with no parents.
- **FR-013**: A role MUST be validated against the known roles (`invalid_input` when unknown); an omitted role MUST leave the Project default; a child MUST NOT inherit the caller's role.
- **FR-014**: The rule-of-thumb block MUST be appended on every launch and repeated in the `create_session` description; it MUST stay short enough not to break the shipped-rules size test.
- **FR-015**: Every failure MUST reach omp as `isError: true` with `{error:{code,message}}` and MUST NOT show a toast; spec 124's router, 8 KiB cap and cancel handling are reused.
- **FR-016**: `list_sessions` rows and `get_session_status` results MUST carry `parentId` when set (additive to contract 129).
- **FR-017**: A report from a child to its parent MUST use `send_session_message` unchanged and MUST count toward the per-pair limit.
- **FR-018**: Docs MUST change with the code: ADR 0009 records the tree rules and approval scope; `CONTEXT.md` Child Session and Own tree terms; contract updated; `docs/PLAN.md` row 1c.3.

### Key Entities

- **Child Session**: defined in `CONTEXT.md`; a Session with a `parent_session_id`.
- **Own tree**: the calling agent's Session plus its descendants; the approval scope for `update_session`.
- **Live child**: a child that is not archived.
- **Rule-of-thumb block**: the short text that tells an agent when to create a Session, use a subagent, or use a background agent.

## Accessibility (WCAG 2.1 AA)

No renderer surface changes in this slice. A child appears as a flat row in the existing Session list (nesting is #1862). The approval card is the existing card and its keyboard and focus behaviour is unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Live (fake-omp harness via `pnpm verify:tauri`): `create_session` in `yolo` returns an id, the Session appears in the list with its own Worktree and branch, and its first `prompt` frame names the parent; in a card mode the card appears first and Deny creates nothing.
- **SC-002**: Live: the 4th live child succeeds, the 5th is `child_limit`; a depth-3 Session creating a child is `depth_limit`; each failure is a tool error and no toast.
- **SC-003**: A `registry.json` from before this change loads in a unit test and a live check, with no parents.
- **SC-004**: Live: a child's `send_session_message` to its parent is delivered (queued when busy) and the 11th in 10 minutes is `rate_limited`.
- **SC-005**: New logic carries co-located unit tests; each guard (depth, width, descendant/self parent, own-tree scope, re-root on delete, atomic limit, role validation, first-turn text) has a test that fails when the guard is removed.
- **SC-006**: `pnpm ci:local` passes and no touched file exceeds 600 lines.

## Assumptions

- Specs 124 and 129 have merged: Tool channel, `tools_for`, router, `send_session_message`, loop guard, `verify:tauri` fake-omp harness exist on `main`.
- Roles are the omp model roles already offered by `model.listRoles`.
- Names and ids are the identity an agent works with; no new id scheme.

## Out of scope

Archive, stop, pause, resume and delete tools (#1860); Conversation tools (#1861); nested rows in the Session list (#1862); subagents and background agents (#712, #1272); starting a stopped Session; persisting the loop-guard counter.

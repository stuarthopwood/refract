# Implementation Plan: Session list tree for nested Sessions

**Branch**: `feat/session-tree` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

## Summary

Draw `parentSessionId` links as a tree inside each Project group, with a persisted per-parent collapse, text count and roll-up, a "from <parent>" line, tree keyboard and ARIA, a polite creation announcement, and a confirm dialog when archiving a parent with live children. Two pieces of plumbing carry it: `collapsedParentIds` on the existing `SessionListCollapse` value (choice A) and an optional `includeChildren` argument on `sessions.archive` backed by one shared Rust cascade function (choice B). Everything else is renderer code built from existing shared components.

## Technical Context

**Language**: TypeScript (React, Zustand) plus a small Rust change. **Storage**: the existing settings file; one new optional field, no migration. **Testing**: vitest `*.test.ts` beside each module (the repo has no DOM test library, so component output is tested through pure helpers and `react-dom/server` markup), Rust `*_tests.rs` and `*.test.rs` beside each Rust module, then a live fake-omp check with screenshots. **Constraints**: no file over 600 lines (`ipc/settings.rs` 571 and `store/settings.rs` 554 are near it), why-only comments (#1322), shared components from `src/renderer/components/`.

## Constitution / Rules Check

- AGENTS.md Testing (HARD RULE, epic #1918): every changed module gets a co-located test file, named in the table below. PASS (tasks name them).
- Rust owns the cascade (ADR 0007, ADR 0009): the renderer sends one call and never loops. PASS.
- ADR 0009: archive keeps links; delete re-roots; this plan changes neither. PASS.
- #735 and #559 group state rules: parents reuse the persist, restore-before-paint and ephemeral search override rules. PASS.
- Reusable UI: reuse `ConfirmAlertDialog`, `IconButton`, `CountBadge` and `InlineStatus` from `src/renderer/components/`; no second disclosure or dialog component. PASS.
- File-size cap: see Budget.

## Code map (verified on `6f3a93c9`)

| Concern | Location |
|---|---|
| `parentSessionId` on summaries | `src/shared/model.ts:52` (`SessionBase`) |
| Collapse value and default | `src/shared/model.ts:108-109` (`SessionListCollapse`, `DEFAULT_SESSION_LIST_COLLAPSE`) |
| List store: group state, persist, restore, prune | `src/renderer/state/session-list-store.ts:13` (state), `:74-79` (persist), `:105-106` (initial), `:221-222` (restore), `:231` (prune), `:205-217` (search override on open) |
| Startup restore | `src/renderer/state/init-stores.ts:310` |
| Archive in the renderer store | `src/renderer/state/sessions-store.ts:36` (type), `:190-192` (`archive`) |
| Renderer IPC type and bridge | `src/shared/ipc.ts:494` (`archive(id)`), `:258` (`SESSIONS_ARCHIVE`); `src/tauri-bridge/index.ts:163` |
| Archive callers | `features/sessions/useSessionRowActions.ts:36,242-260`, `features/sessions/sessionRowSurface.ts:23-62` (`useSurfaceArchiveActions`), `features/chat/ChatPane.tsx:585`, `features/home/TidyUpSection.tsx:85` |
| Project group list | `features/sessions/RepositoryGroup.tsx:287-290` (`<ul>` and `active.map`), `:43` and `:219` (`containsOpenSession`) |
| Row | `features/sessions/SessionRow.tsx:91-146` (`<li data-choice-item>`, accessible name at `:120`), `SessionRowTable.tsx:36` (table `<li>`), `SessionRowParts.tsx` (second line parts) |
| Archived and Personal Agent lists | `features/sessions/ArchivedGroup.tsx:38`, `PersonalAgentRow.tsx:34` (stay flat) |
| Filter, search and creation announcement | `features/sessions/SessionList.tsx:59-133` (`announce` on creation, `wasHiddenByFilter`), `createdSessionAnnouncement.ts` |
| Needs-you status | `features/sessions/sessionDisplay.tsx:28-30` (`isNeedsYouSession`), `:190-191` (icon) |
| Shared confirm dialog | `src/renderer/components/ConfirmAlertDialog` (used by `DeleteDialog.tsx:218`, `RemoveRepositoryDialog.tsx:67`, `StartSessionHost.tsx:42`) |
| Rust settings value | `src-tauri/src/store/settings.rs:41-47` (struct), `settings_parse.rs:74-114` (default, sanitiser, parser), `settings_setters.rs:61-66` (setter), `ipc/settings.rs:388-411` (setter argument) |
| Rust archive handler and core | `src-tauri/src/ipc/sessions_lifecycle.rs:211-221` (`sessions_archive`), `ipc/sessions_lifecycle/archive_core.rs` (`archive_core`) |
| Rust cascade today | `src-tauri/src/agent_tools/sessions_end_tools.rs:84-106` (set), `:153-190` (`run_with`, spawn and await), `store/session_tree.rs:58` (`descendants`) |

## Design

1. **Tree model (pure, new `features/sessions/sessionTree.ts`).** `buildSessionTree(sessions, ids)` returns top-level nodes with `children`, `level`, `posInSet` and `setSize`. A Session is a child only when its parent is in the same input list, is live and shares the Project; a cycle, a self link or a missing parent makes it top level. Sibling order is the input order, so recent-first holds. Level is clamped at 4. `flattenVisible(tree, collapsed)` gives the rows a keyboard step visits. `rollUp(node)` returns `{ children, needsYou }` counts; `fromLabel(session, sessionsById)` returns `from <name>`, with `(archived)` or `(hidden)` when the parent is not live-visible, or `null`. `liveDescendants(sessions, id)` returns the dialog's set with the same rules as Rust (`archivedAt` null, any depth, cycle safe).
2. **Collapse state (choice A).** `SessionListCollapse` gains `collapsedParentIds: string[]`; the store holds `collapsedParentIds: Set<string>` with `isParentOpen(id)`, `toggleParent(id)` and `pruneParents(liveParentIds)`. `toggleParent` follows `setRepositoryOpen`: while a query is active it writes the `searchOverride` only (a `parents` map is added to it); otherwise it updates the set and calls `persist()`. `restore` reads the field with a default of `[]`. `pruneParents` runs where `pruneCollapsed` runs for repositories (after a successful `repositories.list` load) and also when `sessions-store` refresh settles, because parents come and go without a Project change. `collapseAll` and `expandAll` are left alone (decision in spec).
3. **Rust settings.** Add `collapsed_parent_ids: Vec<String>` (serde `collapsedParentIds`, default empty) to `SessionListCollapse`; reuse the sanitiser and caps by generalising `sanitize_collapsed_repository_ids` to `sanitize_collapsed_ids` (the old name is removed and its two callers renamed, no alias). `parse_session_list_collapse` reads the field as optional: absent or malformed gives `[]` without failing the other fields. The setter argument parser requires it; the shape message is extended. `settings_setters.rs` needs no change beyond the new struct field.
4. **Archive cascade (choice B).** New `store/session_tree.rs::archive_subtree_ids(sessions, id)` returns the target plus every live descendant, deepest first (the order and the "skip archived" rule of `plan_for` today). New `ipc/sessions_lifecycle/archive_core.rs::archive_subtree_core(state, id)` takes the Project tree gate, computes the set, refuses if any member is deleting, then archives each through `archive_core` and returns the same "already archived: ..." partial-failure text the tool gives. `plan_for` calls `archive_subtree_ids`, and the tool's commit step calls `archive_subtree_core`, so there is one set and one order. `sessions_archive` parses an optional boolean second argument and calls `archive_subtree_core` when true, else `archive_core`. Any non-boolean is `invalid_argument`. The renderer type (`ipc.ts:494`), bridge (`index.ts:163`) and store `archive(id, includeChildren?)` pass the flag.
5. **Tree rows.** `RepositoryGroup.tsx` renders `buildSessionTree` output. A group with no parent keeps today's `<ul>`; a group with parents gets `role="tree"` and each row's `<li>` gets `role="treeitem"`, `aria-level`, `aria-setsize`, `aria-posinset` and, for parents, `aria-expanded`, with its children in a nested `<ul role="group">`. Indent comes from a CSS variable on the row (`--tree-level`), not from nesting padding, so the row's hit area and focus ring stay full width. The toggle is an `IconButton` (chevron icon already used by group headers) placed before the status icon, 24 by 24 CSS pixels, with `aria-label` "Collapse <name>" / "Expand <name>" and `aria-controls` pointing at the child group. `SessionRowParts.tsx` gains the count, roll-up and "from" lines as text; they truncate and their full text is in the row's accessible name (`SessionRow.tsx:120`) and in `SessionDetailsCard`. The table layout (`SessionRowTable.tsx`) shows the same two text pieces without nesting.
6. **Keyboard.** A pure `treeKeyMove(rows, focusedId, key, collapsed)` returns `{ focus?, toggle? }` for Right, Left, Home and End; Up and Down keep the existing roving behaviour in `SessionList`. The row's `onKeyDown` calls it. Enter and Space on the toggle button use the default button behaviour.
7. **Archive dialog.** `useArchiveSession(session)` (new, `features/sessions/useArchiveSession.ts`) computes `liveDescendants`; with none it calls `archive(id)` as today, otherwise it opens a `ConfirmAlertDialog` host with the title, the running names (a descendant is running when `status` is not `stopped` or `idle`-without-process per `sessionDisplay.tsx`; the helper `isRunning` lives beside `isNeedsYouSession`), **Archive all** (`archive(id, true)`), **Archive parent only** (`archive(id)`) and **Cancel**. `useSessionRowActions.ts:256-260`, `sessionRowSurface.ts:62` and `ChatPane.tsx:585` call it; `TidyUpSection.tsx:85` is unchanged. Focus handling reuses the capture-and-restore code already in `useSessionRowActions.ts:254-290`.
8. **Announcement.** `SessionList.tsx:121-133` already detects creations; for a Session with `parentSessionId` it calls a new `createdChildAnnouncement(child, parent, collapsed)` in `createdSessionAnnouncement.ts` and never touches focus or the open state. First load and no-new-id refreshes stay silent.
9. **Search.** The tree builder runs on the filtered list. During a query `isParentOpen` reads the override first, default open.
10. **Narrow widths.** The row is a flex line with `min-w-0`; indent is capped by the level clamp; count, roll-up and "from" lines use `truncate`; the toggle never shrinks. Verified at 320 CSS pixels.

## Design review findings

Pending: the controller runs the `ui-architect-v3` review on the spec before implementation starts (spec, UX review). This section records its findings as Decided entries; if one changes a design item above, the item and the matching task are updated first.

## Test plan (AGENTS.md Testing)

| Changed module | Test file (co-located) | Proves |
|---|---|---|
| `features/sessions/sessionTree.ts` (new) | `features/sessions/sessionTree.test.ts` (new) | nesting; missing, self and cycle parents go top level; cross-Project parent goes top level; level clamp; order kept; roll-up counts; "from" label with `(archived)` and `(hidden)`; `liveDescendants` at depth 3 skips archived |
| tree keyboard (`treeKeyMove`, in `sessionTree.ts`) | `sessionTree.test.ts` | Right expands or enters; Left collapses or goes to parent; Home and End; leaf Right does nothing |
| `state/session-list-store.ts` | `state/session-list-store.test.ts` (new) | default open; toggle persists the right payload; restore of the field; prune drops dead parents; query writes only the override and the clear drops it; collapse all leaves parents alone |
| `state/sessions-store.ts` | `state/sessions-store.test.ts` (exists) | `archive(id, true)` passes the flag; default passes none; failure notifies and returns false |
| `shared/model.ts` | `shared/model.test.ts` (exists) | default has `collapsedParentIds: []` |
| `features/sessions/useArchiveSession.ts` (new) | `useArchiveSession.test.ts` (new, pure decision function plus `react-dom/server` markup of the dialog body) | no descendants archives at once; N counts live descendants at every depth; singular text; running names listed; each button makes the right call; archived descendants excluded |
| row markup (`SessionRow.tsx`, `RepositoryGroup.tsx`) | `features/sessions/SessionRowTree.test.ts` (new, `renderToStaticMarkup`) | `role`, `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded`; collapsed parent omits children; count, roll-up and "from" text present; a group with no parent keeps the old markup |
| `createdSessionAnnouncement.ts` | `features/sessions/createdSessionAnnouncement.test.ts` (new) | child wording; "collapsed" suffix; no text for a root Session |
| `store/settings.rs`, `settings_parse.rs`, `ipc/settings.rs` | `store/settings_tests.rs`, `ipc/settings` tests beside it | field absent reads `[]`; malformed reads `[]` and keeps the other fields; caps; round trip; setter requires the field |
| `store/session_tree.rs` | `store/session_tree.test.rs` (exists) | `archive_subtree_ids` order (deepest first), skips archived, cycle safe |
| `ipc/sessions_lifecycle/archive_core.rs`, `ipc/sessions_lifecycle.rs` | `ipc/sessions_lifecycle_tests.rs` (exists) | flag true archives the subtree; false archives one; non-boolean is `invalid_argument`; deleting member refuses; partial failure message |
| `agent_tools/sessions_end_tools.rs` | `agent_tools/sessions_end_tools.test.rs` (exists) | the tool still archives the same set through the shared function (existing cascade tests keep passing) |

Each guard test is proved by mutating the guard, watching the test fail, and restoring it.

## Budget

`ipc/settings.rs` (571): the setter argument grows by under 15 lines; if it would cross 590, the parse helper moves to a new `ipc/settings_collapse.rs` first. `store/settings.rs` (554): under 5 lines. `archive_core.rs` (99): room. `sessions_lifecycle.rs` (409): about 8 lines. `RepositoryGroup.tsx` (313) and `SessionRow.tsx` (307): the tree rendering goes to a new `SessionTree.tsx`, so neither grows by more than about 20 lines. `useSessionRowActions.ts` (424): the archive wiring shrinks as `useArchiveSession` takes over.

## Project Structure

```text
specs/136-session-tree-1862/   spec.md plan.md tasks.md analysis.md checklists/requirements.md
src/renderer/features/sessions/sessionTree.ts, sessionTree.test.ts          (new)
src/renderer/features/sessions/SessionTree.tsx, SessionRowTree.test.ts      (new)
src/renderer/features/sessions/useArchiveSession.ts, useArchiveSession.test.ts  (new)
src/renderer/features/sessions/createdSessionAnnouncement.test.ts           (new)
src/renderer/state/session-list-store.test.ts                               (new)
scripts/verify-tauri-1862.mjs                                               (new live check)
```

## Complexity Tracking

No violations. One deliberate duplication-avoider: the IPC handler and the `archive_session` tool share `archive_subtree_ids` and `archive_subtree_core`, so there is one cascade. The renderer set in the dialog (`liveDescendants`) mirrors the Rust rule so the dialog's N is what **Archive all** archives; the Rust recheck at call time is the authority.

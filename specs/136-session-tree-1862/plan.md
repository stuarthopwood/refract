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
- Reusable UI: reuse `ConfirmAlertDialog` and `IconButton` from `src/renderer/components/`; the count, roll-up and "from" lines are text in the row's existing second-line parts (`SessionRowParts.tsx`), so no badge component is needed and none is added. PASS.
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
| Row | `features/sessions/SessionRow.tsx` (about 307 lines): `<li ref={rowRef} data-choice-item className="group relative w-full">` at `:145`, open button `aria-label={accessibleName}` at `:170`, `onKeyDown={handleOpenButtonKeyDown}` at `:182`; `SessionRowTable.tsx:36` (table `<li>`); `SessionRowParts.tsx` (second line parts). Re-verify these before each task. |
| Archived and Personal Agent lists | `features/sessions/ArchivedGroup.tsx:38`, `PersonalAgentRow.tsx:34` (stay flat) |
| Filter, search and creation announcement | `features/sessions/SessionList.tsx:59-133` (`announce` on creation, `wasHiddenByFilter`), `createdSessionAnnouncement.ts` |
| Needs-you status | `features/sessions/sessionDisplay.tsx:28-30` (`isNeedsYouSession`), `:190-191` (icon) |
| Shared confirm dialog | `src/renderer/components/ConfirmAlertDialog.tsx` (one Cancel and one optional confirm, `confirmRef`, `busy`, `busyLabel`, `error`; used by `DeleteDialog.tsx:218`, `RemoveRepositoryDialog.tsx:67`, `StartSessionHost.tsx:42`); gains `secondaryLabel` and `onSecondary` |
| Rust settings value | `src-tauri/src/store/settings.rs:41-47` (struct), `settings_parse.rs:74-114` (default, sanitiser, parser), `settings_setters.rs:61-66` (setter), `ipc/settings.rs:388-411` (setter argument) |
| Rust archive handler and core | `src-tauri/src/ipc/sessions_lifecycle.rs:211-221` (`sessions_archive`), `ipc/sessions_lifecycle/archive_core.rs` (`archive_core`) |
| Rust cascade today | `src-tauri/src/agent_tools/sessions_end_tools.rs:84-106` (set), `:153-190` (`run_with`, spawn and await), `store/session_tree.rs:58` (`descendants`) |

## Design

1. **Tree model (pure, new `features/sessions/sessionTree.ts`).** `buildSessionTree(sessions, ids)` returns top-level nodes with `children`, `level`, `posInSet` and `setSize`. A Session is a child only when its parent is in the same input list, is live and shares the Project; a cycle, a self link or a missing parent makes it top level. Sibling order is the input order, so recent-first holds. Level is clamped at 4. `flattenVisible(tree, collapsed)` gives the rows a keyboard step visits. `rollUp(node)` returns `{ children, needsYou }` counts; `fromLabel(session, sessionsById)` returns `from <name>`, with `(archived)` or `(hidden)` when the parent is not live-visible, or `null`. `liveDescendants(sessions, id)` returns the dialog's set with the same rules as Rust (`archivedAt` null, any depth, cycle safe).
2. **Collapse state (choice A).** `SessionListCollapse` gains `collapsedParentIds: string[]`; the store holds `collapsedParentIds: Set<string>` with `isParentOpen(id)`, `toggleParent(id)` and `pruneParents(liveParentIds)`. `toggleParent` follows `setRepositoryOpen`: while a query is active it writes the `searchOverride` only (a `parents` map is added to it); otherwise it updates the set and calls `persist()`. `restore` reads the field with a default of `[]`. `pruneParents` runs where `pruneCollapsed` runs for repositories (after a successful `repositories.list` load) and also when `sessions-store` refresh settles, because parents come and go without a Project change. `collapseAll` and `expandAll` are left alone (decision in spec).
3. **Rust settings.** Add `collapsed_parent_ids: Vec<String>` (serde `collapsedParentIds`, default empty) to `SessionListCollapse`; reuse the sanitiser and caps by generalising `sanitize_collapsed_repository_ids` to `sanitize_collapsed_ids` (the old name is removed and its two callers renamed, no alias). `parse_session_list_collapse` reads the field as optional: absent or malformed gives `[]` without failing the other fields. The setter argument parser requires it; the shape message is extended. `settings_setters.rs` needs no change beyond the new struct field.
4. **Archive cascade (choice B).** New `store/session_tree.rs::archive_subtree_ids(sessions, id)` returns the target plus every live descendant, deepest first (the order and the "skip archived" rule of `plan_for` today). New `ipc/sessions_lifecycle/archive_core.rs::archive_subtree_core(state, id)` takes the Project tree gate, computes the set, refuses if any member is deleting, then archives each through `archive_core` and returns the same "already archived: ..." partial-failure text the tool gives. `plan_for` calls `archive_subtree_ids`, and the tool's commit step calls `archive_subtree_core`, so there is one set and one order. `sessions_archive` parses an optional boolean second argument and calls `archive_subtree_core` when true, else `archive_core`. Any non-boolean is `invalid_argument`. The renderer type (`ipc.ts:494`), bridge (`index.ts:163`) and store `archive(id, includeChildren?)` pass the flag.
5. **Tree rows.** `RepositoryGroup.tsx` renders `buildSessionTree` output through a new `SessionTree.tsx`. A group with no parent keeps today's markup; a group with parents gets `role="tree"`. Each Session is one `<li role="treeitem">` with `aria-level` (true level), `aria-setsize`, `aria-posinset`, `aria-labelledby` (its open button) and, for parents, `aria-expanded`. Inside the `<li>` the row content moves to an inner element that carries `group relative`, the hover and active-indicator styling, and the existing `group-has-[aria-expanded]` rule, so a parent's hover and selected bar stop at its own row; the children render in a sibling `<ul role="group">`. Indent comes from `--tree-indent: calc((min(level, 4) - 1) * 12px)` on the inner row (12 px a level, 36 px maximum, `aria-level` unclamped), not from nesting padding, so the hit area and focus ring stay full width. The toggle is a shared `IconButton` (`size="icon-xs"`, 24 by 24 CSS pixels, chevron rotated by `aria-expanded` with `motion-reduce:transition-none`) placed absolutely in the existing 24 pixel left gutter, always visible, first in DOM order, labelled "Collapse <name>" or "Expand <name>", with `aria-controls` set only while the group renders. `SessionRowParts.tsx` gains a non-shrinking count or roll-up segment at the start of line 2 ("1 needs you, 2 children"; the branch or activity text is dropped while the roll-up shows) and a third line "from <parent name>" with a non-shrinking "from " and state suffix; the parent's name carries the ellipsis. A collapsed parent's roll-up is added to the open button's accessible name; the count and "from" line go in the sr-only description of `SessionDetailsCard` and its visible details. The table layout (`SessionRowTable.tsx`) shows the same text without nesting. A parent takes the open-Session state when a descendant is selected.
6. **Keyboard.** A pure `treeKeyMove(rows, focusedId, key, collapsed)` returns `{ focus?, toggle? }` for Down, Up, Home, End, Right and Left (Right on a collapsed parent expands, on an expanded one focuses the first child; Left collapses an expanded parent or focuses the parent). The handler sits in `useSessionRowActions.ts` beside `handleOpenButtonKeyDown` (`:128`) and on the toggle; it acts only when the event target is the open button or the toggle, no Ctrl, Alt, Meta or Shift is held, and the group renders `role="tree"`, so Radix submenu arrows are untouched. There is no roving behaviour today (`SessionList.tsx:153`), so these keys are new and additive: Tab order does not change. Focus moves by looking up the target row's open button through a `data-session-id` attribute, because collapsed rows are not in the DOM. Enter and Space on the toggle use the default button behaviour.
7. **Archive dialog.** `ConfirmAlertDialog` gains optional `secondaryLabel` and `onSecondary`, rendered between Cancel and the confirm button in the footer as an outline button that follows the same `busy` and `aria-disabled` rules; the existing callers pass neither and are unchanged. `useArchiveSession(session)` (new, `features/sessions/useArchiveSession.ts`) computes `liveDescendants` from the unfiltered store list; with none it calls `archive(id)` as today, otherwise it opens a `ConfirmAlertDialog` host. Title "Archive '<name>' and its N child Sessions?"; description "Archive all stops these Sessions' agents. Archive parent only leaves them running. Archived Sessions can be restored."; under "Running now:" a scrolling list of the running names (a descendant is running when `status` is not `stopped` or `idle`-without-process per `sessionDisplay.tsx`; `isRunning` sits beside `isNeedsYouSession`), a branch appended to repeated names and "(hidden)" on hidden ones, plus "Includes M nested Session(s)." when N exceeds the direct count. Footer order and weight: **Cancel** (initial focus), **Archive parent only** (`archive(id)`), **Archive all** (`archive(id, true)`, primary), `size="md"`. While the call runs both actions are inert (`busy`, `busyLabel="Archiving..."`); on failure `error` shows and the dialog stays open, as `DeleteDialog` does. On success the list announcer says the result (spec FR-011). `useSessionRowActions.ts:256-260`, `sessionRowSurface.ts:62` (the Manage sessions table) and `ChatPane.tsx:585` call it; `TidyUpSection.tsx:85` is unchanged. Focus handling reuses the capture-and-restore code in `useSessionRowActions.ts:254-290`, including `contextMenuOpenerRef`.
8. **Announcement.** `SessionList.tsx:121-133` already detects creations; for a Session with `parentSessionId` it calls a new `createdChildAnnouncement(child, parent, collapsed)` in `createdSessionAnnouncement.ts` and never touches focus or the open state. First load and no-new-id refreshes stay silent.
9. **Search.** The tree builder runs on the filtered list. During a query `isParentOpen` reads the override first, default open.
10. **Narrow widths.** The inner row is a flex line with `min-w-0`; indent is capped at 36 px; the name keeps about 116 CSS pixels at 320 pixels; the count or roll-up segment and the "from " prefix and suffix are `shrink-0` and the name and branch carry `truncate`; the toggle never shrinks. Verified at 320 CSS pixels and at 200 percent zoom in light and dark themes.

## Design review findings

`ui-architect-v3` reviewed the spec and this plan on 2026-11-18 (one read-only pass; the three-specialist fan-out was not available). Its twelve findings are folded into design items 5, 6, 7 and 10 and into spec FR-002 to FR-013, and are listed as Decided entries in spec.md "UX review". The one correction to this plan: the earlier text said Up and Down "keep the existing roving behaviour", which does not exist; item 6 now adds them inside tree groups.

## Test plan (AGENTS.md Testing)

| Changed module | Test file (co-located) | Proves |
|---|---|---|
| `features/sessions/sessionTree.ts` (new) | `features/sessions/sessionTree.test.ts` (new) | nesting; missing, self and cycle parents go top level; cross-Project parent goes top level; level clamp; order kept; roll-up counts; "from" label with `(archived)` and `(hidden)`; `liveDescendants` at depth 3 skips archived |
| tree keyboard (`treeKeyMove`, in `sessionTree.ts`) | `sessionTree.test.ts` | Down, Up, Home and End over the visible rows only; Right expands or enters; Left collapses or goes to parent; leaf Right and a modifier key do nothing |
| `state/session-list-store.ts` | `state/session-list-store.test.ts` (new) | default open; toggle persists the right payload; restore of the field; prune drops dead parents; query writes only the override and the clear drops it; collapse all leaves parents alone |
| `state/sessions-store.ts` | `state/sessions-store.test.ts` (exists) | `archive(id, true)` passes the flag; default passes none; failure notifies and returns false |
| `shared/model.ts` | `shared/model.test.ts` (exists) | default has `collapsedParentIds: []` |
| `features/sessions/useArchiveSession.ts` (new) | `useArchiveSession.test.ts` (new, pure decision function plus `react-dom/server` markup of the dialog body) | no descendants archives at once; N counts live descendants at every depth; singular text; running names listed with "(hidden)" and nested-count line; each button makes the right call; archived descendants excluded; result announcement text |
| `components/ConfirmAlertDialog.tsx` | `components/ConfirmAlertDialog.test.ts` (new or extended, `renderToStaticMarkup`) | no `secondaryLabel` renders the old footer; with it, Cancel, secondary, confirm in that order; secondary is inert while `busy` |
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

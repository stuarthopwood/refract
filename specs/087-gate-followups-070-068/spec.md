# Spec 087: gate follow-ups from specs 070 and 068

Issues: #1452 (spec 070 gate: labels, session usage, advisor roster) and #1446 (spec 068 gate: session list and settings polish). Branch `gate-followups-1452-1446` (Lane X). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on both issues; see `clarifications.md`. No new tests (prototyping phase); existing tests must keep passing. No theme token, `globals.css` theme block, `themeContrast.ts` or `theme-contrast-pairs.mjs` file is touched (Lane W, spec 086).

## Problem

The spec 070 and spec 068 gates left Medium and Low findings: the usage agent filter omits advisors, truncated text uses native `title`, a sparkline has no summary for screen readers, label-pill removal is silent, the advisor roster check matches basenames loosely and is lost on reload, the session Details card keeps its actions away from the path, git-changes header buttons appear on file-row hover, Chat width diverges from Theme, the width and theme autosave can apply a stale result, the Show hidden toggle loses focus and announcements, and the unused `theme.preview` IPC remains.

## User stories

- US-1 As a usage reader, I can filter by the Advisor agent type.
- US-2 As a screen-reader user, a compact list shows full text through the shared tooltip, a sparkline reads its latest, low and high values, and removing a label filter is announced.
- US-3 As a user with a WATCHDOG.yml roster, the notice returns after a renderer reload and only exact roster file names open.
- US-4 As a session-list user, the Details card actions sit beside the path, the git-changes header button no longer appears on file-row hover, and the group header outline survives forced-colors mode.
- US-5 As a Settings user, Chat width looks and behaves like Theme, and a quick run of arrow keys ends on the last choice.
- US-6 As a keyboard user, turning Show hidden off keeps focus in the toolbar and announces why; unhiding dismisses the stale undo toast.
- US-7 As a maintainer, one reveal icon and label are used everywhere and the dead `theme.preview` IPC is gone.

## Functional requirements

- FR-001 `UsageFilters.tsx` offers `advisor` ("Advisor") in the agent filter.
- FR-002 `LoadingOverlay` delays its blur and loading card ~150 ms (`delayMs`, default 150); `aria-busy` (loading only, not for a custom overlay such as Paused) and `inert` apply immediately; a custom overlay has a `bg-background/80` backing fill. Theme and chat width pickers select optimistically and roll back on failure only for the latest request. `PausedBody` uses it (`delayMs={0}` so Resume takes focus at once).
- FR-003 `CompactList` shows truncated text through the shared Tooltip, not `title`.
- FR-004 Compact `Sparkline` `aria-label` ends with "latest X, low Y, high Z".
- FR-005 Removing an Issues-list label pill announces "Removed label filter {name}" through `useChatAreaAnnouncer`.
- FR-006 Rust `is_openable` compares the exact basename against the roster file basenames; the roster parser reads at most 2000 lines.
- FR-007 `AdvisorRosterNotice` re-detects the roster for its Session when the store holds none (renderer reload).
- FR-008 `docs/design/components.md` records the RoleRow inline warning note.
- FR-009 `SessionDetailsCard`: Copy path and Show in File Explorer are ghost icon buttons with tooltips at the end of the path row; the footer row is removed.
- FR-010 `GitChangesGroup` drops the outer `group`; its header buttons reuse `HEADER_ACTION_BUTTON_CLASS` exported from `GroupHeader.tsx` (moved from `RepositoryGroup`).
- FR-011 `GroupHeaderRow` gains `forced-colors:has-[:focus-visible]:outline-[Highlight]`; its `plain` branch builds from the shared base class.
- FR-012 `ChatWidthPicker` matches `ThemePicker`'s radio ring and dot, uses `max-w-sm`, and drops the check mark, "Current" and spacer.
- FR-013 `revealAction.ts` uses `FolderSearchIcon`; `ThemePicker` uses the shared reveal icon and label; `FolderOpenIcon` stays for pickers.
- FR-014 The stale comment at `path-actions.tsx:1` is corrected.
- FR-015 Theme and Chat width saves ignore a result older than the latest choice.
- FR-016 `ShowHiddenToggle` focuses collapse-all through a `data-collapse-all-groups` hook with an `aria-label` fallback, announces "Show hidden turned off, no hidden sessions" on auto-off, and the Hide undo toast is dismissed by id on unhide.
- FR-017 `theme.preview` is removed from `src/shared/ipc.ts`, the bridge, `src-tauri/src/ipc/theme.rs` and its tests; script comments that name it are updated.
- FR-018 Live check `scripts/verify-tauri-087.mjs` screenshots each changed surface and writes `report.json` with the code `gitHead`.

## Items skipped

| Item | Result |
|---|---|
| Usage session filter sargable (#1452) | skipped: schema migration, backfill and re-ingest for an unmeasured scan on a small local DB |
| Settings roster check only the agent dir (#1452) | skipped: Settings has no Session cwd by design |
| `SessionStartNotice` onto `LoadingOverlay` (#1452) | skipped: it has no blur of its own and `inert` would block keyboard reading of the dimmed history |
| Loading-overlay screenshot (#1452) | skipped: the fake gh has no delay hook |
| Agents badge per-theme accent token, Obsidian hover contrast (#1446) | skipped: spec 086 owns theme tokens and contrast |

## Success criteria

- `pnpm ci:local` passes. `verify-tauri-087.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.


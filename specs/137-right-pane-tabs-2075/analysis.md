# Analysis: spec, plan and tasks (#2075)

Run by hand on 2026-11-19, after you absorbed the UI ruling (rulings 1-4, C1, H1-H10, M1-M9, L1-L5).

## Result

Consistent after the fixes below. No open gaps.

## Checks

- **FR coverage:** every FR-001 to FR-034 appears in the `tasks.md` Coverage line; every SC maps to T023 or T024.
- **Task traceability:** every task T002 to T025 cites at least one FR, SC or finding ID. T001 (gate) is done; T025 is the PR gate.
- **Terminology:** the spec, plan and tasks use "Split", "Chat pane", "Session" and "Document tab" as `CONTEXT.md` defines them. No "split view".
- **Reusable components (ADR 0003):** FR-025 lists the shared components; T003, T007, T008, T010 and T018 build on them, and none forks a component.
- **Docs style:** the spec folder uses second person, active voice and sentence-case headings.

## Gaps found and fixed

- FR-032 was out of numeric order and its wording was unclear; it now reads "Panel liveness" and T011 covers it.
- FR-020 pointed at a verification task that no longer exists (T015); it now names the Ctrl+N fallback announcer path, and T019 checks it.
- The old tasks had no task for the narrow-window note (M6); T021 and T020 now cover it.
- The old tasks had no docs task (M7); T022 covers it.
- Phase numbering and task IDs changed: the Coverage line was rewritten against the new IDs.

## Grounding facts verified against `81ecabf4`

| Claim | Result |
|---|---|
| Ctrl+Shift+H collides with an in-app chord | No. Existing chords: Ctrl+Shift+P, X, B, `\`, 0, and Ctrl+W, Ctrl+K, Ctrl+N. WebView2 behaviour stays a live check (T024). |
| `builtinActions.ts:129` is `toggle-right-pane` | Right (the `id` sits at line 129). `close-chat-pane` is at 117, its `when()` at 122; `focus-other-pane`'s `when()` at 144. |
| Rust `WIDTH_MAX` mirrors the renderer | Right: `right_pane.rs:14` is 520, mirroring `RIGHT_PANE_MAX_WIDTH_PX` (`right-pane-store.ts:7`). |
| M6: no window minimum | Confirmed. `tauri.conf.json` sets no `minWidth`; no `min_inner_size` anywhere in `src-tauri`. `lib.rs:280` opens at 1280 by 800, and `window_state.rs:17-18` (`MIN_WIDTH` 800, `MIN_HEIGHT` 500) clamps only a restored saved size at startup (line 91), so you can still resize below 800 px. The spec Grounding and edge cases say so. |
| `previewRequestSeq` | `file-explorer-store.ts:176`, keyed by Session only; the spec now says file tabs key it by Session and path. |
| `watcherRefCounts` | In both `GitChangesPanel.tsx:16` and `FileExplorerPanel.tsx:72`. |
| `init-stores.ts` guard | The restore guard is at line 320, not 319. |
| `navCollapsed` sync | `App.tsx:163`, not 161. |
| `GitChangesPanel.tsx:299` hand-built label | Right. |
| `FilePreviewPane.tsx:156` `role="region"` | Right. |
| `quickCreateFallback.ts:21` | Announcer call for the Ctrl+N fallback. |

## Left for implement time

Re-check every line number when the tasks start; the plan says so in its heading.

## Deviations found at implement time

- **T002 tab key (2026-11-19):** the plan says the tab id is a stable hash of the identity. The store keys tabs by the identity string itself (`file:<path>`, `diff:<group>:<path>`), so two identities can never collide on a hash. `documentTabDomId(id)` gives the DOM-safe hashed id (`doc-tab-<base36>`) for `aria-controls` and `aria-labelledby`, because a path can hold spaces and slashes. Later tasks use the identity string as the key and `documentTabDomId` only for DOM attributes.
- **T005 prune and path helper (2026-11-19):** `normaliseRelativePath` moved from `agent-panel-actions.ts` to `src/shared/rightPane.ts` so persistence and the agent actions share one rule. The "drop on delete, not archive" hook is `useSessionsStore.refresh` (the one place a deleted Session leaves the list; archived Sessions stay listed) plus the `init-stores.ts` restore under the `sessionsLoad.ok` guard, both via `pruneSessions`, not a per-event `dropSession`. A pane in another window deleting a Session is covered too.
- **T005 interim cap (2026-11-19):** `RIGHT_PANE_MAX_WIDTH_PX` is gone. `RIGHT_PANE_INTERIM_CAP_PX` (520) stays for `App.tsx` `maxSize` and the Wide preset only, so the layout is unchanged until T017 and T020 delete it.
- **T006 where the state lives (2026-11-19):** no new store. `groupOpenBySession` joins `commitDraftsBySession` in `git-changes-store.ts` and `draftBySession` joins `bySession` in `side-chat-store.ts`, because a panel's last-watcher unmount calls `forgetSession` and the Conversation-change `clearThread` would each drop state held in `bySession`. `pruneCommitDrafts` became `pruneSessionUi` (commit drafts and group state); `pruneDrafts` handles the Side chat draft. Both run in `useSessionsStore.refresh` for Sessions no longer live. The Side chat draft is now per Session; it was one shared `useState` before. The panels are not mounted in tests (node environment), so the survive-a-tab-switch proof is on the stores: the unmount calls (`forgetSession`, `clearThread`) leave the state in place.
- **T007-T009 pure helpers and test file type (2026-11-19):** the strip keyboard rules (`tabKeyAction`) and the "All tabs" footer enablement (`bulkCloseEnabled`) live in `tab-items.ts`, and `isGenuineOpen` plus the launcher, title-row and tab-bar choice (`shellLayout`) live in `shell-tabs.ts`, each with a co-located test, because the repo has no jsdom and the shell cannot be mounted in tests. `PanelTabBar.test.ts` is `.ts`, not `.test.tsx`, since it uses `createElement`.
- **T009 document placeholder (2026-11-19):** the "This document view is not available yet." placeholder in `RightPaneShell.tsx` stays until Phase 3 (T011 and T012) builds the file and diff views, so T009 routes an active document tab to the placeholder rather than to a real view.
- **T011 file locations and the view's shape (2026-11-19):** the Git changes files live in `src/renderer/features/right-pane/git-changes/`, not `features/git-changes/`. `GitDiffView.tsx` takes `{ sessionId, group, path }` and reads the live entry from the Git changes store, so it needs no entry prop from the tab. Its pure logic (`isNoLongerChanged`, `entrySignature`, `nextDiffState`, `patchStats`, the announcement text) is in `git-diff-state.ts` with a co-located test, because the repo has no jsdom. `useGitChangesWatch.ts` holds the `gitChangesWatch` acquire/release and the post-reset restart, shared by the panel and the view; neither keeps a private count.
- **T011 "No longer changed" (2026-11-19):** the view marks its own tab dead through `markDead` and announces through the shared polite announcer (`agent-announcement-store`). A diff tab that is not active is not mounted, so nothing flags it dead until it is selected; T012's `DocumentTabView` (which owns the reload-on-snapshot-change rule) or a later task must flag inactive tabs.
- **T011 interim row activation (2026-11-19):** with `selection` gone, a row activation and the agent `showFileRequest` effect in `GitChangesPanel` call `openDocument` for a diff tab with no modifier-key, focus-return or `retargetDiff` handling. T014 adds those, and T015 removes the `showFileRequest` effect once `agent-panel-actions.ts` opens tabs directly. The Back-button focus-restore effect went with the Back button; T014 owns focus return to the originating row.
- **T011 comment-density baseline (2026-11-19):** the `GitChangesPanel.tsx` entry in `scripts/comment-density-baseline.json` is removed, because the long Back-button comment left the file; the baseline only shrinks.
- **T012 inactive diff tabs and the shell hook (2026-11-19):** this closes T011's gap. `GitDiffView` no longer calls `markDead`; it only announces. `useDiffTabLiveness` (`documents/useDiffTabLiveness.ts`), mounted once in `RightPaneShell`, covers every open diff tab of the Session: while one is open it holds the git watcher, loads the snapshot, runs `useDiffTabRetarget`, and marks each tab dead or alive through `planDeadMarks` and `syncDiffTabLiveness` (`diff-liveness.ts`, tested). A file that moved group stays alive, because `isNoLongerChanged` looks across groups and `retargetDiff` moves the tab. `GitChangesPanel` also calls `useDiffTabRetarget`; each run plans from the live tabs (`planDiffRetargets`), so the second call finds nothing left to move. The shell call is the one that works while a diff tab is active and the panel is unmounted; T014 may drop the panel's call.
- **T012 file previews in the explorer store (2026-11-19):** `FileExplorerSessionState.preview` and `previewLoading` are gone. `previews[sessionId][path]` holds `{ preview, loading }`, apart from `bySession` because a restored tab can preview before the tree loads. `previewRequestSeq` is keyed by Session and path, with one global counter so a cleared and reloaded path never reuses a number an old load holds. `loadPreview(sessionId, relativePath)` keeps its signature, so `agent-panel-actions.ts` needs no change. `clearPreview` runs from a `useDocumentTabsStore` subscription when a file tab closes or a Session drops. `applyPatch` marks a loaded preview `deleted` and marks every open file tab dead (`markGoneFileTabs`), mounted or not; a truncated listing proves nothing, so it marks neither. `file-explorer-store.test.ts` is new.
- **T012 helpers kept in `documents/` (2026-11-19):** `FileExplorerPanel.tsx` is T013's, so its Open in VS Code, Reveal and Copy path handlers could not be shared in this wave. `usePathActionHandlers.ts` repeats them for the file tab; once T013 extracts the panel's helpers, the two should merge. `useFileExplorerWatch.ts` holds the explorer watcher while a file tab is mounted, because the panel is unmounted whenever a document tab is active. `file-reload.ts` (`fileChangeSignature`) is the per-path key that re-runs the preview load on a snapshot change.
- **T012 view state and the placeholder (2026-11-19):** `FilePreviewPane` takes `wrap`, `showSource`, `scrollTop` and their change callbacks as props, and no longer owns a `role="region"` or `tabIndex`; the document store's per-tab view state holds all three. Wrap defaults to off and Source to off, as the old pane did. The T009 placeholder in `RightPaneShell.tsx` is gone: an active document tab renders `DocumentTabView`. The views have no component test (no jsdom); the logic they use is covered in `diff-liveness.test.ts`, `file-reload.test.ts` and `file-explorer-store.test.ts`.
- **T013 (2026-11-19):** Space activates a row except while type-ahead is active; `row-open.ts` exposes `keyboardActivation(mods)`/`pointerActivation(mods)`; `FileExplorerPanel.tsx` is 536 lines, so its file-size baseline entry was removed.
- **T014 (2026-11-19):** modifier keys come from an `onClickCapture` on the panel root (row components pass no event); a click with no pointer detail counts as keyboard activation; retargeting runs from the snapshot hook `useDiffTabRetarget`, which also covers Stage all, Unstage all, the row menu and external changes; the agent show-file effect and the store's `requestShowFile`/`clearShowFileRequest`/`showFileRequestBySession` were deleted.
- **T015 (2026-11-19):** `show_file` opens the diff tab with `focus:false` and returns `{ path, existed }`; a file `reveal` also opens a background file tab, a folder opens none; tool descriptions, `panel-actions.json` and Rust unchanged.
- **T016 (2026-11-19):** no new store action. The DOM focus landing (right pane, composer, transcript) is not unit-tested, because the repo has no jsdom; the pure `chatToggleFocus` rule is.
- **T017 (2026-11-19):** the pure `chat-layout.ts` holds `chatWidthPx` and `widthFitsSplit`. The app was not run.
- **T018 (2026-11-19):** `RailIconButton` is unchanged. The chat toggle carries `data-chat-toggle`, not `data-rail-toggle`, so the Right pane shortcut does not focus it. One polite "Chat pane, N needs you" is announced when the count rises while chat is hidden (FR-033, ruling 4).
- **T019 (2026-11-19):** the tests are in `useChordDispatcher.test.ts` with a shared `chordTestHarness.ts`. The Ctrl+N fallback announcer is at the app root, so a hidden chat does not affect it.
- **T020 (2026-11-19):** the fit rule disables any preset that cannot fit, not only Wide. The narrow-window close (Show chat gives chat 360 px and closes the pane, tabs and `widthPx` kept, when 240 px does not remain) lives in the shared `showChatPane`, so the rail, Ctrl+Shift+H, the palette and the menus all get it; the first cut had it in the menus only. With chat hidden the handle is disabled, so Shift+F10 on it may not open its menu; the app menu, the rail and the palette still reach Show chat. "Close pane" stays while chat is hidden and closes the pane and shows chat. `RIGHT_PANE_INTERIM_CAP_PX` is deleted.
- **T023 (2026-11-19):** every `ci:local` step passed on `2eca353e`; the full run's Rust step twice failed `git::worktree_delete::...hand_emptied...` with a git timeout under default parallelism, and passed 1466/1466 at `--test-threads=4` and 20/20 alone (load, not #2075).
- **T024 (2026-11-19, partial; not ticked):** live checks on the scratch debug build passed scenarios 1, 2, 3, 6, 7 and 8 and scenario 5 for a single chat; 4, 9, 10 and 5 in a Split are still to run. Fixes found: `8e96ef14` (showing chat refits the right pane), `3bd65c21` (the same clamp when the pane opens) and the hold-width fix (hiding chat collapsed the panel to 0 px, the transcript re-wrapped and its scroll position moved from 120 to 921; the content now keeps its last width while collapsed).

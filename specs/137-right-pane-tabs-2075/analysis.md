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

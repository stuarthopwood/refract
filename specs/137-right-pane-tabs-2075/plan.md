# Implementation plan: Right pane file and diff tabs, collapsible chat, wider pane

**Spec**: `specs/137-right-pane-tabs-2075/spec.md` **Issue**: #2075 **Branch**: `feat/2075-right-pane-tabs`

## Summary

Add a per-Session document-tab model beside the existing panel tabs, extend `PanelTabBar` to render both from tab items, route the explorer and Git changes row activations (and the agent `show_file` and `reveal` actions) into it, make the centre chat panel collapsible with a shared toggle, lift the 520 px cap, and persist the new state in `Settings.rightPane`. Renderer plus a small Rust settings change; no new dependency. The UI ruling of 2026-11-19 (rulings 1-4, C1, H1-H10, M1-M9, L1-L5) is folded in below; each design item names the findings it answers.

## Reused patterns (line numbers verified on this branch at `81ecabf4`; re-check at implement time)

| Need | Reuse | Where |
|---|---|---|
| Tab strip | `PanelTabBar` extended with tab items; `COMPACT_HIDE` (line 16) | `features/right-pane/PanelTabBar.tsx` |
| Tab look | `TAB_LOOK_CLASS` (no fill, pill or box; #1302) | `components/ui/tabs.tsx:9` |
| Non-registry tabs | pinned panels precedent | `usePinnedPanelsStore`, `panel-registry.ts` `isPinnedPanelId` |
| Pane store and width constants | `useRightPaneStore`; `RIGHT_PANE_MAX_WIDTH_PX` | `state/right-pane-store.ts:7` |
| Persistence, debounce, snapshot | `startRightPanePersistence`, `restoreRightPane` | `features/right-pane/right-pane-persistence.ts` |
| Rust settings row, clamp | `RightPaneState`, `WIDTH_MAX` (line 14, mirrors the renderer constant) | `src-tauri/src/store/right_pane.rs`; `shared/rightPane.ts` |
| Pane toggle (template for chat toggle) | `toggleRightPane` | `features/right-pane/toggle-right-pane.ts` |
| Palette chord and guards | `toggle-right-pane` (line 129), `useChordDispatcher`, `chordMatches` | `features/palette/builtinActions.ts`, `useChordDispatcher.ts`, `actionRegistry.ts:87` |
| Rail buttons | `IconRail.tsx`, `CountBadge` | `features/right-pane/IconRail.tsx`, `components/ui/count-badge.tsx` |
| Width presets, menus | `PaneWidthMenu.tsx` (`PANE_WIDTH_CHOICES`, line 27), `RightPaneResizeHandle.tsx`, app menu bar "Right pane width" | `features/right-pane/`, `features/app-menu/AppMenuBar.tsx:157` |
| File preview view | `FilePreviewPane` (own `role="region"`, line 156) | `file-explorer/FilePreviewPane.tsx` |
| File open path, stale-load guard | `activateRow` (~304), `loadPreview`, `previewRequestSeq` | `FileExplorerPanel.tsx`, `state/file-explorer-store.ts:176` |
| Diff view and open path | `GitChangesDiffPane` (line 206), `openDiff`, `agentOpened`, `GROUP_LABELS` | `git-changes/GitChangesPanel.tsx`, `GitChangesGroup.tsx:19` |
| Git watcher ref count | `watcherRefCounts` | `GitChangesPanel.tsx:16`, `FileExplorerPanel.tsx:72` |
| Agent actions | `show_file`, `reveal`, `PANEL_ACTION_HANDLERS`, `normaliseRelativePath` | `features/right-pane/agent-panel-actions.ts` |
| Focus-suppressed open | `openPanel(id, { focus: false })`, `suppressNextContentFocus` | `state/right-pane-store.ts` |
| Announcer and toast | `AgentOpenedAnnouncer` store, toast helpers | `features/right-pane/AgentOpenedAnnouncer.tsx` |
| Needs-you wording | `needsYouLabel` | `features/sessions/sessionTree.ts:95` |
| Diff counts | `DiffStatCounts` | `features/sessions/sessionDisplay.tsx:207` |
| Focus outline | `INSET_FOCUS_OUTLINE_CLASS` | `components/ui/focus-classes.ts` |
| Layout | chat `ResizablePanel` (line 182), nav `navCollapsed` sync (line 163), `canShowSplit` (line 64), `setVisible` effect (lines 85-97) | `App.tsx` |
| Restore guard | `if (sessionsLoad.ok)` | `state/init-stores.ts:320` |

## Design

1. **State** (`state/document-tabs-store.ts`, new): `bySession[sessionId] = { tabs: DocumentTab[], activeId, recency: string[], openedFrom: Record<id, TabKey> }`; actions `openDocumentTab` (dedupe, activate or background, eviction), `closeDocumentTab` (returns the next key by `openedFrom`, then neighbour), `retargetDiff` (staging), `markDead`, `closeOthers`, `closeAllDocuments`, `closeDead`, `restore`, `dropSession`, per-tab view state (`wrap`, `source`, `scrollTop`; not persisted). Tab id is a stable hash of identity (`file:<path>`, `diff:<group>:<path>`), reused for `aria-controls` and `aria-labelledby` (H9). Eviction (`pickEviction`): dead tab first, then least recent, never the opened or the active tab; the caller announces and toasts (ruling 1). Pure helpers (`tabIdentity`, `labelsFor`, `pickEviction`, `nextAfterClose`) sit beside it for unit tests.
2. **Active selection** (H9): one `activeTabKey` union (`panel` or `document`) in `useRightPaneStore`, one `activateTab` that updates the panel and document stores together; selecting a panel tab never leaves a stale document id; no active document tab falls back to the last active panel. `activePanelId` stays only as the panel half of the union. The launcher, `isTabBar`, the one-tab title row and `isGenuineOpen` in `RightPaneShell` count and handle both kinds.
3. **`PanelTabBar`** (H8, L2, L4): accept `items: TabItem[]`; render panel tabs (pinned left), one `aria-hidden` thin separator, then a scrolling document-tab container. Each item is a `role="presentation"` flex wrapper holding the tab and a sibling `IconButton` close (named from the item kind); remove `closePositions` and its per-tab `ResizeObserver`. Document tabs `shrink-0 min-w-28 max-w-48`, name `shrink-[100]`, leading `FileIcon`/`FileDiffIcon`, `DiffStatCounts` (with `accessibleLabel`) under `COMPACT_HIDE`; the close hit area extends to the 40 px strip height. The "All tabs" `IconButton` plus `DropdownMenu` (`DropdownMenuRadioGroup`, leading icons, separators, capped height) sits outside the scroller and mounts with the tablist; its footer holds Close others, Close all files and diffs, Close no-longer-changed tabs. Keep roving tabindex, Arrow, Home, End, Delete, middle-click; `scrollIntoView` for the active tab.
4. **Views** (`features/right-pane/documents/`): `DocumentTabView` switches on kind. `FileTabView` wraps `FilePreviewPane`, keyed by Session and path (extend `loadPreview` and `previewRequestSeq` to that key so stale loads cancel, M9), reloads on activate and on a snapshot change, acquires `watcherRefCounts` itself, and drops the nested `role="region"`/`tabIndex` (L3). `DiffTabView` wraps `DiffViewFromPatch`, extracted from `GitChangesDiffPane` into `git-changes/GitDiffView.tsx`; it acquires the watcher (H5) and shows "No longer changed" on the tab and in a `role="status"` region (H6). Remove the in-panel preview split and Back button. Lift `groupOpen` and the Side chat draft to Session-keyed stores (H10).
5. **Openers** (H4, ruling 2): explorer `activateRow` and Git changes `openDiff` call `openDocumentTab`; Ctrl+click and Ctrl+Enter pass `background: true` and keep list focus; a keyboard activation moves focus to the new tab; closing returns focus to the originating row when it exists. Agent `showFile` and `reveal` (file) call it with `focus: false` and announce "Agent opened diff of foo.ts" through the announcer store (M5); an existing tab activates without a duplicate; `reveal` on a folder keeps today's explorer expansion and opens no tab. Staging retargets the open diff tab (H6).
6. **Chat collapse** (C1, H1, H2, H7, ruling 3): `chatCollapsed` lives on the right-pane store; `effectiveCollapsed = chatCollapsed && view === 'chat'` (H1) drives `collapsible collapsedSize={0}`, an imperative panel ref, and `inert` plus `aria-hidden` on the chat panel. The chat panel `onResize` syncs state from a user drag, as `navCollapsed` does (H2), and ignores width 0 for `chatWidthPx`, so `canShowSplit` freezes and the `setVisible` effect keeps both Sessions (C1). `toggleChatPane()` mirrors `toggleRightPane`: never both hidden, focus moves only per FR-019, polite announcement through the announcer store. The rail toggle, palette entry (`toggle-chat-pane`, Ctrl+Shift+H, `when: view === 'chat'`), the "Right pane width" dropdown and the handle context menu call it. `close-chat-pane` and `focus-other-pane` get a not-collapsed guard in `when()` (H7); Session-activating actions show chat (ruling 3). Native `menu.rs` View menu stays unchanged.
7. **Rail** (M1, ruling 4): extract `RailIconButton` from `IconRail` (Right pane toggle, `RailButton`, chat toggle use it). The chat toggle: name "Chat pane", `aria-expanded`/`aria-controls`, `MessagesSquareIcon`, tooltip with the shortcut and the palette path for Pause and Stop (M8), `CountBadge` count (1-2) with `needsYouLabel` suffix in the name, one polite announcement on the transition. Sits under the Right pane toggle in the fixed top group; disabled without a Session.
8. **Width** (H3): remove `maxSize`; `RIGHT_PANE_MAX_WIDTH_PX` becomes `RIGHT_PANE_SANITY_MAX_WIDTH_PX` (4096) mirrored by Rust `WIDTH_MAX` (`right_pane.rs:14`); presets 240/320/640 with Wide disabled when it cannot fit; the right panel's `onResize` calls `setWidth` only on user-driven resizes; show chat expands chat first, then resizes the pane to `widthPx`; while chat is hidden the presets and handle are disabled and "Show chat" replaces them; the handle name and `PaneWidthMenu` checked state never report `widthPx` then.
9. **Persistence and Rust** (M4): add optional `document_tabs` and `chat_collapsed` to `RightPaneState` (a missing key is the default, so no migration); renderer validates on `restoreRightPane` (identity, path rules, 1024 bytes, per-Session 20, normalise `open:false` with `chatCollapsed:true`); prune only under `sessionsLoad.ok`; delete drops tabs, archive keeps them; Rust validates shape and relative paths only.
10. **Docs** (M7): see T022.

## Risks and open items

- `react-resizable-panels` collapse behaviour is `[INFERENCE]` (not run): verify `collapsedSize={0}` plus `minSize={360}` and a user drag to 0 on a scratch build (H2).
- Ctrl+Shift+H has no in-app collision (existing chords: Ctrl+K, Ctrl+Shift+P/X/B/`\`/0, Ctrl+N, Ctrl+W, Ctrl+,); whether WebView2 or the OS swallows it is a live check.
- The Ctrl+N quick-create fallback announcement may be unreachable while chat is hidden; verify (FR-020).
- Hidden chat keeps Sessions visible, so Unread response is not raised while hidden (FR-034). Recorded, accepted.
- Files near 600 lines: `FileExplorerPanel.tsx` 620, `GitChangesPanel.tsx` ~560, `App.tsx` 323: extract before adding (FR-027).
- No window minimum size (`tauri.conf.json` sets none; `lib.rs:280` opens at 1280 × 800; `window_state.rs` clamps only a restored size to 800 × 500): the narrow-window behaviour is specified in the spec edge cases.

## Verification

Co-located Vitest tests for the store, labels, eviction, `PanelTabBar` overflow, geometry and keyboard, toggle invariant, shortcut guards, persistence round-trip and validation; Rust tests in `right_pane.rs` for the new fields and the new ceiling. Live check on a scratch build (see `skill://refract-tauri-live-check-isolation`): tabs, eviction announcement, hide and show chat while streaming in a single chat and a Split with a scroll-position assertion (L5), width beyond 520, drag-collapse, restart restore, Ctrl+Shift+H. Evidence under task scratch `evidence/`.

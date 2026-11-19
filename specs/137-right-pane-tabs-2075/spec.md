# Feature specification: Right pane file and diff tabs, collapsible chat, wider pane

**Feature branch**: `feat/2075-right-pane-tabs`
**Created**: 2026-11-19
**Status**: Draft (UI ruling absorbed 2026-11-19; Stuart can reverse any ruling before code starts)
**Input**: GitHub issue #2075 (p1, `right-pane`, child of epic #1135). Route: `specify`, per the `github-actions[bot]` triage comment. The grill is replaced by delegated decisions (below). The `ui-architect-v3` review ran on 2026-11-19, delegated by Stuart, and its four rulings plus every Critical, High and Medium finding are folded in here. The ruling text is the issue comment `UI ruling (ui-architect-v3, delegated by Stuart 2026-11-19)`. Supersedes the centre main-area tab direction of #1102 and #732 (closed); retargets #878's editable Rendered view onto file tabs. Builds on spec 024 (right-pane toggle and persistence), spec 035 (file explorer) and #730 (panel order).

## Grounding (corrects the issue premise)

Files and diffs already open in the RIGHT pane, not the centre. A diff replaces the Git changes file list in-panel (`git-changes/GitChangesPanel.tsx`, `GitChangesDiffPane` at line 206, Back button); a file preview is a bottom split inside the File explorer (`file-explorer/FilePreviewPane.tsx`). The right pane is capped at 520 px (`state/right-pane-store.ts:7`, mirrored by `src-tauri/src/store/right_pane.rs:14` `WIDTH_MAX`). The centre `chat` `ResizablePanel` in `App.tsx:182` has `minSize={360}` and no `collapsible`. The `chat` panel also hosts Home, Pull requests, Issues and Usage, where the right pane is inert (`paneShown`, `App.tsx:55`). `PanelTabBar` renders only `openPanelIds` (`PanelId` panels). `RightPaneShell` mounts only the active panel, so a panel's local state is lost on every tab switch. `usePinnedPanelsStore` (PR and Issue) is the precedent for non-registry tabs.

The shell has no enforced minimum window size: the window opens at 1280 × 800 (`lib.rs` `inner_size`), `tauri.conf.json` sets no `minWidth`, and `shell/window_state.rs` (`MIN_WIDTH` 800, `MIN_HEIGHT` 500) clamps only a restored saved size at startup. The native View menu (`shell/menu.rs:62`) holds zoom and full screen only; the right pane's width dropdown lives in `AppMenuBar.tsx` ("Right pane width", line 157).

## Clarifications (decided by Skippy, delegated by Stuart 2026-11-19, with the UI ruling applied)

- Identity: `file` = Session + relative path; `diff` = Session + group + relative path. Reopening activates the existing tab. (FR-001, FR-002)
- One strip: `PanelTabBar` is extended; panel tabs pin at the left, then document tabs scroll; panel tabs are window-wide, document tabs are per Session. (FR-003, FR-004, FR-008)
- Close and overflow: close button, Delete, middle-click; scroll plus an "All tabs" menu; closing returns to the tab that was active when you opened it. (FR-007, FR-008)
- **Ruling 1, cap REPLACED:** 20 document tabs per Session stays, but eviction closes dead tabs first, then the least recently active, never the tab being opened or the active tab; it is announced and toasted; recency persists. (FR-010)
- **Ruling 2, no preview tab ACCEPTED:** every activation is a persistent tab. Ctrl+click and Ctrl+Enter open a tab in the background. The All tabs menu gains Close others, Close all files and diffs, Close no-longer-changed tabs. (FR-005, FR-006, FR-008, FR-029)
- **Ruling 3, chat toggle hides both Chat panes of a Split ACCEPTED** with conditions: freeze the split width state, disable the chat-only chords while hidden, and show chat when you select a Session. (FR-017, FR-020)
- **Ruling 4, attention badge with no auto-restore ACCEPTED:** a numeric `CountBadge`, a fixed accessible name with a `needsYouLabel` suffix, one polite announcement. Sessions stay marked visible, so Unread response is not raised while chat is hidden. (FR-033, FR-034)
- Persistence: `Settings.rightPane.documentTabs` and `chatCollapsed`. (FR-011)
- Width: 520 px cap removed; 240 px floor kept; Wide preset 640 (disabled where it cannot fit); 4096 px sanity ceiling; `widthPx` is the source of truth and chat is the remainder. (FR-021 to FR-024)

## User scenarios

### User story 1 - Read a file in its own tab (P1)
A developer clicks a file in the File explorer and reads it in a tab beside the Git changes tab. The tree is still there, with its expanded folders, when they switch back.
**Independent test**: open two files; two tabs; reopen the first; no third tab.
**Acceptance scenarios**:
1. **Given** the File explorer shows a tree, **When** the developer activates a file row, **Then** a file tab labelled with the file name opens, becomes active and shows the preview (text, Markdown, image and the existing empty states).
2. **Given** that file's tab is open, **When** the developer activates the same row, **Then** that tab is activated and no tab is added.
3. **Given** two files with the same name in different folders, **When** both are open, **Then** each tab label extends the path until the labels differ (for example `a/src/index.ts` and `b/src/index.ts`), and the tooltip and the view header show the full path.
4. **Given** a keyboard activation (Enter or Space) on a file row, **When** the tab opens, **Then** focus moves to the new tab so Arrow keys and Delete work at once; a pointer activation leaves focus where it is.
5. **Given** a file row, **When** the developer presses Ctrl+click or Ctrl+Enter, **Then** the tab opens without activating, the file list keeps its focus and the announcer names the opened file.
6. **Given** a file tab opened from a row, **When** the developer closes it, **Then** the tab that was active when it opened becomes active (the neighbour if that tab is gone) and focus returns to the originating row where it still exists.

### User story 2 - Review a diff in its own tab (P1)
**Acceptance scenarios**:
1. **Given** the Git changes list, **When** the developer activates a changed file, **Then** a diff tab opens and the Git changes panel keeps its list (no in-panel diff, no Back button). Ctrl+click and Ctrl+Enter open in the background, as in story 1.
2. **Given** a file is both staged and modified, **When** the developer opens each row, **Then** two diff tabs open, labelled Staged and Unstaged (shared `diffGroupLabel`; Untracked and Conflicts likewise), and each accessible name carries type, group and counts, for example "Diff, Button.tsx, staged, +12 −3".
3. **Given** a diff tab is open and the file's changes change on disk, **Then** the diff refreshes in place while the tab is active or not; **and when** the file is no longer changed, **Then** the tab shows "No longer changed" on the tab itself and in the view, announces it through a `role="status"` region, and stays until closed.
4. **Given** a diff tab for a Changes entry, **When** the developer stages that file, **Then** the open tab retargets to the Staged group, or closes if a Staged tab for that path already exists; unstaging does the reverse.

### User story 3 - Hide the chat to maximise the right pane (P1)
**Acceptance scenarios**:
1. **Given** chat and right pane showing, **When** the developer uses the rail toggle, palette command, "Right pane width" menu item or shortcut, **Then** the chat collapses to zero width and the right pane fills the space.
2. **Given** chat is hidden, **When** the developer shows it again, **Then** the chat returns at its previous width, the right pane then resizes back to `widthPx`, and both match their earlier widths when the window did not change.
3. **Given** the right pane is closed, **When** the developer hides the chat, **Then** the right pane opens first on its last active tab (the launcher only when no tab exists); **and given** chat is hidden, **When** the right pane is closed, **Then** chat is shown.
4. **Given** an agent is streaming while chat is hidden, **When** chat is shown, **Then** the stream, scroll position and composer draft are intact; in a Split, both Chat panes keep their scroll and draft and neither remounts.
5. **Given** chat is hidden, **When** the developer selects a Session from the Session list, a notification, "New session" or the palette, **Then** chat shows.
6. **Given** chat is hidden and a Session needs the developer, **Then** the rail toggle shows a numeric badge and its accessible name says so; chat is not shown for you.

### User story 4 - A wider right pane (P2)
1. **Given** any state, **When** the developer drags the handle, uses arrow keys, Home/End or a preset, **Then** the pane widens beyond 520 px up to the window limit and the 240 px floor still holds.
2. **Given** chat is hidden, **Then** the width presets and the right-pane handle are disabled and a "Show chat" item takes their place; the saved `widthPx` never reflects the filled width.

### User story 5 - Tabs survive a restart (P2)
1. **Given** tabs open for two Sessions and chat hidden, **When** the app restarts, **Then** each Session shows its tabs, active tab and eviction recency, and chat is still hidden (when you are in the chat view).
2. **Given** a restored file tab whose file is gone, **Then** it shows "This file no longer exists" rather than an error.

### Edge cases
- No Session open or a Session with no Project (Personal Agent): file and diff tabs are not offered; the existing "No repository" states stay.
- 21st document tab: the dead tab closes first, else the least recently active; the opened tab and the active tab are never the one closed; a toast and a polite announcement say "Closed Foo.ts (20-tab limit)".
- Session archived: its tabs stay (you can restore the Session). Session deleted: its tabs are dropped.
- A path with `..`, absolute or `\` segments from an agent action: refused by `normaliseRelativePath` before any tab opens. `reveal` on a folder keeps its behaviour (expands the folder in the File explorer, opens no tab).
- Chat hidden, then you open Home, Pull requests, Issues or Usage: the chat area is shown (the right pane is inert there), and the stored `chatCollapsed` preference is untouched, so returning to the chat view hides chat again.
- You drag the right pane wide enough that the chat panel collapses: chat state syncs to collapsed and the invariant holds (FR-018). You collapse the right pane while chat is collapsed: chat shows.
- Stored `open: false` with `chatCollapsed: true` (hand edit or older bug): `restoreRightPane` normalises it to `chatCollapsed: false`.
- Narrow window: the layout has no window minimum (see Grounding), so a window can be narrower than rail 48 px + Session list 220 px + chat 360 px + pane 240 px (about 870 px). Then "Show chat" gives chat its 360 px and closes the right pane (tabs and `widthPx` kept) when 240 px does not remain. The Wide preset is disabled when 640 px plus chat 360 px, the rail and the visible Session list do not fit (about 1330 px at the default 280 px Session list). Chat keeps its minimum, and the toggle stays the way to maximise the right pane.

## Requirements

**Tabs**
- FR-001: Document tab identities: `file`: Session id and normalised relative POSIX path; `diff`: Session id, group (`conflicts`, `staged`, `changes`, `untracked`) and path. DOM ids (`aria-controls`, `aria-labelledby`) use a stable hash of the identity.
- FR-002: Opening an existing identity activates it (or leaves it inactive for a background open) and never duplicates it.
- FR-003: `PanelTabBar` renders panel tabs, one thin `aria-hidden` decorative separator, then the front Session's document tabs, all from one list of tab items; no second tab strip or copied tab markup (ADR 0003). Document tabs reuse `TAB_LOOK_CLASS` (no fill, pill or box) with a leading type icon (`FileIcon`, `FileDiffIcon`); diff tabs show `DiffStatCounts` (with `accessibleLabel`) hidden under `COMPACT_HIDE`. Document tabs are `shrink-0 min-w-28 max-w-48` with the name taking `shrink-[100]` priority and truncating; every class sits on the 8 px grid.
- FR-004: Selection is one `TabKey` union (`{ kind: 'panel', id }` or `{ kind: 'document', sessionId, id }`) with one `activateTab` mutation that sets both stores together. The union is derived, never stored: `frontActiveTab()` resolves it for the front Session on every read, so a Session switch or restore cannot leave it stale. Switching Session swaps the document tabs and restores that Session's active tab; panel tabs are unchanged; with no active document tab the selection falls back to the last active panel tab.
- FR-005: File explorer file row activation opens a file tab (click, Enter, Space) and moves focus to it after keyboard activation; Ctrl+click and Ctrl+Enter open it in the background; the bottom preview split is removed so the tree fills the panel.
- FR-006: Git changes row activation opens a diff tab with the same opener rules as FR-005; the in-panel diff and Back button are removed. Agent `show_file` opens the diff tab and `reveal` (file) opens the file tab: the tab activates, focus stays (`openPanel(…, {focus:false})` precedent), and the `AgentOpenedAnnouncer` message names the file and kind ("Agent opened diff of foo.ts"). An existing tab activates with no duplicate.
- FR-007: Each tab has a close button (shared `IconButton`, named from the item kind: "Close index.ts file", "Close Button.tsx diff", "Close Git changes panel"), closes with Delete and middle-click. Closing a panel tab activates the neighbour (existing rule). Closing a document tab activates the tab that was active when it opened (`openedFrom`), then the neighbour, and focus returns to the originating row where it still exists, else to the new active tab. The close hit area extends to the 40 px strip height.
- FR-008: Panel tabs pin at the strip's left; document tabs scroll in their own container and keep the active tab in view. An "All tabs" `IconButton` labelled "All tabs" sits outside the scroller, mounts with the tablist (never conditionally), and opens a `DropdownMenu` of `DropdownMenuRadioGroup` items, each with a leading icon, grouped Panels, Files and Diffs by separators, with a capped height. Tab and close button are flex siblings in an in-flow `role="presentation"` wrapper per item (a tab cannot contain a button); `closePositions` and its per-tab `ResizeObserver` are removed.
- FR-009: One tab only: the title row with Close shows (existing rule), counting panel and document tabs together. A lone document tab's title is its full path. `RightPaneShell`'s `isTabBar`, launcher test and `isGenuineOpen` focus logic handle document tabs.
- FR-010: At most 20 document tabs per Session. Opening a 21st evicts, in order: a dead tab ("No longer changed" or a deleted file), then the least recently active; never the tab being opened or the active tab. Eviction is announced in the polite region and with a toast ("Closed Foo.ts (20-tab limit)"). The cap's reason is strip usability, not preview memory (`RightPaneShell` mounts only the active panel). Recency persists (FR-011).
- FR-011: Document tabs persist in `Settings.rightPane.documentTabs`: `{ [sessionId]: { tabs: [{ kind, group?, path }], activeId, recency } }`. An entry is invalid, and dropped on load, when its kind or group is unknown, its path fails the `normaliseRelativePath` rules or exceeds 1024 bytes, its identity repeats, or its Session holds more than 20. Unknown Sessions are pruned only when the Sessions load succeeded (the `if (sessionsLoad.ok)` guard at `init-stores.ts:320`); deleting a Session drops its tabs, archiving does not.
- FR-012: Document tab content is a shared view: file tabs reuse `FilePreviewPane` (Wrap and Source toggles, path actions), diff tabs reuse `DiffViewFromPatch` through a view extracted from `GitChangesDiffPane`. Refresh: each view acquires the ref-counted git watcher itself (`watcherRefCounts` exists in both `GitChangesPanel.tsx:16` and `FileExplorerPanel.tsx:72`), because the panel is unmounted while a document tab is active; a file tab also reloads when it activates and when the Session's git snapshot changes for its path. Stale loads cancel: `previewRequestSeq` in `state/file-explorer-store.ts:176` is keyed by Session, so file tabs key it by Session and path, and arrow-key activation across many tabs never piles up previews. Per-tab view state (Wrap, Source, scroll position) lives in the document store (not persisted). The view renders one landmark, the `tabpanel`: `FilePreviewPane`'s own `role="region"` and `tabIndex` (`FilePreviewPane.tsx:156`) are removed there.

**Chat collapse**
- FR-013: The `chat` panel is `collapsible` with `collapsedSize` 0; the effective state is `effectiveCollapsed = chatCollapsed && view === 'chat'`, so Home, Pull requests, Issues and Usage always show the chat area; the stored preference persists as `Settings.rightPane.chatCollapsed` and is never overwritten by a view change.
- FR-014: One toggle action `toggleChatPane` shared by the rail button, the palette ("Hide chat" / "Show chat"), the "Right pane width" dropdown in the app menu bar plus the handle's context menu, and the shortcut, mirroring `toggle-right-pane.ts`. The native `menu.rs` View menu stays unchanged.
- FR-015: The rail toggle is built from one shared `RailIconButton` (extracted from `IconRail`; the Right pane toggle and `RailButton` use it too, no fork). It has the fixed name "Chat pane", `aria-expanded` and `aria-controls` (no `aria-pressed`), a tooltip naming the shortcut and stating that Pause and Stop stay in the palette, a target of 24 px or more (the rail button is 40 px), and a `MessagesSquareIcon`. It sits under the Right pane toggle in the fixed top group, not the reorderable toolbar, and is disabled when there is no Session.
- FR-016: A `toggle-chat-pane` action is registered in `builtinActions.ts` beside `toggle-right-pane` (line 129) with chord Ctrl+Shift+H and `when: () => view === 'chat'`. `useChordDispatcher` supplies the guards (repeat, IME composition, open overlay) and `chordMatches` supplies exact modifiers (so Alt is ignored). Ctrl+Shift+H has no in-app collision (existing chords: Ctrl+Shift+P, X, B, `\`, 0 and the palette chords). Whether WebView2 swallows it is checked live. Ctrl+W stays "Close chat pane" and is not reused for tabs.
- FR-017: Hiding keeps the chat area mounted, `inert` and `aria-hidden`; streams, scroll and drafts survive. The split width state freezes while collapsed: width-0 resizes from the collapsed panel are ignored, `chatWidthPx` and `canShowSplit` keep their values, so `showSplit` stays true, pane B does not unmount, and the `setVisible` effect keeps both Sessions in the visible set. Hosted-panel suspend/resume for the right pane is unaffected.
- FR-018: Never both hidden. Hiding chat opens the right pane when closed (on its last active tab, else the launcher). Closing or collapsing the right pane while chat is hidden shows chat. A chat collapse the user drags (the panel's `onResize` reports 0, as `navCollapsed` is synced from the Session list panel) updates the same state and obeys the same invariant. `restoreRightPane` normalises a stored `open: false` with `chatCollapsed: true` to `chatCollapsed: false`.
- FR-019: Focus mirrors `toggleRightPane`: focus moves only when it was inside the area being hidden, or when the shortcut triggered the action; a pointer click on the rail toggle keeps focus there. Hiding with focus in chat focuses the active tab content (or launcher). Showing focuses the front composer: in a Split, the Focused Chat pane's composer; for a Session with no composer, that Chat pane's transcript region. A polite live region announces "Chat hidden" or "Chat shown" through the existing `AgentOpenedAnnouncer` store.
- FR-020: In a Split, the toggle hides both Chat panes together. While chat is hidden, `close-chat-pane` (Ctrl+W) and `focus-other-pane` (Ctrl+Shift+\) are disabled through their `when()` guards (`builtinActions.ts:121-122`, `143-144`). The Ctrl+N quick-create fallback announcement (`sessions/quickCreateFallback.ts:21`) goes through the always-mounted chat-area announcer in `App.tsx`, so it stays audible while chat is hidden. Selecting a Session by an explicit action (Session list, notification, "New session" including Ctrl+N, palette) shows chat first; this differs from the agent-initiated opens of FR-006, which never change chat visibility.
- FR-033: Attention badge: `CountBadge` shows a count of 1 or 2 on the rail toggle while chat is hidden, counting needs-you Sessions in the visible Chat panes (one, or two in a Split). The number is the non-colour cue (WCAG 1.4.1); no new dot or badge concept. The accessible name keeps the base "Chat pane" and appends `needsYouLabel` wording ("Chat pane, 1 needs you"). The badge clears when chat shows or the status clears; the transition announces once in the polite region.
- FR-034: Hidden chat keeps its Sessions marked visible (`visible_ids` gates patch flushing at `session/agent/mod.rs:143`, health at `health.rs:161` and the advisor at `advisor.rs:67`; clearing it would break SC-004). The recorded consequence: an Unread response (CONTEXT: finished while the Session was not shown in a Chat pane) is not raised while chat is hidden, because the Session never reads as not shown.

**Width**
- FR-021: Remove `RIGHT_PANE_MAX_WIDTH_PX` as a layout cap; the right panel has no `maxSize`; the limit is the window (group width minus Session list minus chat 360 px while chat shows).
- FR-022: Keep the 240 px floor and the 320 px default; reset by double-click unchanged; drag, arrows, Home/End and presets keep working while chat shows.
- FR-023: `PANE_WIDTH_CHOICES`: Narrow 240, Default 320, Wide 640. The Wide choice is disabled where it cannot fit (edge case above). "Hide chat" / "Show chat" appear in the handle context menu and in the app menu bar's "Right pane width" dropdown, which closes the single-pointer alternative that `docs/design/accessibility.md` records as open under 2.5.7.
- FR-024: `widthPx` is authoritative and chat is the remainder. The right panel's `onResize` calls `setWidth` only for user-driven resizes, never for the width it gains from a chat collapse. Showing chat expands chat first, then resizes the right pane to `widthPx`. While chat is hidden the presets and the right-pane handle are disabled, the handle's accessible name and the `PaneWidthMenu` checked state do not report `widthPx`, and "Show chat" takes their place. Renderer and Rust clamp `widthPx` to 240..4096 as a sanity ceiling only.

**Quality**
- FR-025: Every control comes from a shared component in `src/renderer/components/` or an existing shared feature component (ADR 0003): `RailIconButton`, `CountBadge`, `IconButton`, `DropdownMenu`, `TAB_LOOK_CLASS`, the announcer store and toast helpers, and one `diffGroupLabel` (beside `GROUP_LABELS` in `GitChangesGroup.tsx`, replacing the hand-built string at `GitChangesPanel.tsx:299`). `PanelTabBar` and rail buttons are extended with props or slots, never forked.
- FR-026: Keyboard: tablist Arrow, Home, End, Delete work across panel and document tabs; tab names include type and, for diffs, group and counts; all states meet WCAG 2.2 AA (2.5.7 dragging and 2.5.8 target size are 2.2 criteria) including focus visible and a single-pointer alternative to the drag.
- FR-027: No touched file exceeds 600 lines (extract before adding; `FileExplorerPanel.tsx` is 620); comments say why, never what (#1322).
- FR-028: Per-panel state survives tab switches: `GitChangesPanel`'s `groupOpen` and the Side chat draft move from local state to Session-keyed stores, so the tree, the groups and the draft are as you left them.
- FR-029: The All tabs menu adds "Close others", "Close all files and diffs" and "Close no-longer-changed tabs", each announced with the count closed.
- FR-030: Staging or unstaging retargets the open diff tab to its new group, or drops it when that identity already exists; a diff whose file is no longer changed shows the dead state on the tab and as a `role="status"` announcement.
- FR-031: Docs: update `docs/design/components.md:147` (Wide 520, the 240..520 range) and `:148` (tab bar), `CONTEXT.md:371` ("Wide 520", "no Min/Default/Max"; add Document tab and Chat collapse terms), `docs/design/accessibility.md` (the 2.5.7 note and its Open entry), the Tooltip and Diff stat sections, and the "Reusable components first" inventory; amend specs 024 and 035 with a "superseded by 137" note.
- FR-032: Panel liveness: live state that a panel's unmount drops (such as the git watcher count) is reacquired by the document view that replaces it (see FR-012).

## Key entities
- **Document tab**: a file or diff tab in the right pane, per Session. New glossary term in `CONTEXT.md`.
- **Tab item**: the render model `PanelTabBar` takes (id, kind, icon, label, tooltip, closable, trailing).
- **Active tab**: the one selection union over panel and document tabs, derived for the front Session.
- **Chat collapse**: the chat area at zero width, persisted as a preference and applied only in the chat view. New glossary term.

## Success criteria
- SC-001: Open ten files and diffs; each is one tab, no duplicates, any reachable by keyboard alone; opening the 21st evicts per FR-010 with a visible announcement.
- SC-002: With chat hidden the right pane is wider than 520 px on a 1920 px window; showing chat restores both widths exactly when the window did not change.
- SC-003: Restart restores tabs, active tab, recency and chat state; a deleted file shows the deleted state.
- SC-004: A streaming Session keeps streaming while chat is hidden, in a single chat and in a Split, with scroll position and drafts intact (live check, including a scroll-position assertion).
- SC-005: `pnpm ci:local` green; new logic has co-located tests; every guard's test fails when the guard is removed (mutation proof).

## Out of scope
Editing (#878), drag-reorder of tabs, split or pinned document tabs, a preview-tab mode, centre-pane tabs (#1102, #732).

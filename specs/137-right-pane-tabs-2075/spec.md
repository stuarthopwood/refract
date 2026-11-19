# Feature Specification: Right pane file and diff tabs, collapsible chat, wider pane

**Feature Branch**: `feat/2075-right-pane-tabs`
**Created**: 2026-11-19
**Status**: Draft (awaiting UI design review)
**Input**: GitHub issue #2075 (p1, `right-pane`, child of epic #1135). Route: `specify`, per the `github-actions[bot]` triage comment. Grill replaced by delegated decisions (below); items marked [REVIEW] go to the `ui-architect-v3` review before code. Supersedes the centre main-area tab direction of #1102 and #732 (closed); retargets #878's editable Rendered view onto file tabs. Builds on spec 024 (right-pane toggle and persistence), spec 035 (file explorer) and #730 (panel order).

## Grounding (corrects the issue premise)

Files and diffs already open in the RIGHT pane, not the centre. A diff replaces the Git changes file list in-panel (`git-changes/GitChangesPanel.tsx`, `GitChangesDiffPane`, Back button); a file preview is a bottom split inside the File explorer (`file-explorer/FilePreviewPane.tsx`). The right pane is capped at 520 px (`state/right-pane-store.ts:5`, mirrored by `src-tauri/src/store/right_pane.rs` `WIDTH_MAX`), and the centre `chat` `ResizablePanel` in `App.tsx` has `minSize={360}` and no `collapsible`. `PanelTabBar` renders only `openPanelIds` (`PanelId` panels). `usePinnedPanelsStore` (PR and Issue) is the precedent for non-registry tabs.

## Clarifications (Decided, Skippy, delegated by Stuart 2026-11-19; full list in the issue comment)

- Identity: `file` = Session + relative path; `diff` = Session + group + relative path. Reopening activates the existing tab. (FR-001, FR-002)
- One strip: `PanelTabBar` is extended; document tabs follow panel tabs; panel tabs are window-wide, document tabs are per Session. (FR-003, FR-004)
- Close and overflow: close button, Delete, middle-click; scroll plus an "All tabs" menu when overflowing; **[REVIEW]** cap of 20 per Session, least recently active closes. (FR-007 to FR-010)
- Openers: explorer file row, Git changes row, agent `show_file` and `reveal` (no focus steal). **[REVIEW]** every activation is a persistent tab; no preview tab. (FR-005, FR-006)
- Persistence: `Settings.rightPane.documentTabs` and `chatCollapsed`. (FR-011, FR-012)
- Chat collapse: rail toggle, palette, View menu, shortcut; stays mounted; never both hidden. **[REVIEW]** split view hides both panes; **[REVIEW]** attention badge, no auto-restore. (FR-013 to FR-020)
- Width: 520 px cap removed; 240 px floor kept; Wide preset 640; 4096 px sanity ceiling. (FR-021 to FR-024)

## User Scenarios

### User Story 1 - Read a file in its own tab (P1)
A developer clicks a file in the File explorer and reads it in a tab beside the Git changes tab, with the tree still visible when they switch back.
**Independent Test**: open two files; two tabs; reopen the first; no third tab.
**Acceptance Scenarios**:
1. **Given** the File explorer shows a tree, **When** the developer activates a file row, **Then** a file tab labelled with the file name opens, becomes active and shows the preview (text, Markdown, image and the existing empty states).
2. **Given** that file's tab is open, **When** the developer activates the same row, **Then** that tab is activated and no tab is added.
3. **Given** two files with the same name in different folders, **When** both are open, **Then** each tab label adds its parent folder so they differ, and the tooltip shows the full path.

### User Story 2 - Review a diff in its own tab (P1)
**Acceptance Scenarios**:
1. **Given** the Git changes list, **When** the developer activates a changed file, **Then** a diff tab opens and the Git changes panel keeps its list (no in-panel diff, no Back button).
2. **Given** a file is both staged and modified, **When** the developer opens each row, **Then** two diff tabs open, labelled so staged and unstaged differ.
3. **Given** a diff tab is open and the file's changes change on disk, **Then** the diff refreshes in place; **and when** the file is no longer changed, **Then** the tab shows "No longer changed" and stays until closed.

### User Story 3 - Hide the chat to maximise the right pane (P1)
**Acceptance Scenarios**:
1. **Given** chat and right pane showing, **When** the developer uses the rail toggle, palette command, View menu item or shortcut, **Then** the chat collapses to zero width and the right pane fills the space.
2. **Given** chat is hidden, **When** the developer shows it again, **Then** the chat returns at its previous width and the right pane returns to its previous width.
3. **Given** the right pane is closed, **When** the developer hides the chat, **Then** the right pane opens first (never both hidden); **and given** chat is hidden, **When** the right pane is closed, **Then** chat is shown.
4. **Given** an agent is streaming while chat is hidden, **When** chat is shown, **Then** the stream, scroll position and composer draft are intact.

### User Story 4 - A wider right pane (P2)
1. **Given** any state, **When** the developer drags the handle, uses arrow keys, Home/End or a preset, **Then** the pane widens beyond 520 px up to the window limit and the 240 px floor still holds.

### User Story 5 - Tabs survive a restart (P2)
1. **Given** tabs open for two Sessions and chat hidden, **When** the app restarts, **Then** each Session shows its tabs and active tab, and chat is still hidden.
2. **Given** a restored file tab whose file is gone, **Then** it shows "This file no longer exists" rather than an error.

### Edge Cases
- No Session open or a Session with no Project (Personal Agent): file and diff tabs are not offered; the existing "No repository" states stay.
- 21st document tab: the least recently active closes; the new tab is never the one closed.
- Session archived or deleted: its tabs are dropped.
- A path with `..`, absolute or `\` segments from an agent action: refused by `normaliseRelativePath` before any tab opens.
- Window too narrow for chat 360 px plus pane 240 px: chat stays visible (min wins) and the toggle is the way to maximise.

## Requirements

**Tabs**
- FR-001: Document tab identities: `file`: Session id and normalised relative POSIX path; `diff`: Session id, group, and path.
- FR-002: Opening an existing identity activates it and never duplicates it.
- FR-003: `PanelTabBar` renders panel tabs then the front Session's document tabs from one list of tab items; no second tab strip or copied tab markup (ADR 0003). Items carry icon, label, tooltip, closable and optional trailing slot (diff counts).
- FR-004: Switching Session swaps the document tabs and restores that Session's active tab; panel tabs are unchanged. Active tab falls back to the last active panel tab.
- FR-005: File explorer file row activation opens a file tab (click, Enter, Space); the bottom preview split is removed so the tree fills the panel.
- FR-006: Git changes row activation opens a diff tab; the in-panel diff and Back button are removed. Agent `show_file` opens the diff tab and `reveal` (file) opens the file tab, neither moving focus; announcements via `AgentOpenedAnnouncer` unchanged. [REVIEW: no preview tab]
- FR-007: Each tab has a close button, closes with Delete and middle-click; closing the active tab activates the neighbour (existing rule) and moves focus there.
- FR-008: When tabs overflow, the strip scrolls and keeps the active tab in view; an "All tabs" menu (shared `DropdownMenu`) lists every tab and activates the chosen one.
- FR-009: One tab only: the title row with Close shows (existing rule), counting panel and document tabs together.
- FR-010: [REVIEW] At most 20 document tabs per Session; opening another closes the least recently active.
- FR-011: Document tabs and each Session's active tab persist in `Settings.rightPane.documentTabs`; invalid entries are dropped on load; tabs of unknown Sessions are dropped.
- FR-012: Document tab content is a shared view: file tabs reuse `FilePreviewPane` (with Wrap and Source toggles and the path actions); diff tabs reuse `DiffViewFromPatch` through a view extracted from `GitChangesDiffPane`.

**Chat collapse**
- FR-013: The `chat` panel is `collapsible` with `collapsedSize` 0; state persists as `Settings.rightPane.chatCollapsed`.
- FR-014: One toggle action `toggleChatPane` shared by the rail button, the palette ("Hide chat" / "Show chat"), the View menu and the shortcut, mirroring `toggle-right-pane.ts`.
- FR-015: The rail toggle is a shared rail button with `aria-pressed`, a visible tooltip naming the shortcut and a 24 px-or-larger target (WCAG 2.5.8).
- FR-016: The shortcut works only in the chat view, ignores Alt, repeat, IME composition and any open overlay (same guards as `use-right-pane-shortcut.ts`) and does not collide with an existing binding.
- FR-017: Hiding keeps chat mounted, `inert` and `aria-hidden`; streams, scroll and drafts are preserved; hosted-panel suspend/resume for the right pane is unaffected.
- FR-018: Never both hidden: hiding chat opens the right pane; closing the right pane while chat is hidden shows chat.
- FR-019: Focus: hiding with focus in chat focuses the active tab content (or launcher); showing focuses the front composer. A polite live region announces "Chat hidden" or "Chat shown".
- FR-020: [REVIEW] Split view: the toggle hides both chat panes together. [REVIEW] If a hidden chat's Session needs the developer, the rail toggle shows the existing attention badge and its accessible name says so; chat is not auto-restored.

**Width**
- FR-021: Remove `RIGHT_PANE_MAX_WIDTH_PX` as a layout cap; the right panel has no `maxSize`; the limit is the window (group width minus Session list minus chat 360 px while chat shows).
- FR-022: Keep the 240 px floor and the 320 px default; reset by double-click unchanged; drag, arrows, Home/End and presets keep working.
- FR-023: `PANE_WIDTH_CHOICES`: Narrow 240, Default 320, Wide 640; the handle context menu and View menu gain "Hide chat" / "Show chat".
- FR-024: `widthPx` keeps its value while chat is hidden (the filled width is not saved), so showing chat restores it. Renderer and Rust clamp to 240..4096 as a sanity ceiling only.

**Quality**
- FR-025: Every control comes from a shared component in `src/renderer/components/` (ADR 0003); `PanelTabBar` and rail buttons are extended with props or slots, never forked.
- FR-026: Keyboard: tablist Arrow, Home, End, Delete work across panel and document tabs; tab names include type and, for diffs, the group; all states meet WCAG 2.1 AA including focus visible and 2.5.7 (no drag-only resize).
- FR-027: No touched file exceeds 600 lines (extract before adding); comments say why, never what (#1322).

## Key Entities
- **Document tab**: a file or diff tab in the right pane, per Session. New glossary term in `CONTEXT.md`.
- **Tab item**: the render model `PanelTabBar` takes (id, kind, icon, label, tooltip, closable, trailing).
- **Chat collapse**: chat panel at zero width, persisted.

## Success Criteria
- SC-001: Open ten files and diffs; each is one tab, no duplicates, any reachable by keyboard alone.
- SC-002: With chat hidden the right pane is wider than 520 px on a 1920 px window; showing chat restores both widths exactly.
- SC-003: Restart restores tabs, active tab, chat state; a deleted file shows the deleted state.
- SC-004: A streaming Session keeps streaming while chat is hidden (live check).
- SC-005: `pnpm ci:local` green; new logic has co-located tests; every guard's test fails when the guard is removed (mutation proof).

## Out of Scope
Editing (#878), drag-reorder of tabs, split or pinned document tabs, a preview-tab mode, centre-pane tabs (#1102, #732).

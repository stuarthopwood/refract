# Implementation Plan: Right pane file and diff tabs, collapsible chat, wider pane

**Spec**: `specs/137-right-pane-tabs-2075/spec.md` **Issue**: #2075 **Branch**: `feat/2075-right-pane-tabs`

## Summary

Add a per-Session document-tab model beside the existing panel tabs, extend `PanelTabBar` to render both from tab items, route the explorer and Git changes row activations (and the agent `show_file` and `reveal` actions) into it, make the centre chat panel collapsible with a shared toggle, lift the 520 px cap, and persist the new state in `Settings.rightPane`. Renderer plus a small Rust settings change; no new dependency.

## Reused patterns (read on `origin/main`; line numbers to re-check at implement time)

| Need | Reuse | Where |
|---|---|---|
| Tab strip | `PanelTabBar` extended with tab items | `features/right-pane/PanelTabBar.tsx` |
| Non-registry tabs | pinned panels precedent | `usePinnedPanelsStore`, `panel-registry.ts` `isPinnedPanelId` |
| Pane store and width constants | `useRightPaneStore` | `state/right-pane-store.ts:5-7` |
| Persistence, debounce, snapshot | `startRightPanePersistence`, `restoreRightPane` | `features/right-pane/right-pane-persistence.ts` |
| Rust settings row, clamp | `RightPaneState`, `WIDTH_MAX`, plain-replace setter | `src-tauri/src/store/right_pane.rs`; `shared/rightPane.ts` |
| Pane toggle (template for chat toggle) | `toggleRightPane`, `use-right-pane-shortcut.ts` | `features/right-pane/toggle-right-pane.ts` |
| Rail buttons, palette actions | `IconRail.tsx`, `builtinActions.ts` | `features/right-pane/IconRail.tsx`, `features/palette/builtinActions.ts` |
| Width presets, menu | `PaneWidthMenu.tsx`, `RightPaneResizeHandle.tsx` | `features/right-pane/` |
| File preview view | `FilePreviewPane` | `file-explorer/FilePreviewPane.tsx` |
| File open path | `activateRow` then `loadPreview` | `FileExplorerPanel.tsx` (~303) and `state/file-explorer-store.ts` |
| Diff view and open path | `GitChangesDiffPane`, `openDiff`, `agentOpened` | `git-changes/GitChangesPanel.tsx` |
| Agent actions | `show_file`, `reveal`, `PANEL_ACTION_HANDLERS` | `features/right-pane/agent-panel-actions.ts` |
| Hosted panel focus and announcer | `AgentOpenedAnnouncer`, `hosted-panel-actions.ts` | `features/right-pane/` |
| Layout | chat `ResizablePanel` | `App.tsx` (~217) |

## Design

1. **State** (`state/document-tabs-store.ts`, new): `bySession[sessionId] = { tabs: DocumentTab[], activeId, recency: string[] }`; `openDocumentTab` (dedupe, activate, apply 20-cap), `closeDocumentTab`, `activateDocumentTab`, `restore`, `dropSession`. Tab id is derived from identity (`file:<path>`, `diff:<group>:<path>`), so dedupe is a map lookup. Pure helpers (`tabIdentity`, `labelsFor` for duplicate-name disambiguation, `pickEviction`) live beside it for unit tests.
2. **Active selection**: extend `useRightPaneStore` so `activePanelId` stays for panels and a separate `activeDocumentId` (per front Session via the document store) takes precedence when set; selecting a panel tab clears it. Persistence snapshot adds `documentTabs`, `chatCollapsed`.
3. **`PanelTabBar`**: accept `items: TabItem[]` (panel and document tabs), `onActivate`, `onClose`, an optional `overflowMenu` slot; keep roving tabindex, Arrow, Home, End, Delete; `scrollIntoView` for the active tab; "All tabs" `DropdownMenu` shown only when `scrollWidth > clientWidth` (ResizeObserver).
4. **Views**: `DocumentTabView` (new, in `features/right-pane/documents/`) switches on kind: `FileTabView` wraps `FilePreviewPane` and reads the preview through the file-explorer store keyed by path (extend `loadPreview` so a tab can hold its own preview; keep one preview per open file tab, evicted on close); `DiffTabView` wraps `DiffViewFromPatch`, extracted from `GitChangesDiffPane` into `git-changes/GitDiffView.tsx` so the panel no longer owns diff state. Remove the in-panel preview split and Back button.
5. **Openers**: explorer `activateRow` file branch calls `openDocumentTab`; Git changes `openDiff` calls it; agent `showFile` and `reveal` call it with `focus: false`, preserving `agentOpened` semantics through the announcer.
6. **Chat collapse**: `chat-collapse-store` or a field on the right-pane store (`chatCollapsed`); `App.tsx` chat panel gets `collapsible collapsedSize={0}`, an imperative panel ref, `inert` and `aria-hidden` when collapsed; `toggleChatPane()` enforces the never-both-hidden invariant and moves focus; rail toggle, palette entries, View menu item, shortcut and a polite live region call it. In split view the toggle collapses the whole centre group.
7. **Width**: remove `maxSize` from the right panel and the 520 constant; compute the layout limit from the group width; `RIGHT_PANE_MAX_WIDTH_PX` becomes `RIGHT_PANE_SANITY_MAX_WIDTH_PX` (4096) mirrored in Rust `WIDTH_MAX`; presets 240/320/640; `widthPx` is not overwritten while chat is hidden.
8. **Persistence / Rust**: add optional `document_tabs` and `chat_collapsed` to `RightPaneState` with defaults (`parse_from_disk` already treats a missing key as default, so no migration); renderer validates on `restoreRightPane`; the Rust side validates shape and relative paths only.
9. **Docs**: `CONTEXT.md` glossary gains "Document tab" and "Chat collapse"; `docs/design/components.md` records the `PanelTabBar` item API; amend spec 024 and 035 with a "superseded by 137" note on the preview split.

## Risks and open items

- Memory: each file tab holds a preview; the 20-tab cap and eviction on close bound it. [REVIEW]
- `react-resizable-panels` collapse with a hidden panel keeps its size; verify `collapsedSize={0}` plus `minSize={360}` do not fight on window shrink.
- Shortcut candidate `Ctrl+Shift+H` must be checked against `keybindings` and the OS before use (T-task).
- Files near 600 lines (`FileExplorerPanel.tsx` 620, `GitChangesPanel.tsx` ~560): extract before adding (spec FR-027).

## Verification

Co-located Vitest tests for the store, labels, eviction, `PanelTabBar` overflow and keyboard, toggle invariant, shortcut guards, persistence round-trip; Rust tests in `right_pane.rs` for the new fields and the new ceiling. Live check on a scratch build (see `skill://refract-tauri-live-check-isolation`): tabs, hide and show chat while streaming, width beyond 520, restart restore. Evidence under task scratch `evidence/`.

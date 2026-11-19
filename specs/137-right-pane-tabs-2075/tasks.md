# Tasks: Right pane file and diff tabs (#2075)

Test work is part of each task (AGENTS.md Testing rule): every guard's test must fail when the guard is removed, proven by mutating it. Co-located tests sit beside the source file. Run tasks in order within a phase; commit and push after each phase (`feat(right-pane): ... (#2075)`). Do not run `ci:local` before the final task. Check any file near 600 lines first and extract before adding.

## Phase 0: Gate
- [ ] T001 UI design review of the [REVIEW] items (tab cap and eviction, no preview tab, split-view hide, attention badge) by `ui-architect-v3`; fold the findings into spec.md. Nothing below starts before this. (controller)

## Phase 1: State and persistence
- [ ] T002 `src/renderer/state/document-tabs-store.ts` + `document-tabs-store.test.ts`: identity, dedupe, open/close/activate, 20-cap eviction by recency, dropSession, per-Session active (FR-001, FR-002, FR-004, FR-010).
- [ ] T003 `document-tab-labels.ts` + `.test.ts`: duplicate-name disambiguation, staged/unstaged diff labels, tooltip path (US1.3, US2.2).
- [ ] T004 `src/shared/rightPane.ts` and `src-tauri/src/store/right_pane.rs`: add `documentTabs`, `chatCollapsed`; replace the 520 cap with the 4096 sanity ceiling. Rust tests in `right_pane.rs` (missing key = default, bad shape ignored, relative-path validation, width ceiling) (FR-011, FR-013, FR-024).
- [ ] T005 `right-pane-store.ts` (+ test): drop the 520 constant, add the sanity ceiling, `activeDocumentId`, chat-collapsed flag; `right-pane-persistence.ts` (+ test): snapshot, restore validation, drop unknown Sessions (FR-011, FR-021, FR-024, US5).

## Phase 2: Tab strip
- [ ] T006 `PanelTabBar.tsx` (+ `PanelTabBar.test.tsx`): tab items, trailing slot, middle-click close, Delete, roving focus after close, scroll active into view (FR-003, FR-007, FR-026).
- [ ] T007 Overflow "All tabs" `DropdownMenu` in `PanelTabBar` with ResizeObserver, shown only when overflowing (FR-008); test with a mocked ResizeObserver.
- [ ] T008 `RightPaneShell.tsx` (+ test): build items from panel and document tabs, single-tab title row rule across both, route active content (FR-009).

## Phase 3: Views and openers
- [ ] T009 Extract `GitDiffView.tsx` from `GitChangesPanel.tsx` (+ test): diff fetch, loading, error, "No longer changed" state; `GitChangesPanel` keeps list and commit box only; drop Back button and `selection` state (FR-006, FR-012, US2.3).
- [ ] T010 `documents/DiffTabView.tsx` and `documents/FileTabView.tsx` (+ tests): wrap `GitDiffView` and `FilePreviewPane`; per-tab preview held in the file-explorer store and evicted on close; deleted-file state (FR-012, US5.2).
- [ ] T011 `FileExplorerPanel.tsx` (+ test): file activation opens a tab; remove the bottom split; extract helpers first (file is over 600 lines) (FR-005).
- [ ] T012 `GitChangesPanel.tsx` row activation opens a diff tab (+ test) (FR-006).
- [ ] T013 `agent-panel-actions.ts` (+ `agent-panel-actions.test.ts`): `show_file` and `reveal` open tabs without taking focus, path validation kept, `AgentOpenedAnnouncer` message names the tab (FR-006). Update `specs/124-tool-channel-1193/contracts/panel-actions.json` only if descriptions change; Rust contract tests in `src-tauri/src/agent_tools/` if it does.

## Phase 4: Chat collapse and width
- [ ] T014 `toggle-chat-pane.ts` (+ test): invariant (never both hidden), focus moves, live region text, split-view collapse (FR-014, FR-017 to FR-020).
- [ ] T015 `App.tsx`: chat panel `collapsible collapsedSize={0}`, ref, `inert`/`aria-hidden`, right panel with no `maxSize`, layout limit from group width (FR-013, FR-017, FR-021). Keep `App.tsx` under 600 lines by extracting a `CenterRightLayout` if needed.
- [ ] T016 `IconRail.tsx` toggle (`aria-pressed`, tooltip with shortcut, attention badge), `builtinActions.ts` palette entries, View menu item, `use-chat-pane-shortcut.ts` (+ tests incl. guards: Alt, repeat, IME, overlay) (FR-015, FR-016, FR-020).
- [ ] T017 `PaneWidthMenu.tsx`, `RightPaneResizeHandle.tsx` (+ tests): presets 240/320/640, "Hide chat" item, arrows/Home/End still work with the raised limit, width not overwritten while chat hidden (FR-022 to FR-024).

## Phase 5: Docs and glossary
- [ ] T018 `CONTEXT.md` terms; `docs/design/components.md` `PanelTabBar` item API; "superseded by 137" notes in specs 024 and 035; `docs/PLAN.md` row 1d.2 status.

## Phase 6: Verify
- [ ] T019 `pnpm ci:local`; fix only what fails.
- [ ] T020 Live check on a scratch build with isolated data: open ten files/diffs, dedupe, overflow, restart restore, hide chat while a Session streams, width beyond 520 px, keyboard-only pass; screenshots and notes under `evidence/` (SC-001 to SC-004).
- [ ] T021 Five-reviewer gate (code, security, test, a11y, performance), PR with `Closes #2075`; comment on #1102, #732 closed, #878 retarget note, epic #1135 updated.

## Coverage

FR-001 T002; FR-002 T002; FR-003 T006; FR-004 T002; FR-005 T011; FR-006 T009, T012, T013; FR-007 T006; FR-008 T007; FR-009 T008; FR-010 T002; FR-011 T004, T005; FR-012 T009, T010; FR-013 T004, T015; FR-014 T014; FR-015 T016; FR-016 T016; FR-017 T014, T015; FR-018 T014; FR-019 T014; FR-020 T014, T016; FR-021 T005, T015; FR-022 T017; FR-023 T017; FR-024 T004, T005, T017; FR-025 all view tasks; FR-026 T006, T020; FR-027 T011, T012, T015; SC-001 to SC-004 T020; SC-005 T019.

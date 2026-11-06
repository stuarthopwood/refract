# Tasks 051

- [x] T001 Rust list/view and IPC handlers
- [x] T002 Contract types, channels, parity, bridge
- [x] T003 Shared `ListDetailSplit`
- [x] T004 Shared `FilterTabs`; PR list uses it
- [x] T005 `ScreenHeader` window-controls prop
- [x] T006 Issues store
- [x] T007 Issues view, list, row, detail
- [x] T008 View routing and GitHub nav group
- [ ] T009 Gate: ci:local, reviewers, live check

## Phase 1: Convergence

- [x] T010 Add the shared `src/renderer/components/LabelOverflow.tsx`: a `Badge`-based focusable "+N" pill whose `Tooltip` (`flex-col items-start` content) lists each hidden label with its `ColourDot` on hover and keyboard focus, with the accessible name "N more labels: a, b" per FR-004
- [x] T011 Split `src/renderer/features/issues/IssueRow.tsx` into a container holding the `data-issue-row` title button and a sibling `LabelOverflow`, keeping the whole-row hit area, hover and selected fill, kebab inset, focus ring, `NewSessionRowMenu` context menu and `scripts/verify-tauri-*.mjs` selectors working per FR-004
- [x] T012 Update `scripts/hit-targets-baseline.json` for the new `LabelOverflow.tsx` raw button per FR-004
- [x] T013 Live-check on a scratch Tauri debug build (`scripts/verify-tauri-504.mjs`): Tab reaches "+N", the tooltip shows the hidden labels with colour dots on focus and hover, rows with two or fewer labels are unchanged; screenshots `02a-overflow-hover.png` and `02b-overflow-focus.png` per FR-004

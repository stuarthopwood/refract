# Tasks: Right pane toggle, persistence and rail counts

No new tests (prototyping phase). Verification: typecheck, existing tests, `pnpm ci:local`, live check.

- [x] T001 Git `usePanelCount` returns null with no changed files; count carries files and +/- (`panel-registry.ts`).
- [x] T002 Launcher row and tab render the git count via `DiffStatCounts` (`PanelLauncher.tsx`, `PanelTabBar.tsx`).
- [x] T003 Shared `PanelCountBadge` and rail badges with count-bearing names (`IconRail.tsx`).
- [x] T004 `toggleCollapsed` store action and the rail toggle button.
- [x] T005 `use-right-pane-shortcut.ts` (Ctrl+Shift+B) plus focus rules; mount it without growing `App.tsx`.
- [x] T006 Keyboard shortcuts dialog and `docs/design/index.md` Keyboard table.
- [x] T007 Rust: `store/right_pane.rs`, `Settings.right_pane`, `settings.setRightPane`, parity map.
- [x] T008 TS: model, ipc, bridge, settings-store default.
- [x] T009 `right-pane-persistence.ts` debounced writer; `restore` in `init-stores.ts` (drop unknown ids, repair active tab, launcher when empty).
- [x] T010 Docs: CONTEXT.md, `docs/design/components.md`, PLAN.md row 19 and C1.
- [ ] T011 Gate: `pnpm ci:local`, live check, five reviewers.

## Analysis (speckit.analyze)

Every FR maps to a task: FR-001 T004; FR-002/003 T005; FR-004 T006; FR-005 to FR-007 T007 to T009; FR-008/009 T001; FR-010 T003; FR-011 T002. No conflicts with spec 013 beyond the two declared amendments. Risk: `App.tsx` line cap (mitigated by new files).

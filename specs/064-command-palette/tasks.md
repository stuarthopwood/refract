# Tasks: spec 064

- [x] T001 Add `cmdk` and `components/ui/command.tsx` (FR-4).
- [x] T002 Add `features/palette/actionRegistry.ts` (FR-1).
- [x] T003 Extract `features/sessions/newSessionInFocusedPane.ts` from the Ctrl+N handler; `App.tsx` calls it (FR-2).
- [x] T004 Add `features/palette/builtinActions.ts`, register at startup, delete `usageViewAction.ts` (FR-2).
- [x] T005 Add `paletteStore.ts`, `usePaletteShortcut.ts`, `paletteItems.ts`, `usePaletteConversations.ts`, `CommandPalette.tsx`; mount in `App.tsx` (FR-3 to FR-7).
- [x] T006 Make `KeyboardShortcutsDialog.tsx` read the registry (FR-8).
- [x] T007 Update `docs/PLAN.md` and `docs/design/index.md` (FR-9).
- [x] T008 Run `pnpm typecheck`, `pnpm test` and every `pnpm check:*` (SC-4).

## Slice 2

- [x] T009 `icon` on menu items and registry actions (FR-11, FR-12).
- [x] T010 `actionMenuItem` and `textEditItems` builders (FR-10).
- [ ] T011 Migrate the menus listed in FR-13 to icons and builders (FR-13, FR-14).
- [ ] T012 Route the window-level chords through the registry (FR-15).
- [ ] T013 Native context-menu block, repo header menu, one-open-menu (FR-17 to FR-19).
- [ ] T014 Docs (FR-20); `docs/PLAN.md` row and #1404 and #1405 lines.
- [ ] T015 `pnpm ci:local`, quality gate, live check (SC-5 to SC-9).

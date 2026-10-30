# Tasks: spec 064

- [x] T001 Add `cmdk` and `components/ui/command.tsx` (FR-4).
- [x] T002 Add `features/palette/actionRegistry.ts` (FR-1).
- [x] T003 Extract `features/sessions/newSessionInFocusedPane.ts` from the Ctrl+N handler; `App.tsx` calls it (FR-2).
- [x] T004 Add `features/palette/builtinActions.ts`, register at startup, delete `usageViewAction.ts` (FR-2).
- [x] T005 Add `paletteStore.ts`, `usePaletteShortcut.ts`, `paletteItems.ts`, `usePaletteConversations.ts`, `CommandPalette.tsx`; mount in `App.tsx` (FR-3 to FR-7).
- [x] T006 Make `KeyboardShortcutsDialog.tsx` read the registry (FR-8).
- [x] T007 Update `docs/PLAN.md` and `docs/design/index.md` (FR-9).
- [x] T008 Run `pnpm typecheck`, `pnpm test` and every `pnpm check:*` (SC-4).

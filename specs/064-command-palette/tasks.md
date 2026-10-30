# Tasks: spec 064

- [ ] T001 Add `cmdk` and `components/ui/command.tsx` (FR-4).
- [ ] T002 Add `features/palette/actionRegistry.ts` (FR-1).
- [ ] T003 Extract `features/sessions/newSessionInFocusedPane.ts` from the Ctrl+N handler; `App.tsx` calls it (FR-2).
- [ ] T004 Add `features/palette/builtinActions.ts`, register at startup, delete `usageViewAction.ts` (FR-2).
- [ ] T005 Add `paletteStore.ts`, `usePaletteShortcut.ts`, `paletteItems.ts`, `usePaletteConversations.ts`, `CommandPalette.tsx`; mount in `App.tsx` (FR-3 to FR-7).
- [ ] T006 Make `KeyboardShortcutsDialog.tsx` read the registry (FR-8).
- [ ] T007 Update `docs/PLAN.md` and `docs/design/index.md` (FR-9).
- [ ] T008 Run `pnpm typecheck`, `pnpm test` and every `pnpm check:*` (SC-4).

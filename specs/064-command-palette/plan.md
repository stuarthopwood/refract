# Plan: spec 064

Renderer only (no Rust, no IPC change). New feature folder `src/renderer/features/palette/`.

1. Dependency `cmdk`; shadcn wrapper `src/renderer/components/ui/command.tsx` (`Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`) built on the existing `Dialog` primitive and `Kbd` styling.
2. `features/palette/actionRegistry.ts`: the registry (FR-1). Plain module state; no React.
3. `features/palette/builtinActions.ts`: the FR-2 actions. `when` and `run` read store `getState()` only, so slice 2 menus can call them. New session logic moves out of `App.tsx` into `features/sessions/newSessionInFocusedPane.ts`, which `App.tsx` and the action both call (one code path, keeps `App.tsx` small).
4. `features/palette/paletteStore.ts` (open flag) and `usePaletteShortcut.ts` (Ctrl+K, Ctrl+Shift+P; guards: Readiness, `defaultPrevented`, repeat, IME).
5. `features/palette/CommandPalette.tsx` plus `paletteItems.ts` (section items from stores and the registry) and `usePaletteConversations.ts` (Conversations of the focused Session, loaded on open).
6. `KeyboardShortcutsDialog.tsx` rows come from `getActions()` grouped by `group`, plus the contextual keys; remove `usageViewAction.ts`.
7. Docs: `docs/PLAN.md` row, `docs/design/index.md` Keyboard table. `CONTEXT.md` gets no new term (the palette is not a domain term).

Chords are stored as key arrays (`['Ctrl','Shift','X']`) because that is what the dialog renders; the palette matcher compares `ctrlKey`, `shiftKey` and the key token with the same Latin or `event.code` fallback the existing handlers use.

Accessibility: cmdk supplies `role="combobox"`, `aria-activedescendant`, `role="listbox"`, `role="option"` and labelled groups; the Dialog gives modality and an `sr-only` title. Focus return follows the shortcuts dialog's `onCloseAutoFocus` pattern.

No new tests (rapid-prototyping phase). Verify with `pnpm typecheck`, `pnpm test` and the `check:*` scripts; the live check belongs to the director.

## Slice 2 plan

Renderer only; `src-tauri/` unchanged (no native item maps to a registry action).

1. Icons (FR-11, FR-12): `icon` prop on the context-menu and dropdown-menu item, checkbox, radio and sub-trigger wrappers, rendered through one shared `MenuItemIcon` in `components/ui/menu-item-classes.tsx` or a sibling; `PaletteAction.icon`.
2. Builders (FR-10, FR-14): `features/palette/menuItems.ts(x)` with `actionMenuItem(id)` and `textEditItems`, rendering through `ContextMenuItem` or `DropdownMenuItem`.
3. Migrate every menu user (FR-13) to icons and, where an action id exists, to the builders.
4. Chords (FR-15): `features/palette/useChordDispatcher.ts` replaces the per-chord `useEffect` handlers in `App.tsx`; guards stay in the actions' `when()`.
5. #1404 (FR-17 to FR-19): `features/menus/` holds `useBlockNativeContextMenu` (one `contextmenu` listener), `openMenuStore` (one open menu id) wired into the shared menu roots, and the repo header context menu in `RepositoryGroup.tsx`.
6. Docs (FR-20).

No new tests (rapid-prototyping phase).

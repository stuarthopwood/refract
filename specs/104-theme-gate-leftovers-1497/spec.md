# Spec 104: Theme gate leftovers (#1497)

Status: in progress. Follows spec 086 (#1485, #1491). Decisions: issue #1497 comment "Decided (Skippy, delegated by Stuart 2026-10-31)".

## Requirements

- FR-1: A check row's duration sits in a fixed-width, right-aligned slot; rows without a link show "No details link" inline and keep a trailing spacer so durations align.
- FR-2: `RowKebabMenu` opens its menu at the pointer on right-click (Radix ContextMenu) and from the kebab button; a keyboard-raised contextmenu event opens the kebab dropdown. Both share one `RowMenuItems` component.
- FR-3: Only `https:` hrefs render as links; other schemes render a disabled item.
- FR-4: The Rust theme-file rejection message hints that `mermaid-cscale-12` and `mermaid-cscale-label-12` were renamed to `-11`.
- FR-5: Choosing a built-in theme when clearing the custom theme fails keeps the custom id, warns the user, and reports success of the built-in save.
- FR-6: Removing the active custom theme dismisses the "Custom theme applied" toast; a failed list refresh after removal shows an error toast.
- FR-7: The built-in group heading reads "Built-in themes" in Appearance and the profile menu; `ProfileMenu` declares its refs before use.
- FR-8: `useThemeEntries` has an explicit return type, memoised customs and a single combined `all` list.
- FR-9: `derived-tokens.mjs` scales alpha by the mix percentage; `check-theme-contrast.mjs` parses the in-app `PAIRS` structurally and its `gateKeys` honours `onlyThemes` and `informationalThemes`.
- FR-10: `resolveCssColour` reads the backdrop once per resolution pass.

## Already on main

- Native browser menu on rows without a link: blocked globally by `AppContextMenu` and `useBlockNativeContextMenu`.
- 24px kebab: `IconButton size="icon-xs"` is `size-6`.

## Out of scope

Command palette, chord dispatcher, row menus touched by palette slice 2 and `scripts/verify-tauri.mjs` (owned by lane #1439). No new tests (prototyping phase).

## Acceptance

`pnpm ci:local` passes; `scripts/verify-tauri-104.mjs` passes on a built debug exe.

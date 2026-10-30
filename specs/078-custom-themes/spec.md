# spec 078: Custom theme files and per-element tokens (#458, slices 1 to 3)

Amends spec 007 ("Presets only", `spec.md:17, 269`): a user can load a theme file. Per ADR 0002 there is still no in-app colour editor. Slices 4 to 6 of #458 are #1472, #1473 and #1474.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; ui-architect-v3 rulings; recorded on #458)

- Q: Editor or files? [Decided: files] ADR 0002 and the #474 grill supersede the issue's editor item.
- Q: Where do themes live? [Decided] `<data dir>/themes/<id>.json`; the new setting `customTheme` names the active file; `theme` stays the built-in fallback.
- Q: File shape? [Decided] `{ version: 1, name, base, tokens }`. `base` is a built-in id; missing tokens come from it.
- Q: Which tokens may a file set? [Decided] The allowlist in `src/shared/theme-tokens.json`, read by Rust, the renderer and the scripts. Unknown keys reject the file.
- Q: What does an invalid file do? [Decided] It is listed as rejected with one reason and never applies. A valid file with poor contrast applies, with warnings.
- Q: Light themes? [Decided: no] `color-scheme` is not settable.
- Q: Recovery? [Decided] Ctrl+Shift+0 resets to Dark; a post-apply toast and the reset control use fixed dark colours; a broken active file falls back to Dark at startup; `--reset-theme` clears `customTheme`.
- Q: Export of a built-in? [Decided] Writes a full starter file with every allowlisted token resolved to a colour.
- Q: UI? [Decided: ui-architect-v3] One radiogroup with "Built-in" and "Custom" sub-labels; group buttons Import theme and Open themes folder; per-row kebab with Export, Show in folder, Remove (confirm); warning badge plus closed disclosure; Profile menu lists custom themes with swatches.

## Functional requirements

- FR-1: `theme-tokens.json` lists every colour token a file may set; each is defined in all five built-in theme blocks. New tokens `--chat-user-bubble-bg`, `--chat-user-bubble-fg`, `--chat-user-bubble-border` default to the user bubble's current look and replace `bg-accent/50` in `UserMessageRow`.
- FR-2: Rust validates a theme file: `*.json` only, inside the themes folder, no symlink, 64 KiB cap, try/catch parse, allowlisted keys, strict colour grammar (hex 3/4/6/8, `transparent`, `rgb()`, `hsl()`, `oklch()` with numeric arguments and optional alpha), a valid `base`, a name of 1 to 40 safe characters, `version` 1.
- FR-3: IPC `themes.list`, `themes.import`, `themes.export`, `themes.remove`, `themes.openFolder` and `theme.setCustom`; import copies through the validator; export writes only through a save dialog.
- FR-4: The renderer applies a custom theme as the `base` class plus `style.setProperty` per token (never CSS text), live and at startup from the bootstrap payload without a flash.
- FR-5: Appearance and the Profile menu list custom themes as ruled above; built-ins stay read-only.
- FR-6: A contrast check of about 15 text and boundary pairs runs on the applied theme in the renderer and lists warnings; it never blocks.
- FR-7: Recovery as clarified above.

## Success criteria

- `pnpm ci:local` passes; no new tests; no file grows past its baseline.
- Live check: every built-in theme and a hot-pink custom theme render; a bad file is rejected with its reason; Ctrl+Shift+0 resets.

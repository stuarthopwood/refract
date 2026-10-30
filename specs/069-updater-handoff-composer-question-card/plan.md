# Plan: spec 069

## Updater (#1433)

- `src-tauri/src/updates/install_on_quit.rs` (and a new `install_script.rs` if the file nears 600 lines): build the inner PowerShell script as a fixed string, pass it with `-EncodedCommand` (base64 UTF-16LE) so no path or quote is ever spliced into the command line. Paths reach it only through env vars (`REFRACT_INSTALLER_PATH`, `REFRACT_RELAUNCH_PATH`, `REFRACT_INSTALL_LOG`).
- Inner script: wait for the Refract pid, run the installer with `Start-Process -PassThru -Wait`, record `ExitCode` (or the exception text) to the log, then relaunch.
- Rust writes a fresh `install.log` header before scheduling, so a stale result is never read.
- `resolve_startup_state` parses the last `result:` line of the log and puts the exit code and log path in `lastError`.

## Composer spelling (#1431)

- New Rust command `spellcheck.suggest` using the Windows Spell Checking API (`ISpellCheckerFactory`), and `spellcheck.add`.
- `ComposerContextMenu.tsx` finds the word under the caret on open, asks for suggestions, and renders them via a shared menu-item builder in `features/palette/menuItems`.

## Pills and Question card (#1429, #1434, #1435)

- `ComposerStatusLine.tsx`: `gap-x-2` to `gap-x-3`.
- Shared option-row class used by `AskCard.tsx` and `RequestCard.tsx`; Cancel `ghost`.
- `AskCard.tsx`: extract "advance or submit given this draft" and call it from the radio row activation (pointer click, Space), not from `onValueChange`.

## Docs

`docs/PLAN.md` rows, `docs/design/components.md` (Cancel ghost, option-row fill), `quickstart.md` and `spec.md` FR-066 wording for single-choice pick.

# Spec 099: spec 090 gate leftovers (#1503)

## Scope

Lows and Mediums left after the spec 090 gate (#1448, #1441). The root cause of the updater failure (#1433) is out of scope.

## Requirements

- FR-1 Updater hand-off: a junction or symlink `updates_dir` is rejected; `install.log` is opened without following a link; the PowerShell `-ne` comment records that it is case-insensitive; the hash-to-launch gap is documented, not closable from script.
- FR-2 Question card: a second click of a double-click never picks in the next question; busy option rows keep their resting fill on hover; `scripts/verify-556-zero-box.mjs` points at the current `AskCard.tsx` line.
- FR-3 Message navigation: Next in the last screen steps to the message below the topmost one instead of announcing "Last message".
- FR-4 Spellcheck menu: the "No suggestions" row is focusable with `aria-disabled` so screen readers reach it, using the `inset` prop; the spellable-word guard is `isSpellable(word)`.
- FR-5 Suspect window: the Shake trigger keeps one tree shape when `notice` flips and its tooltip does not reopen on focus return after the dialog; the Settings notice uses a singular title and link label for one model and the plural for several; a failed first catalog load does not spend the one forced refresh; the Settings link has `hover:decoration-2`.

## Deferred (follow-up issue)

Ghost hover in `buttonVariants` (Lane AI owns `button.tsx`) and a shared ExternalLink (#935); composer click-position word and suggestion shift; COM per-language spell-checker caching (apartment-threaded objects on pool threads, over the 30-line bar and unsafe without a real-device check); WMI child environment allowlist (an over-narrow list can break the installer and cannot be proven here without a real install); `hover:decoration-2` on the AgentsCard link (not a suspect-window surface).


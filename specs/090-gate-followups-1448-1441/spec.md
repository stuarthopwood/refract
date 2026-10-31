# Spec 090: gate follow-ups for #1448 and #1441

## Scope

Quality-gate follow-ups for the updater hand-off, the composer spellcheck menu, the Question card (#1448) and the suspect-window warning, Settings notice and message Next stepping (#1441). The root cause of the updater failure (#1433) is out of scope.

## Requirements

- FR-1 Updater hand-off: the helper re-hashes the installer after the app exits and refuses a changed file; the verified path must be the canonical file directly inside the updates directory and not a reparse point; a header write failure aborts the hand-off; the not-started sentinel is `int.MinValue`; the exit-code line parse is anchored; PowerShell is resolved only from System32.
- FR-2 Spellcheck: the IPC reports whether the word is misspelt; a misspelt word with no suggestions shows a disabled "No suggestions" row plus Add to dictionary; words under 2 or over 64 characters, or with control characters, are not sent.
- FR-3 Question card: choosing a single-choice option moves to the next incomplete question and never submits; a hint says so when the pick advances; busy rows use `aria-disabled`; checkbox marks use the shared box class.
- FR-4 Suspect window: the Settings notice is titled "Some context windows may be wrong", carries the shake-menu link label with an external-link icon in `AlertActions`, and both links announce "(opens in a new tab)"; the note names the `-1m` variant or `modelOverrides` as the next step; the catalog refresh flag is one per run.

## Skipped

Ghost hover into `buttonVariants` and a shared ExternalLink (Lane Y and #935 territory); COM per-language caching; WMI child environment allowlist; Cancel-discard confirm; composer click-position word and suggestion shift; Shake trigger tree and tooltip refocus; message-nav Next in the last screen (`stepToMessage`), deferred as a follow-up; stale `verify-tauri-ask.mjs` (superseded by `verify-tauri-090.mjs`).

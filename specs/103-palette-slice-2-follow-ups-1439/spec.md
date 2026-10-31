# Spec 103: Palette slice 2 follow-ups (issue #1439)

Status: in progress. Source: follow-ups from the palette slice 2 gate, decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1439. Closes #1439.

## Requirements

- FR-1 The Ctrl+Shift+\ chord matches on `code` Backslash or IntlBackslash, or `key` `\` or `|`, so non-US layouts work.
- FR-2 The Ctrl+, chord matches `key` first, then falls back to `code` Comma.
- FR-3 `getActions()` returns a cached array, invalidated on register and unregister.
- FR-4 Repository header menu labels follow #1404: "Project colour…" and "GitHub report…".
- FR-5 `verify-tauri.mjs` drives the Add project dropdown through `addRepository`; `verify-tauri-503.mjs` waits for "GitHub report…".
- FR-6 `scripts/verify-tauri-103.mjs` proves the chords, Ctrl+Shift+X on a long fake-omp turn, and the reachable repository menus.

## Already handled or skipped

- Ellipsis-click survival: not reproduced; no change.
- DevTools Inspect stays blocked.
- Menus needing real `gh` or git state (tree node, Checks, git change rows, link menus, quick actions): listed as skipped in the live check.
- Anything in ChatHeader, header controls, PR rows, pinned panels: skipped, owned by lane #1511.

## Out of scope

New automated tests (prototyping phase).

## Acceptance

`pnpm ci:local` green and `verify-tauri-103.mjs` reports PASS from the pushed HEAD.

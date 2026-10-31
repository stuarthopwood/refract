# Spec 098: Gate leftovers of spec 091 (issue #1504)

Status: in progress. Source: Mediums and Lows left by the spec 091 gate, decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31), lane AI pickup" comment on #1504. Closes #1504.

## Requirements

- FR-1 `button.tsx` owns disabled styling: the not-allowed cursor and the `forced-colors` GrayText for `aria-disabled`, and a per-variant `aria-disabled:hover:` neutraliser that outranks a caller's plain `hover:` override. The per-feature copies of the cursor and GrayText classes are removed; callers that override the base colour carry their own neutraliser (`ComposerBox` send button).
- FR-2 `callToListItem` no longer sets `title`, so Recent calls rows are not extra Tab stops and are not read twice.
- FR-3 `CompactList`: a focusable row has side padding so the inset outline does not cover text; the value never breaks mid-number.
- FR-4 The pending git kebab keeps a stable accessible name.
- FR-5 `advisor_roster.rs`: `openable_target` compares paths component by component (still failing closed), uses a const longest-first name list instead of sorting per call, and documents the accepted open-path TOCTOU in one line.
- FR-6 `theme-store.ts`: a thrown `setCustom` resets `confirmedCustomId`; `refreshCustomThemes` has a try/catch; the stale-reply clear no longer bumps `latestSaveId`, so an in-flight built-in save is not treated as stale.
- FR-7 `ShowHiddenToggle`: the deferred "Show hidden turned off" announcement re-checks `hidden === 0 && !showHidden`.
- FR-8 `RepositoryGroup`: the `aria-keyshortcuts={undefined}` comment sits above the prop.
- FR-9 `IconButton` maps `Cmd` to `Meta` and `Del` to `Delete`; `App.tsx` and `ProfileItem.tsx` drop their redundant explicit `aria-keyshortcuts`.
- FR-10 `scripts/verify-tauri-091.mjs`: header comment corrected, hover reads poll for a settled style instead of fixed sleeps, the Delete close-button check is asserted (two panels open), and the aria-disabled hover and cursor are checked with a screenshot.

## Out of scope

New automated tests (prototyping phase). Ctrl+W in `ChatHeader.tsx` (Lane AG, #1310; carried to the follow-up issue). A focusable-row role in `CompactList` (no valid role for a focusable list item; no caller sets `title` now).

## Acceptance

`scripts/verify-tauri-091.mjs` passes in the built app; `pnpm ci:local` passes.

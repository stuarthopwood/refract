# Spec 107: Holiday touches follow-ups (issue #1377)

Status: in progress. Source: #1048 gate leftovers (PR #1375), decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1377. Closes #1377.

## Requirements

- FR-1 `EmptyChatState` mounts `HolidayAmbientLoop` with `avoidTextColumn`, so no piece crosses the muted text (item 1).
- FR-2 A flight's translation is clamped by the piece's size and position so the piece stays fully inside the pane at the top, bottom and sides (item 2).
- FR-3 The flight scheduler honours `prefers-reduced-transparency` as well as reduced motion and forced colours: no flights while any matches, re-checked on change (item 3).
- FR-4 The snowflake stroke is 2px; opacity unchanged (item 4).
- FR-5 The live check screenshots the empty chat state's holiday watermark; session panes keep the plain watermark (item 5).
- FR-6 Live-check fixes in `verify-1048-holiday-touches-slice2.mjs` (item 6): `waitFor` around the animation check, a positive control for the plain watermark, a reduced-motion check that proves a flight was running first, diagnostics moved into a helper, named viewport and settle constants.

## Out of scope

New automated tests (prototyping phase); anything lane #1470 touches.

## Acceptance

`pnpm ci:local` green and `verify-1048-holiday-touches-slice2.mjs` reports PASS from the pushed HEAD.

# Spec 105: Gate-script residual limits (issue #1499)

Status: in progress. Source: spec 089 reviewer-gate residuals, decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1499. Closes #1499.

## Requirements

- FR-1 `check-literal-colours.mjs` records two accepted limits in its header: inline all-letter short hex (`#abc`) is not counted, and string concatenation defeats the regexes (items 1, 3).
- FR-2 The `querySelector`/`querySelectorAll`/`closest`/`matches` exemption applies only to a string argument that is selector-shaped (starts with `#`, `.` or `[`, no colour function); anything else passed there is counted (item 2).
- FR-3 `color-mix(` and relative colour `rgb(from ...)`/`hsl(from ...)` (and the other colour functions) are counted; named colours are not. Newly detected offenders are baselined in this change (item 4).
- FR-4 A trailing `//` comment forming no block is recorded as by design in `comment-density-scan.mjs` (item 5).
- FR-5 `verify-tauri-083.mjs` defaults its shots dir to a fixed `tmpdir()/refract-083-shots`, cleared only by known file names (item 6).
- FR-6 `radio()` supports a space-separated multi-id `aria-labelledby` (item 7).
- FR-7 The `url(#id)` check resolves the referenced gradient in a live probe and in the app DOM (item 8).
- FR-8 `ProjectColorPopover.tsx` help text no longer contains hex literals, dropping its baseline from 3 to 1.

## Newly baselined by FR-3

`ComposerBox.tsx` 1, `ui/button.tsx` 1, `ui/chart.tsx` 1, `ui/checkbox.tsx` 5, `ContextUsageReadout.tsx` 1 (all `color-mix(`).

## Out of scope

New automated tests (prototyping phase); theme files and anything lane #1497 touches.

## Acceptance

`pnpm ci:local` green and `verify-tauri-083.mjs` reports PASS from the pushed HEAD.

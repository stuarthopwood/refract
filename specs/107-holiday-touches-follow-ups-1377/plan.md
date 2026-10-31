# Plan 107

Hand-authored Spec Kit artefacts (specify, clarify via the issue's decision comment, plan, tasks, analyze). Route: specify.

- `clampFlightToBounds` in `holidayArtwork.tsx` rewrites each keyframe's `translate(x, y)` against the container and piece rects measured at rest, just before `animate()`.
- `NO_MOTION_QUERY` in `HolidayAmbientLoop.tsx` is the single media query for the listener, the initial state and the unmount check; it matches the CSS hiding rule.
- The live check is the existing `scripts/verify-1048-holiday-touches-slice2.mjs`.
- Files: `HolidayAmbientLoop.tsx`, `holidayArtwork.tsx`, `EmptyChatState.tsx`, `scripts/verify-1048-holiday-touches-slice2.mjs`.

# Spec 097: Composer focus follow-ups (issue #1507)

Status: in progress. Source: gate follow-ups of #1285 and #1295 (spec 092), decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31), lane AH pickup" comment on #1507. Closes #1507.

## Requirements

- FR-1 One shared input-with-trailing-button primitive in `components/ui/` serves `SecretInput` and `SearchField`: the same right padding, button size and focus classes.
- FR-2 `RequestCard`: after a failed answer, if the focused control was disabled by `busy` and focus is stranded, focus returns to the originating control.
- FR-3 `StopBanner`: `aria-labelledby` names the group from the visible title, so the title is read once; bottom padding keeps the banner's focus ring from clipping when it has no buttons.
- FR-4 `RequestCard` text and secret questions put Cancel in the `CardFooter`, away from the reveal toggle.
- FR-5 `SecretInput`: the wrapper's `flex-1` is a caller prop; the reveal label follows the pressed state ("Show secret" / "Hide secret"); the toggle shows a visible pressed state.
- FR-6 `useComposerFocusHandoff`: when `focusStopBanner` returns false the pane takes focus; `pane` and `active` are read only when a branch needs them.
- FR-7 The secret field is labelled by the question heading (`aria-labelledby`), not `aria-label="Secret"` plus `aria-describedby`.
- FR-8 The `dark:hover:bg-muted` override on Cancel lives in the `ghost` variant (scoped to `CardFooter`), not at call sites.
- FR-9 The `RequestCard` error alert is a live region (`role="alert"`).
- FR-10 `scripts/verify-tauri-092.mjs`: waits for `t1295-done` after submit; waits on the expected `activeElement` instead of two fixed 500 ms sleeps; scans the app log and the scratch data dir for the synthetic secret (092 FR-007); the "paste" assertion is reworded to say what it proves.

## Out of scope

New automated tests (prototyping phase). New session, Issues page and pull request list surfaces (lane AG, #1310).

## Acceptance

`scripts/verify-tauri-092.mjs` (hardened) passes in the built app; `pnpm ci:local` passes.

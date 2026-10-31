# Plan 105

Hand-authored Spec Kit artefacts (specify, clarify via the issue's decision comment, plan, tasks, analyze). Route: specify.

- Selector exemption: blank selector-shaped string arguments of `querySelector(All)`/`closest`/`matches` before counting, instead of a lookbehind on the hex regex.
- New regex `COLOUR_FN_RELATIVE` for `color-mix(` and `<colour fn>(from`.
- `verify-tauri-083.mjs` is the live check: it runs the changed gate paths and the new gradient and multi-id radio paths.
- Files: `scripts/check-literal-colours.mjs`, `scripts/comment-density-scan.mjs`, `scripts/verify-tauri-083.mjs`, `scripts/literal-colours-baseline.json`, `ProjectColorPopover.tsx` (copy only).

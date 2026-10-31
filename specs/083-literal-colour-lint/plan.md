# Plan: spec 083

## Design

- **Script.** `scripts/check-literal-colours.mjs`, modelled on `check-icon-only-controls.mjs`: walk `src/renderer`, blank comments, count `PALETTE` and `HEX` matches per file, compare with the baseline.
- **Baseline.** `scripts/literal-colours-baseline.json`: `MermaidBlock.tsx`, `ProjectColorPopover.tsx`, `projectColor.ts`, `themeContrast.ts`, `themeTokens.ts`, one each.
- **Wiring.** `package.json` script plus a `ci.yml` step after "Check icon-only controls".
- **Docs.** ADR 0001 note, design page, `docs/PLAN.md` row.

## Analysis (consistency check)

- No renderer source changes, so the five built-in themes cannot change.
- The hex lookbehind requires a quote, backtick, `[` or `(`; comments are stripped first, so issue refs do not match.
- The script is about 70 lines, under the file-size cap; comments are why-only.

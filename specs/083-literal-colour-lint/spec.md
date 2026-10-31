# spec 083: Literal colour lint (#1473; #458 slice 5)

Enforces ADR 0001: components use no hex literals and no Tailwind palette colour classes. Slice 5 of #458; slice 4 is spec 081, slice 6 is #1474.

## User stories

1. As a theme author, I can trust that no component hard-codes a colour, so a theme file recolours everything it should.
2. As a reviewer, `pnpm ci:local` fails a change that adds a hex literal or a palette class, instead of me checking by hand.

## Functional requirements

- FR-1: `scripts/check-literal-colours.mjs` scans non-test `.ts` and `.tsx` under `src/renderer` and fails on a hex literal (3, 4, 6 or 8 digits, directly after a quote, backtick, `[` or `(`) or a Tailwind palette class (`bg|text|ring|border|fill|stroke|shadow|outline|from|via|to|divide|decoration|caret|accent` plus a palette name, optional shade and opacity).
- FR-2: Comments are blanked before matching, so issue refs such as `(#1001)` never count.
- FR-3: Existing offenders are baselined per file in `scripts/literal-colours-baseline.json`; a count above the baseline fails, and so does a count below it (stale allowance), so the baseline only shrinks; `--write-baseline` regenerates it.
- FR-4: `pnpm check:literal-colours` exists and is a step in `.github/workflows/ci.yml`, so `pnpm ci:local` runs it.
- FR-5: Docs state the rule is enforced (ADR 0001 note, `docs/design/foundations-tokens-theming.md`, `docs/PLAN.md`).
- FR-6: Palette-class cleanup: none needed at HEAD (spec 081 removed the last ones); the remaining hex literals (five files; two in `ProjectColorPopover.tsx` are help-text examples) are baselined, not swapped.

## Success criteria

- `pnpm ci:local` passes and runs the new check; no new tests; no file grows past its baseline.
- Adding `text-green-600` or `'#fff'` to a renderer file makes the check exit 1.
- Live check: the app renders in two themes unchanged.

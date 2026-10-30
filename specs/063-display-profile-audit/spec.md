# Spec 063: Display-profile luminance audit script (#553)

A developer script that applies a documented display transform to each theme's key surface, edge and text pairs and reports the pairs that stop being distinguishable under TN washout, VA black crush and sunlight glare. Child of epic #549. Supports WCAG 1.4.3 and 1.4.11 under hard conditions; it does not replace `check:theme-contrast`.

## Clarifications

### Session 2026-10-30 (answers from the #553 grill, Skippy delegated by Stuart)

- Q: Script only, or script plus a dev toolbar? A: Script only. Nothing ships to users or appears in Settings.
- Q: Which profiles? A: TN washout and VA black crush; sunlight glare too because it is the same transform with different numbers.
- Q: What is the model? A: A gamma, black-level and gain curve applied to relative luminance. It is not a simulation of a specific panel; the limits are stated in the script header and docs.
- Q: Which pairs? A: Canvas, sidebar, card, popover, divider, control edge and muted text, for every theme `check-theme-contrast.mjs` reads.
- Q: What thresholds? A: #550's ladder rule: card and popover at least 5 L* above canvas, sidebar at least 2.3 L* above canvas, divider at least 1.5:1, control edges at least 3:1 against canvas and card, muted text at least 4.5:1.
- Q: Does it gate CI? A: No. Report-only (exit 0) by default; `--strict` exits 1. It is not added to `ci:local` or the workflow, because existing themes would fail main. Offenders go in one follow-up issue.
- Q: CDP screenshots? A: Deferred to a separate follow-up issue.
- Q: How is the contrast script reused? A: The theme token parser moves unchanged into a shared module that both scripts import.

## Functional requirements

- FR-1: `scripts/theme-tokens.mjs` exports the parsed `themes` table and the helpers `check-theme-contrast.mjs` already used; `check-theme-contrast.mjs` imports it and its output is unchanged.
- FR-2: `scripts/display-profiles.mjs` defines the profiles and `applyProfile(luminance, profile)`. The transform is `Y' = lift + gain * max(0, (Y - crush) / (1 - crush)) ^ (gamma / 2.2)`, clamped to 0..1.
- FR-3: `scripts/check-display-profiles.mjs` resolves each pair's tokens to opaque linear colour (compositing alpha over the right backdrop in gamma space), applies each profile, and compares the result with the threshold.
- FR-4: Each report row shows theme, profile, pair, baseline value, transformed value, threshold and result. An offender that also fails untransformed is marked as such.
- FR-5: Exit 0 by default; `--strict` exits 1 when any pair is under its threshold.
- FR-6: `pnpm check:display-profiles` exists; it is not in `ci:local` or `.github/workflows/ci.yml`.
- FR-7: `docs/design/foundations-tokens-theming.md` documents usage, the model and its limits.

## Success criteria

- SC-1: `pnpm check:display-profiles` prints offender counts per theme and profile and exits 0.
- SC-2: `pnpm check:display-profiles --strict` exits 1 while offenders exist.
- SC-3: `pnpm check:theme-contrast` output is identical before and after the parser extraction.
- SC-4: `pnpm ci:local` is green.

## Edge cases

- Alpha tokens (divider, input, muted text) are composited over the surface they sit on before the transform.
- A theme missing a token reports the pair as missing and does not crash.

## Deferred

- CDP screenshots per theme and profile (follow-up issue).
- Adding the check to `ci:local` once the existing offenders are fixed.

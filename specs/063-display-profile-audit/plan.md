# Plan: spec 063

1. Extract the code that reads `globals.css` and builds `themes` out of `check-theme-contrast.mjs` into `scripts/theme-tokens.mjs`, unchanged; the checker imports `themes`, `css`, `repoRoot`, `cssPath` and `sidebarBorderAliasesDivider`.
2. Add `scripts/display-profiles.mjs`: profile table plus `applyProfile`, pure functions, no I/O.
3. Add `scripts/check-display-profiles.mjs`: pair table, threshold ladder, report, `--strict`.
4. Add the `check:display-profiles` package script; leave `ci:local` and the workflow alone.
5. Document usage, model and limits in `docs/design/foundations-tokens-theming.md`.

Profiles (gamma against a 2.2 reference, black-level lift, crush, gain):

| Profile | gamma | lift | crush | gain |
| --- | --- | --- | --- | --- |
| tn-washout | 1.8 | 0.02 | 0 | 1 |
| va-black-crush | 2.6 | 0 | 0.004 | 1 |
| sunlight-glare | 2.2 | 0.08 | 0 | 0.92 |

Contrast uses the WCAG ratio `(Y1 + 0.05) / (Y2 + 0.05)` on transformed luminance; surface steps use CIE L* of transformed luminance.

No new tests (rapid-prototyping phase). Verify by running the script.

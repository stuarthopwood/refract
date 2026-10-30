# Tasks: spec 063

- [ ] T001 Extract the theme token parser to `scripts/theme-tokens.mjs`; `check-theme-contrast.mjs` imports it; output unchanged (FR-1, SC-3).
- [ ] T002 Add `scripts/display-profiles.mjs` (FR-2).
- [ ] T003 Add `scripts/check-display-profiles.mjs` with pairs, thresholds, report and `--strict` (FR-3 to FR-5).
- [ ] T004 Add `check:display-profiles` to `package.json` only (FR-6).
- [ ] T005 Document usage, model and limits (FR-7).
- [ ] T006 Run `check:display-profiles`, `--strict`, `check:theme-contrast`, `check:comment-density`, `check:file-size` (SC-1 to SC-3).
- [ ] T007 File the offenders follow-up and the screenshots follow-up; open the PR.

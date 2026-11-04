# Tasks: Six new themes (#1590)

No test tasks: prototyping rule forbids new tests; existing tests are only updated.

## Phase 1: Discovery
- [x] T001 Locate the #1381 per-theme CDP screenshot helper (`scripts/verify-*` / `git grep`) and note its API. (FR-010, SC-003)
- [x] T002 Confirm `scripts/theme-tokens.mjs` source files, whether `check-file-size.mjs` caps CSS, and current line count of `src/renderer/styles/globals.css`. (plan decision 2)
- [x] T003 Run the hard-coded dark sweep (`dark:`, `oklch(`, hex, `rgba`, `bg-black`, `text-white`, `color-scheme`) in `src/renderer`; record the list for the PR. (FR-008)

## Phase 2: Foundation
- [x] T004 Add six ids to Rust `ThemeId` in `src-tauri/src/store/theme_id.rs` and any matches on it. (FR-003)
- [x] T005 Register six entries in `src/shared/themes.ts` (id, name, swatch, syntaxTheme) in picker order. (FR-001, FR-003)
- [x] T006 Extend `scripts/theme-tokens.mjs` to read the new stylesheets. (FR-002)
- [x] T007 Make `check-display-profiles.mjs` STEP pairs direction-aware by `color-scheme`; confirm the existing five themes' output is unchanged. (FR-005)
- [x] T008 Add light Shiki theme to `shikiHighlighter.ts` / `themes.ts` `syntaxTheme`; verify light Mermaid derivation in `mermaidTheme.ts`. (FR-009)

## Phase 3: Light themes (US1)
- [x] T009 [P] `.theme-light` token block, `color-scheme: light` in `themes-light.css`. (FR-002, FR-007)
- [x] T010 [P] `.theme-light-warm-paper` block. (FR-002, FR-007)
- [x] T011 `.theme-light-high-contrast` block: solid ink, 7:1, no alpha text. (FR-006)
- [x] T012 Re-base alpha tokens (text, ghost edges, composer, selection) on ink for light themes. (plan decision 3)
- [x] T013 Fix sweep findings from T003 via tokens. (FR-008)
- [x] T014 Import new stylesheets from the entry stylesheet; check the 600-line cap. (plan decision 2)

## Phase 4: Dark accent themes (US2)
- [x] T015 [P] `.theme-lagoon` block (teal). (FR-002)
- [x] T016 [P] `.theme-amethyst` block (purple). (FR-002)
- [x] T017 [P] `.theme-hearth` block (warm). (FR-002)

## Phase 5: Contrast and swatches (US3)
- [x] T018 Add new ids to `onlyThemes` / `informationalThemes` lists in `theme-contrast-pairs.mjs`; add light-specific pairs where dark pairs do not apply. (FR-004)
- [x] T019 Update `markdown-token-contrast.mjs`, `composer-selection-contrast.mjs`, `derived-tokens.mjs`, Mermaid contrast scripts for the new ids. (FR-004)
- [x] T020 Extend `theme-swatch-drift.mjs` so each new swatch equals its tokens. (plan decision 9)
- [x] T021 Tune palettes until `pnpm check:theme-contrast` passes for all 11 themes. (SC-001)
- [x] T022 Run `check-display-profiles.mjs --strict`; tune until 0 newly failing for new themes. (SC-002) Enforced by `scripts/verify-tauri-1590.mjs`: each theme's glare offenders (live tokens) must not exceed Dark's, and Dark's parsed count must equal the 11-offender baseline; offline, `check-display-profiles.mjs` shows all six new themes at or below 11 (light themes 0).
- [x] T023 Update existing tests that enumerate themes (no new cases). (FR-003)

## Phase 6: Live verification
- [ ] T024 Add `scripts/verify-1590-themes.mjs` (CDP, real input) selecting each new theme: checks `color-scheme`, persistence after restart, picker and Theme menu swatches. (US1-3) Driver written as `scripts/verify-tauri-1590.mjs`; the run worker still has to run it, and persistence after restart plus the picker swatches are not yet covered.
- [ ] T025 Capture Chat, Pull requests, Settings, Usage screenshots per new theme (6 x 4) via the #1381 helper; confirm Tauri chrome follows `color-scheme: light`, adding Rust `set_theme` if not. (SC-003)

## Phase 7: Docs and ship
- [x] T026 Update `foundations-tokens-theming.md`, `accessibility.md`, `product-look-and-feel.md`. (FR-010)
- [x] T027 CHANGELOG entry and the #1590 row in `docs/PLAN.md`. (FR-010)
- [ ] T028 `pnpm check:comment-density`, file-size check, `node scripts/ci-local.mjs` in the build slot. (SC-004)
- [ ] T029 PR body: proposed names, sweep list, screenshots, contrast and display-profile output; five-reviewer gate.

## Dependencies
T001-T003 first. T004-T008 before Phases 3-4. T009/T010/T015/T016/T017 parallel (different blocks). T018-T022 after blocks exist. T024-T025 after T021-T022. Phase 7 last.

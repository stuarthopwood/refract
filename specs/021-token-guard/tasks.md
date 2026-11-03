# Tasks: Token guard

**Input**: Design documents from `specs/021-token-guard/` (plan.md, spec.md, research.md, data-model.md, contracts/ipc.md, quickstart.md)

**Tests**: Rust unit tests inside `src-tauri/src/omp/token_guard/` only, kept minimal. No new tests in `src/renderer` or `src/shared` (prototyping rule). Existing gates plus a live check verify the work.

**Lanes**: two sequential implementation lanes. Lane A merges before Lane B starts. Each task is tagged `[A]` or `[B]`; the "Owns" line lists the files that lane may edit. Shared files (`src/shared/ipc.ts`, `src-tauri/src/session/agent/frame.rs`, `scripts/check-parity.mjs`) get small edits from both lanes, always A first.

**Rules for every task**: shared components from `src/renderer/components` (ADR 0003); no file over 600 lines and no baselined file may grow (`pnpm check:file-size`); no `types.ts` or `constants.ts` dumping grounds; commit and push after each task.

## Lane A: overlay, launch arguments, rules, Settings rows, #1184 removal

Owns: `src-tauri/src/omp/{process.rs,process_args.rs,mod.rs,token_guard/**}`, `src-tauri/resources/refract-rules.md`, `src-tauri/src/ipc/token_guard.rs` (+ its registration), `src-tauri/src/session/agent/launch.rs`, `src-tauri/src/{lib.rs,events.rs}`, `src/shared/tokenGuard.ts`, `src/renderer/state/token-guard-store.ts`, `src/renderer/features/settings/Omp*.tsx`, `SettingsScreen.tsx`, `view-store.ts`, and every file in the #1184 removal list in plan.md.

- [X] T001 [A] [US1] Add `src/shared/tokenGuard.ts` with the value types and grilled defaults (FR-004, FR-005) and `token_guard/values.rs` mirroring them: atomic JSON store `token-guard.json` via `store/atomic_json.rs`, per-key validation, per-key fallback to default (FR-006)
- [X] T002 [A] [US1] Add `token_guard/overlay.rs`: render nested YAML with `refract-overlay-version`, write atomically (temp then rename) on every launch (FR-001, FR-003); minimal Rust unit tests for rendering
- [X] T003 [A] [US5] Add `src-tauri/resources/refract-rules.md` (about 1.5k chars: director model, one task per worker, narrow reads, cheapest fitting agent) and `token_guard/rules.rs`: embed with `include_str!`, write to the data dir, return the path (FR-010)
- [X] T004 [A] [US1] Add `token_guard/args.rs` returning `--config <overlay>` and `--append-system-prompt <rules path>`; on a write failure return no argument for the failed file and emit `token-guard:launch-warning` once (FR-017)
- [X] T005 [A] [US1] Extract `build_args` from `omp/process.rs` into `omp/process_args.rs`, append the token guard arguments for every launch (FR-001, FR-002); `process.rs` must end smaller than before; update `scripts/file-size-baseline.json` downward
- [X] T006 [A] [US2] Add `ipc/token_guard.rs` and register `tokenGuard.get/set/reset` plus the `token-guard:launch-warning` event in `src/shared/ipc.ts`, `src/tauri-bridge/index.ts` and `scripts/check-parity.mjs` (contracts/ipc.md; Principle V)
- [X] T007 [A] [US2] Add `token-guard-store.ts` and subscribe in `init-stores.ts`; show one sonner toast per launch warning (FR-017)
- [X] T008 [A] [US2] Add the `omp` section id to `SettingsSectionId` in `view-store.ts` and render `OmpSection.tsx` and `OmpValueRow.tsx` in `SettingsScreen.tsx`: one row per overlay key, "Set by Refract" text, typed control (`SettingSwitchRow`, `ui/input`, model-threshold list), Reset to default, note that running Sessions keep launch values; existing sections unchanged (FR-006, FR-007, FR-008, FR-022)
- [X] T009 [A] [US1] Remove the #1184 global reset: delete every Rust, renderer, shared and script item in plan.md "#1184 removal list", keep the dotted-key validator and its test, mark `specs/020-omp-settings-guard/spec.md` superseded (FR-009)
- [X] T010 [A] Lane A gate: run the verification gates (T020) and the live checks for quickstart steps 1 to 3 and 7 (T021 part 1); fix before Lane B starts

## Lane B: shake, call counter, Long conversation readout, Hand off, banner, accessibility

Owns: `src-tauri/src/omp/token_guard/{shake.rs,counter.rs}`, `src-tauri/src/session/agent/{handoff.rs,frame.rs (hooks only)}`, the `tokenGuard.handoff` and `token-guard:calls` additions in `ipc/token_guard.rs`, `src/shared/ipc.ts` entries, `src/renderer/features/chat/{LongConversationChip.tsx,LongConversationBanner.tsx}` plus minimal wiring in `ComposerStatusLine.tsx`/`MessageInput.tsx`/`ChatPane.tsx`.

- [X] T011 [B] [US3] Add `token_guard/shake.rs`: after settle, if the Session's context tokens exceed 60000, read context tokens fresh (`get_session_stats` `contextUsage`, not the possibly stale readout), send `/shake` once through `proc.request`; swallow its `command_output` frame; log result; make the next prompt await an in-flight shake with a bounded timeout; never run while a turn is active (FR-011, FR-012, FR-019); minimal Rust unit tests for the threshold and one-per-settle logic
- [X] T012 [B] [US3] Hook the settle points in `session/agent/frame.rs` (`session_settled`, `prompt_result` with `sessionSettled`) with a single call into `token_guard::shake` without growing `frame.rs` beyond a few lines
- [X] T013 [B] [US4] Add `token_guard/counter.rs`: count assistant `message_end` per Session and Conversation, reset on new Conversation, re-derive from history on open or resume, emit `token-guard:calls` (FR-013)
- [X] T014 [B] [US4] Add `session/agent/handoff.rs` and the `tokenGuard.handoff` channel: Idle only, request summary, await settle, `start_new_conversation`, send summary as first message, return `{ok:false, reason}` on failure leaving the old Conversation untouched (FR-015, FR-020)
- [X] T015 [B] [US4] Add `LongConversationChip.tsx` (a `ReadoutChip` with the text "Long conversation, N calls" and a real `Button` "Hand off", disabled with a text reason while busy) and wire it into the Status line at 300 calls (FR-014, FR-020)
- [X] T016 [B] [US4] Add `LongConversationBanner.tsx` from the shared `ui/alert` and wire it into `ChatPane.tsx` at 500 calls: Hand off button, per-Conversation dismissal, returns after 100 more calls (FR-014, FR-021)
- [X] T017 [B] [US4] Accessibility: state in text not colour alone; keyboard-operable buttons with visible focus; one visually hidden `role="status"` announcement per threshold per Conversation, not per call; handle toast/dialog focus on Hand off failure (FR-016, SC-005)
- [X] T018 [B] [US4] Wire frontend Hand off error display (reason in text) using shared components (FR-015)
- [X] T019 [B] Lane B gate: run T020 and T021 part 2

## Verification (existing gates only)

- [X] T020 [A/B] Run `pnpm typecheck`, `pnpm test`, `pnpm check:indent`, `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:drag-regions`, `pnpm check:file-size`, `pnpm check:parity`; and `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` each with `--manifest-path src-tauri/Cargo.toml`, using the shared `CARGO_TARGET_DIR` (SC-001 to SC-006 guards)
- [X] T021 [A/B] Live check per `quickstart.md` with `scripts/verify-tauri.mjs` and a scratch `REFRACT_DATA_DIR` (never `pnpm dev`, never the real `%APPDATA%\refract-tauri`): part 1 (Lane A) steps 1 to 3 and 7; part 2 (Lane B) steps 4 to 6. Record evidence in the PR body (SC-001 to SC-006)

## Dependencies

T001 -> T002, T004, T006. T003 -> T004. T004 -> T005. T006 -> T007, T008. T009 after T006 and T008 (both edit `ipc.ts`, the bridge, `check-parity.mjs` and `init-stores.ts`, so removal follows additions) and before T010. T010 -> T011 to T018 (Lane B starts after Lane A merges). T011 -> T012. T013 -> T014 -> T015, T016. T015, T016 -> T017, T018. T019 last.

## Coverage

FR-001..005 T001, T002, T005; FR-006..008, FR-022 T008; FR-009 T009; FR-010 T003; FR-011, FR-012, FR-019 T011, T012; FR-013 T013; FR-014 T015, T016; FR-015, FR-020 T014; FR-016 T017; FR-017 T004, T007; FR-018 all UI tasks; FR-021 T016. SC-001..002 T021 part 1; SC-003..006 T021 part 2 and T017.


## Phase 2: Convergence

**Scope**: Settings > Advanced batch, spec 2026-11-03 Clarifications. One PR, four commits in order #1553, #1579, #1555, #1580. No new tests (prototyping rule); update existing tests only where a change breaks them.

### #1553 compaction thresholds as a percent of the context window

- [x] T022 Change `src-tauri/src/omp/token_guard/values.rs` (KEYS, `default_for`, `Kind`) and `src/shared/tokenGuard.ts`: add `compaction.thresholdPercent` (Int 1-99, default 70), remove `compaction.thresholdTokens` as an edited key, make `compaction.modelThresholds` a record of `"N%"` strings validated by `^(\d{1,2})%$` with no built-in entries per FR-023, FR-024 (partial)
- [x] T023 Write `compaction.thresholdTokens: -1` in the overlay from `src-tauri/src/omp/token_guard/overlay.rs` so the percent wins per FR-023 (partial)
- [x] T024 Bump the stored `version` to 2 in `values.rs` and reset stored `compaction.thresholdTokens` and `compaction.modelThresholds` token overrides on load (keep `compaction.idleThresholdTokens`); surface a one-time one-line note through the existing Advanced notice slot per FR-026 (missing)
- [x] T025 Rework `src/renderer/features/settings/advanced/AdvancedSection.tsx` (remove the `fallbackTokens` feed for these rows) and `PerModelThresholdTable.tsx`: global row in percent, per-model rows in percent with "≈ N of W tokens" from `ModelCatalogEntry.contextWindow` (`useModelRoleStore`/`useModelRolesStore`), "Add model" seeds the global percent, hint tied by `aria-describedby`, accessible names include "percent" per FR-024 (partial)
- [x] T026 Idle threshold row: percent of the Default role model's window (read from `useModelRolesStore`) with "≈ N tokens" beneath, stored as round(% x window) tokens, token field fallback when the window is unknown; extend `NumberUnitField.tsx` with a `%` unit and optional secondary hint line (ADR 0003, no one-off) per FR-025 (missing)
- [x] T027 Update existing tests that pin the old token wording or defaults (`src/shared`, `src/renderer/features/settings/advanced`, `values.rs` unit tests); keep `PerModelThresholdTable.tsx` under 600 lines; run `pnpm check:file-size`, `pnpm check:comment-density`; commit `#1553` per FR-023..026 (partial)

### #1579 shared NumberField (after #1553)

- [ ] T028 Add the shared `src/renderer/components/ui/NumberField.tsx`: `type="number"` with `min`, `step`, `max`, visible native spinners, ArrowUp/ArrowDown stepping, `onKeyDown` blocking `e`, `+`, `-`, blur or ignore on wheel so a focused value never changes, keep commit-on-Enter and commit-on-blur, `parseCount` validation and `aria-invalid` per FR-027 (missing)
- [ ] T029 Replace the text `Input` (`inputMode="numeric"`) in `src/renderer/features/settings/advanced/NumberUnitField.tsx` (lines 58-76) and the per-model inputs in `PerModelThresholdTable.tsx` with `NumberField`; all nine `count` rows in `src/shared/tokenGuard.ts` use it per FR-027 (missing)
- [ ] T030 Set `step` by unit: 1 for lines, requests, subagents, seconds, KB and percent fields (Cross-issue 2); 1000 for tokens including the idle threshold's token fallback; keep accessible names including the unit; leave `ScaleControl.tsx` unchanged per FR-027 (missing)
- [ ] T031 Update existing tests broken by the primitive change; run gates; commit `#1579` per FR-027 (partial)

### #1555 plain-language descriptions, labels, method hints

- [ ] T032 Rewrite every row `description` in `src/shared/tokenGuard.ts` (`TOKEN_GUARD_ROWS`, lines 84-229) with the approved #1555 table wording, leaving `compaction.thresholdTokens`/`compaction.modelThresholds` rows to #1553, with no "OMP" in user-visible text per FR-028 (missing)
- [ ] T033 Rename "Cross-device tools" to "Load rare tools on demand" (`tools.xdev`) and "Auto-continue after learning" to "Extra turn to record lessons" (`autolearn.autoContinue`); change the Advisor option label "Every turn" to "Every step" at `tokenGuard.ts:177-180` keeping stored value `turn` per FR-028 (missing)
- [ ] T034 Add an optional `description` to the compaction method options in `tokenGuard.ts:76-82` and render it as a muted line under each method name in the shared row/checkbox components with `aria-describedby` for Shake, Handoff, Soft, Remote, Snapcompact per FR-028 (missing)
- [ ] T035 Update existing tests pinning old wording; run gates; commit `#1555` per FR-028 (partial)

### #1580 token-impact warning lines (after #1555 and #1553)

- [ ] T036 Add optional `impact?: { costlierWhen: (value, default) => boolean; text: string }` to `TokenGuardKeyInfo` in `src/shared/tokenGuard.ts` and fill it for the draft rows (`read.defaultLimit`, `grep.contextBefore`/`grep.contextAfter`, `tools.artifactSpillThreshold`, `task.softRequestBudget`, `advisor.reviewMode`, `todo.eager`, `autolearn.autoContinue`, `tools.xdev`, `snapcompact.toolResults`); exclude `task.maxConcurrency` per FR-029 (missing)
- [ ] T037 Render the impact line in the shared `src/renderer/features/settings/advanced/AdvancedRow.tsx` with the warning severity token and a `TriangleAlert` icon under the description, linked by `aria-describedby`, no per-row styling per FR-029 (missing)
- [ ] T038 Compaction rows (Cross-issue 1): global `compaction.thresholdPercent` warns above 70; each per-model row in `PerModelThresholdTable.tsx` warns above the current global percent; at or below shows none per FR-029 (missing)
- [ ] T039 Check each row whose costlier direction is not established (`compaction.methodOrder`, `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds`, `snapcompact.systemPrompt`, `read.summarize.enabled`, `prewalk.enabled`, `plan.defaultOnStartup`) against the OMP settings docs and the #1212 notes; add a line only for a clear direction; record each decision in the PR body per FR-029 (missing)
- [ ] T040 Verify the warning colour meets 4.5:1 in every theme (`pnpm check:theme-contrast`); run gates; commit `#1580` per FR-029, SC-007 (partial)

### Final

- [ ] T041 Live verification per `quickstart.md` step 8 with `scripts/verify-tauri.mjs`, a scratch `REFRACT_DATA_DIR` and a seeded version 1 store: percent rows and "≈" hints, overlay `thresholdPercent: 70`/`thresholdTokens: -1`, one-time migration note, NumberField stepping/blocked keys/wheel, new wording and hints, no warnings at defaults and a warning when costlier (including per-model above global); capture screenshots for Stuart's wording approval per US2/AC7-10, SC-007 (missing)

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

- [x] T028 Add the shared `src/renderer/components/ui/NumberField.tsx`: `type="number"` with `min`, `step`, `max`, visible native spinners, ArrowUp/ArrowDown stepping, `onKeyDown` blocking `e`, `+`, `-`, blur or ignore on wheel so a focused value never changes, keep commit-on-Enter and commit-on-blur, `parseCount` validation and `aria-invalid` per FR-027 (missing)
- [x] T029 Replace the text `Input` (`inputMode="numeric"`) in `src/renderer/features/settings/advanced/NumberUnitField.tsx` (lines 58-76) and the per-model inputs in `PerModelThresholdTable.tsx` with `NumberField`; all nine `count` rows in `src/shared/tokenGuard.ts` use it per FR-027 (missing)
- [x] T030 Set `step` by unit: 1 for lines, requests, subagents, seconds, KB and percent fields (Cross-issue 2); 1000 for tokens including the idle threshold's token fallback; keep accessible names including the unit; leave `ScaleControl.tsx` unchanged per FR-027 (missing)
- [x] T031 Update existing tests broken by the primitive change; run gates; commit `#1579` per FR-027 (partial)

### #1555 plain-language descriptions, labels, method hints

- [x] T032 Rewrite every row `description` in `src/shared/tokenGuard.ts` (`TOKEN_GUARD_ROWS`, lines 84-229) with the approved #1555 table wording, leaving `compaction.thresholdTokens`/`compaction.modelThresholds` rows to #1553, with no "OMP" in user-visible text per FR-028 (missing)
- [x] T033 Rename "Cross-device tools" to "Load rare tools on demand" (`tools.xdev`) and "Auto-continue after learning" to "Extra turn to record lessons" (`autolearn.autoContinue`); change the Advisor option label "Every turn" to "Every step" at `tokenGuard.ts:177-180` keeping stored value `turn` per FR-028 (missing)
- [x] T034 Add an optional `description` to the compaction method options in `tokenGuard.ts:76-82` and render it as a muted line under each method name in the shared row/checkbox components with `aria-describedby` for Shake, Handoff, Soft, Remote, Snapcompact per FR-028 (missing)
- [x] T035 Update existing tests pinning old wording; run gates; commit `#1555` per FR-028 (partial)

### #1580 token-impact warning lines (after #1555 and #1553)

- [x] T036 Add optional `impact?: { costlierWhen: (value, default) => boolean; text: string }` to `TokenGuardKeyInfo` in `src/shared/tokenGuard.ts` and fill it for the draft rows (`read.defaultLimit`, `grep.contextBefore`/`grep.contextAfter`, `tools.artifactSpillThreshold`, `task.softRequestBudget`, `advisor.reviewMode`, `todo.eager`, `autolearn.autoContinue`, `tools.xdev`, `snapcompact.toolResults`); exclude `task.maxConcurrency` per FR-029 (missing)
- [x] T037 Render the impact line in the shared `src/renderer/features/settings/advanced/AdvancedRow.tsx` with the warning severity token and a `TriangleAlert` icon under the description, linked by `aria-describedby`, no per-row styling per FR-029 (missing)
- [x] T038 Compaction rows (Cross-issue 1): global `compaction.thresholdPercent` warns above 70; each per-model row in `PerModelThresholdTable.tsx` warns above the current global percent; at or below shows none per FR-029 (missing)
- [x] T039 Check each row whose costlier direction is not established (`compaction.methodOrder`, `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds`, `snapcompact.systemPrompt`, `read.summarize.enabled`, `prewalk.enabled`, `plan.defaultOnStartup`) against the OMP settings docs and the #1212 notes; add a line only for a clear direction; record each decision in the PR body per FR-029 (missing)
- [x] T040 Verify the warning colour meets 4.5:1 in every theme (`pnpm check:theme-contrast`); run gates; commit `#1580` per FR-029, SC-007 (partial)

### Final

- [X] T041 Live verification per `quickstart.md` step 8 with `scripts/verify-tauri.mjs`, a scratch `REFRACT_DATA_DIR` and a seeded version 1 store: percent rows and "≈" hints, overlay `thresholdPercent: 70`/`thresholdTokens: -1`, one-time migration note, NumberField stepping/blocked keys/wheel, new wording and hints, no warnings at defaults and a warning when costlier (including per-model above global); capture screenshots for Stuart's wording approval per US2/AC7-10, SC-007 (missing)

## Phase 3: Convergence

**Scope**: #1581 Optimise token usage, spec 2026-11-04 Clarifications (FR-030..032, US2/AC11, SC-008). One PR; commits in order: defaults spike, backend, UI. No new tests (prototyping rule); update existing tests only where a change breaks them. T041 stays open and also covers #1581 (see T049).

### Defaults spike (first, per FR-031)

- [X] T042 Review each key in `TOKEN_GUARD_KEYS` (`src/shared/tokenGuard.ts`) against the Usage database (calls per session, read calls per file, tokens per call before and after compaction, subagent calls against `task.softRequestBudget`, advisor calls by review mode) and the OMP settings docs; write one row per key (current, proposed or unchanged, evidence, expected effect) into the PR body per FR-031 (missing)
- [X] T043 Apply each proposed default to `default_for` in `src-tauri/src/omp/token_guard/values.rs` and to the mirrored default and description in `TOKEN_GUARD_ROWS` in `src/shared/tokenGuard.ts`; add a one-time migration in `values.rs` for each moved default (modelled on the #1545 `read_limit_migrated` flag in `Stored`, bumping nothing a user-set value would lose) so users on the old default move and user-set values stay; update `values.rs` unit tests only where they pin a moved default; commit per FR-031 (missing)

### Backend: reset every key (after T043)

- [X] T044 Add `reset_all` in `src-tauri/src/omp/token_guard/values.rs` clearing every override in one locked store write, and register `tokenGuard.resetAll` in `src-tauri/src/ipc/token_guard.rs` returning the same snapshot as `tokenGuard.reset` per FR-030 (missing)
- [X] T045 Add `TOKEN_GUARD_RESET_ALL: 'tokenGuard.resetAll'` and the `tokenGuard.resetAll()` signature to `src/shared/ipc.ts`, the request in `src/tauri-bridge/index.ts`, the channel in `scripts/check-parity.mjs` and `specs/021-token-guard/contracts/ipc.md`, and `resetAll(): Promise<void>` in `src/renderer/state/token-guard-store.ts` using the same `apply` path as `reset` per FR-030 (missing)

### UI: Optimise token usage button and dialog (after T045)

- [X] T046 Add a pure helper in `src/shared/tokenGuard.ts` (or beside `AdvancedSection.tsx`) returning the rows whose value differs from its default (label, current value text, default text, including `modelRoles.advisor` and `compaction.modelThresholds`) so the button state and the dialog list share one source per FR-030, SC-008 (missing)
- [X] T047 Add the button to the page header in `src/renderer/features/settings/AdvancedSection.tsx`: shared `Button` (`src/renderer/components/ui/button.tsx`, `variant="default"`), label "Optimise token usage", disabled with the tooltip "Already optimised" when T046 returns no rows; do not add a second primary action to the page per FR-030, US2/AC11 (missing)
- [X] T048 Add the confirm dialog on `src/renderer/components/ConfirmAlertDialog.tsx`: title "Optimise token usage?", description "These settings go back to their defaults. New Sessions use them; running Sessions are unchanged.", a real list of "label: from → to" rows, confirm "Optimise", cancel "Cancel", `busy` while `resetAll` runs, error shown in its live region and dialog kept open on failure, focus returned to the button on close; call `useTokenGuardStore.resetAll` only on confirm per FR-032, US2/AC11 (missing)
- [X] T049 Update existing tests broken by the change; run `pnpm check:file-size` (keep `AdvancedSection.tsx` and `values.rs` under 600 lines or extract, never raise baselines), `pnpm check:comment-density`, `pnpm check:theme-contrast`; extend T041's live verification with: button enabled after changing a row, dialog lists exactly the changed rows, cancel writes nothing, confirm resets all rows and clears warnings, disabled with "Already optimised" at defaults; screenshots for Stuart per US2/AC11, SC-008 (missing)

## Phase 4: Convergence

**Scope**: #1646 NumberField chevrons, spec 2026-11-05 Clarifications (FR-027, FR-033, SC-009). One PR, no new renderer tests (prototyping rule).

- [x] T050 Hide the native spinner in `src/renderer/components/ui/NumberField.tsx` and draw two stacked muted `ChevronUpIcon`/`ChevronDownIcon` `Button`s (ghost, `tabIndex={-1}`, `aria-hidden`) at the right edge with an 8px gap after the value; click calls `stepUp()`/`stepDown()` then dispatches an `input` event; disabled when the field is disabled/read-only or at `max`/`min` per FR-033 (missing)
- [x] T051 Update the Number fields paragraph in `docs/design/components.md` to describe the chevrons per FR-027 (partial)
- [x] T052 Live verification with `scripts/verify-tauri-1646.mjs`: NumberField in Settings > Advanced in a dark and a light theme, zoomed on the chevrons and the gap; click steps and fires onChange; screenshots per SC-009 (missing)

## Phase 5: Convergence

**Scope**: #1767 global config as the token guard store, spec FR-034..FR-039. Backend in `e45c4daa`; no new renderer tests (prototyping rule).

- [x] T053 `src/shared/tokenGuard.ts`: `TokenGuardMigration`, `TokenGuardTrigger`, snapshot `migration`/`effectiveTriggers`/`projectOverrides`, `live` flag per key, `parseThresholdInput` per FR-035..FR-039
- [x] T054 `token-guard-store.ts`, bridge and `ipc.ts`: pass `repositoryId`, expose migration, triggers, overrides, `dismissMigrationNotice`; drop the thresholds-reset notice
- [x] T055 `AdvancedSection.tsx`, `AdvancedRow.tsx`, `PerModelThresholdTable.tsx`: migration notice and error, trigger list, "Applies to new Conversations", project override note, three-form threshold field
- [x] T056 Live verification on a scratch `REFRACT_DATA_DIR` and scratch `~/.omp` home: backup file, retry on failure, probe of live keys, override note (`scripts/verify-tauri-1767.mjs`, all steps pass)

## Phase 6: Convergence

**Scope**: #1765 apply token guard changes to running Sessions, spec FR-036 amended. Probes in research.md sections 9 and 10.

- [x] T057 Probe the token guard keys against a running omp 18.17.0 with the scripted provider; record per-key results and unverified keys in research.md section 10
- [x] T058 Amend FR-036, plan.md and quickstart.md for live apply
- [x] T059 Legacy overlays: `ipc/token_guard.rs` set/reset/resetAll call `overlay::refresh_legacy`, which rewrites the legacy overlay and full legacy plan variants a Session launched before the migration still reads; the one-key plan variant and `working_mode/mod.rs` `default_mode` need no change (startup-only key, read at Session load); `overlay.rs:1` comment fixed
- [x] T060 Change the label to "Applies to new Sessions" in `AdvancedRow.tsx` and `AdvancedSection.tsx`; no restart button
- [x] T061 Co-located tests for the new logic, `pnpm ci:local`
- [x] T062 Live check saving a value in Settings while a Session runs (`scripts/verify-tauri-1765.mjs`). Scenario A (main path: global config.yml holds the new value, 'Applies to new Sessions' label, reworded Optimise dialog) and scenario B (legacy overlay: seeded token-guard.json, migration made to fail at launch by a directory at `token-guard-migration-backup.json`, overlay rewritten after the Settings write) both pass against a debug build at the branch head; evidence in `C:/Users/shopwood/refract-live-check-1765/`
- [x] T063 Reword the Optimise token usage confirm dialog (`OptimiseTokenUsage.tsx`) and mark FR-008 superseded by FR-036; the live check screenshots the dialog

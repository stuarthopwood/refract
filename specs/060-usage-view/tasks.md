# Tasks 060: Usage view

Format: `ID [P] description (paths)`. `[P]` = parallelisable with its neighbours (different files, no unfinished dependency). No new renderer tests (AGENTS.md prototyping rule); Rust tests only where listed. No task runs a build in this docs-only step; verification tasks run at implement time.

## Slice 1: Rust `usage` module, IPC, contract (PR 1, Closes nothing; PR 2 closes #1331)

- [X] S1-01 Add `rusqlite` (`default-features = false`, `features = ["bundled"]`) to `src-tauri/Cargo.toml`; confirm the lock diff adds only rusqlite, libsqlite3-sys and its direct deps.
- [X] S1-02 [P] `src-tauri/src/usage/paths.rs`: `usage_db_path()`, `sessions_dir()` with the pure `REFRACT_OMP_SESSIONS_DIR` override (absolute path only, else ignored).
- [X] S1-03 [P] `src-tauri/src/usage/schema.rs`: DDL from `data-model.md`, `user_version`, corrupt or newer file renamed to `usage.db.bak-<ts>` and recreated, `prefs` get/set.
- [X] S1-04 [P] `src-tauri/src/usage/credits.rs`: `credits_for(provider, cost_total)` (x100 for `github-copilot`, else none).
- [X] S1-05 [P] `src-tauri/src/usage/frustration.rs`: yelling, profanity and blame counts, word lists in this file only.
- [X] S1-06 [P] `src-tauri/src/usage/project_label.rs`: normalise paths; label from `cwd` then folder-name fallback; match Projects and Worktrees via the registry.
- [X] S1-07 `src-tauri/src/usage/ingest.rs`: bounded line reader from `file_offsets` (complete lines only, restart from 0 if the file shrank); replay `model_change` and `thinking_level_change`; assistant and `model_usage` rows; toolCall/toolResult upsert by `toolCallId`; user-message rows; one transaction per file. Depends on S1-03 to S1-06.
- [X] S1-08 `src-tauri/src/usage/rollup.rs`: delta upserts into the three rollups in the ingest transaction. Depends on S1-03.
- [X] S1-09 `src-tauri/src/usage/scan.rs`: walk the sessions dir, `(len, mtime)` change detection, newest-first order, progress counters, `main`/`subagent` from path. Depends on S1-07.
- [X] S1-10 `src-tauri/src/usage/mod.rs`: `UsageService` (std thread worker, nudge channel, five-minute rescan while started, `start`/`stop`/`status`, `usage.progress` emission at most once a second), `usage.relabel` on start. Depends on S1-09.
- [X] S1-11 [P] `src-tauri/src/usage/queries.rs` (+ `queries_tables.rs` if over 500 lines): filter-to-SQL builder (bound parameters, allowlisted sort keys), summary, timeseries with `tzOffsetMinutes`, token mix, breakdowns, top sessions, paged calls, frustration series. Depends on S1-03.
- [X] S1-12 [P] `src-tauri/src/github/copilot_plan.rs`: add `plan_snapshot()` (percent, entitlement, remaining) from the same cached response; keep `plan_percent_used()` unchanged.
- [X] S1-13 `src-tauri/src/usage/budget.rs`: Copilot row from `plan_snapshot()`, `omp usage --json` by argv (no shell, 10 s timeout, existing omp path resolution), 5-minute cache, defensive parse, reset date and burn rate, `unavailable` reason. Depends on S1-12.
- [X] S1-14 [P] `src/shared/ipc-usage.ts`: channel constants and types per `contracts/ipc.md`; `tauri-bridge` methods; `scripts/check-parity.mjs` entries; `ipc.ts` untouched.
- [X] S1-15 `src-tauri/src/ipc/usage.rs` and `ipc/usage_prefs.rs`: handlers, argument validation, registered from `ipc/mod.rs`. Depends on S1-10, S1-11, S1-13, S1-14.
- [X] S1-16 Hook the session manager: on a Refract Session's `message_end`, nudge the worker with that Session's Conversation file (`src-tauri/src/session/`, registry-sourced path). Depends on S1-10.
- [X] S1-17 Rust tests, a few only (`src-tauri/src/usage/*.test.rs`): offset resume after append, dedupe on re-read, partial last line, `model_change` replay, credits rule, Project label matching, filter-to-SQL parameterisation. Depends on S1-07, S1-11.
- [X] S1-18 Docs: `docs/PLAN.md` row (slice 1 landed), `CONTEXT.md` terms (Usage view, Project label, usage.db), `docs/rust-build.md` env vars `REFRACT_OMP_SESSIONS_DIR`.
- [X] S1-19 `scripts/verify-tauri-1331.mjs` with synthetic fixture generator under `%TEMP%`, fake `omp` and fake `gh` on PATH, scratch `REFRACT_DATA_DIR` and `REFRACT_OMP_SESSIONS_DIR`, scratch exe copy and remote-debugging port; asserts per `quickstart.md` step 4 and the single `omp usage --json` call. Depends on S1-15, S1-16.
- S1-20 Verify: `pnpm ci:local` (includes `check:file-size`, `check:parity`, cargo fmt, clippy `-D warnings`, `cargo test`), then the live check from S1-19. Gate agents, then PR (`feat(usage): ...`, no `Closes`). Depends on S1-17 to S1-19.

## Slice 2: renderer Usage view (PR 2, stacked on slice 1, Closes #1331)

- [X] S2-01 Check `package.json` for an existing charting library; if none, add the SVG chart primitive `src/renderer/components/ui/chart.tsx` (stacked bars, pattern fills, direct labels, sparkline, "View as table" toggle).
- [X] S2-02 [P] `src/renderer/components/StatCard.tsx` (value, label and caption read as one unit).
- [X] S2-03 [P] `src/renderer/components/SortableTable.tsx` (keyboard, `aria-sort`, paging, empty row).
- [X] S2-04 [P] `src/renderer/components/ProgressStrip.tsx` (`role="progressbar"` with value, polite live region on finish).
- [X] S2-05 `MainView` gains `'usage'` and `openUsage` in `src/renderer/state/view-store.ts`; `src/renderer/state/usage-store.ts` (filters, prefs, results, progress, start on open, stop on close, persisted via `usage.setPrefs`).
- [X] S2-06 `src/renderer/App.tsx`: one `usage` branch beside `pull-requests`/`issues`, net zero lines (baseline cap); Usage item in `src/renderer/features/sessions/ViewsNavGroup.tsx` after Issues.
- [X] S2-07 [P] `src/renderer/features/usage/captions.ts`: fixed caption templates chosen by value; hidden when jokes are off.
- [X] S2-08 `src/renderer/features/usage/UsageFilters.tsx` using `FilterTabs`, `Select`, `ListToolbar`; Custom range inputs.
- [X] S2-09 [P] `BudgetCard.tsx` (Copilot row, burn-rate line, provider rows, "Budget unavailable" with reason).
- [X] S2-10 [P] `HeadlineCards.tsx` (eight `StatCard`s; USD instead of credits for non-Copilot).
- [X] S2-11 [P] `SpendChart.tsx` and `TokenMixChart.tsx` on the chart primitive; day/hour toggle.
- [X] S2-12 [P] `UsageTables.tsx` split into one component per table if over 400 lines: by Project, by model and reasoning, by tool, top ten (row opens the Session when known), per-call log.
- [X] S2-13 [P] `FrustrationCard.tsx` (counts, mood sparkline; hidden when jokes are off).
- [X] S2-14 `UsageView.tsx` and `UsageEmptyState.tsx` (names the sessions folder): composes S2-08 to S2-13 under `ScreenHeader`, `region` landmark with `h1`, `ProgressStrip` while backfilling. Depends on S2-02 to S2-13.
- [X] S2-15 Settings row "Jokes on the Usage view" with `SettingSwitchRow` in `src/renderer/features/settings/ChatDisplaySection.tsx`, wired to `usage.setPrefs`.
- [X] S2-16 `src/renderer/features/usage/usageViewAction.ts` palette descriptor (registered when #5 lands).
- [X] S2-17 Docs: `docs/PLAN.md` row done, `CONTEXT.md`, `docs/design/components.md` (chart, StatCard, SortableTable, ProgressStrip).
- [X] S2-18 Extend `scripts/verify-tauri-1331.mjs` with the `quickstart.md` step 5 checks and a screenshot per state; include the large generated fixture for the progress bar and the empty `sessions\` folder.
- S2-19 Verify: `pnpm ci:local`, live check, then `code-reviewer`, `security-auditor`, `performance-optimiser`, `accessibility-auditor` gates; PR (`feat(usage): usage view`, `Closes #1331`). Depends on S2-14 to S2-18.

## Phase 3: Convergence (#1655, ingest at launch)

- [X] C-01 `src-tauri/src/ipc/usage.rs` and `src-tauri/src/lib.rs`: `start_at_launch(&AppState)` called from Tauri setup after app state exists; logs `usage: ingest started at launch`; `usage.start` stays idempotent per FR-006.
- [X] C-02 Remove `usage.stop` end to end: Rust handler, `UsageService::stop`, `Msg::Stop`, scan `stop` callback, `USAGE_STOP`, `UsageApi.stop`, bridge method, `check-parity.mjs` entry, renderer `usage-service.ts` holder set; the stores call `usage.start()` directly and never stop it.
- [X] C-03 Amend `spec.md` (FR-006, Session 2026-11-05), `plan.md`, `analysis.md`, `contracts/ipc.md` and `quickstart.md` to match.
- [X] C-04 Verify: `pnpm ci:local`; live driver `scripts/verify-tauri-1655.mjs` proves ingest ran at launch without the Usage view being opened; PR `fix(usage): start ingest at app launch`, `Closes #1655`.

## Phase 4: Convergence (#1656, rewritten session file; FR-019, SC-005)

Findings: FR-003 and FR-005 (partial): a file rewritten with the same head and a length at or past the stored offset resumed inside new content and skipped rows. SC-005 (missing): no regression test.

- [X] C-05 `src-tauri/src/usage/fingerprint.rs`: move `fnv1a` and the head window helper out of `ingest.rs`; add a window fingerprint at any start offset per FR-019 (partial)
- [X] C-06 `src-tauri/src/usage/schema.rs`: `tail_len`, `tail_hash` in the DDL, `user_version` 3, in-place `ALTER TABLE` from version 2 (version 1 still rebuilds) per FR-019 (partial)
- [X] C-07 `src-tauri/src/usage/ingest.rs`: store the tail window on save; a head or tail mismatch on resume restarts at byte 0; an empty window is unknown and is recorded without a reset per FR-019 (partial)
- [X] C-08 Regression tests in `ingest.test.rs` (same-head longer rewrite, truncated rewrite, unknown-window legacy row, no double counting) and `schema.rs` (a version 2 database keeps its rows and gains the columns) per SC-005 (missing)
- [X] C-09 `scripts/verify-tauri-1656.mjs` live driver per `quickstart.md` step 7 (missing)
- C-10 Verify: `pnpm ci:local`, the C-09 driver; PR `fix(usage): re-ingest session files rewritten past the first 256 bytes`, `Closes #1656`. Depends on C-05 to C-09.

## Phase 5: Convergence (#1845, tool Cost share as a percentage)

Findings: the spec Tool rows and Schema version decisions (amended 2026-11-11), FR contract `usage.breakdown`, and data-model v4 are met by the code; the live check against an old-schema database was missing.

- [X] C-11 `src-tauri/src/usage/schema.rs`: `user_version` 4, in-place rename of `cost_share` to `cost_usd` on `tool_calls` and `tool_rollup` from versions 2 and 3, with a test that history survives per the Schema version decision (met)
- [X] C-12 `queries_tables.rs`, `queries.rs`, `ipc-usage.ts`: by-tool `costShare` is a fraction of the window's tool spend, absent when nothing was priced, per the Tool rows decision and `contracts/ipc.md` (met)
- [X] C-13 `format.ts`, `UsageTables.tsx`: percentage, em dash when absent, with `format.test.ts` coverage per the Tool rows decision (met)
- [X] C-14 `scripts/verify-tauri-1845.mjs` live driver: seeds a version 3 `usage.db` holding `cost_share` rows, proves the migration and screenshots the tools table with percentages and the em dash (missing)
- C-15 Verify: `pnpm ci:local`, the C-14 driver; PR `fix(usage): tool Cost share shows a percentage`, `Refs #1845`. Depends on C-11 to C-14.

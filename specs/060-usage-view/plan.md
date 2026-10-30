# Plan 060: Usage view

Two stacked slices. Slice 1 is Rust plus contract with no UI; Slice 2 is the renderer on top of it. Docs-only so far: no code or tests were written for this plan.

## Slice 1: Rust `usage` module, IPC and contract

New `src-tauri/src/usage/`, each file under 600 lines:

- `mod.rs`: `UsageService` (worker handle, status, nudge channel), `start`/`stop`.
- `schema.rs`: DDL, `user_version`, corruption rebuild (`usage.db.bak-<ts>`), prefs table.
- `paths.rs`: `usage_db_path()` from `crate::data_dir()`; `sessions_dir()` with the pure `REFRACT_OMP_SESSIONS_DIR` override (same logic shape as `lib.rs::resolve_data_dir_override`).
- `scan.rs`: directory walk, `(len, mtime)` change detection, newest-first backfill order, progress counters.
- `ingest.rs`: bounded line reader from `file_offsets`, one transaction per file, `model_change`/`thinking_level_change` replay, assistant and `model_usage` rows, tool-call and tool-result upsert, user-message rows.
- `rollup.rs`: delta upserts into `message_rollup`, `tool_rollup`, `session_rollup`.
- `credits.rs`: `credits_for(provider, cost_total)`.
- `project_label.rs`: cwd (then folder-name fallback) to label via Projects and Worktrees from the registry; path normalisation.
- `frustration.rs`: yelling, profanity and blame scoring and its word lists.
- `queries.rs` (+ `queries_tables.rs` if needed): summary, timeseries, token mix, breakdowns, top sessions, paged call log, frustration series; shared filter-to-SQL builder with bound parameters only.
- `budget.rs`: Copilot row via `github::copilot_plan::plan_snapshot()`, `omp usage --json` spawn (argv, no shell, 10 s timeout, reusing the existing omp path resolution under `src-tauri/src/omp/`), 5-minute cache, defensive parse.
- Cargo: `rusqlite = { version = "<current>", default-features = false, features = ["bundled"] }` in `src-tauri/Cargo.toml`.
- `github/copilot_plan.rs`: add `plan_snapshot()` returning percent, entitlement, remaining beside the existing `plan_percent_used()` (same cache; no extra request).
- `ipc/usage.rs` (+ `ipc/usage_prefs.rs`): handlers registered from `ipc/mod.rs`; a renderer-supplied value is only a filter, a sort key from an allowlist, or a page number, never a path or SQL fragment.
- Session hook: on a Refract Session's `message_end`, send a nudge for that Session's Conversation file (the existing session manager event path under `src-tauri/src/session/`).
- Contract: new `src/shared/ipc-usage.ts` (channel names, filter, result and event types); `ipc.ts` gains no lines; `tauri-bridge` methods; `check-parity.mjs` entries. Details in `contracts/ipc.md`.
- Tests: a few Rust unit tests only (offset resume, dedupe, partial line, `model_change` replay, credits, label matching, filter-to-SQL), to keep `cargo test` meaningful. No renderer tests.

## Slice 2: renderer Usage view

- State: `MainView` gains `'usage'`; `view-store` `openUsage`; `state/usage-store.ts` (filters, prefs, results, progress; one fetch per filter change; stops the rescan when the view closes).
- Nav: Usage item in `features/sessions/ViewsNavGroup.tsx` after Issues. Palette: `features/usage/usageViewAction.ts` descriptor, registered when #5 lands.
- `App.tsx`: one branch beside `pull-requests`/`issues` (net zero lines: baseline cap).
- Shared components (ADR 0003), reusing `ScreenHeader`, `FilterTabs`, `ScreenSection`, `Empty`, `RefreshButton`, `Select`, `ListToolbar`: new `components/ui/chart.tsx` (stacked bars, patterns, direct labels, sparkline, "View as table"), `components/StatCard.tsx` (value, label, caption as one unit), `components/SortableTable.tsx` (`aria-sort`, keyboard, paging), `components/ProgressStrip.tsx` (`role="progressbar"`, polite live region).
- Feature `features/usage/`: `UsageView`, `UsageFilters`, `BudgetCard`, `HeadlineCards`, `SpendChart`, `TokenMixChart`, `UsageTables` (one component per table), `FrustrationCard`, `captions.ts` (fixed templates chosen by value), `UsageEmptyState`.
- Settings: "Jokes on the Usage view" row in `ChatDisplaySection.tsx` (or the closest existing section) using `SettingSwitchRow`, wired to `usage.setPrefs`.
- Top-ten row opens the Session when the Session registry knows the Conversation file.
- Docs: `docs/PLAN.md` row status, `CONTEXT.md` (Usage view, Project label), `docs/design/components.md` (new shared components), ADR 0006 consequences check.

## Verification (both slices, no real OMP folder, no real Copilot calls)

- `REFRACT_DATA_DIR` scratch dir and `REFRACT_OMP_SESSIONS_DIR` pointing at a synthetic fixture under `%TEMP%` (a main file, a nested subagent file, a truncated last line, a model switch mid-file).
- Fake `omp` on PATH (`omp usage --json` and the RPC recorded frames) and fake `gh` (plan snapshot), via `pnpm verify:tauri` style script `scripts/verify-tauri-1331.mjs`; scratch exe copy with its own `--remote-debugging-port`.
- Slice 1 proof: call the IPC from the page, assert totals equal the fixture sum, then ingest twice and assert nothing changes; append a line and assert the nudge lands it.
- Slice 2 proof: open Usage, check cards, chart table toggle, sort, filters, jokes off, empty state against an empty sessions dir, progress bar, then a screenshot per state.
- Gate per slice: `pnpm ci:local` and the quality gate (no cargo or pnpm builds in this docs task).

## Constitution check

I (OMP is the engine): reading session files is ADR 0006; `omp usage --json` is a one-shot read-only CLI call, not a session. II/III: no RPC wire or lifecycle change; the nudge uses the existing event stream. IV: field names verified on real files (research item 3, 5). V (Tauri security baseline): no new capability or CSP change; all new commands are Rust IPC with typed args; no path from the renderer reaches the filesystem; SQL is parameterised; `omp` spawned by argv. Re-checked after design: pass.

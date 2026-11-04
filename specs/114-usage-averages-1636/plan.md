# Implementation Plan: Usage view Averages section

**Spec**: `specs/114-usage-averages-1636/spec.md` | **Issue**: #1636

## Technical context

Rust (rusqlite) usage queries in `src-tauri/src/usage/`; TypeScript contract `src/shared/ipc-usage.ts`; React renderer `src/renderer/features/usage/`. No schema change, no new IPC channel (`usage.summary` result grows).

## Design

**Rust.**
- `queries.rs` is 597 lines, so the 600-line cap forces a split: move `Summary`, `summary()` and `tool_totals()` into new `queries_summary.rs` (`pub mod queries_summary;` in `usage/mod.rs`). `ratio` becomes `pub(super)` in `queries.rs` (still used by `token_mix`). Callers migrate: `ipc/usage.rs` (`queries::summary` -> `queries_summary::summary`) and `queries.test.rs` imports. No re-export shim.
- `Summary` gains `active_days: i64`, `sessions: i64`, `month_to_date_usd: f64`, `month_active_days: i64`.
- `active_days`: same filtered `rollup_source` as the totals, `count(DISTINCT ((hour + off) / 86400000))` where `calls > 0`; `exact = ctx.offset_ms() % HOUR_MS != 0` exactly as `timeseries`. Share the bucket expression and the exact rule through one `pub(super)` helper in `queries.rs` so the chart and the average cannot drift.
- `sessions`: `count(DISTINCT session_file)` over `messages` (target `MESSAGES`: `build(&MESSAGES, ctx)` applies filters and window, including `sessionDir`). Rollups carry no session column. Cost: one indexed (`messages_ts`) scan; acceptable, only the view and Session panel call it.
- Month fields: clone the filters as `range: "custom"`, `from: Some(month_start)`, `to: None` (drops the caller's range, keeps Project, model, reasoning, agent type, Session) and run the same sum and active-day query. `month_start` comes from new `timeutil::month_start_local(now_ms, offset_ms)` (uses `civil_from_days`/`days_from_civil`; make the latter `pub(super)` or add the helper beside it).
- Months with no spend: `month_active_days = 0`, `month_to_date_usd = 0`.

**Contract.** `UsageSummary` in `ipc-usage.ts` mirrors the four fields; `specs/060-usage-view/contracts/ipc.md` row for `usage.summary` updated.

**Renderer.**
- New `averages.ts` (pure): `computeAverages(summary, today)` returning values or `null` per average, and `weekdaysLeft(today)` (Mon-Fri after today to month end, local). Small, no UI.
- New `AverageCards.tsx`: `ScreenSection title="Averages"` + the 11rem grid of six `StatCard`s; `null` renders `-` through the existing empty-value convention (else a `<span aria-label="No data">-</span>`). Captions: "Over N active days" (singular "1 active day"), "Copilot models only", "This month, ignores the date range"; none from `captions.ts` jokes.
- `format.ts`: add `formatUsdPerCall` (3 decimals under $1, else `formatUsd`), leave `formatUsd` alone.
- `UsageView.tsx`: render `AverageCards` under `HeadlineCards` inside the existing `gap-8` stack (#1407).
- `SessionUsagePanel.tsx` / `HeadlineCards.tsx` stacked branch: muted line adds "Avg spend per call Z". Change is one line in the stacked branch; `HeadlineCards` does not gain cards.

**Docs.** `docs/PLAN.md` row 1063 status and PR link; ipc contract row; `specs/060-usage-view/tasks.md` unchanged.

## Files the implementation touches

Rust: `src-tauri/src/usage/queries.rs` (shrinks), new `queries_summary.rs`, `mod.rs`, `timeutil.rs`, `queries.test.rs` (extend existing test, fix imports), `src-tauri/src/ipc/usage.rs` (one call path).
TS: `src/shared/ipc-usage.ts`, new `features/usage/AverageCards.tsx`, new `features/usage/averages.ts`, `format.ts`, `UsageView.tsx`, `HeadlineCards.tsx` (stacked line only).
Docs: `specs/060-usage-view/contracts/ipc.md`, `docs/PLAN.md`.
Verification script: extend `scripts/verify-tauri-1331.mjs` or add a `scripts/verify-tauri-1636.mjs` CDP driver (allowed) with fixtures from `verify-1331-fixtures.mjs`.

## Constitution and repo rules

No new tests (prototyping); comments "why" only; 600-line cap held by the split; shared `StatCard`/`ScreenSection` reused; 2-space indent.

## Risks

- #1571 (Project filter / `ProjectIndex`) edits `queries.rs`-adjacent project code and the Usage view filters; merge after this lane, rebase conflicts expected only in `queries.rs`/`ipc/usage.rs` imports.
- `session_file` as "Session" counts subagent files (flagged in the spec).

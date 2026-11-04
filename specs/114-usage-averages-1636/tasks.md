# Tasks: Usage view Averages section (#1636)

Order is dependency order. No new test files or cases; T4 extends an existing test as the issue requires.

- [x] T1 Rust split: create `src-tauri/src/usage/queries_summary.rs` holding `Summary`, `summary()`, `tool_totals()` moved from `queries.rs`; register in `usage/mod.rs`; make `ratio` `pub(super)`; update `ipc/usage.rs` and `queries.test.rs` imports. `queries.rs` must end under 600 lines. (FR-008)
- [x] T2 `timeutil.rs`: add `month_start_local(now_ms, offset_ms)`. In `queries.rs` add the shared day-bucket expression and exact-rows rule used by `timeseries`; make `timeseries` use it. (FR-002)
- [x] T3 `queries_summary.rs`: add `active_days`, `sessions`, `month_to_date_usd`, `month_active_days` to `Summary` and `summary()` per plan. Depends on T1, T2. (FR-001, FR-002)
- [x] T4 Extend `summary_and_calls_read_what_was_recorded` in `queries.test.rs` for the four fields with a Project filter and a range that excludes part of the month. Depends on T3. (issue verification)
- [x] T5 [P] `src/shared/ipc-usage.ts` mirrors the four fields; update the `usage.summary` row in `specs/060-usage-view/contracts/ipc.md`. (FR-001)
- [x] T6 [P] `features/usage/averages.ts`: `computeAverages` and `weekdaysLeft`. Depends on T5. (FR-003)
- [x] T7 [P] `format.ts`: `formatUsdPerCall`. (spec Clarifications)
- [x] T8 `features/usage/AverageCards.tsx` and its mount in `UsageView.tsx` under `HeadlineCards`; `-` accessible name; captions. Depends on T6, T7. (FR-004, FR-006, FR-007)
- [x] T9 Session usage panel: stacked muted line gains "Avg spend per call Z" (`HeadlineCards.tsx` stacked branch). Depends on T7. (FR-005)
- [x] T10 CDP live check driver `scripts/verify-tauri-1636.mjs`: seeded fixtures, hand-checked averages for 7d and All, with and without Project; screenshots. Session panel line is not driven live (covered by the headline render only).
- [x] T11 `docs/PLAN.md` row 1063 status and PR link. Gate: `node scripts/ci-local.mjs` (build slot), `pnpm check:comment-density`.

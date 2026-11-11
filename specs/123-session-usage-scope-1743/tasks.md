# Tasks: Session usage panel scope and range toggles (#1743)

Order is dependency order. One Rust test is added (T3); no TypeScript tests.

- [x] T1 Rust filter: `Filters.session_file`, `queries_session::file_clause`, `session_clause`, `session_scoped`, `needs_tool_calls` in `queries.rs` / `queries_session.rs`. (FR-001)
- [x] T2 Rust prefs: `sessionScope` / `sessionRange` allowlisted keys in `ipc/usage_prefs.rs`. (FR-002)
- [x] T3 Rust test in `queries.test.rs`: one file matched with folded separators and case, `today` plus the file, empty value rejected. Depends on T1. (FR-001)
- [x] T4 [P] `src/shared/ipc-usage.ts` types and `specs/060-usage-view/contracts/ipc.md` rows. (FR-001, FR-002)
- [x] T5 `session-usage-store.ts`: scope and range state, prefs load and persist, target-keyed entries, hourly buckets for Today. Depends on T4. (FR-004, FR-006)
- [x] T6 `SessionUsageToggles.tsx` on the shared `ToggleGroup`. Depends on T4. (FR-003, FR-005)
- [x] T7 `SessionUsagePanel.tsx`: target from `currentConversation`, mount toggles, empty-state text. Depends on T5, T6. (FR-003, FR-005)
- [x] T8 `docs/PLAN.md` row for #1743. Gate: `pnpm typecheck`, `pnpm check:comment-density`, `pnpm check:file-size`; `cargo test`, `pnpm ci:local` and the live check are pending the build slot.

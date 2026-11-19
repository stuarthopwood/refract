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

## Phase 2: Convergence (#2070)

- [x] C-1 `queries_session.rs::file_clause` matches the file or its sibling folder (prefix on the base name), `queries.rs` comment. (FR-001 superseded)
- [x] C-2 `queries.test.rs`: Conversation counts its subagent and advisor rows and not `.bak` or `onex`; single-Conversation Session equals its Conversation; Main thread is the file alone. Depends on C-1.
- [x] C-3 `usage_prefs.rs` allows `main`; `ipc-usage.ts` `UsageSessionScope` gains `main`; `specs/060-usage-view/contracts/ipc.md` row. (FR-002, FR-008)
- [x] C-4 `session-usage-store.ts`: `scopeFilters`, `effectiveScope`, `entryKey` per scope; `session-usage-store.test.ts`. Depends on C-3. (FR-008)
- [x] C-5 `SessionUsageToggles.tsx` Main thread segment and `SessionUsagePanel.tsx` empty-state noun. Depends on C-4. (FR-008)
- [ ] C-6 Verify (build phase): `cargo test usage`, `cargo clippy`, `pnpm ci:local`, live check that Session equals Conversation for the Personal Agent session and Main thread shows the old Conversation figure.

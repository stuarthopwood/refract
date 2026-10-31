# Tasks: spec 096

- [ ] T1 `Session.originIssue` (Rust registry, TS model, literals)
- [ ] T2 `add_worktree_for_issue` and the slug
- [ ] T3 `gh_permission.rs` write-access check
- [ ] T4 `session_kickoff.rs`: builder, `issues.newSession`, PR command returns `{ session, kickoff }`
- [ ] T5 Bridge and IPC types
- [ ] T6 `startSessionFromItem`, existing-Session prompt, kickoff apply, composer notice
- [ ] T7 Entry points: Issues row, PR row menu, palette, New session URL, PR detail
- [ ] T8 Header origin issue
- [ ] T9 `pnpm ci:local`, live check `scripts/verify-tauri-096.mjs`
- [ ] T10 Six-reviewer gate

## Analysis

FR-1 T2/T4, FR-2 T4, FR-3 T4/T6, FR-4 T4, FR-5 T3, FR-6 T6, FR-7 T7, FR-8 T6/T7. Decisions 1 to 7 map to T7, T2, T1/T8, T4, T3/T6, T6, T2. No conflict with ADR 0003: dialogs, menus and buttons are the shared primitives.

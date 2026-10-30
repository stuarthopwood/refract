# Tasks 070

- [x] T1 #1400 store, IPC, Rust any-of search
- [x] T2 #1400 Badge onDismiss, LoadingOverlay, IssueList picker, pill row, overlay
- [x] T3 #1402 sessionDir filter (IPC type and Rust queries)
- [x] T4 #1402 panel registration, store, SessionUsagePanel, HeadlineCards/SpendChart variants
- [x] T5 #1409 Rust roster detection, IPC, launch notice
- [x] T6 #1409 Advisor row warning, Usage caption
- [x] T7 #1409 check:advisor-roster and ci:local wiring
- [ ] T8 docs/PLAN.md rows
- [x] T9 ci:local, live check with screenshots
- [x] T10 reviewer gate (follow-up #1452) reviewer gate

## Analysis

Cross-checked spec, plan and tasks: every FR maps to a task and file group. Shared files across issues: `features/usage` call log and `HeadlineCards`/`SpendChart` (T4, T6, different regions), `package.json` and the ci:local script (T7 only). Workers do not run cargo; the director runs it once, serially. No gaps found.

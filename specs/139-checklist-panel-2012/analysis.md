# Analysis: Checklist right-pane panel (#2012)

Cross-artifact pass over spec.md, plan.md and tasks.md, following `.omp/commands/speckit.analyze.md`. Read-only on code: no cargo or vitest run, and the code cites are from the earlier read of this worktree (`origin/main` at `2b765e18`), re-verified by T001. The pass was kept lean because the run was over its request budget. Every finding was fixed in the docs before commit unless marked Open.

| ID | Category | Severity | Finding | Fix |
|---|---|---|---|---|
| A1 | Gap | Medium | The decision record left the reveal-request consumer's behaviour and the `toolUnavailable` clear rule unspecified; both are in scope | Added as spec Clarifications "added by this spec" with reasons; FR-014, FR-016; T003, T017 |
| A2 | Inconsistency | Medium | `checklist.get` shape change touches `ipc-checklist.ts` and the bridge, which #2013 also edits | Plan orders this first and limits the bridge change to the get wrapper; T005 migrates all callers with no shim |
| A3 | Ambiguity | Low | Names of the bridge file, cargo crate and test commands are not confirmed | T001 re-reads and the task text says "per T001"; Open until T001 runs |
| A4 | Coverage | Low | The contract file and Rust panel list for `'checklist'` were not in the issue's file list | T009 covers `panel-actions.json`, `panels.rs` and the parity tests |
| A5 | Risk | Medium | Contrast pairs may fail on some presets | T007 says fix the token usage, never lower the minimum |
| A6 | Not verified | Low | The `checklist.get` golden/parity script name is unknown | Named generically in T005; resolved in T001 |

Coverage: every FR maps to at least one task (see tasks.md Coverage); every decision 1-8 maps to a Clarification, FR and task; no `[NEEDS CLARIFICATION]` remains. Out-of-scope items (#2013 controls, #2014 source line) appear in no task. No file is budgeted above 400 lines.

# Analysis: Usage view Project labels for worktree and scratch cwds

Cross-check of `spec.md`, `plan.md` and `tasks.md` against the code, 2026-11-04.

| Requirement | Covered by | Result |
| --- | --- | --- |
| Worktree and reaped-worktree cwds show the Project | T002 (worktrees root), T005 | Covered |
| Scratch/temp cwds become one **Other** row | T001, T005 | Covered |
| Encoded session folders resolve to a Project | T003, T005 | Covered |
| Unmatched cwd shows a readable folder name, case duplicates merge | T001, T005 | Covered |
| Project filter reads the same label | No change: filter and breakdown read the stored `project_label` | Covered |
| Totals unchanged | T005 relabels only, via `rollup::relabel_file`; T006 asserts the total | Covered |

## Findings

- Compile risk: no cargo build was run in this lane. The run worker's `cargo test` and `cargo clippy` are the first compile.
- Heuristic: encoded-folder matching is hyphen-lossy. It only applies to files without a cwd; a Project `fdb` could claim an unregistered `fdb-agentkit` folder. Longest-first ordering makes a registered `fdb-agentkit` win.
- No IPC, query or renderer change was needed, so no renderer tests are added.

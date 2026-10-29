# Tasks: Agents trust the OS certificate store

No new tests (issue and AGENTS.md). Commit and push after each task.

- [x] T1 Live-test `NODE_USE_SYSTEM_CA=1` against the baseline (recorded in spec.md).
- [x] T2 Add `trust_system_ca` in `omp/process_args.rs` and call it from `omp/process.rs`.
- [x] T3 Status note in `docs/PLAN.md`.
- [ ] T4 Gate (code-reviewer, test-reviewer, security-auditor), `pnpm ci:local`, live check on a scratch exe.

Analyze: FR-001 to FR-004 map to T2; SC-001 to T1 and T4; no gaps.

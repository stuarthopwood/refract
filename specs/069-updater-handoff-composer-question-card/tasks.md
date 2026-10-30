# Tasks: spec 069

- [ ] T001 Hand-off script: exit code capture, `install.log`, `-EncodedCommand`, relaunch rule (FR-1, FR-2, FR-4)
- [ ] T002 Reconciliation: cause-bearing `lastError` from the log (FR-3)
- [ ] T003 Live check the hand-off with scratch fake installers (exit non-zero, then zero)
- [ ] T004 Spelling: Windows spell-check command, menu items, replace-word (FR-5)
- [ ] T005 Status line gap (FR-6)
- [ ] T006 Question card row fill, centred control, ghost Cancel on both card paths (FR-7)
- [ ] T007 Single-choice pick advances or submits (FR-8)
- [ ] T008 Docs and `docs/PLAN.md` rows
- [ ] T009 `pnpm ci:local`, `pnpm check:ui-text`, live checks, quality gate

## Analyze

Every FR maps to a task (FR-1/2/4: T001; FR-3: T002; FR-5: T004; FR-6: T005; FR-7: T006; FR-8: T007). No new tests are added (prototyping phase); existing `install_on_quit` tests stay green. No conflict with spec 006 verification rules; #1387 (footer alignment) is untouched.

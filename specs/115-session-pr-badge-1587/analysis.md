# Analysis: Chat header badge tracks Session-written PRs and issues

Cross-check of `spec.md`, `plan.md`, `tasks.md` against issue #1587's grill block and `docs/PLAN.md` line ~1031.

## Coverage

| Requirement | Plan | Tasks |
| --- | --- | --- |
| FR-001 detect writes | `gh_commands.rs` | T004, T005 |
| FR-002 tokenised, reads ignored | `shell_words.rs` | T002, T004 |
| FR-003 number from args, URL arg, output URL | `detect` | T004, T005 |
| FR-004 successful calls only | `detect` | T005 |
| FR-005 `touched` shape, dedupe, cap | `touched.rs`, `model.ts` | T001, T003, T012 |
| FR-006 per-Conversation lifecycle | `history.rs`, launch/conversations | T006, T009, T013 |
| FR-007 lazy state refresh with back-off | `item_by_number` | T008, T010 |
| FR-008 badge plus +N, ordering rule | `HeaderPrControls`, `TouchedRefControls` | T016, T017 |
| FR-009 no duplicates of #1315 items | `HeaderPrControls` | T017 |
| FR-010 open in pane or on GitHub | `openTouched.ts` | T011, T015 |
| FR-011 `owner/repo#N` | `TouchedRefControls` | T016 |
| FR-012 accessibility | `TouchedRefControls` | T016, T021 |
| FR-013 shared components | `Badge`, `HeaderActionButton`, `DropdownMenu` | T014, T016 |
| FR-014 reusable detector interface | "Detector interface" | T005, T010 |

## Findings

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| A1 | LOW | FR-001 listed `-X POST`/`PATCH`/`--input` while T004 also covers PUT and DELETE. | FR-001 widened to match T004. |
| A2 | LOW | `readout.rs` is already large; T012 adds state and wiring to it. | T019 checks the 600-line cap; new logic lives in `readout_touched.rs`. |
| A3 | LOW | No existing shell tokenizer was found, so T002 adds one. | Required by the grill ("tokenizer, not regex"); recorded under Complexity Tracking. |

No CRITICAL or HIGH findings. Constitution check: no violations. Every requirement has a task and every task maps to a requirement or to verification and docs. No new tests are planned, per the prototyping rule.

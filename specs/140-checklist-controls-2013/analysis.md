# Analysis: spec 140 (#2013)

Lean pass, run by reading spec.md, plan.md and tasks.md together. No code was read in this pass; code anchors rely on the earlier reads and T001 re-verifies them.

## Coverage

| Requirement | Task |
|---|---|
| FR-001 | T002, T003 |
| FR-002 | T007 |
| FR-003 | T008, T009 |
| FR-004, FR-005, FR-006, FR-007 | T006 (T004, T005) |
| FR-008 | T008 |
| FR-009 | T011 |
| FR-010 | T010 |
| FR-011 | T011, T019 |
| FR-012 | T013-T018 |
| FR-013 | every task (tests named), T021 |
| SC-001..SC-005 | T003, T008, T019, T022, T021 |

## Findings

- **F1 (resolved)**: the first spec draft had `accept_complete` hash text before `rev` existed. Resolved by the builder form (Clarifications; T005).
- **F2 (resolved)**: `value` and `complete` need `baseRev`; the design signature omitted it. Added (Clarifications; T006, T009).
- **F3 (resolved)**: `not_agent_completable` was not an `ErrorCode`. Added (T004).
- **F4 (resolved)**: plan referenced T010, T011, T012, T022 by number; tasks.md keeps those numbers (T019 sits after T011 on purpose).
- **F5 (open, low)**: file lengths of `frame.rs` (385) and `chat.rs` (339) were read earlier; T001 re-measures and splits before editing if a file would pass 600.
- **F6 (open, low)**: #2012 filenames are unknown until it merges; T013-T018 say "named in T001". If #2012 is not merged when this lane starts, the renderer phase waits.
- **F7 (open, medium)**: whether the `message_start` frame text equals the sent text exactly (needed for the hash match in T010) was not verified in this pass; T010's `edited_text_does_not_start_it` and a test using a real frame fixture cover it, and a mismatch would be a finding to report.

No `[NEEDS CLARIFICATION]` remains. No constitution conflicts found.

## Deviations list (filled by T001)

T001 re-read at branch head `f4d8d661` (cut from `origin/main` `78d21cf4`). Every anchor in plan.md "Technical Context" still holds. Line counts of the touched existing files: `agent_tools/envelope.rs` 170 (test 139), `agent_tools/mod.rs` 134, `agent_tools/sessions_send.rs` 190, `session/agent/chat.rs` 339, `session/agent/frame.rs` 385, `checklist/records.rs` 215 (test 336), `checklist/ops.rs` 444 (test 129), `checklist/result.rs` 200, `checklist/developer_ops.rs` 106, `checklist/mod.rs` 19, `ipc/checklist.rs` 205, `src/shared/ipc-checklist.ts` 80, `src/tauri-bridge/checklist.ts` 15, `src/shared/checklist.ts` 189 (test 60). None passes 600 lines after its budgeted change, so no split is needed.

Deviations and findings:

1. **#2012 is not merged.** `origin/main` has no panel file, no `state/checklist-store.ts` and no `CHECKBOX_BOX_ONLY_CLASS`. Only `origin/feat/checklist-panel-2012` exists, holding docs only (spec 139). Its tasks.md names the files T013-T018 will use: panel dir `src/renderer/features/right-pane/checklist/`, item row `ChecklistRow.tsx` (the T017 mount point), `ChecklistPanel.tsx`, store `src/renderer/state/checklist-store.ts`, `CHECKBOX_BOX_ONLY_CLASS` in `src/renderer/components/ui/checkbox.tsx`. These are planned names, to be re-checked against the merged code before Phase 3.
2. **Renderer paths.** Renderer code lives under `src/renderer/` (`features/`, `state/`, `components/ui/`), so tasks.md's `features/<panel dir>` and `state/checklist-drafts.ts` mean `src/renderer/features/right-pane/checklist/` and `src/renderer/state/checklist-drafts.ts`. `src/shared/` and `src/tauri-bridge/` sit directly under `src/`.
3. **T012 is already met.** `CHECKLIST_CAPS` in `src/shared/checklist.ts` has `maxValueBytes: 1024` and `maxItemMessageBytes: 4096`, and `checklist.test.ts` compares the block with `model.rs`. T012 only needs the named test if it is not already covered.
4. **`accept_complete` has no production caller yet**, only three call sites in `checklist/records.test.rs` (lines 153, 207, 328), so T005 changes the signature and those tests only.
5. **`ErrorCode::ALL` has no length test today**; `result.test.rs:134` only iterates it. `error_code_all_has_thirteen` is new, in `ops.test.rs`.
6. **Field name for an over-cap value.** `set_value` validates with `Field::Value`, so its `too_large` names `value`; the spec wants `field: "text"` for `itemMessage`. The engine must check the cap itself before calling `apply_developer`.
7. **Plain `Value` text may hold U+2028 and U+2029** (`validate.rs` bans only controls other than `\n` and `\t` for `Field::Value`); the envelope body escape does not care, but the transcript is one envelope either way.

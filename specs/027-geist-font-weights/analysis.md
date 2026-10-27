# Analysis: spec 027

Cross-artifact check of spec.md, plan.md and tasks.md, 2026-10-27.

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | Medium | The issue names `docs/DESIGN.md` "Look and feel", which is now only an index; the live pages are `docs/design/product-look-and-feel.md` (line 13, code font) and `docs/design/foundations-typography-spacing.md` (lines 19, 44-57: font list, scale table, "450" note about Segoe). | T007 targets those two pages; the scale table is rewritten to 300/400/500/600. |
| 2 | Low | `COMMAND_PILL_TEXTAREA_CLASS` sets no font, so `font-code` on the `Textarea` and on `COMPOSER_MIRROR_CLASS` is enough. | Plan step 4 stands. |
| 3 | Low | Every FR maps to a task: FR-001/003/005 to T002, FR-002 to T001, FR-004 to T003, FR-006 to T004, FR-007 to T005 and T006, FR-008 to T002 and T007, FR-009 to T008, FR-010 by omission. | None. |
| 4 | Low | `ipc.ts` has 6 lines of headroom under its baseline (892 of 898); the plan adds 2. | Hold the limit; `check:file-size` in T008. |

No Critical or High findings.

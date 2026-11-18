# Analysis: Session list tree for nested Sessions (#1862)

Cross-artifact consistency pass over spec.md, plan.md, tasks.md and checklists/requirements.md, following `.omp/commands/speckit.analyze.md`, against the code at `6f3a93c9`. Every finding below was fixed in the docs before this file was committed.

## Findings

| ID | Category | Severity | Finding | Fix |
|---|---|---|---|---|
| I1 | Inconsistency | High | FR-009 and plan item 6 said Up and Down Arrow "keep the existing roving behaviour". The list has none (`useSessionRowActions.ts:128-133` claims only F2; `SessionList.tsx:153` rules out arrow roving), so a `role="tree"` would have had no vertical keys. | FR-009, User Story 6 scenario 4, plan item 6, T007 and T009 now add Down, Up, Home and End inside tree groups only; Tab order is unchanged. |
| I2 | Underspecification | High | The `ConfirmAlertDialog` has one Cancel and one confirm, but FR-010 needs three actions, and the task list built none of that. | FR-010, plan item 7 and T009(a) extend the shared component with `secondaryLabel` and `onSecondary` (no second dialog component); a test row was added to plan.md. |
| I3 | Inconsistency | High | The dialog text said archiving "stops" the children, which is false for **Archive parent only**. | FR-010 and User Story 4 scenario 2 state each button's effect; the list label is "Running now:" in the spec, plan and T009 (T009 said "Still running:"). |
| I4 | Inconsistency | Medium | Plan item 5 and T008 used `--tree-level` and nested padding language; the spec fixes 12 pixels a level capped at 36 pixels. | All three now use `--tree-indent: calc((min(level, 4) - 1) * 12px)`. |
| I5 | Underspecification | Medium | N in the dialog counts live descendants at every depth while the row count is direct children; hidden descendants were not named. | FR-010 adds the "Includes M nested Session(s)" line and "(hidden)" marks, taken from the unfiltered list; the test row covers both. |
| I6 | Inconsistency | Medium | The plan's code map put the row `<li>` at `SessionRow.tsx:91-146`; it is at `:145`. | Code map corrected; it says to re-verify before each task. |
| I7 | Ambiguity | Medium | "Child count" and "roll-up" had four phrasings. | One grammar, attention first: "1 needs you, 2 children" (FR-002, FR-005, User Story 3). |
| I8 | Task ordering | Medium | T012 (apply review findings) sat before T013 although the review was already folded in, and T013 depended on it. | T012 is now a check against the Decided entries made while taking the T013 evidence; the dependency note says so. |
| I9 | Coverage | Low | FR-009 mapped only to T007 and T008; the key handler lives in `useSessionRowActions.ts`. | Coverage lists T007 and T009 for FR-009. |
| I10 | Stale text | Low | plan.md "Design review findings" said the review was pending. | Replaced with the finished summary and the one plan correction (I1). |

## Coverage

- Every FR-001 to FR-018 maps to at least one task (Coverage section of tasks.md); every SC maps to T013, T014, T015, T018 or T020.
- Every edge case has a home: cycle, self and missing parent (`sessionTree.test.ts`), depth clamp (T007, T008), delete re-root and restore (Rust, spec 131 and 134 tests; the list reads the data), selected row in a collapsed parent (T008), narrow widths (T014), partial failure (T003 test, FR-011).
- Every Clarification entry appears in an FR: choice A in FR-006 and FR-014, choice B in FR-015, N in FR-010, search in FR-007, announcements in FR-011 and FR-012.

## Rule checks

- ADR 0009: archive keeps links and delete re-roots; this slice changes neither. The Rust change only moves the cascade into `archive_subtree_core`, shared with the `archive_session` tool, so there is one set and one order.
- AGENTS.md: why-only comments (#1322); every changed module has a co-located test file in plan.md's test plan (epic #1918); the 600-line cap is budgeted in plan.md (`ipc/settings.rs` 571, `store/settings.rs` 554) with an extraction path; none is in `scripts/file-size-baseline.json`.
- Reusable UI: `IconButton` and `ConfirmAlertDialog` from `src/renderer/components/`, extended in place; no second disclosure, dialog or badge component (FR-016, T019).
- No parenthetical UI copy rule (`docs/design/product-look-and-feel.md`): the "(archived)" and "(hidden)" suffixes are part of the Decided "from <parent> (archived)" wording from the grill, so they stay; they are plain text, not a bracketed aside.

## Open questions

None.

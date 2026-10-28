# Analysis: 8px spacing grid (spec, plan, tasks)

Run 2026-10-27 (`/speckit.analyze`), read-only consistency check across `spec.md`, `plan.md`, `tasks.md`, issue #1252, ADR 0003 and the AGENTS.md rules.

## Coverage

| Requirement | Task |
| --- | --- |
| FR-001 | T2, T4-T9, T10 |
| FR-002 | T2 |
| FR-003 | T2, T4-T9 |
| FR-004 | T2, T4-T9 |
| FR-005 | T1, T10 |
| FR-006 | T3, T10 |
| FR-007 | T6 |
| FR-008 | T11 |
| FR-009 | every task, T11 |

Every requirement has a task and every task maps to a requirement. No orphan tasks.

## Findings

- **No Critical or High findings.**
- **Medium - fixed-row-height assumption (spec US2.3):** a search for `ROW_HEIGHT`, `estimateSize`, `itemHeight` and `ITEM_HEIGHT` in `src/renderer` found none, so the issue's inferred risk is likely absent; T4 still greps for `h-7` and virtualiser usage before closing the item. Resolution: left in T4.
- **Medium - number drift in the issue:** the issue's scan counts come from `origin/main` at filing time and #1246 will change many lines; the counts are not used as acceptance criteria, only the gate result is. Resolution: none needed.
- **Low - `lg`/`icon-lg` (36px):** stays out of the system per the issue; the gate does not cover sizing utilities, so these are untouched. Resolution: none.
- **Low - allowlist drift:** a stale allowlist entry fails the gate (plan, design step 1), so exceptions cannot rot silently.

## Rule conformance

- ADR 0003: shared components first (T2), no copies.
- 600-line cap: class edits only; checked by `check:file-size` in T11.
- No new tests: none planned; existing tests asserting old classes are updated (T2).
- Sequencing: implementation waits for #1246 to merge, then merges `origin/main` before T1.

## Verdict

Ready to implement once #1246 has merged.

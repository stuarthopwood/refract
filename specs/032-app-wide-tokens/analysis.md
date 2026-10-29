# Analysis: App-wide design tokens (spec, plan, tasks)

Run 2026-10-29 (`/speckit.analyze`), read-only check across `spec.md`, `plan.md`, `tasks.md`, the ten issues and their 2026-10-28 grill comments, ADR 0003 and the AGENTS.md rules.

## Coverage

| Requirement | Task |
| --- | --- |
| FR-001 to FR-003 | T1 |
| FR-004, FR-005 | T2 |
| FR-006 to FR-008, FR-011, FR-014 | T3 |
| FR-012 | T4 |
| FR-009, FR-010, FR-013 | T5 |
| FR-015 | T1 to T5, T7 |

## Findings

- No uncovered requirement and no task without a requirement.
- Shared-file risk: `globals.css` (S1, S2, S4) and `PanelTabBar.tsx` (S3 underline, S5 collapse). Mitigation: separate regions, re-read after each slice.
- #1144 inventory is stale (8px grid landed); the sweep re-baselines against main per the grill.
- #1065 and #1270 verify-script and `check-spacing` bullets are excluded and tracked in #1137.
- AGENTS.md "no new tests" holds; existing tests asserting old classes are updated, not deleted.
- 600-line cap: `PanelTabBar.tsx`, `globals.css` and `MessageInput.tsx` must be checked against `scripts/file-size-baseline.json` before and after.

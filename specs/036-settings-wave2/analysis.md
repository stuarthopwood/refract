# Analysis: Settings wave 2 (spec, plan, tasks)

Run 2026-10-29 (`/speckit.analyze`), read-only check across `spec.md`, `plan.md`, `tasks.md`, the six issues (#714, #717, #1070, #1141, #450, #842) with their 2026-10-29 grill comments, ADR 0003, and the AGENTS.md rules.

## Coverage

| Requirement | Task |
| --- | --- |
| FR-001 to FR-003 | T1, T3 |
| FR-004 | T3 |
| FR-005 | T2, T4 |
| FR-006, FR-007 | T6, T7 |
| FR-008 | T8 |
| FR-009 | T5 |
| FR-010, FR-011 | T10, T11, T12 |
| FR-012 | T9, T10, T12 |
| FR-013 | T13 |
| FR-014 | T16, T17, T18 |
| FR-015, FR-017 | T14 |
| FR-016 | T15 |
| FR-018 | T16 to T18, T19 |

## Findings

- No uncovered requirement and no task without a requirement. Task IDs are unique.
- Path correction: #1141 names `src-tauri/src/omp/model_roles.rs`; the file is `src-tauri/src/ipc/model_roles.rs` (474 lines). The spec and tasks use the real path.
- Cross-package coupling: the advisor model leaves Advanced (T12) and appears in Models (T9). They must land together or the advisor setting disappears; T9 and T12 are marked as a pair.
- Shared-file risk: `globals.css` (T8 role tokens, T14 text variables), `ProfileMenu.tsx` (T3 section ids, T13 chip), `SettingsScreen.tsx` (T3 owns; T12 import line only), `ModelRolesSection.tsx` (562 lines; T5, T7, T8, T9 all touch it). Mitigation: T5 first, then T7 to T9 serialised inside WP-B, new code in new files so the file shrinks.
- Section-id rename: `openSettings(...)` callers are `App.tsx`, `MessageInput.tsx`, `ProfileItem.tsx`, `ProfileMenu.tsx`; sibling lanes may add callers. Grep before merge (T19).
- 600-line cap and baselines: `ModelRolesSection.tsx` 562, `store/settings.rs` 555, `ipc/settings.rs` 562, `lib.rs` 555, `ipc.ts` 844 against a 898 baseline. WP-E uses sibling files and one-line hooks.
- Contrast: role colours (T8) and any new muted icon use must pass `check:theme-contrast` on every preset; the pairs are added in the same task.
- Probe risk: the supported OMP may confirm fewer inheritance links than documented; FR-007 is written so the UI is correct for any confirmed set, so this cannot block the PR.
- Text scale: the `max(11px, ...)` clamp is by design only effective on the smallest tokens; fixed-height controls at 150 percent are checked in T21 (`Button` `xs` and `sm`, tab strip, Session rows, chips).
- Renderer degrades to scale 1 on a shell without `settings.setTypography`, so WP-D does not hard-block on WP-E.
- AGENTS.md "no new tests" holds: no test-writing task exists; existing tests that assert old ids, labels or the "Current" text are updated, not deleted. `modelRoleSuffix.test.ts` stays passing.
- Docs-only follow-up: `CONTEXT.md` already holds the glossary terms Settings page, Settings group, Advanced; verify Role colour and Text size are present when T4 runs.

# Analysis: Live-verify the token guard Settings keys (#1935)

**Date**: 2026-11-12 | Read-only consistency check of `spec.md`, `plan.md`, `tasks.md` against the constitution, the grill outcomes and AGENTS.md.

## Coverage

| Requirement | Plan | Tasks |
|---|---|---|
| FR-001 verdict per key (17) | B | T005, T007-T013, T014 |
| FR-002 real omp, scripted provider, scratch dirs | A | T003, T004, T005 |
| FR-003 A/B, two agreeing runs | A (`ab.mjs`), D | T001, T005, T014 |
| FR-004 flags and `LIVE_KEYS` match | C | T015, T016 |
| FR-005 research.md, FR-036, quickstart | C | T017 |
| FR-006 `tools.xdev` not re-probed | B | T013 (explicit), none run it |
| FR-007 co-located unit tests, under 600 lines | A | T001, T002, T006 |
| FR-008 no label, layout or Rust change | C | T015 (flag only) |
| Key count: 3 idle + 2 snapcompact + 2 task + advisor + 2 grep + 2 read + todo + artifact + prewalk + plan + autolearn = 17 | B table | T007-T013 (4 + 1 + 2 + 2 + 3 + 2 + 3 = 17) |

All 8 requirements map to tasks; every task maps to a requirement. The 17 keys in the plan's table are exactly the keys in `TOKEN_GUARD_KEYS` that lack `live: true`.

## Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A1 | Medium | T007-T012 all add a group to `run.mjs`, so parallel workers would collide on one file. | Dependencies line says to serialise edits to `run.mjs`; at implement, one group module per task (`groups/<name>.mjs`) is acceptable under the plan's "small modules". |
| A2 | Medium | The plan does not say how the advisor probe avoids a `WATCHDOG.yml` roster; Stuart's rule (2026-10-30) forbids creating one. | Plan Constitution Check and T012 state it: default advisor, `modelRoles.advisor` in the scratch `config.yml` only. Quickstart repeats it. |
| A3 | Low | Spec flags OQ-1, OQ-2, OQ-3 as open; defaults are stated for each, none blocks implement. | Left open in the spec; implement proceeds on the defaults. If Stuart answers differently, only T013 (OQ-1), T011 (OQ-2) or T004-T006 (OQ-3) change. |
| A4 | Low | The idle verdict `startup-only` means "observed to change nothing", which in RPC sessions is true at startup too, so the label "Applies to new Sessions" is itself not fully accurate for those three rows. | Out of scope per the grill (a key with no observable stays startup-only); recorded as OQ-1 and in the PR body. |
| A5 | Low | New `scripts/` that spawn `omp` could raise CodeQL alerts (#1942 excludes only `scripts/verify-*.mjs`). | T004 is to spawn with a fixed argv and no shell. Not a new task. |
| A6 | Low | Assignment sets the `docs/PLAN.md` #1935 row to in progress now; tasks only say done at merge. | Done in this slice's last commit; the flip to done stays the controller's merge step (T018). |
| A7 | Low | #1942 used spec number 128; spec dirs 123 already collide twice. | This spec is 129; rename at implement only if another lane lands 129 first. |

No Critical or High findings. Constitution check: Principle I holds (real `omp --mode rpc-ui`, config edited via `omp config set`), tests co-located, files under 600 lines, "why"-only comments, Conventional Commit title `chore(settings): ...`.

## Verdict

Clean for implement.

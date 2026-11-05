# Analysis: Token guard: cut prompt cache writes

Cross-check of `spec.md`, `plan.md` and `tasks.md` against the code (`values.rs`, `overlay.rs`, `args.rs`) and the OMP bundle, 2026-11-05.

| Requirement | Covered by | Result |
| --- | --- | --- |
| FR-001 `providers.cacheWarming` key, default `idle`, validated | T001, T002, T007 | Covered |
| FR-002 overlay renders the `providers:` block | T003 (`build_tree` and `emit_node` need no change) | Covered |
| FR-003 no `modelOverrides`, `promptCache` or `cacheRetention`; never write `models.yml` | T003; plan slice 1 and 2 | Covered |
| FR-004 `task.softRequestBudget` 60, no per-agent entries | T004, T006, T003 | Covered |
| FR-005 one-time migration of a stored 80 | T005, T007 | Covered |
| FR-006 no Refract watchdog | No task; Out of scope by design | Covered |
| FR-007 three upstream drafts, not filed | T008 | Covered |
| FR-008 changed-defaults table in the PR | T010 | Covered |
| FR-009 Rust tests on rendered values and migration | T003, T007 | Covered |

## Findings

- The task data model lines up with the code: `defaults()` and `effective()` read `KEYS`, `args.rs` always writes the overlay, and the IPC payload carries `defaults()`, so no wiring beyond `values.rs` is needed. No `TOKEN_GUARD_KEYS` row is added (no switch); `changedRows` and `AdvancedSection` iterate rows only.
- OMP already defaults `providers.cacheWarming` to `idle`: the pin does not change behaviour in the installed OMP. The spec and the PR say so. The real gap (`github-copilot` has no `promptCache`) is upstream.
- `--config` cannot carry `modelOverrides`: answered in the spec Clarifications.
- Layering: the overlay outranks the user's `config.yml`, so it overrides a user-set `off`. Same as every other key; recorded in Edge Cases.
- Compile risk: no cargo build was run in this lane. The `migrate` extraction is the main risk; it is pure so tests avoid a temp directory (no `tempfile` dev-dependency exists).
- `CHANGELOG.md` is generated at release, so there is no changelog task.
- The two measurement ACs ("idle writes down by half after a week", "no run passes 1.5x") stay open on the issue; the second needs the upstream detached-budget fix.
- No inconsistencies, gaps or unresolved clarifications remain.

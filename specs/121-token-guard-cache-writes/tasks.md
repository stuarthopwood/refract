# Tasks: Token guard: cut prompt cache writes

**Spec**: `spec.md` | **Plan**: `plan.md` | **Issue**: #1672

## Phase 1: Idle expiry (slice 1)

- [x] T001 `values.rs`: add `("providers.cacheWarming", Kind::Text)` to `KEYS` and `"providers.cacheWarming" => json!("idle")` to `default_for` (FR-001).
- [x] T002 `values.rs`: add `CACHE_WARMING_MODES` (`off`, `streaming`, `idle`) and a `validate` arm for the key (FR-001).
- [x] T003 `overlay.rs`: update `renders_nested_yaml_with_version_header` to assert `providers:\n  cacheWarming: "idle"\n`; add a test that the default overlay has no `cacheRetention`, `modelOverrides`, `promptCache` or `agentSoftRequestBudget` (FR-002, FR-003, slice 2).

## Phase 2: Request budget (slice 3)

- [x] T004 `values.rs`: `task.softRequestBudget` default 80 to 60 in `default_for` (FR-004).
- [x] T005 `values.rs`: add `soft_budget_migrated` to `Stored`; extract the `read_stored` migration steps into a pure `migrate(&mut Stored)` and add the one-time drop of a stored 80 (FR-005).
- [x] T006 `overlay.rs`: change the assertion at line 120 from `softRequestBudget: 80` to `60` (FR-004).
- [x] T007 `values.rs` tests: `migrate` drops 80 once, keeps 40 and 0, sets the flag, keeps a deliberate 80 on a second pass; `validate` accepts `idle`/`off`/`streaming` and rejects `always` and `""` for the new key (FR-005, FR-009).

## Phase 3: Upstream drafts and docs

- [x] T008 Copy the three upstream drafts (`upstream-retention.md`, `upstream-copilot-promptcache.md`, `upstream-detached-budget.md`) from `%LOCALAPPDATA%\Temp\lane1672\` into `specs/121-token-guard-cache-writes/upstream/` unedited; do not file them (FR-007). Done in the spec lane.
- [x] T009 `docs/PLAN.md`: status line for #1672 (idle pin, 80 to 60, findings, upstream drafts, open ACs).
- [x] T010 PR body: defaults table of setting, old, new, evidence (FR-008), with `Refs #1672`; leave the two measurement ACs open on the issue.

## Phase 4: Verification

- [x] T011 Main's run worker: `cargo fmt --check`, `cargo test` (token_guard), `cargo clippy`, ci-local.

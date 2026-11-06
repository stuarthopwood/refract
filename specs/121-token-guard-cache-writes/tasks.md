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

## Phase 5: Convergence (2026-11-06)

- [x] T012 Converge `spec.md` with upstream: OMP PR can1357/oh-my-pi#17988 (merge 830d04d9, in v18.17.0) keeps `softRequestBudget` on revived, restored and workpool subagents; budget is resolved by registry id (`persisted-revive.ts:556`). AC2 ("no run passes 1.5x") is covered upstream for OMP >= 18.17.0; Refract builds no watchdog (FR-006 stands).
- [x] T013 Record retention as decided, not set: no `cacheRetention` override (global or per-agent); `providers.cacheRetention: long` for main Sessions is dropped (FR-003).
- [x] T014 Drop the detached-budget upstream draft: `upstream/upstream-detached-budget.md` removed; FR-007 now lists two drafts (supersedes T008's third file).
- [ ] T015 AC1 (idle-expiry cache writes down by half) stays open pending the post-release measurement (~2026-11-12). Shipped earlier in PR #1684: `providers.cacheWarming=idle` and `softRequestBudget` 80 to 60 (`values.rs:87-88,225-227`); unchanged here.

# Implementation Plan: Token guard: cut prompt cache writes

**Spec**: `specs/121-token-guard-cache-writes/spec.md` | **Issue**: #1672 | **Builds on**: spec 021 (not edited)

## Technical context

Rust only, `src-tauri/src/omp/token_guard/`. `args.rs` `launch_args` loads `values::load(dir)` and always writes `token-guard-overlay.yml` through `overlay::render`, so a key in `values::KEYS` with a `default_for` value reaches OMP through `--config` with no further wiring. The IPC payload (`ipc/token_guard.rs`) already sends `values::defaults()`. The renderer needs no change: `TOKEN_GUARD_KEYS` rows carry no default values, and a key with no row is simply not shown in Settings (there is no switch to build). No schema, IPC or renderer change; no renderer test.

## Design

**Slice 1: idle expiry (`values.rs`, `overlay.rs`).**
- `KEYS` gains `("providers.cacheWarming", Kind::Text)`; `default_for` returns `json!("idle")`.
- `validate`: `(Kind::Text, "providers.cacheWarming") => is_member(value, CACHE_WARMING_MODES)` with `CACHE_WARMING_MODES = ["off", "streaming", "idle"]`, next to `REVIEW_MODES`.
- `overlay::render` needs no change: `build_tree` splits `providers.cacheWarming` into a `providers:` node and `emit_node` writes `providers:\n  cacheWarming: "idle"\n`.
- `--config` and `modelOverrides` (the open question): No. OMP reads `modelOverrides.promptCache` only from `models.yml` (`ModelRegistry`'s `ConfigFile("models")`), and the overlay is a settings layer with no such entry. So no `promptCache` override is added to the overlay and Refract never writes `models.yml`. The root cause (OMP's model data declares `promptCache` only for anthropic, bedrock and factory-droid, so the warmer skips `github-copilot`) goes to `upstream-copilot-promptcache.md`.
- Because OMP's default is already `idle`, this is a pin, not a behaviour change in the installed OMP. The PR says so.

**Slice 2: retention.** No code. OMP has only the global `providers.cacheRetention`; setting it globally would also move main Sessions to 5-minute entries. The overlay must not carry the key; a test asserts that. `upstream-retention.md` asks for `task.agentCacheRetention`.

**Slice 3: budget (`values.rs`, `overlay.rs` test).**
- `default_for("task.softRequestBudget")` returns `json!(60)`. `max_count` and the Settings row stay as they are.
- Migration (spec 021 FR-031): `Stored` gains `#[serde(default)] soft_budget_migrated: bool`. The migration steps in `read_stored` move into a pure `fn migrate(stored: &mut Stored)` (no IO, so tests call it without a temp directory): the existing `read_limit_migrated` and `version` steps unchanged, plus `if !stored.soft_budget_migrated { if overrides.get("task.softRequestBudget") == Some(&json!(80)) { remove }; flag = true }`. Persisted with the next write, as `read_limit_migrated` is. No `STORE_VERSION` bump: the overlay header version and the thresholds notice stay as they are.
- A value other than 80, including 0, is kept. After the flag is set, a deliberate 80 stays.
- Detached/revived finding (recorded, no Refract code): the first spawn gets `MZe(name, task.softRequestBudget, task.agentSoftRequestBudget)` with the notice; the IRC wake-turn job (`detached: true`) and the revive path pass `softRequestBudget: 0, softRequestBudgetNotice: false`; the guard returns on `budget <= 0`; each call starts `R.requests` at 0. `upstream-detached-budget.md` asks OMP to budget those runs.
- No `agentSoftRequestBudget`: only agent type `task` passes the stop (271 runs, p90 206, max 778; others peak at 68 or fewer).

**Upstream drafts.** Three files, written by this lane to `%LOCALAPPDATA%\Temp\lane1672\` and copied into `specs/121-token-guard-cache-writes/upstream/` so the evidence survives: `upstream-retention.md`, `upstream-copilot-promptcache.md`, `upstream-detached-budget.md`. Not filed.

**Tests (Rust, in-module).**
- `overlay.rs`: `renders_nested_yaml_with_version_header` asserts `softRequestBudget: 60` (was 80 at line 120) and `providers:\n  cacheWarming: "idle"\n`; a new test asserts the default overlay has no `cacheRetention`, `modelOverrides`, `promptCache` or `agentSoftRequestBudget`.
- `values.rs`: `every_key_has_a_valid_default` already covers the new key; new tests for `migrate` (80 dropped once, 40 and 0 kept, flag set, a second pass keeps a deliberate 80), and `validate` for `providers.cacheWarming` (`idle`, `off`, `streaming` ok; `always`, `""` rejected). The existing `softRequestBudget` tests pin 40 and 10_001 and stay.

## Files

`src-tauri/src/omp/token_guard/values.rs`, `src-tauri/src/omp/token_guard/overlay.rs`, `docs/PLAN.md` (status line), `specs/121-token-guard-cache-writes/`. `CHANGELOG.md` is generated at release, so no entry. Both Rust files stay far under 600 lines.

## Constitution and repo rules

"Why" comments only; no renderer test; no `scripts/file-size-baseline.json` change; no build in this lane (the run worker runs `cargo test`, `cargo clippy`, `cargo fmt --check`, ci-local). PR title `feat(token-guard): cut prompt cache writes`, body `Refs #1672` plus the defaults table (setting, old, new, evidence).

## Risks

- Cannot compile in the spec lane. Risk points: the `migrate` extraction (borrowing `stored.overrides` in `get` then `remove`) and the new `match` arm in `validate`.
- The overlay layer outranks the user's `config.yml`, so a user who set `providers.cacheWarming: off` there is overridden. Same as every other token guard key; settable through the store if wanted.
- `idle` warming costs a one-token call per refresh when the cost floor is met; OMP decides. The 1.5x and "half after a week" criteria stay open on the issue.

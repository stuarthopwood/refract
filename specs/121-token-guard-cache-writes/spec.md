# Feature Specification: Token guard: cut prompt cache writes

**Feature Branch**: `lane/1672-token-guard-cache`
**Created**: 2026-11-05
**Status**: Draft
**Input**: GitHub issue #1672 (`p0`, `enhancement`, scope `settings`), scope decided by Stuart 2026-11-04 (all three parts), grilled 2026-11-05. Builds on spec 021 (token guard); 021 is not edited.

## Clarifications

### Session 2026-11-05

Answers come from the issue's grill with Stuart (2026-11-04 and 2026-11-05), director rulings and the installed OMP bundle and docs. No `[NEEDS CLARIFICATION]` marker was left open.

- Q: Is there an on/off switch for any of this? -> A: No. The new values are defaults only (`KEYS`/`default_for` in `values.rs`, rendered by `overlay::render`; `args.rs` `launch_args` always writes `token-guard-overlay.yml`). One spec, one PR, three slices. (from grill)
- Q: Can the `--config` overlay YAML carry `modelOverrides` with `promptCache`, as `~/.omp/agent/models.yml` does? -> A: No. `modelOverrides.promptCache` is honoured (docs/models.md "Prompt cache lifetimes", highest priority) but only from `models.yml`: `ModelRegistry` loads it through its own `ConfigFile("models")`, and uses the settings object only for disabled providers and the context-window toggle. The `--config` file is a settings layer (global, project, `configOverlay`, overrides) with no `modelOverrides` entry. So the plan adds no `promptCache` override, and an upstream issue asks OMP to ship `promptCache: {short: 300}` metadata for `github-copilot` Claude models. Refract never writes the user's `models.yml`. (checked in the OMP bundle)
- Q: Why add `providers.cacheWarming: idle` if it is already OMP's default? -> A: The root cause is not the setting: the warmer (`cache-warmer.ts`) needs `model.promptCache[tier]`, which OMP sets only for anthropic, bedrock and factory-droid, not `github-copilot`. Pinning `idle` keeps warming on if the default moves and puts the value in the generated file where the PR can report it. Stuart's own `models.yml` already declares `promptCache: {short: 300}` for his Copilot Claude models, so warming works for him; other users need the upstream fix. (grill; bundle)
- Q: Does OMP have a per-agent `cacheRetention`? -> A: No. `providers.cacheRetention` is one global setting; there is no `task.agentCacheRetention`, no agent-frontmatter value and no `task` argument, unlike `task.agentSoftRequestBudget`, `task.agentServiceTierOverrides` and `task.agentCompactionThresholdOverrides`. So there is no code change, never a global `cacheRetention` (it would also cut main Sessions to 5-minute entries), and an upstream issue asks for `task.agentCacheRetention`. (checked in the bundle and docs)
- Q: Should `agentSoftRequestBudget` get per-type entries? -> A: No. Only agent type `task` exceeds the stop: 271 runs, p90 206 requests, max 778. Every other type peaks at 68 or fewer. (usage data)
- Q: How do detached or revived subagents get their budget? -> A: They get none. In `runSubagent` the first spawn passes `softRequestBudget: MZe(agent.name, task.softRequestBudget, task.agentSoftRequestBudget)` with the notice on. The IRC wake-turn job (`detached: true`) and the keep-alive/revive path both pass `softRequestBudget: 0, softRequestBudgetNotice: false`; the guard starts with `if (budget <= 0) return`, and the request count starts at 0 in every call, so revival neither inherits the count nor a budget. Cause recorded; no Refract watchdog; an upstream issue covers it. (checked in the bundle)
- Q: Why 60? -> A: Runs over 120 requests (the old stop, 80 x 1.5): 191, about $9.1k. A budget of 60 covers 84% of the over-stop cost. (usage data)
- Q: What happens to users already on the old default? -> A: Spec 021 FR-031: a one-time migration, like #1545's `read_limit_migrated`, drops a stored override of exactly 80 and sets `soft_budget_migrated`. Other values stay. No migration for `providers.cacheWarming` (new key). (director ruling)
- Q: Which acceptance criteria stay open? -> A: "Idle writes down by half after a week" and "no run passes 1.5x" are left open on the issue; they need post-release data and the upstream detached-budget fix. (grill)
- Q: Evidence figures? -> A: Cache writes about $5.3k of $12.9k over 30 days; main-session gaps of 300 to 3600 s are 3.4% of messages and 56.3% of main-session cache-write cost; `github-copilot` has 24 warm-like calls in 257k messages. (usage database)

## User Scenarios & Testing

### User Story 1 - Idle Sessions keep their prompt cache warm (Priority: P1)

A Session that sits idle for a few minutes should not pay a full cache write when the user comes back. Refract guarantees the launch overlay asks OMP to refresh idle cache entries (`providers.cacheWarming: idle`), and records why that cannot yet work for `github-copilot` models.

**Why this priority**: cache writes are about $5.3k of $12.9k spend over 30 days. Main-session gaps of 300 to 3600 s are 3.4% of messages but 56.3% of main-session cache-write cost.

**Independent Test**: Render the overlay from the defaults and read the `providers` block; render it from a store that overrides the key and read the override.

**Acceptance Scenarios**:

1. **Given** a fresh store, **When** the overlay is rendered, **Then** it contains `providers:` with `cacheWarming: "idle"`.
2. **Given** a stored `providers.cacheWarming` of `"off"` or `"streaming"`, **Then** the overlay carries that value; any other stored value falls back to `"idle"` for that key only.
3. **Given** a `github-copilot` Claude model, **Then** the overlay carries no `modelOverrides` and Refract never writes the user's `models.yml` (see FR-003).

### User Story 2 - Short-lived subagents do not pay the 1-hour write premium (Priority: P2)

Per-agent `cacheRetention` would let a scout or sonic child write 5-minute entries (1.25x input) while the main Session keeps 1-hour entries (2x). OMP has no per-agent control, so this slice ships no code: it records the finding and drafts the upstream request. Retention is never set globally.

**Independent Test**: Render the overlay and confirm no `providers.cacheRetention` line exists.

**Acceptance Scenarios**:

1. **Given** any store, **Then** the overlay has no `cacheRetention` key at any level.
2. **Given** the upstream draft, **Then** it names the missing control, the existing per-agent records it should mirror, and the 30-day evidence.

### User Story 3 - A tighter subagent request budget (Priority: P1)

`task.softRequestBudget` goes from 80 to 60, so a runaway `task` subagent is told to wrap up at 60 requests and is stopped at 90, instead of 80 and 120.

**Why this priority**: only agent type `task` passes the stop (271 runs, p90 206 requests, max 778); every other type peaks at 68 or fewer. Runs over 120 requests: 191, about $9.1k. A budget of 60 covers 84% of the over-stop cost.

**Independent Test**: Render the overlay from the defaults and read `task.softRequestBudget`; load an old store that holds 80 and read the effective value.

**Acceptance Scenarios**:

1. **Given** a fresh store, **Then** the overlay contains `task:\n  maxConcurrency: 6\n  softRequestBudget: 60\n`.
2. **Given** a store from before this change that holds an override of exactly 80, **When** it loads, **Then** the override is dropped once and the effective value is 60.
3. **Given** a store that holds any other value (including 0, "no limit"), **Then** the value is kept.
4. **Given** the migration has run and the user then deliberately sets 80, **Then** 80 is kept (the migration never runs twice).
5. **Given** the overlay, **Then** it has no `task.agentSoftRequestBudget`.

### Edge Cases

- The overlay layer outranks the user's `config.yml` in OMP (global, project, `--config` overlay, session overrides), so the overlay's `providers.cacheWarming` replaces a user value set only in `config.yml`. This matches every other token guard key.
- The "Optimise token usage" button clears every override, so it restores `idle` and 60 like any other default.
- A woken or revived subagent run has no budget in OMP at all (see Assumptions); the lowered budget does not reach it.
- A user whose own `models.yml` already declares `promptCache` for `github-copilot` models gets warming today; nothing here changes that.

## Requirements

- **FR-001**: `values.rs` gains the key `providers.cacheWarming` (`Kind::Text`, default `"idle"`), validated as one of `off`, `streaming`, `idle`. It is in `KEYS` and `default_for`, so `defaults()`, `effective()` and `overlay::render` carry it. No Settings row is added: there is no on/off switch.
- **FR-002**: `overlay::render` emits it as the `providers:` block, `cacheWarming: "idle"` by default.
- **FR-003**: The overlay carries no `modelOverrides`, no `promptCache` and no `cacheRetention`. Refract never writes or edits `~/.omp/agent/models.yml`. Reason: OMP reads `modelOverrides.promptCache` only from `models.yml`, not from a `--config` overlay (see Clarifications). The gap goes to an upstream issue.
- **FR-004**: `task.softRequestBudget` default changes from 80 to 60 in `default_for`. No `task.agentSoftRequestBudget` entries are added.
- **FR-005** (spec 021 FR-031): a one-time migration drops a stored `task.softRequestBudget` override equal to 80 (the old default) and records `soft_budget_migrated` in the store, modelled on `read_limit_migrated` (#1545). Other stored values, including 0, stay. Nothing else migrates: `providers.cacheWarming` is a new key, so no old store holds a value for it.
- **FR-006**: No Refract watchdog for detached or revived subagent runs. The gap goes to an upstream issue.
- **FR-007**: Three upstream issue drafts are written and not filed: per-agent `cacheRetention`, `promptCache` for `github-copilot` models (and, optionally, `modelOverrides` from `--config`), and the soft budget for detached and revived runs. Each carries its evidence.
- **FR-008**: The PR description reports each changed default as a table of setting, old value, new value and evidence, as in #1581 (spec 021 FR-031). Rows: `providers.cacheWarming` (not set by Refract, OMP default `idle`; now pinned) and `task.softRequestBudget` (80 to 60).
- **FR-009**: Rust tests check the rendered overlay values and the migration. No renderer change and no renderer test.

## Success Criteria

- The rendered default overlay contains `providers.cacheWarming: "idle"` and `task.softRequestBudget: 60`, and no `cacheRetention`, `modelOverrides` or `agentSoftRequestBudget`.
- An old store holding 80 loads as 60; a store holding 40 or 0 keeps its value; the flag stops a second migration.
- The PR reports each changed default with evidence, and the three upstream drafts exist with evidence.
- Left open on the issue, to be measured after release: idle cache writes down by half after a week, and no run passing 1.5x its budget. This PR does not claim either: the second one needs the upstream detached-budget fix.

## Assumptions and non-goals

- Findings that shaped the scope (observed in the installed OMP bundle and docs, 2026-11-05):
  - `providers.cacheWarming` already defaults to `idle` in OMP. The warmer skips any model whose `model.promptCache[tier]` is undefined, and OMP's model data sets that only for anthropic, bedrock and factory-droid. So `github-copilot` shows 24 warm-like calls out of 257k messages. Pinning `idle` protects against a default change; it does not by itself make `github-copilot` warm.
  - The `--config` overlay cannot carry `modelOverrides` (Clarifications).
  - There is no per-agent `cacheRetention` (only the global `providers.cacheRetention`).
  - Detached and revived subagent runs get `softRequestBudget: 0` (Clarifications).
- Not building: an on/off switch, a Settings row, a Refract watchdog for runaway runs, a global `cacheRetention`, or `agentSoftRequestBudget` entries.
- Not editing spec 021 or the user's `models.yml`.
- Rust tests are allowed for this lane; no renderer tests.
